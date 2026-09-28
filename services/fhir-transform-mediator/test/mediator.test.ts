import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.js";
import { parseConfig, parseIntegrations } from "../src/config.js";
import { execute } from "../src/execute.js";
import { TransportError } from "../src/http.js";
import { mappings } from "../src/mappings/index.js";
import { mediatorDefinition } from "../src/openhim.js";

const env = {
  VALIDATOR_URL: "http://example.test/Patient/$validate",
  NHID_GENERATOR_URL: "http://nhid-generator:9090/generate",
};
const definition = {
  id: "national-registration-v1",
  channelPath: "/nagarik/registration",
  mapping: "patient-registration-v1",
  role: "national-app-clients",
  options: {
    nationalIdSystem: "https://example.test/nid",
  },
  validation: { urlEnv: "VALIDATOR_URL", timeoutMs: 1000 },
};
const integration = () => parseIntegrations([definition], env)[0];
const context = { correlationId: "test-request-1" };
const input = {
  name: "Example Person",
  gender: "female",
  dob: "2000-02-29",
  nationalId: "00123",
};
const nagarikDefinition = {
  id: "nagarik-app-registration-v1",
  channelPath: "/nagarik/registration",
  mapping: "nagarik-app-registration-v1",
  role: "national-app-clients",
  options: {},
  validation: { urlEnv: "VALIDATOR_URL", timeoutMs: 1000 },
  nhidGenerator: { urlEnv: "NHID_GENERATOR_URL", timeoutMs: 1000 },
};
const nagarikIntegration = () => parseIntegrations([nagarikDefinition], env)[0];
const nagarikInput = {
  requestId: "NAG-2026-09-14-0001842",
  source: "nagarik-app",
  citizen: {
    nationalId: "1234-5978-9012-3",
    citizenshipNumber: "12-34-56-78901",
    healthInsuranceNumber: "HIB-000123456",
    nameEn: { given: "Aarav", family: "Shrestha" },
    nameNe: { given: "आरव", family: "श्रेष्ठ" },
    gender: "M",
    dobBS: "2047-02-01",
    dobAD: "1990-05-15",
    casteEthnicityCode: "1",
    mobile: "+9779801234567",
    email: "aarav.shrestha@example.com",
    permanentAddress: {
      provinceCode: "3",
      districtCode: "306",
      localLevelCode: "30608",
      wardNo: 10,
      tole: "Naxal",
      postalCode: "44600",
    },
  },
};
const valid = {
  resourceType: "OperationOutcome",
  issue: [{ severity: "information", code: "informational" }],
};
const reply = (body: unknown, status = 200) => ({ status, body });

test("registration maps input to FHIR without generating an NHID", () => {
  assert.deepEqual(
    mappings["patient-registration-v1"].toFhir(input, integration().options),
    {
      resourceType: "Patient",
      name: [{ text: "Example Person" }],
      gender: "female",
      birthDate: "2000-02-29",
      identifier: [{ system: "https://example.test/nid", value: "00123" }],
    },
  );
});

test("EMR FHIR Patient mapping preserves the source resource", () => {
  const patient = { resourceType: "Patient", name: [{ text: "EMR patient" }] };
  assert.deepEqual(
    mappings["emr-fhir-patient-v1"].toFhir(patient, {}),
    patient,
  );
});

test("execution validates mapped FHIR and returns it without forwarding", async () => {
  const calls: any[] = [];
  const result = await execute(
    integration(),
    input,
    context,
    async (request: any) => {
      calls.push(request);
      return reply(valid);
    },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    resourceType: "Patient",
    name: [{ text: "Example Person" }],
    gender: "female",
    birthDate: "2000-02-29",
    identifier: [{ system: "https://example.test/nid", value: "00123" }],
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [env.VALIDATOR_URL],
  );
  assert.equal(result.orchestrations.length, 1);
});

test("execution sends validated FHIR to the NHID generator and returns its response", async () => {
  const generator = {
    nhidGenerator: { urlEnv: "NHID_GENERATOR_URL", timeoutMs: 1000 },
  };
  const configured = parseIntegrations(
    [{ ...definition, ...generator }],
    env,
  )[0];
  const calls: any[] = [];
  const generated = { healthId: "1234-5678-9012" };
  const result = await execute(
    configured,
    input,
    context,
    async (request: any) => {
      calls.push(request);
      return calls.length === 1 ? reply(valid) : reply(generated, 201);
    },
  );

  assert.equal(result.status, 201);
  assert.deepEqual(result.body, generated);
  assert.deepEqual(
    calls.map((call) => call.url),
    [env.VALIDATOR_URL, env.NHID_GENERATOR_URL],
  );
  assert.equal(calls[1].body.resourceType, "Patient");
});

test("Nagarik receives the stored Patient as flat JSON with FHIR names", async () => {
  for (const status of [200, 201]) {
    let calls = 0;
    let stored: unknown;
    const result = await execute(
      nagarikIntegration(),
      nagarikInput,
      context,
      async (request) => {
        if (++calls === 1) return reply(valid);
        // The service returns the resource it stored, with the health ID added.
        const patient = request.body as { identifier: unknown[] };
        stored = {
          ...patient,
          identifier: [
            ...patient.identifier,
            {
              system:
                "http://fhir.digitalhealth.gov.np/core/NamingSystem/nepal-health-id",
              value: "WE1353934",
            },
          ],
        };
        return reply(stored, status);
      },
    );

    assert.equal(result.status, status);
    assert.deepEqual(result.body, {
      requestId: nagarikInput.requestId,
      source: "nagarik-app",
      patient: {
        nationalId: nagarikInput.citizen.nationalId,
        citizenshipNumber: nagarikInput.citizen.citizenshipNumber,
        healthInsuranceNumber: nagarikInput.citizen.healthInsuranceNumber,
        healthId: "WE1353934",
        name: [
          { given: ["Aarav"], family: "Shrestha" },
          { given: ["आरव"], family: "श्रेष्ठ" },
        ],
        gender: "male",
        birthDate: "1990-05-15",
        birthDateBS: "2047-02-01",
        casteEthnicity: "1",
        telecom: {
          phone: nagarikInput.citizen.mobile,
          email: nagarikInput.citizen.email,
        },
        address: {
          province: "3",
          district: "306",
          localLevel: "30608",
          wardNo: 10,
          tole: "Naxal",
          postalCode: "44600",
          country: "NP",
        },
      },
    });
    assert.equal(result.orchestrations.length, 2);
  }
});

test("a Patient the response mapping cannot read fails as a bad gateway", async () => {
  let calls = 0;
  const result = await execute(
    nagarikIntegration(),
    nagarikInput,
    context,
    async () =>
      ++calls === 1 ? reply(valid) : reply({ id: "no-patient" }, 201),
  );
  assert.equal(result.status, 502);
  assert.deepEqual(result.body.error, {
    code: "response_mapping_failed",
    message: "The NHID service returned an invalid response.",
  });
});

test("Nagarik receives a validation error message", async () => {
  const result = await execute(
    nagarikIntegration(),
    nagarikInput,
    context,
    async () =>
      reply({
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "required" }],
      }),
  );

  assert.equal(result.status, 422);
  assert.deepEqual(result.body, {
    requestId: nagarikInput.requestId,
    source: "nagarik-app",
    status: "failed",
    error: {
      code: "fhir_validation_failed",
      message: "The submitted citizen data failed validation.",
      issues: [{ severity: "error", code: "required" }],
    },
  });
});

test("Nagarik identifies a validation service outage", async () => {
  const result = await execute(
    nagarikIntegration(),
    nagarikInput,
    context,
    async () => {
      throw new TransportError(false);
    },
  );

  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    requestId: nagarikInput.requestId,
    source: "nagarik-app",
    status: "failed",
    error: {
      code: "upstream_unavailable",
      message: "The validation service is unavailable.",
    },
  });
});

test("Nagarik receives an NHID service error message", async () => {
  let calls = 0;
  const result = await execute(
    nagarikIntegration(),
    nagarikInput,
    context,
    async () =>
      ++calls === 1 ? reply(valid) : reply({ error: "unavailable" }, 503),
  );

  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    requestId: nagarikInput.requestId,
    source: "nagarik-app",
    status: "failed",
    error: {
      code: "nhid_service_failed",
      message: "The NHID service could not complete the registration.",
    },
  });
});

const messages: Record<string, string> = {
  nhid_missing_fields:
    "The registration is missing fields the NHID service requires.",
  nhid_missing_gender_or_phone:
    "Gender and mobile number are required to generate a new Health ID.",
  nhid_rejected_resource:
    "The NHID service rejected the generated patient resource.",
  nhid_identity_mismatch:
    "A record with this national ID exists, but its details do not match this registration.",
  nhid_existing_record:
    "A record with this national ID exists without a Health ID.",
  nhid_service_failed: "The NHID service could not complete the registration.",
};

test("NHID service failures are classified by their error envelope", async () => {
  const cases = [
    {
      status: 400,
      message: "Missing field(s): National ID, given name",
      expect: 400,
      code: "nhid_missing_fields",
      issues: ["National ID", "given name"],
    },
    {
      status: 400,
      message:
        "Gender and phone number are required to generate a new HealthID",
      expect: 400,
      code: "nhid_missing_gender_or_phone",
    },
    {
      status: 400,
      message: "Not a valid FHIR Patient request: unknown variant `m`",
      expect: 502,
      code: "nhid_rejected_resource",
    },
    {
      status: 409,
      message:
        "NID already exists but the provided data does not match the existing record",
      expect: 409,
      code: "nhid_identity_mismatch",
    },
    {
      status: 409,
      message: "NID already exists",
      expect: 409,
      code: "nhid_existing_record",
    },
    {
      status: 500,
      message: "Could not generate health ID checksum",
      expect: 502,
      code: "nhid_service_failed",
    },
    {
      status: 502,
      message: "FHIR request failed: connection refused",
      expect: 502,
      code: "nhid_service_failed",
    },
  ];
  for (const item of cases) {
    let calls = 0;
    const result = await execute(
      nagarikIntegration(),
      nagarikInput,
      context,
      async () =>
        ++calls === 1
          ? reply(valid)
          : reply({ status: false, message: item.message }, item.status),
    );
    assert.equal(result.status, item.expect, item.code);
    assert.deepEqual(result.body, {
      requestId: nagarikInput.requestId,
      source: "nagarik-app",
      status: "failed",
      error: {
        code: item.code,
        message: messages[item.code],
        ...(item.issues ? { issues: item.issues } : {}),
      },
    });
    // No upstream text crosses the boundary.
    assert.ok(!JSON.stringify(result.body).includes(item.message.slice(0, 20)));
  }
});

test("failed FHIR validation returns an error without forwarding the resource", async () => {
  const result = await execute(integration(), input, context, async () =>
    reply({
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "required" }],
    }),
  );
  assert.equal(result.status, 422);
  assert.equal(result.body.error, "fhir_validation_failed");
  assert.equal(result.orchestrations.length, 1);
});

test("NP Core's missing health ID requirement is the only ignored validation error", async () => {
  const healthIdOnly = await execute(integration(), input, context, async () =>
    reply({
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "error",
          code: "structure",
          details: {
            text: "Slice 'Patient.identifier:healthId': a matching slice is required, but not found",
          },
        },
      ],
    }),
  );
  assert.equal(healthIdOnly.status, 200);

  const otherError = await execute(integration(), input, context, async () =>
    reply({
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "error",
          code: "required",
          diagnostics: "Patient.name is required",
          expression: ["Patient.name"],
        },
      ],
    }),
  );
  assert.equal(otherError.status, 422);
});

test("configuration accepts validation-only integrations and rejects unsafe validators", () => {
  assert.doesNotThrow(() => parseIntegrations([definition], env));
  assert.throws(() =>
    parseIntegrations([definition], { VALIDATOR_URL: "file:///etc/passwd" }),
  );
  assert.throws(() => parseIntegrations([definition, definition], env));
});

test("deployment configuration enables only the Nagarik integration", async () => {
  const source = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../integrations.json", import.meta.url)),
      "utf8",
    ),
  );
  assert.deepEqual(
    source.map((item: { id: string }) => item.id),
    ["nagarik-app-registration-v1"],
  );
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

test("OpenHIM channel returns validated FHIR without mediator client authorization", async () => {
  let validations = 0;
  const server = createServer(
    createApp(
      parseConfig({ OPENHIM_REGISTER: "false" }),
      [integration()],
      async () => {
        validations++;
        return reply(valid);
      },
    ),
  );
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/nagarik/registration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(JSON.parse(envelope.response.body).resourceType, "Patient");
    assert.equal(validations, 1);
  } finally {
    await close(server);
  }
});

test("OpenHIM registration keeps authorization on the channel and uses one validation timeout", () => {
  const channels = mediatorDefinition(
    parseConfig({ OPENHIM_REGISTER: "false" }),
    [integration()],
  ).defaultChannelConfig;
  assert.deepEqual(channels[0].allow, ["national-app-clients"]);
  assert.equal(channels[0].requestBody, true);
  assert.equal(channels[0].timeout, 6000);
});
