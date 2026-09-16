import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.js";
import { parseConfig, parseIntegrations } from "../src/config.js";
import { execute } from "../src/execute.js";
import { mappings } from "../src/mappings/index.js";
import { mediatorDefinition } from "../src/openhim.js";

const env = { VALIDATOR_URL: "http://example.test/Patient/$validate" };
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
