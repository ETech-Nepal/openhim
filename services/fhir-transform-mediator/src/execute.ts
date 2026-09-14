import { z } from "zod";
import { createHash } from "node:crypto";
import type { Integration } from "./config.js";
import { mappings } from "./mappings/index.js";
import {
  postJson,
  TransportError,
  type JsonRequest,
  type Transport,
} from "./http.js";

export type Context = {
  clientId: string;
  correlationId: string;
  idempotencyKey?: string;
};
export type Orchestration = {
  name: string;
  request: { method: string; path: string; timestamp: string };
  response: { status: number; timestamp: string };
};
export type Result = {
  status: number;
  body: Record<string, unknown>;
  orchestrations: Orchestration[];
};
type Outcome = "not-called" | "unknown" | "success" | "rejected";

const outcomeSchema = z.object({
  resourceType: z.literal("OperationOutcome"),
  issue: z
    .array(
      z.object({
        severity: z.enum(["fatal", "error", "warning", "information"]),
        code: z.string().min(1),
      }),
    )
    .min(1),
});

const issueCodes = new Set([
  "invalid",
  "structure",
  "required",
  "value",
  "invariant",
  "security",
  "forbidden",
  "processing",
  "not-supported",
  "duplicate",
  "multiple-matches",
  "not-found",
  "code-invalid",
  "business-rule",
  "conflict",
  "exception",
  "timeout",
  "throttled",
  "informational",
]);

// Diagnostics and FHIRPath expressions can contain patient data. Only known codes leave this boundary.
function safeIssues(body: unknown) {
  const parsed = outcomeSchema.safeParse(body);
  return parsed.success
    ? parsed.data.issue.map((issue) => ({
        severity: issue.severity,
        code: issueCodes.has(issue.code) ? issue.code : "processing",
      }))
    : undefined;
}

export function failure(
  status: number,
  error: string,
  context: Context,
  stage: string,
  downstreamOutcome: Outcome = "not-called",
  issues?: unknown,
  orchestrations: Orchestration[] = [],
): Result {
  return {
    status,
    body: {
      error,
      stage,
      correlationId: context.correlationId,
      downstreamOutcome,
      ...(issues !== undefined ? { issues } : {}),
    },
    orchestrations,
  };
}

export function transform(
  integration: Integration,
  input: unknown,
  direction: "request" | "response",
  context: Context,
): Result {
  try {
    const mapper = mappings[integration.mapping];
    const body =
      direction === "request"
        ? mapper.toFhir(input, integration.options)
        : mapper.fromFhir(input, integration.options);
    return { status: 200, body, orchestrations: [] };
  } catch (error) {
    const issues =
      error instanceof z.ZodError
        ? error.issues.map((issue) => ({ code: issue.code, path: issue.path }))
        : undefined;
    return failure(
      400,
      `${direction}_mapping_failed`,
      context,
      `${direction}-mapping`,
      "not-called",
      issues,
    );
  }
}

export async function execute(
  integration: Integration,
  input: unknown,
  context: Context,
  transport: Transport = postJson,
): Promise<Result> {
  const mapped = transform(integration, input, "request", context);
  if (mapped.status !== 200) return mapped;
  if (!integration.destination)
    return failure(503, "submission_not_configured", context, "configuration");
  const orchestrations: Orchestration[] = [];
  let stage = "request-validation";
  let outcome: Outcome = "not-called";

  const call = async (request: JsonRequest) => {
    const entry: Orchestration = {
      name: `${integration.id}: ${stage}`,
      request: {
        method: request.method ?? "POST",
        path: new URL(request.url).pathname,
        timestamp: new Date().toISOString(),
      },
      response: { status: 0, timestamp: new Date().toISOString() },
    };
    orchestrations.push(entry);
    try {
      const response = await transport(request);
      entry.response.status = response.status;
      return response;
    } finally {
      entry.response.timestamp = new Date().toISOString();
    }
  };

  const validate = async (
    body: unknown,
    profile?: string,
  ): Promise<Result | undefined> => {
    const endpoint = integration.validation!;
    const url = new URL(endpoint.url);
    if (profile) url.searchParams.set("profile", profile);
    const response = await call({
      url: url.href,
      body,
      timeoutMs: endpoint.timeoutMs,
      headers: endpoint.authorization
        ? { Authorization: endpoint.authorization }
        : {},
    });
    const issues = safeIssues(response.body);
    if (response.status < 200 || response.status >= 300 || !issues)
      return failure(
        502,
        "validator_failed",
        context,
        stage,
        outcome,
        undefined,
        orchestrations,
      );
    if (issues.some((issue) => ["fatal", "error"].includes(issue.severity)))
      return failure(
        stage === "request-validation" ? 422 : 502,
        "fhir_validation_failed",
        context,
        stage,
        outcome,
        issues,
        orchestrations,
      );
  };

  try {
    if (integration.validation) {
      const invalidRequest = await validate(
        mapped.body,
        integration.validation.requestProfile,
      );
      if (invalidRequest) return invalidRequest;
    }
    stage = "patient-lookup";
    if (integration.lookup) {
      const identifiers = z
        .array(z.object({ system: z.string(), value: z.string().min(1) }))
        .safeParse(mapped.body.identifier);
      const requiredIdentifiers = integration.lookup.matchIdentifierSystems.map(
        (system) =>
          identifiers.success
            ? identifiers.data.find(
                (identifier) => identifier.system === system,
              )
            : undefined,
      );
      if (requiredIdentifiers.some((identifier) => !identifier))
        return failure(
          422,
          "lookup_identifiers_missing",
          context,
          stage,
          "not-called",
          undefined,
          orchestrations,
        );
      const url = new URL(
        "Patient",
        integration.lookup.url.endsWith("/")
          ? integration.lookup.url
          : `${integration.lookup.url}/`,
      );
      for (const identifier of requiredIdentifiers)
        url.searchParams.append(
          "identifier",
          `${identifier!.system}|${identifier!.value}`,
        );
      const lookup = await call({
        method: "GET",
        url: url.href,
        timeoutMs: integration.lookup.timeoutMs,
        headers: {
          ...(integration.lookup.authorization && {
            Authorization: integration.lookup.authorization,
          }),
          "X-Correlation-ID": context.correlationId,
        },
      });
      if (lookup.status < 200 || lookup.status >= 300)
        return failure(
          502,
          "lookup_failed",
          context,
          stage,
          "not-called",
          safeIssues(lookup.body),
          orchestrations,
        );
      const bundle = z
        .object({
          resourceType: z.literal("Bundle"),
          type: z.literal("searchset"),
          entry: z.array(z.object({ resource: z.unknown() })).optional(),
        })
        .safeParse(lookup.body);
      if (!bundle.success)
        return failure(
          502,
          "lookup_failed",
          context,
          stage,
          "not-called",
          undefined,
          orchestrations,
        );
      const matches = (bundle.data.entry ?? [])
        .map((entry) => entry.resource)
        .filter(
          (resource): resource is Record<string, unknown> =>
            typeof resource === "object" &&
            resource !== null &&
            (resource as { resourceType?: unknown }).resourceType === "Patient",
        )
        .filter((resource) => {
          const candidateIdentifiers = identifiers.success
            ? z
                .array(z.object({ system: z.string(), value: z.string() }))
                .safeParse(resource.identifier)
            : undefined;
          return (
            candidateIdentifiers?.success &&
            requiredIdentifiers.every((identifier) =>
              candidateIdentifiers.data.some(
                (candidate) =>
                  candidate.system === identifier!.system &&
                  candidate.value === identifier!.value,
              ),
            )
          );
        });
      if (matches.length > 1)
        return failure(
          409,
          "multiple_existing_patients",
          context,
          stage,
          "success",
          undefined,
          orchestrations,
        );
      if (matches.length === 1) {
        const existing = transform(
          integration,
          matches[0],
          "response",
          context,
        );
        if (existing.status === 200)
          return { status: 200, body: existing.body, orchestrations };
      }
    }
    stage = "destination";
    outcome = "unknown";
    const destination = integration.destination;
    const response = await call({
      url: destination.url,
      body: mapped.body,
      timeoutMs: destination.timeoutMs,
      headers: {
        ...(destination.authorization && {
          Authorization: destination.authorization,
        }),
        "X-Correlation-ID": context.correlationId,
        ...(integration.forwardIdempotencyKey &&
          context.idempotencyKey && {
            "Idempotency-Key": createHash("sha256")
              .update(
                JSON.stringify([
                  integration.id,
                  context.clientId,
                  context.idempotencyKey,
                ]),
              )
              .digest("hex"),
          }),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      outcome =
        response.status >= 400 && response.status < 500
          ? "rejected"
          : "unknown";
      return failure(
        response.status >= 400 && response.status <= 599
          ? response.status
          : 502,
        "downstream_rejected",
        context,
        stage,
        outcome,
        safeIssues(response.body),
        orchestrations,
      );
    }
    // Accepted asynchronous work and empty acknowledgments are not completed registrations.
    if (![200, 201].includes(response.status))
      return failure(
        502,
        "unexpected_success_status",
        context,
        stage,
        "unknown",
        undefined,
        orchestrations,
      );
    outcome = "success";
    const issues = safeIssues(response.body);
    if (issues?.some((issue) => ["fatal", "error"].includes(issue.severity)))
      return failure(
        502,
        "downstream_rejected",
        context,
        stage,
        "unknown",
        issues,
        orchestrations,
      );
    if (integration.validation) {
      stage = "response-validation";
      const invalidResponse = await validate(
        response.body,
        integration.validation.responseProfile,
      );
      if (invalidResponse) return invalidResponse;
    }
    stage = "response-mapping";
    const converted = transform(
      integration,
      response.body,
      "response",
      context,
    );
    if (converted.status !== 200)
      return failure(
        502,
        "response_mapping_failed",
        context,
        stage,
        outcome,
        undefined,
        orchestrations,
      );
    return { status: response.status, body: converted.body, orchestrations };
  } catch (error) {
    const timeout = error instanceof TransportError && error.timeout;
    return failure(
      timeout ? 504 : 502,
      timeout ? "upstream_timeout" : "upstream_unavailable",
      context,
      stage,
      outcome,
      undefined,
      orchestrations,
    );
  }
}
