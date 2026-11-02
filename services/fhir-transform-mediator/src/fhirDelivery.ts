import type { AppDefinition } from "./config.js";
import {
  caller,
  failure,
  prepare,
  timedOut,
  type Call,
  type Context,
  type Orchestration,
  type Result,
} from "./execute.js";
import { postJson, type Transport } from "./http.js";

// Delivery to a FHIR server (`delivery.mode: "fhir"`), for apps whose clients write
// clinical data: the client's own token travels on, so HAPI applies that client's
// scopes and facility rules. Every Patient goes to the identity mediator first.

type Json = Record<string, unknown>;
type Entry = {
  fullUrl?: string;
  resource?: Json;
  request?: { method?: string; url?: string; ifNoneExist?: string };
  response?: Json;
};
type Bundle = { resourceType: "Bundle"; type?: string; entry?: Entry[] };

const FHIR = "application/fhir+json";
const outcome = (code: string, diagnostics: string) => ({
  resourceType: "OperationOutcome",
  issue: [{ severity: "error", code, diagnostics }],
});
const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Run fn over items, at most `limit` at a time, keeping order.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// A mediator reached directly (not through OpenHIM) answers in the OpenHIM envelope.
function unwrap(body: unknown): unknown {
  if (isObject(body) && "x-mediator-urn" in body && isObject(body.response)) {
    const inner = body.response.body;
    try {
      return typeof inner === "string" ? JSON.parse(inner) : inner;
    } catch {
      return null;
    }
  }
  return body;
}

// Replace every reference to `from` (a fullUrl) with `to`, anywhere in the resource.
function repoint(node: unknown, from: string, to: string) {
  if (Array.isArray(node)) node.forEach((item) => repoint(item, from, to));
  else if (isObject(node))
    for (const [key, value] of Object.entries(node)) {
      if (key === "reference" && value === from) node[key] = to;
      else repoint(value, from, to);
    }
}

// Two rows for one person must not register them concurrently. The key is the
// person's identifiers as sent.
function personKey(patient: Json) {
  const ids = Array.isArray(patient.identifier) ? patient.identifier : [];
  return ids
    .filter(isObject)
    .map((id) => `${id.system}|${id.value}`)
    .sort()
    .join(",");
}

type Registered =
  | { ok: true; reference: string; status: number; patient: Json }
  | { ok: false; status: number; body: unknown };

function registrar(app: AppDefinition, context: Context, call: Call) {
  const locks = new Map<string, Promise<unknown>>();
  return async (patient: Json): Promise<Registered> => {
    const key = personKey(patient);
    const previous = (key && locks.get(key)) || Promise.resolve();
    const run = previous.then(async (): Promise<Registered> => {
      const endpoint = app.identity!;
      let response;
      try {
        response = await call(
          "identity",
          endpoint,
          new URL(endpoint.url),
          patient,
          {
            Authorization: context.caller!.authorization,
            "X-Correlation-ID": context.correlationId,
          },
        );
      } catch (error) {
        return {
          ok: false,
          status: timedOut(error) ? 504 : 502,
          body: outcome(
            "exception",
            "The identity service could not be reached",
          ),
        };
      }
      const body = unwrap(response.body);
      if (
        response.status >= 200 &&
        response.status < 300 &&
        isObject(body) &&
        typeof body.id === "string"
      ) {
        return {
          ok: true,
          reference: `Patient/${body.id}`,
          status: response.status,
          patient: body,
        };
      }
      return {
        ok: false,
        status: response.status >= 400 ? response.status : 502,
        body:
          isObject(body) && body.resourceType === "OperationOutcome"
            ? body
            : outcome("exception", "Patient registration failed"),
      };
    });
    if (key)
      locks.set(
        key,
        run.catch(() => {}),
      );
    return run;
  };
}

async function postToFhir(
  app: AppDefinition,
  context: Context,
  call: Call,
  bundle: Bundle,
) {
  const delivery = app.delivery!;
  try {
    const response = await call(
      "dispatch",
      delivery,
      new URL(delivery.url),
      bundle,
      {
        ...(delivery.forwardToken && {
          Authorization: context.caller!.authorization,
        }),
        "X-Correlation-ID": context.correlationId,
      },
    );
    return { status: response.status, body: response.body };
  } catch (error) {
    return {
      status: timedOut(error) ? 504 : 502,
      body: outcome(
        timedOut(error) ? "timeout" : "exception",
        "The FHIR server could not be reached",
      ),
    };
  }
}

const statusLine = (status: number) =>
  `${status} ${status === 201 ? "Created" : status === 200 ? "OK" : ""}`.trim();

/**
 * Register the Bundle's Patients with the identity mediator, point references at the
 * stored Patients, and send the remaining entries to the FHIR server as one Bundle of
 * the same type. Returns a `<type>-response` Bundle in the request's entry order.
 */
async function deliverBundle(
  app: AppDefinition,
  context: Context,
  call: Call,
  bundle: Bundle,
  register: ReturnType<typeof registrar>,
) {
  const entries = bundle.entry ?? [];
  const type = bundle.type === "batch" ? "batch" : "transaction";
  const patientResults = new Map<number, Registered>();
  for (const [index, entry] of entries.entries()) {
    if (entry.resource?.resourceType !== "Patient" || !app.identity) continue;
    const registered = await register(entry.resource);
    patientResults.set(index, registered);
    // All or nothing: a transaction stops at the first Patient that cannot be registered.
    if (!registered.ok && type === "transaction")
      return { status: registered.status, body: registered.body };
    if (registered.ok && entry.fullUrl) {
      for (const other of entries)
        if (other !== entry)
          repoint(other.resource, entry.fullUrl, registered.reference);
    }
  }

  const rest = entries.filter((_, index) => !patientResults.has(index));
  let delivered: Entry[] = [];
  if (rest.length) {
    const { status, body } = await postToFhir(app, context, call, {
      resourceType: "Bundle",
      type,
      entry: rest,
    });
    if (
      status < 200 ||
      status >= 300 ||
      !isObject(body) ||
      !Array.isArray(body.entry)
    ) {
      return {
        status: status >= 400 ? status : 502,
        body: isObject(body)
          ? body
          : outcome("exception", "The FHIR server failed"),
      };
    }
    delivered = body.entry as Entry[];
  }

  let next = 0;
  const response: Bundle = {
    resourceType: "Bundle",
    type: `${type}-response`,
    entry: entries.map((_, index) => {
      const registered = patientResults.get(index);
      if (!registered) return delivered[next++] ?? {};
      return registered.ok
        ? {
            response: {
              status: statusLine(registered.status),
              location: `${registered.reference}/_history/${(registered.patient.meta as Json | undefined)?.versionId ?? "1"}`,
            },
          }
        : {
            response: {
              status: String(registered.status),
              outcome: registered.body,
            },
          };
    }),
  };
  return { status: 200, body: response };
}

/** One record (fields input) or one Bundle (fhir input). */
async function deliverOne(
  app: AppDefinition,
  input: unknown,
  context: Context,
  call: Call,
  orchestrations: Orchestration[],
  register: ReturnType<typeof registrar>,
) {
  if (app.format === "fhir") {
    const bundle = input as Bundle;
    if (
      !isObject(input) ||
      bundle.resourceType !== "Bundle" ||
      !["batch", "transaction"].includes(String(bundle.type)) ||
      !Array.isArray(bundle.entry)
    ) {
      return {
        status: 400,
        body: outcome(
          "invalid",
          "Expected a FHIR Bundle of type batch or transaction",
        ),
      };
    }
  }
  const prepared = await prepare(app, input, context, call, orchestrations);
  if ("result" in prepared)
    return { status: prepared.result.status, body: prepared.result.body };
  const resource = prepared.resource;
  const bundle: Bundle =
    resource.resourceType === "Bundle"
      ? (resource as Bundle)
      : {
          resourceType: "Bundle",
          type: "transaction",
          entry: [
            {
              resource,
              request: { method: "POST", url: String(resource.resourceType) },
            },
          ],
        };
  return deliverBundle(app, context, call, bundle, register);
}

export async function executeFhir(
  app: AppDefinition,
  input: unknown,
  context: Context,
  transport: Transport = postJson,
): Promise<Result> {
  const orchestrations: Orchestration[] = [];
  const call = caller(app, orchestrations, transport);
  const register = registrar(app, context, call);

  if (!app.rows) {
    const { status, body } = await deliverOne(
      app,
      input,
      context,
      call,
      orchestrations,
      register,
    );
    return { status, body, orchestrations, contentType: FHIR };
  }

  // Rows: each is mapped, validated and written on its own (one transaction per row),
  // so one bad row fails alone and the client resends only that row.
  const rows = Array.isArray(input) ? input : [input];
  if (!rows.length || rows.length > app.rows.max) {
    return failure(
      400,
      "request_mapping_failed",
      context,
      "request-mapping",
      app,
      {
        issues: [
          {
            code: "invalid",
            message: `Send between 1 and ${app.rows.max} records`,
          },
        ],
        orchestrations,
      },
    );
  }
  const results = await mapLimit(rows, 5, async (row, index) => {
    const { status, body } = await deliverOne(
      app,
      row,
      context,
      call,
      orchestrations,
      register,
    );
    return {
      index,
      status,
      ...(status >= 200 && status < 300 ? { response: body } : { error: body }),
    };
  });
  return {
    status: 200,
    body: { correlationId: context.correlationId, results },
    orchestrations,
  };
}
