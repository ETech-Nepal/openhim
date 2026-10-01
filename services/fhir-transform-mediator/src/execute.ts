import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppDefinition } from "./config.js";
import { postJson, TransportError, type Transport } from "./http.js";
import { selectSegments, type Segment } from "./mapping/select.js";
import {
  FieldError,
  render,
  renderResource,
  type CanonicalFields,
} from "./mapping/template.js";

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
// Every message is fixed text or a field name. Submitted values and upstream text never appear.
export type Issue = {
  code: string;
  message: string;
  severity?: string;
  expression?: string;
  field?: string;
  path?: Segment[];
  keys?: string[];
};

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
type OutcomeIssue = z.infer<typeof outcomeSchema>["issue"][number];

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

// Echo fields are read straight from the input and kept only when valid, so an error
// response never repeats a malformed value.
function echoFields(app: AppDefinition, input: unknown) {
  const fields: CanonicalFields = new Map();
  for (const field of app.fields.filter((item) => item.echo)) {
    const parsed = field.schema.safeParse(
      selectSegments(input, field.segments),
    );
    if (parsed.success) fields.set(field.name, parsed.data);
  }
  return fields;
}

function errorBody(
  app: AppDefinition | undefined,
  error: string,
  stage: string,
  context: Context,
  issues: Issue[] | undefined,
  input: unknown,
) {
  const fallback = {
    error,
    stage,
    correlationId: context.correlationId,
    ...(issues?.length && { issues }),
  };
  const template = app?.errors?.template;
  if (!app || !template) return fallback;
  const fields = input === undefined ? new Map() : echoFields(app, input);
  const located = issues?.find((issue) => issue.field);
  fields.set("error.code", error);
  fields.set("error.stage", stage);
  fields.set("error.correlation_id", context.correlationId);
  fields.set(
    "error.message",
    issues?.length
      ? issues.map((issue) => issue.message).join("; ")
      : (app.errors?.messages[error] ?? "The request could not be completed."),
  );
  if (located) {
    fields.set("error.field", located.field);
    fields.set("error.path", located.path);
  }
  // One issue is already in message/field/path; list them only when there are several.
  if (issues && issues.length > 1) fields.set("error.issues", issues);
  try {
    const body = render(template, fields);
    return typeof body === "object" ? body : fallback;
  } catch {
    return fallback;
  }
}

export function failure(
  status: number,
  error: string,
  context: Context,
  stage: string,
  app?: AppDefinition,
  extra: {
    issues?: Issue[];
    orchestrations?: Orchestration[];
    input?: unknown;
  } = {},
): Result {
  return {
    status,
    body: errorBody(app, error, stage, context, extra.issues, extra.input),
    orchestrations: extra.orchestrations ?? [],
  };
}

function unknownKeys(app: AppDefinition, input: unknown) {
  type Node = Map<Segment, Node>;
  const root: Node = new Map();
  for (const field of app.fields.filter((item) => item.value === undefined)) {
    let node = root;
    for (const segment of field.segments) {
      if (!node.has(segment)) node.set(segment, new Map());
      node = node.get(segment)!;
    }
  }
  const issues: Issue[] = [];
  const visit = (value: unknown, node: Node, at: Segment[]) => {
    if (!node.size || value === null || typeof value !== "object") return;
    const record = value as Record<Segment, unknown>;
    const keys: Segment[] = Array.isArray(value)
      ? value.map((_, index) => index)
      : Object.keys(value);
    for (const key of keys)
      if (node.has(key)) visit(record[key], node.get(key)!, [...at, key]);
    const unknown = keys.filter((key) => !node.has(key)).map(String);
    if (unknown.length) {
      const field = at.join(".") || "request";
      issues.push({
        code: "unrecognized_keys",
        field,
        path: at,
        keys: unknown,
        message: `${field} has unknown field(s): ${unknown.join(", ")}`,
      });
    }
  };
  visit(input, root, []);
  return issues;
}

function extract(app: AppDefinition, input: unknown) {
  const fields: CanonicalFields = new Map();
  const issues: Issue[] = [];
  for (const spec of app.fields) {
    if (spec.value !== undefined) {
      fields.set(spec.name, spec.value);
      continue;
    }
    const at = { field: spec.field, path: spec.segments };
    const value = selectSegments(input, spec.segments);
    if (value === undefined) {
      if (spec.required)
        issues.push({
          code: "required",
          ...at,
          message: `${spec.field} is required`,
        });
      continue;
    }
    const parsed = spec.schema.safeParse(value);
    if (parsed.success) fields.set(spec.name, parsed.data);
    else
      issues.push({
        code: "invalid",
        ...at,
        message: `${spec.field} ${spec.rule ?? "is invalid"}`,
      });
  }
  if (app.strict) issues.push(...unknownKeys(app, input));
  return { fields, issues };
}

function build(
  app: AppDefinition,
  fields: CanonicalFields,
  provenance: Map<string, string>,
) {
  const collect = (prefix: string, local: Map<string, string>) => {
    for (const [path, name] of local) provenance.set(`${prefix}.${path}`, name);
  };
  if (app.resources.length === 1) {
    const [{ mapping }] = app.resources;
    const local = new Map<string, string>();
    const resource = renderResource(mapping, fields, local);
    collect(mapping.resourceType, local);
    return resource;
  }
  // Entries reference each other by these fullUrls, so references stay inside the Bundle.
  const urls = new Map(
    app.resources.map((resource) => [resource.key, `urn:uuid:${randomUUID()}`]),
  );
  return {
    resourceType: "Bundle",
    type: app.bundleType,
    entry: app.resources.map((resource, index) => {
      const scoped = new Map(fields);
      for (const [name, key] of Object.entries(resource.refs))
        scoped.set(name, urls.get(key));
      const local = new Map<string, string>();
      const rendered = renderResource(resource.mapping, scoped, local);
      collect(`Bundle.entry[${index}].resource`, local);
      return {
        fullUrl: urls.get(resource.key),
        resource: rendered,
        ...(app.bundleType === "transaction" && {
          request: resource.request ?? {
            method: "POST",
            url: resource.mapping.resourceType,
          },
        }),
      };
    }),
  };
}

// Finds the canonical field behind a validator FHIRPath: the path itself, an element built
// from one field only, or else the nearest parent. `value.ofType(Coding)` is the FHIRPath
// form of the JSON key `valueCoding`. Inside a Bundle the validator annotates paths, as in
// `Bundle.entry[1].resource/*Encounter/null*/.identifier`; the comment is dropped.
function locate(provenance: Map<string, string>, expression: string) {
  let key = expression
    .replace(/\/\*.*?\*\//g, "")
    .replace(
      /\.(\w+)\.ofType\((\w)(\w*)\)/g,
      (_, name: string, first: string, rest: string) =>
        `.${name}${first.toUpperCase()}${rest}`,
    );
  const below = new Set(
    [...provenance]
      .filter(
        ([path]) => path.startsWith(`${key}.`) || path.startsWith(`${key}[`),
      )
      .map(([, name]) => name),
  );
  if (below.size === 1) return [...below][0];
  for (;;) {
    const name = provenance.get(key);
    if (name) return name;
    const cut = Math.max(key.lastIndexOf("."), key.lastIndexOf("["));
    if (cut <= 0) return undefined;
    key = key.slice(0, cut);
  }
}

function validationIssues(
  app: AppDefinition,
  issues: OutcomeIssue[],
  provenance: Map<string, string>,
) {
  const seen = new Set<string>();
  return issues.flatMap((issue): Issue[] => {
    const code = issueCodes.has(issue.code) ? issue.code : "processing";
    const expression = (issue.expression ?? issue.location)?.[0];
    const name = expression && locate(provenance, expression);
    // A fixed config value has no submitted field to name, so it reports its FHIR path.
    const source =
      name &&
      app.fields.find(
        (field) => field.name === name && field.value === undefined,
      );
    if (!source)
      return [
        {
          severity: issue.severity,
          code,
          ...(expression && { expression }),
          message: `${expression ?? "The resource"} ${app.validation.messages.default}`,
        },
      ];
    // The validator can report one bad value at several depths.
    if (seen.has(source.field)) return [];
    seen.add(source.field);
    const messages = app.validation.messages;
    const rule =
      code === "code-invalid"
        ? messages["code-invalid"]
        : code === "required"
          ? messages.required
          : messages.default;
    return [
      {
        severity: issue.severity,
        code,
        expression,
        field: source.field,
        path: source.segments,
        message: `${source.field} ${rule}`,
      },
    ];
  });
}

export async function execute(
  app: AppDefinition,
  input: unknown,
  context: Context,
  transport: Transport = postJson,
): Promise<Result> {
  const orchestrations: Orchestration[] = [];
  const fail = (
    status: number,
    error: string,
    stage: string,
    issues?: Issue[],
  ) =>
    failure(status, error, context, stage, app, {
      issues,
      orchestrations,
      input,
    });
  const call = async (
    stage: string,
    endpoint: { url: string; authorization?: string; timeoutMs: number },
    url: URL,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const entry: Orchestration = {
      name: `${app.id}: ${stage}`,
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
        body,
        timeoutMs: endpoint.timeoutMs,
        headers: {
          ...headers,
          ...(endpoint.authorization && {
            Authorization: endpoint.authorization,
          }),
        },
      });
      entry.response.status = response.status;
      return response;
    } finally {
      entry.response.timestamp = new Date().toISOString();
    }
  };
  const timedOut = (error: unknown) =>
    error instanceof TransportError && error.timeout;

  const { fields, issues } = extract(app, input);
  if (issues.length)
    return fail(400, "request_mapping_failed", "request-mapping", issues);
  const provenance = new Map<string, string>();
  let resource: Record<string, unknown>;
  try {
    resource = build(app, fields, provenance);
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    const source = app.fields.find((field) => field.name === error.field);
    const field = source?.field ?? error.field;
    return fail(400, "request_mapping_failed", "request-mapping", [
      {
        code: error.reason,
        field,
        ...(source && { path: source.segments }),
        message: `${field} ${error.reason === "required" ? "is required" : "is not a supported value"}`,
      },
    ]);
  }

  const stage = "request-validation";
  const url = new URL(app.validation.url);
  if (app.validation.profile)
    url.searchParams.set("profile", app.validation.profile);
  let validation;
  try {
    validation = await call(stage, app.validation, url, resource);
  } catch (error) {
    return timedOut(error)
      ? fail(504, "upstream_timeout", stage)
      : fail(502, "upstream_unavailable", stage);
  }
  const outcome = outcomeSchema.safeParse(validation.body);
  if (validation.status < 200 || validation.status >= 300 || !outcome.success)
    return fail(502, "validator_failed", stage);
  const blocking = outcome.data.issue.filter(
    (issue) =>
      ["fatal", "error"].includes(issue.severity) &&
      !app.validation.ignore.some((text) =>
        [issue.diagnostics, issue.details?.text].some((message) =>
          message?.includes(text),
        ),
      ),
  );
  if (blocking.length)
    return fail(
      422,
      "fhir_validation_failed",
      stage,
      validationIssues(app, blocking, provenance),
    );
  if (!app.delivery) return { status: 200, body: resource, orchestrations };

  // One-way hand-off: a success body is never read, and the request is never retried,
  // because a timed-out request may already have been accepted.
  let delivery;
  try {
    delivery = await call(
      "dispatch",
      app.delivery,
      new URL(app.delivery.url),
      resource,
      { "X-Correlation-ID": context.correlationId },
    );
  } catch (error) {
    return timedOut(error)
      ? fail(504, "dispatch_timeout", "dispatch")
      : fail(502, "dispatch_failed", "dispatch");
  }
  if (!app.delivery.successStatuses.includes(delivery.status)) {
    // The downstream service's own error answer (such as an NHID conflict), unchanged.
    const body = delivery.body;
    if (
      app.delivery.relayErrors &&
      delivery.status >= 400 &&
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body)
    )
      return { status: delivery.status, body, orchestrations };
    return fail(502, "dispatch_failed", "dispatch");
  }
  return {
    status: 202,
    body: acknowledgementBody(app, context, input),
    orchestrations,
  };
}

// Built only from app configuration, the correlation ID, and echo fields; the downstream
// response is never read into it.
function acknowledgementBody(
  app: AppDefinition,
  context: Context,
  input: unknown,
) {
  const message = app.acknowledgement?.message;
  const fallback = {
    status: "accepted",
    ...(message && { message }),
    correlationId: context.correlationId,
  };
  const template = app.acknowledgement?.template;
  if (!template) return fallback;
  const fields = echoFields(app, input);
  fields.set("ack.status", "accepted");
  fields.set("ack.message", message);
  fields.set("ack.correlation_id", context.correlationId);
  try {
    const body = render(template, fields);
    return typeof body === "object" ? body : fallback;
  } catch {
    return fallback;
  }
}
