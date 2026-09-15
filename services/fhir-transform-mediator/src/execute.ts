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
  body: Record<string, unknown>;
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

function onlyMissingHealthId(body: unknown) {
  const parsed = outcomeSchema.safeParse(body);
  const errors = parsed.success
    ? parsed.data.issue.filter((issue) =>
        ["fatal", "error"].includes(issue.severity),
      )
    : [];
  return (
    errors.length > 0 &&
    errors.every(
      (issue) =>
        ["required", "structure"].includes(issue.code) &&
        [issue.diagnostics, issue.details?.text].some((message) =>
          message?.includes(
            "Slice 'Patient.identifier:healthId': a matching slice is required, but not found",
          ),
        ),
    )
  );
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
  context: Context,
): Result {
  try {
    const mapper = mappings[integration.mapping];
    const body = mapper.toFhir(input, integration.options);
    return { status: 200, body, orchestrations: [] };
  } catch (error) {
    const issues =
      error instanceof z.ZodError
        ? error.issues.map((issue) => ({ code: issue.code, path: issue.path }))
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
  const mapped = transform(integration, input, context);
  if (mapped.status !== 200) return mapped;
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
      return failure(
        502,
        "validator_failed",
        context,
        stage,
        "not-called",
        undefined,
        orchestrations,
      );
    if (
      issues.some((issue) => ["fatal", "error"].includes(issue.severity)) &&
      !onlyMissingHealthId(response.body)
    )
      return failure(
        422,
        "fhir_validation_failed",
        context,
        stage,
        "not-called",
        issues,
        orchestrations,
      );
    return { status: 200, body: mapped.body, orchestrations };
  } catch (error) {
    const timeout = error instanceof TransportError && error.timeout;
    return failure(
      timeout ? 504 : 502,
      timeout ? "upstream_timeout" : "upstream_unavailable",
      context,
      "request-validation",
      "not-called",
      undefined,
      orchestrations,
    );
  } finally {
    entry.response.timestamp = new Date().toISOString();
  }
}
