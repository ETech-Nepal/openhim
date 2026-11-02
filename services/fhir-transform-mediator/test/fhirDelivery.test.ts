import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadCatalog, parseConfig } from "../src/config.js";
import { executeFhir } from "../src/fhirDelivery.js";
import { createApp } from "../src/app.js";
import type { JsonRequest } from "../src/http.js";

const env = {
  VALIDATOR_URL: "http://127.0.0.1:8081/validateResource",
  NHID_REGISTRATION_URL: "http://nhid-generator:9090/generate",
  HAPI_FHIR_CHANNEL_URL: "http://openhim-core:5001/fhir",
  HAPI_FHIR_CHANNEL_AUTHORIZATION: "Basic aGFwaS1zZWNyZXQ=",
  IDENTITY_PATIENT_URL: "http://identity-mediator:4002/fhir/Patient",
  HAPI_FHIR_URL: "http://fhir:8080/fhir",
  KEYCLOAK_ISSUER: "http://keycloak.test/realms/openhie",
  KEYCLOAK_JWKS_URI: "http://keycloak:8080/certs",
};
const configDir = fileURLToPath(new URL("../config", import.meta.url));
const apps = loadCatalog({ CONFIG_DIR: configDir }, env).apps;
const cdrs = apps.find((a) => a.id === "cdrs-v1")!;
const bundleApp = apps.find((a) => a.id === "fhir-bundle-v1")!;
const context = () => ({
  correlationId: "c-1",
  caller: { clientId: "1001", authorization: "DPoP hospital-token" },
});
const MRN = "http://mohp.gov.np/fhir/NamingSystem/hospital-mrn";

// Validator: valid. Identity: answers in the OpenHIM envelope, one Patient id per MRN.
// HAPI: a response entry per request entry.
function stub({ identityStatus = 201, hapiStatus = 200 } = {}) {
  const calls: JsonRequest[] = [];
  const ids = new Map<string, string>();
  const transport = async (request: JsonRequest) => {
    calls.push(structuredClone(request));
    if (request.url.startsWith(env.VALIDATOR_URL))
      return {
        status: 200,
        body: {
          resourceType: "OperationOutcome",
          issue: [{ severity: "information", code: "informational" }],
        },
      };
    if (request.url === env.IDENTITY_PATIENT_URL) {
      const patient = request.body as {
        identifier: { system: string; value: string }[];
      };
      const key = JSON.stringify(patient.identifier);
      if (!ids.has(key)) ids.set(key, `pat-${ids.size + 1}`);
      const body =
        identityStatus < 300
          ? { ...patient, id: ids.get(key), meta: { versionId: "1" } }
          : {
              resourceType: "OperationOutcome",
              issue: [
                {
                  severity: "error",
                  code: "conflict",
                  diagnostics: "Health ID conflict",
                },
              ],
            };
      return {
        status: identityStatus,
        body: {
          "x-mediator-urn": "urn:identity",
          response: { status: identityStatus, body: JSON.stringify(body) },
        },
      };
    }
    if (request.url === env.HAPI_FHIR_URL) {
      const bundle = request.body as {
        type: string;
        entry: { resource: { resourceType: string } }[];
      };
      if (hapiStatus >= 400)
        return {
          status: hapiStatus,
          body: {
            resourceType: "OperationOutcome",
            issue: [
              {
                severity: "error",
                code: "forbidden",
                diagnostics: "not yours",
              },
            ],
          },
        };
      return {
        status: 200,
        body: {
          resourceType: "Bundle",
          type: `${bundle.type}-response`,
          entry: bundle.entry.map((e, i) => ({
            response: {
              status: "201 Created",
              location: `${e.resource.resourceType}/r${i}/_history/1`,
            },
          })),
        },
      };
    }
    throw new Error(`unexpected ${request.url}`);
  };
  return { calls, transport };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  hospital_patient_number: 2405078,
  encounter_number: "E-1",
  first_name: " CHANDRIKA ",
  last_name: "KANDEL",
  sex: "Female",
  dob: "1990-01-15",
  phone_number: "9841000001",
  imis_id: "0",
  department_type: "C",
  department_id: "22",
  department_name: "Family Medicine",
  visit_date_ad_time: "2026-07-28 00:02:00.000",
  registration_number: "None",
  ...overrides,
});

test("CDRS rows: each row registers its Patient, then writes its Encounter with the client's token", async () => {
  const { calls, transport } = stub();
  const result = await executeFhir(
    cdrs,
    [row(), row({ encounter_number: "E-2" })],
    context(),
    transport,
  );
  assert.equal(result.status, 200);
  const results = (
    result.body as { results: { index: number; status: number }[] }
  ).results;
  assert.deepEqual(
    results.map((r) => [r.index, r.status]),
    [
      [0, 200],
      [1, 200],
    ],
  );

  const identity = calls.filter((c) => c.url === env.IDENTITY_PATIENT_URL);
  assert.equal(identity.length, 2);
  assert.equal(identity[0].headers?.Authorization, "DPoP hospital-token");
  const patient = identity[0].body as Record<string, any>;
  assert.deepEqual(patient.identifier, [
    {
      use: "usual",
      type: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v2-0203",
            code: "MR",
          },
        ],
      },
      system: `${MRN}/1001`,
      value: "2405078",
    },
  ]);
  assert.equal(patient.gender, "female");
  assert.deepEqual(patient.name, [
    { use: "official", family: "KANDEL", given: ["CHANDRIKA"] },
  ]);

  const writes = calls.filter((c) => c.url === env.HAPI_FHIR_URL);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].headers?.Authorization, "DPoP hospital-token");
  const bundle = writes[0].body as Record<string, any>;
  assert.equal(bundle.type, "transaction");
  assert.equal(bundle.entry.length, 1, "the Patient is not delivered to HAPI");
  const encounter = bundle.entry[0].resource;
  assert.equal(encounter.subject.reference, "Patient/pat-1");
  assert.deepEqual(encounter.identifier, [
    {
      use: "official",
      system: "http://nhfr.digitalhealth.gov.np/1001",
      value: "E-1",
    },
  ]);
  assert.equal(encounter.period.start, "2026-07-28T00:02:00.000+05:45");
  assert.equal(encounter.class.code, "AMB");
  assert.equal(
    bundle.entry[0].request.ifNoneExist,
    "identifier=http://nhfr.digitalhealth.gov.np/1001|E-1",
  );
});

test("CDRS: a bad row fails alone; too many rows is refused", async () => {
  const { calls, transport } = stub();
  const result = await executeFhir(
    cdrs,
    [row(), row({ visit_date_ad_time: "2026-02-30 10:00:00.000", sex: "x" })],
    context(),
    transport,
  );
  const results = (
    result.body as { results: { status: number; error?: any }[] }
  ).results;
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 400],
  );
  assert.deepEqual(
    results[1].error.issues.map((i: { field: string }) => i.field).sort(),
    ["sex", "visit_date_ad_time"],
  );
  assert.equal(calls.filter((c) => c.url === env.HAPI_FHIR_URL).length, 1);

  const many = await executeFhir(
    cdrs,
    Array.from({ length: 101 }, () => row()),
    context(),
    stub().transport,
  );
  assert.equal(many.status, 400);
});

test("FHIR Bundle: Patients go to identity, references are repointed, entry order is kept", async () => {
  const { calls, transport } = stub();
  const input = {
    resourceType: "Bundle",
    type: "batch",
    entry: [
      {
        fullUrl: "urn:uuid:p",
        resource: {
          resourceType: "Patient",
          identifier: [{ system: `${MRN}/1001`, value: "M1" }],
        },
        request: { method: "POST", url: "Patient" },
      },
      {
        resource: {
          resourceType: "Encounter",
          subject: { reference: "urn:uuid:p" },
        },
        request: { method: "POST", url: "Encounter" },
      },
    ],
  };
  const result = await executeFhir(bundleApp, input, context(), transport);
  assert.equal(result.status, 200);
  assert.equal(result.contentType, "application/fhir+json");
  const sent = calls.find((c) => c.url === env.HAPI_FHIR_URL)!.body as Record<
    string,
    any
  >;
  assert.equal(sent.type, "batch");
  assert.deepEqual(
    sent.entry.map((e: any) => e.resource.resourceType),
    ["Encounter"],
  );
  assert.equal(sent.entry[0].resource.subject.reference, "Patient/pat-1");
  const body = result.body as Record<string, any>;
  assert.equal(body.type, "batch-response");
  assert.deepEqual(
    body.entry.map((e: any) => e.response.location),
    ["Patient/pat-1/_history/1", "Encounter/r0/_history/1"],
  );
});

test("FHIR Bundle: a refused Patient stops a transaction; HAPI errors are relayed", async () => {
  const tx = {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        fullUrl: "urn:uuid:p",
        resource: { resourceType: "Patient" },
        request: { method: "POST", url: "Patient" },
      },
      {
        resource: {
          resourceType: "Encounter",
          subject: { reference: "urn:uuid:p" },
        },
        request: { method: "POST", url: "Encounter" },
      },
    ],
  };
  const refused = stub({ identityStatus: 409 });
  const r1 = await executeFhir(bundleApp, tx, context(), refused.transport);
  assert.equal(r1.status, 409);
  assert.equal((r1.body as any).issue[0].diagnostics, "Health ID conflict");
  assert.equal(
    refused.calls.some((c) => c.url === env.HAPI_FHIR_URL),
    false,
  );

  const r2 = await executeFhir(
    bundleApp,
    tx,
    context(),
    stub({ hapiStatus: 403 }).transport,
  );
  assert.equal(r2.status, 403);
  assert.equal((r2.body as any).issue[0].code, "forbidden");

  const r3 = await executeFhir(
    bundleApp,
    { resourceType: "Patient" },
    context(),
    stub().transport,
  );
  assert.equal(r3.status, 400);
});

test("apps with auth refuse a request without a valid token", async () => {
  const config = parseConfig({ OPENHIM_REGISTER: "false", ...env });
  const server = createApp(config, apps, stub().transport, async (header) =>
    header === "DPoP good" ? { clientId: "1001", authorization: header } : null,
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  try {
    const post = (auth?: string) =>
      fetch(`http://127.0.0.1:${port}/transform/cdrs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth && { Authorization: auth }),
        },
        body: JSON.stringify([row()]),
      });
    assert.equal((await post()).status, 401);
    assert.equal((await post("DPoP forged")).status, 401);
    const ok = await post("DPoP good");
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});

test("an optional array with nothing in it is left out, not sent empty", async () => {
  const { calls, transport } = stub();
  await executeFhir(cdrs, [row({ phone_number: "" })], context(), transport);
  const patient = calls.find((c) => c.url === env.IDENTITY_PATIENT_URL)!
    .body as Record<string, unknown>;
  assert.equal("telecom" in patient, false);
});
