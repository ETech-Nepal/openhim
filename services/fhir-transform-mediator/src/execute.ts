import { z } from "zod";
import type { Integration } from "./config.js";
import { mappings } from "./mappings/index.js";
import { postJson, TransportError, type Transport } from "./http.js";

export type Context = {
  correlationId: string;
};
export type Orchestration = {
  name: string;
  request: { method: string; path: string; timestamp: string };
  response: { status: number; timestamp: string };
};
export type Result = {
  status: number;
  body: unknown;
  orchestrations: Orchestration[];
};
type Outcome = "not-called";

const outcomeSchema = z.object({
  resourceType: z.literal("OperationOutcome"),
  issue: z
    .array(
      z.object({
        severity: z.enum(["fatal", "error", "warning", "information"]),
        code: z.string().min(1),
        diagnostics: z.string().optional(),
        expression: z.array(z.string()).optional(),
        location: z.array(z.string()).optional(),
        details: z.object({ text: z.string().optional() }).optional(),
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

// NP Core requires a Health ID the NHID generator has not assigned yet, so this error is expected.
const isMissingHealthId = (
  issue: z.infer<typeof outcomeSchema>["issue"][number],
) =>
  ["required", "structure"].includes(issue.code) &&
  [issue.diagnostics, issue.details?.text].some((message) =>
    message?.includes(
      "Slice 'Patient.identifier:healthId': a matching slice is required, but not found",
    ),
  );

// The validator's own text is relayed to the caller that submitted the data, as the NHID
// service's message is. It never enters orchestrations or logs.
function safeIssues(body: unknown) {
  const parsed = outcomeSchema.safeParse(body);
  return parsed.success
    ? parsed.data.issue
        .filter((issue) => !isMissingHealthId(issue))
        .map((issue) => {
          const message = issue.diagnostics ?? issue.details?.text;
          const expression = (issue.expression ?? issue.location)?.[0];
          return {
            severity: issue.severity,
            code: issueCodes.has(issue.code) ? issue.code : "processing",
            ...(expression && { expression }),
            ...(message && { message }),
          };
        })
    : undefined;
}

function onlyMissingHealthId(body: unknown) {
  const parsed = outcomeSchema.safeParse(body);
  const errors = parsed.success
    ? parsed.data.issue.filter((issue) =>
        ["fatal", "error"].includes(issue.severity),
      )
    : [];
  return errors.length > 0 && errors.every(isMissingHealthId);
}

const nhidErrorSchema = z.object({
  status: z.literal(false),
  message: z.string().min(1),
});
const nhidRequiredFields = new Set([
  "National ID",
  "given name",
  "family name",
  "date of birth",
]);
const missingPrefix = "Missing field(s): ";

// The NHID service reports every failure as {status:false,message}. The message is classified
// into a stable code and relayed only to mappings with toError, which answer the caller that
// submitted the data. It never enters the generic error body, orchestrations, or logs.
function nhidError(status: number, body: unknown) {
  const parsed = nhidErrorSchema.safeParse(body);
  const message = parsed.success ? parsed.data.message : "";
  return { ...classifyNhid(status, message), ...(message && { message }) };
}

function classifyNhid(status: number, message: string) {
  if (message.startsWith(missingPrefix)) {
    const fields = message
      .slice(missingPrefix.length)
      .split(", ")
      .filter((field) => nhidRequiredFields.has(field));
    if (fields.length)
      return { status: 400, error: "nhid_missing_fields", issues: fields };
  }
  if (
    message ===
    "Gender and phone number are required to generate a new HealthID"
  )
    return { status: 400, error: "nhid_missing_gender_or_phone" };
  // The mediator built the resource the service rejected, so this is not a caller error.
  if (message.startsWith("Not a valid FHIR Patient request"))
    return { status: 502, error: "nhid_rejected_resource" };
  if (
    message ===
    "NID already exists but the provided data does not match the existing record"
  )
    return { status: 409, error: "nhid_identity_mismatch" };
  if (message === "NID already exists")
    return { status: 409, error: "nhid_existing_record" };
  return {
    status: status === 400 || status === 409 ? status : 502,
    error: "nhid_service_failed",
  };
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

function mappingFailure(
  integration: Integration,
  input: unknown,
  status: number,
  error: string,
  context: Context,
  stage: string,
  issues?: unknown,
  orchestrations: Orchestration[] = [],
  upstreamMessage?: string,
): Result {
  const mapper = mappings[integration.mapping];
  return {
    ...failure(
      status,
      error,
      context,
      stage,
      "not-called",
      issues,
      orchestrations,
    ),
    ...(mapper.toError && {
      body: mapper.toError(input, error, issues, stage, upstreamMessage),
    }),
  };
}

export function transform(
  integration: Integration,
  input: unknown,
  context: Context,
): Result {
  try {
    const mapper = mappings[integration.mapping];
    const body = mapper.toFhir(input, integration.options);
    return { status: 200, body, orchestrations: [] };
  } catch (error) {
    const issues =
      error instanceof z.ZodError
        ? // Zod messages can echo submitted values; keep only the code, path, and type/key names.
          error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
            ...(issue.code === "invalid_type" && { received: issue.received }),
            ...(issue.code === "unrecognized_keys" && { keys: issue.keys }),
          }))
        : undefined;
    return failure(
      400,
      "request_mapping_failed",
      context,
      "request-mapping",
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
  const mapper = mappings[integration.mapping];
  const mapped = transform(integration, input, context);
  if (mapped.status !== 200) {
    const body = mapped.body as { error?: unknown; issues?: unknown };
    return typeof body.error === "string"
      ? mappingFailure(
          integration,
          input,
          mapped.status,
          body.error,
          context,
          "request-mapping",
          body.issues,
        )
      : mapped;
  }
  const orchestrations: Orchestration[] = [];
  if (!integration.validation)
    return { status: 200, body: mapped.body, orchestrations };
  const stage = "request-validation";
  const endpoint = integration.validation;
  const url = new URL(endpoint.url);
  if (endpoint.requestProfile)
    url.searchParams.set("profile", endpoint.requestProfile);
  const entry: Orchestration = {
    name: `${integration.id}: ${stage}`,
    request: {
      method: "POST",
      path: url.pathname,
      timestamp: new Date().toISOString(),
    },
    response: { status: 0, timestamp: new Date().toISOString() },
  };
  orchestrations.push(entry);
  try {
    const response = await transport({
      url: url.href,
      body: mapped.body,
      timeoutMs: endpoint.timeoutMs,
      headers: endpoint.authorization
        ? { Authorization: endpoint.authorization }
        : {},
    });
    entry.response.status = response.status;
    const issues = safeIssues(response.body);
    if (response.status < 200 || response.status >= 300 || !issues)
      return mappingFailure(
        integration,
        input,
        502,
        "validator_failed",
        context,
        stage,
        undefined,
        orchestrations,
      );
    if (
      issues.some((issue) => ["fatal", "error"].includes(issue.severity)) &&
      !onlyMissingHealthId(response.body)
    )
      return mappingFailure(
        integration,
        input,
        422,
        "fhir_validation_failed",
        context,
        stage,
        issues,
        orchestrations,
      );
    if (!integration.nhidGenerator)
      return { status: 200, body: mapped.body, orchestrations };

    const generatorStage = "nhid-generation";
    const generator = integration.nhidGenerator;
    const generatorUrl = new URL(generator.url);
    const generatorEntry: Orchestration = {
      name: `${integration.id}: ${generatorStage}`,
      request: {
        method: "POST",
        path: generatorUrl.pathname,
        timestamp: new Date().toISOString(),
      },
      response: { status: 0, timestamp: new Date().toISOString() },
    };
    orchestrations.push(generatorEntry);
    try {
      const response = await transport({
        url: generatorUrl.href,
        body: mapped.body,
        timeoutMs: generator.timeoutMs,
        headers: generator.authorization
          ? { Authorization: generator.authorization }
          : {},
      });
      generatorEntry.response.status = response.status;
      if (response.status < 200 || response.status >= 300) {
        const classified = nhidError(response.status, response.body);
        return mappingFailure(
          integration,
          input,
          classified.status,
          classified.error,
          context,
          generatorStage,
          classified.issues,
          orchestrations,
          classified.message,
        );
      }
      try {
        return {
          status: response.status,
          body: mapper.fromFhir
            ? mapper.fromFhir(response.body, input, integration.options)
            : response.body,
          orchestrations,
        };
      } catch {
        return mappingFailure(
          integration,
          input,
          502,
          "response_mapping_failed",
          context,
          "response-mapping",
          undefined,
          orchestrations,
        );
      }
    } catch (error) {
      const timeout = error instanceof TransportError && error.timeout;
      return mappingFailure(
        integration,
        input,
        timeout ? 504 : 502,
        timeout ? "upstream_timeout" : "upstream_unavailable",
        context,
        generatorStage,
        undefined,
        orchestrations,
      );
    } finally {
      generatorEntry.response.timestamp = new Date().toISOString();
    }
  } catch (error) {
    const timeout = error instanceof TransportError && error.timeout;
    return mappingFailure(
      integration,
      input,
      timeout ? 504 : 502,
      timeout ? "upstream_timeout" : "upstream_unavailable",
      context,
      "request-validation",
      undefined,
      orchestrations,
    );
  } finally {
    entry.response.timestamp = new Date().toISOString();
  }
}
