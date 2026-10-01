import assert from "node:assert/strict";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.js";
import { loadCatalog, parseConfig } from "../src/config.js";
import { execute, type Issue } from "../src/execute.js";
import { postJson, TransportError, type JsonRequest } from "../src/http.js";
import { parseSelector, select } from "../src/mapping/select.js";
import {
  FieldError,
  renderResource,
  templateFields,
} from "../src/mapping/template.js";
import { mediatorDefinition } from "../src/openhim.js";

const configDir = fileURLToPath(new URL("../config", import.meta.url));
const readJson = (file: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"),
  );
const golden = readJson("./fixtures/nagarik-patient.golden.json");
const nagarikInput = readJson("../examples/nagarik-app-registration.json");
const env = {
  VALIDATOR_URL: "http://127.0.0.1:8081/validateResource",
  NHID_REGISTRATION_URL: "http://nhid-generator:9090/generate",
  HAPI_FHIR_CHANNEL_URL: "http://openhim-core:5001/fhir",
  HAPI_FHIR_CHANNEL_AUTHORIZATION: "Basic aGFwaS1zZWNyZXQ=",
};

// Copies the shipped catalog to a temporary directory, then applies test edits to it.
function catalogDir(edit: (dir: string) => void = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "transform-catalog-"));
  cpSync(configDir, dir, { recursive: true });
  edit(dir);
  return dir;
}
const editJson = (dir: string, file: string, change: (value: any) => any) =>
  writeFileSync(
    path.join(dir, file),
    JSON.stringify(
      change(JSON.parse(readFileSync(path.join(dir, file), "utf8"))),
    ),
  );
const apps = loadCatalog({ CONFIG_DIR: catalogDir() }, env).apps;
const app = (id: string) => apps.find((item) => item.id === id)!;
const nagarik = app("nagarik-app-registration-v1");
const normal = app("normal-mapper-v1");
const emr = app("emr-mapper-v1");

const context = { correlationId: "test-request-1" };
const valid = {
  resourceType: "OperationOutcome",
  issue: [{ severity: "information", code: "informational" }],
};
const reply = (body: unknown, status = 200) => ({ status, body });
// Answers the validator with `validation`, then the delivery channel with `delivery`.
function stub(
  delivery: (
    request: JsonRequest,
  ) => Promise<{ status: number; body: unknown }> = async () =>
    reply(null, 202),
  validation: unknown = valid,
) {
  const calls: JsonRequest[] = [];
  const transport = async (request: JsonRequest) => {
    calls.push(request);
    return request.url.startsWith(env.VALIDATOR_URL)
      ? reply(validation)
      : delivery(request);
  };
  return { calls, transport };
}
const withCitizen = (citizen: Record<string, unknown>) => ({
  ...nagarikInput,
  citizen,
});

test("catalog loads the three deployed apps, each with its own delivery", () => {
  const catalog = loadCatalog({ CONFIG_DIR: configDir }, env);
  assert.deepEqual(
    catalog.apps.map((item) => [item.id, item.route, item.delivery?.url]),
    [
      [
        "nagarik-app-registration-v1",
        "/nagarik/registration",
        env.NHID_REGISTRATION_URL,
      ],
      ["normal-mapper-v1", "/transform/patient", undefined],
      ["emr-mapper-v1", "/emr/encounter", env.HAPI_FHIR_CHANNEL_URL],
    ],
  );
  // A channel an app uses must be configured.
  const { HAPI_FHIR_CHANNEL_URL: _url, ...rest } = env;
  assert.throws(() => loadCatalog({ CONFIG_DIR: configDir }, rest));
});

test("catalog rejects invalid app, mapping, channel, path, and endpoint configuration", () => {
  const rejects = (
    edit: (dir: string) => void,
    useEnv: Record<string, string> = env,
  ) =>
    assert.throws(() => loadCatalog({ CONFIG_DIR: catalogDir(edit) }, useEnv));

  rejects((dir) => editJson(dir, "apps.json", (list) => [...list, list[0]]));
  rejects((dir) =>
    editJson(dir, "apps/normal-mapper.v1.json", (value) => ({
      ...value,
      route: "/nagarik/registration",
    })),
  );
  rejects((dir) =>
    editJson(dir, "apps/normal-mapper.v1.json", (value) => ({
      ...value,
      resources: [{ key: "patient", mapping: "patient.np-core.v9" }],
    })),
  );
  rejects((dir) =>
    editJson(dir, "apps/emr-mapper.v1.json", (value) => ({
      ...value,
      delivery: { ...value.delivery, channel: "missing" },
    })),
  );
  rejects((dir) =>
    editJson(dir, "apps.json", (list) => [
      { ...list[0], config: "../../etc/passwd" },
    ]),
  );
  rejects(() => {}, { ...env, VALIDATOR_URL: "file:///etc/passwd" });
  rejects(() => {}, {
    ...env,
    HAPI_FHIR_CHANNEL_URL: "http://user:pass@openhim-core/fhir",
  });
  // A mapping that needs a field the app does not provide.
  rejects((dir) =>
    editJson(dir, "apps/normal-mapper.v1.json", (value) => {
      delete value.input.fields.national_id;
      return value;
    }),
  );
  // An unsupported template directive.
  rejects((dir) =>
    editJson(dir, "mappings/encounter.r4.v1.json", (value) => ({
      ...value,
      template: { ...value.template, status: { $eval: "status" } },
    })),
  );
  // A multi-resource app without a Bundle type.
  rejects((dir) =>
    editJson(dir, "apps/emr-mapper.v1.json", (value) => {
      delete value.bundleType;
      return value;
    }),
  );
  // An error template that reads a patient field.
  rejects((dir) =>
    editJson(dir, "apps/nagarik-registration.v1.json", (value) => ({
      ...value,
      errors: { ...value.errors, template: { id: { $field: "national_id" } } },
    })),
  );
});

test("selector: different source paths produce the same canonical value", () => {
  assert.equal(
    select(
      { citizen: { nameEn: { family: "Shrestha" } } },
      "$.citizen.nameEn.family",
    ),
    "Shrestha",
  );
  assert.equal(
    select(
      { patients: [{ last_name: "Shrestha" }] },
      "$.patients[0].last_name",
    ),
    "Shrestha",
  );
  assert.equal(select({ patients: [] }, "$.patients[0].last_name"), undefined);
  assert.equal(select({}, "$.constructor"), undefined);
  for (const bad of [
    "$.a.*",
    "$..a",
    "$.a[?(@.b)]",
    "$.a.length()",
    "a.b",
    "$['a']",
  ])
    assert.throws(() => parseSelector(bad), bad);
});

test("template: literal, field, lookup, conditional omission, and interpolation", () => {
  const mapping = {
    id: "example.v1",
    resourceType: "Example",
    fields: {},
    template: {
      resourceType: "Example",
      literal: { $literal: { $field: "not-a-directive" } },
      name: { $field: "name" },
      gender: { $lookup: "sex", map: { M: "male" } },
      phone: { $if: "phone", then: { value: { $field: "phone" } } },
      list: [{ $if: "phone", then: 1 }, 2],
      line: { $format: "Ward {ward}" },
    },
  };
  const fields = new Map<string, unknown>([
    ["name", "A"],
    ["sex", "M"],
    ["ward", 10],
  ]);
  assert.deepEqual(renderResource(mapping, fields), {
    resourceType: "Example",
    literal: { $field: "not-a-directive" },
    name: "A",
    gender: "male",
    list: [2],
    line: "Ward 10",
  });
  assert.deepEqual([...templateFields(mapping.template)].sort(), [
    "name",
    "phone",
    "sex",
    "ward",
  ]);
  assert.throws(
    () =>
      renderResource(
        mapping,
        new Map([
          ["sex", "M"],
          ["ward", 1],
        ]),
      ),
    (error) => error instanceof FieldError && error.field === "name",
  );
  assert.throws(
    () => renderResource(mapping, new Map([...fields, ["sex", "X"]])),
    (error) => error instanceof FieldError && error.reason === "invalid",
  );
});

test("Nagarik request creates the legacy NP Core Patient, dispatches it, and is accepted", async () => {
  const { calls, transport } = stub();
  const result = await execute(nagarik, nagarikInput, context, transport);

  assert.equal(result.status, 202);
  // A user-facing message from config; nothing from the downstream reply.
  assert.deepEqual(result.body, {
    requestId: nagarikInput.requestId,
    source: "nagarik-app",
    status: true,
    code: "accepted",
    message: "Your registration has been received and is being processed.",
    correlationId: context.correlationId,
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      `${env.VALIDATOR_URL}?profile=${encodeURIComponent("http://fhir.digitalhealth.gov.np/core/StructureDefinition/np-core-patient")}`,
      env.NHID_REGISTRATION_URL,
    ],
  );
  assert.deepEqual(calls[0].body, golden.full);
  assert.deepEqual(calls[1].body, golden.full);
  assert.equal(calls[1].headers?.["X-Correlation-ID"], context.correlationId);
  // The NHID channel declares no authorization.
  assert.equal(calls[1].headers?.Authorization, undefined);
  assert.deepEqual(
    result.orchestrations.map((entry) => [entry.name, entry.response.status]),
    [
      ["nagarik-app-registration-v1: request-validation", 200],
      ["nagarik-app-registration-v1: dispatch", 202],
    ],
  );
});

test("Nagarik omits every absent optional field instead of serializing null", async () => {
  const { calls, transport } = stub();
  const {
    citizenshipNumber: _a,
    healthInsuranceNumber: _b,
    nameNe: _c,
    dobBS: _d,
    casteEthnicityCode: _e,
    mobile: _f,
    email: _g,
    permanentAddress: _h,
    ...minimal
  } = nagarikInput.citizen;
  const result = await execute(
    nagarik,
    withCitizen(minimal),
    context,
    transport,
  );
  assert.equal(result.status, 202);
  assert.deepEqual(calls[0].body, golden.minimal);
  assert.doesNotMatch(JSON.stringify(calls[0].body), /null|undefined/);
});

test("dispatch: only a configured status is accepted, and nothing is retried", async () => {
  // EMR does not relay errors, so a downstream body never reaches the caller.
  const emrInput = readJson("../examples/emr-encounter.json");
  for (const status of [204, 409, 503]) {
    const { calls, transport } = stub(async () =>
      reply({ secret: "downstream body" }, status),
    );
    const result = await execute(emr, emrInput, context, transport);
    assert.equal(result.status, 502);
    assert.equal((result.body as { error: string }).error, "dispatch_failed");
    assert.equal(calls.length, 2, "no retry");
    assert.doesNotMatch(JSON.stringify(result.body), /downstream body/);
  }
  const timeout = stub(async () => {
    throw new TransportError(true);
  });
  const result = await execute(
    nagarik,
    nagarikInput,
    context,
    timeout.transport,
  );
  assert.equal(result.status, 504);
  assert.equal((result.body as { code: string }).code, "dispatch_timeout");
  assert.equal(timeout.calls.length, 2, "no retry");
});

test("transport: only a request that reached the server can time out", async () => {
  // Accepts the connection but never answers: the server may have the request.
  const silent = createServer(() => {});
  silent.listen(0, "127.0.0.1");
  await once(silent, "listening");
  const port = (silent.address() as { port: number }).port;
  const outcome = (url: string) =>
    postJson({ url, body: {}, timeoutMs: 300 }).then(
      () => "answered",
      (error: TransportError) => error.timeout,
    );
  try {
    assert.equal(await outcome(`http://127.0.0.1:${port}/`), true);
  } finally {
    silent.closeAllConnections();
    silent.close();
  }
  // Nothing listening any more: refused before anything was sent.
  assert.equal(await outcome(`http://127.0.0.1:${port}/`), false);
});

test("Nagarik relays the NHID service's JSON error as it is", async () => {
  const nhidError = {
    status: false,
    message:
      "NID already exists but the provided data does not match the existing record",
  };
  const result = await execute(
    nagarik,
    nagarikInput,
    context,
    stub(async () => reply(nhidError, 409)).transport,
  );
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, nhidError);

  // A non-JSON error or a 2xx outside successStatuses gets the mediator's own message.
  for (const [status, body] of [
    [503, null],
    [204, { status: false, message: "x" }],
  ] as const) {
    const fallback = await execute(
      nagarik,
      nagarikInput,
      context,
      stub(async () => reply(body, status)).transport,
    );
    assert.equal(fallback.status, 502);
    assert.equal((fallback.body as { code: string }).code, "dispatch_failed");
  }
});

test("Nagarik mapping errors name each field and its rule without echoing values", async () => {
  const { email: _email, ...citizen } = nagarikInput.citizen;
  const result = await execute(
    nagarik,
    withCitizen({
      ...citizen,
      mobile: "98-5550-111",
      nationalId: undefined,
      extra: "x",
    }),
    context,
    async () => assert.fail("validator must not be called"),
  );

  assert.equal(result.status, 400);
  const body = result.body as {
    requestId: string;
    code: string;
    message: string;
    field: string;
    path: unknown;
    issues: Array<Record<string, unknown>>;
  };
  assert.equal(body.requestId, nagarikInput.requestId);
  assert.equal(body.code, "request_mapping_failed");
  assert.equal(body.field, "citizen.nationalId");
  assert.deepEqual(body.path, ["citizen", "nationalId"]);
  assert.match(
    body.message,
    /^citizen\.nationalId is required; citizen\.mobile/,
  );
  assert.deepEqual(
    body.issues.map(({ field, message }) => ({ field, message })),
    [
      {
        field: "citizen.nationalId",
        message: "citizen.nationalId is required",
      },
      {
        field: "citizen.mobile",
        message:
          "citizen.mobile must be +977 followed by 10 digits, for example +9779801234567",
      },
      { field: "citizen", message: "citizen has unknown field(s): extra" },
    ],
  );
  assert.ok(!JSON.stringify(result.body).includes("5550"));
});

test("missing required canonical data is a mapping-stage error", async () => {
  const { given: _given, ...nameNe } = nagarikInput.citizen.nameNe;
  const result = await execute(
    nagarik,
    withCitizen({ ...nagarikInput.citizen, nameNe }),
    context,
    async () => assert.fail("validator must not be called"),
  );
  assert.equal(result.status, 400);
  assert.deepEqual(
    [
      (result.body as { code: string }).code,
      (result.body as { field: string }).field,
      (result.body as { message: string }).message,
    ],
    [
      "request_mapping_failed",
      "citizen.nameNe.given",
      "citizen.nameNe.given is required",
    ],
  );
});

test("Nagarik accepts Bikram Sambat days up to 32 and rejects impossible ones", async () => {
  const withBS = (dobBS: string) =>
    withCitizen({ ...nagarikInput.citizen, dobBS });
  for (const dobBS of ["2047-02-32", "2047-03-31", "2047-12-30"])
    assert.equal(
      (await execute(nagarik, withBS(dobBS), context, stub().transport)).status,
      202,
      dobBS,
    );
  for (const dobBS of ["2047-02-33", "2047-13-01", "2047-00-10", "2047-2-1"])
    assert.equal(
      (await execute(nagarik, withBS(dobBS), context, stub().transport)).status,
      400,
      dobBS,
    );
});

test("Nagarik validation errors name the submitted field without validator text", async () => {
  // Without a citizenship number the health insurance identifier moves to index 1.
  const { citizenshipNumber: _citizenship, ...citizen } = nagarikInput.citizen;
  const { calls, transport } = stub(undefined, {
    resourceType: "OperationOutcome",
    issue: [
      {
        severity: "error",
        code: "structure",
        details: {
          text: "Slice 'Patient.identifier:healthId': a matching slice is required, but not found (from np-core-patient)",
        },
        expression: ["Patient"],
      },
      {
        severity: "error",
        code: "code-invalid",
        details: { text: "Unknown code '306' in the CodeSystem" },
        expression: [
          "Patient.address[0].extension[1].value.ofType(Coding).code",
        ],
      },
      {
        // The real validator reports the same bad code again one level up.
        severity: "error",
        code: "code-invalid",
        details: { text: "The Coding provided was not found" },
        expression: ["Patient.address[0].extension[1].value.ofType(Coding)"],
      },
      {
        severity: "error",
        code: "value",
        details: { text: "Bad identifier HIB-000123456" },
        expression: ["Patient.identifier[1].value"],
      },
      {
        severity: "error",
        code: "invariant",
        details: { text: "Profile rule failed" },
        expression: ["Patient"],
      },
      {
        severity: "warning",
        code: "invariant",
        details: { text: "Best practice warning" },
        expression: ["Patient"],
      },
    ],
  });
  const result = await execute(
    nagarik,
    withCitizen(citizen),
    context,
    transport,
  );

  assert.equal(result.status, 422);
  assert.equal(calls.length, 1, "invalid FHIR is not dispatched");
  assert.deepEqual(result.body, {
    requestId: nagarikInput.requestId,
    source: "nagarik-app",
    status: false,
    message:
      "citizen.permanentAddress.districtCode is not a valid NP Core code; " +
      "citizen.healthInsuranceNumber failed NP Core validation; " +
      "Patient failed NP Core validation",
    code: "fhir_validation_failed",
    field: "citizen.permanentAddress.districtCode",
    path: ["citizen", "permanentAddress", "districtCode"],
    issues: [
      {
        severity: "error",
        code: "code-invalid",
        expression: "Patient.address[0].extension[1].value.ofType(Coding).code",
        field: "citizen.permanentAddress.districtCode",
        path: ["citizen", "permanentAddress", "districtCode"],
        message:
          "citizen.permanentAddress.districtCode is not a valid NP Core code",
      },
      {
        severity: "error",
        code: "value",
        expression: "Patient.identifier[1].value",
        field: "citizen.healthInsuranceNumber",
        path: ["citizen", "healthInsuranceNumber"],
        message: "citizen.healthInsuranceNumber failed NP Core validation",
      },
      {
        severity: "error",
        code: "invariant",
        expression: "Patient",
        message: "Patient failed NP Core validation",
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result.body), /306'|HIB-000123456/);
});

test("Bundle validation issues use annotated paths; fixed config values are not fields", async () => {
  const issue = (expression: string) => ({
    severity: "error",
    code: "invalid",
    expression: [expression],
  });
  const { transport } = stub(undefined, {
    resourceType: "OperationOutcome",
    issue: [
      // The real validator writes Bundle paths with a /*Type/id*/ comment.
      issue("Bundle.entry[0].resource/*Patient/null*/.name[0].family"),
      issue("Bundle.entry[1].resource/*Encounter/null*/.identifier[0].system"),
    ],
  });
  const result = await execute(
    emr,
    readJson("../examples/emr-encounter.json"),
    context,
    transport,
  );
  assert.equal(result.status, 422);
  const [family, system] = (result.body as { issues: Issue[] }).issues;
  assert.equal(family.field, "patients.0.last_name");
  assert.equal(system.field, undefined);
  assert.match(system.message, /^Bundle\.entry\[1\]\.resource.*failed/);
});

test("validator outages are mediator errors and nothing is dispatched", async () => {
  for (const [error, status, code] of [
    [new TransportError(false), 502, "upstream_unavailable"],
    [new TransportError(true), 504, "upstream_timeout"],
  ] as const) {
    let calls = 0;
    const result = await execute(nagarik, nagarikInput, context, async () => {
      calls++;
      throw error;
    });
    assert.equal(result.status, status);
    assert.equal((result.body as { code: string }).code, code);
    assert.equal(calls, 1);
  }
});

test("normal mapper returns validated FHIR without dispatch", async () => {
  const { calls, transport } = stub(async () => assert.fail("no delivery"));
  const result = await execute(
    normal,
    {
      national_id: "00123",
      given_name: "Sita",
      family_name: "Rai",
      gender: "female",
      birth_date: "2000-02-29",
    },
    context,
    transport,
  );
  assert.equal(result.status, 200);
  const patient = result.body as Record<string, unknown>;
  assert.equal(patient.resourceType, "Patient");
  assert.equal(patient.gender, "female");
  assert.deepEqual(patient.name, [
    { use: "official", family: "Rai", given: ["Sita"] },
  ]);
  assert.ok(!("telecom" in patient) && !("address" in patient));
  assert.equal(calls.length, 1);
});

test("EMR selector app builds one transaction Bundle with internal references", async () => {
  const { calls, transport } = stub(async () => reply(null, 200));
  const result = await execute(
    emr,
    {
      patients: [
        {
          national_id: "00123",
          first_name: "Ram",
          last_name: "Shrestha",
          sex: "M",
          dob: "1990-05-15",
        },
      ],
      encounters: [
        {
          id: "0007",
          status: "finished",
          class: "AMB",
          start: "2026-09-14T10:00:00+05:45",
        },
      ],
    },
    context,
    transport,
  );
  assert.equal(result.status, 202);
  // Without an acknowledgement template the default shape carries the configured message.
  assert.deepEqual(result.body, {
    status: "accepted",
    message:
      "The patient and encounter have been received and are being processed.",
    correlationId: context.correlationId,
  });
  const bundle = calls[1].body as {
    resourceType: string;
    type: string;
    entry: Array<{
      fullUrl: string;
      resource: Record<string, any>;
      request: unknown;
    }>;
  };
  assert.deepEqual(calls[0].body, bundle, "the validated Bundle is dispatched");
  assert.equal(calls[1].url, env.HAPI_FHIR_CHANNEL_URL);
  assert.equal(
    calls[1].headers?.Authorization,
    env.HAPI_FHIR_CHANNEL_AUTHORIZATION,
  );
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.type, "transaction");
  const [patient, encounter] = bundle.entry;
  assert.equal(patient.resource.name[0].family, "Shrestha");
  assert.match(patient.fullUrl, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(encounter.resource.subject.reference, patient.fullUrl);
  assert.deepEqual(encounter.resource.identifier, [
    { system: "http://emr.hie.local/encounter-id", value: "0007" },
  ]);
  assert.deepEqual(
    bundle.entry.map((entry) => entry.request),
    [
      { method: "POST", url: "Patient" },
      { method: "POST", url: "Encounter" },
    ],
  );
});

test("OpenHIM registration creates one channel per app without endpoint secrets", () => {
  const definition = mediatorDefinition(
    parseConfig({ OPENHIM_REGISTER: "false" }),
    apps,
  );
  const channels = definition.defaultChannelConfig;
  assert.deepEqual(
    channels.map((channel) => [
      channel.name,
      channel.urlPattern,
      channel.allow,
    ]),
    [
      [
        "FHIR Middleware: nagarik-app-registration-v1",
        "^/nagarik/registration/?$",
        ["national-app-clients"],
      ],
      [
        "FHIR Middleware: normal-mapper-v1",
        "^/transform/patient/?$",
        ["transform-clients"],
      ],
      ["FHIR Middleware: emr-mapper-v1", "^/emr/encounter/?$", ["emr-clients"]],
    ],
  );
  // Validation plus dispatch acceptance only; no downstream processing time.
  assert.deepEqual(
    channels.map((channel) => channel.timeout),
    [30000, 20000, 35000],
  );
  const serialized = JSON.stringify(definition);
  for (const value of Object.values(env))
    assert.ok(!serialized.includes(value), value);
});

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("OpenHIM envelope carries the acknowledgement and the app's error format", async () => {
  const server = createServer(
    createApp(
      parseConfig({ OPENHIM_REGISTER: "false" }),
      apps,
      stub().transport,
    ),
  );
  const url = await listen(server);
  try {
    const accepted = await fetch(`${url}/nagarik/registration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nagarikInput),
    });
    assert.equal(accepted.status, 202);
    const envelope = await accepted.json();
    const body = JSON.parse(envelope.response.body);
    assert.equal(body.code, "accepted");
    assert.equal(
      body.correlationId,
      envelope.response.headers["X-Correlation-ID"],
    );
    assert.equal(
      envelope.properties.integration,
      "nagarik-app-registration-v1",
    );
    assert.equal(envelope.properties.mapping, "patient.np-core.v1");

    const rejected = await fetch(`${url}/nagarik/registration`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    assert.equal(rejected.status, 415);
    const error = JSON.parse((await rejected.json()).response.body);
    assert.equal(error.code, "unsupported_content_type");
    assert.equal(error.source, "nagarik-app");
    assert.doesNotMatch(
      JSON.stringify(error),
      new RegExp(env.HAPI_FHIR_CHANNEL_AUTHORIZATION),
    );
  } finally {
    await close(server);
  }
});
