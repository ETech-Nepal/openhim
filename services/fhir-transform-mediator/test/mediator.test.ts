import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { execute } from "../src/execute.js";
import { mappings } from "../src/mappings/index.js";
import { parseConfig, parseIntegrations } from "../src/config.js";
import { createApp } from "../src/app.js";
import { mediatorDefinition } from "../src/openhim.js";
import { TransportError, postJson } from "../src/http.js";

const env = {
  NHID_URL: "http://example.test/register",
  NHID_AUTH: "Bearer service-secret",
  VALIDATOR_URL: "http://example.test/Patient/$validate",
};
const definition = {
  id: "national-registration-v1",
  channelPath: "/nagarik/registration",
  mapping: "patient-registration-v1",
  role: "national-app-clients",
  allowedClients: ["national-app"],
  options: {
    healthIdSystem: "https://example.test/nhid",
    nationalIdSystem: "https://example.test/nid",
  },
  destination: {
    urlEnv: "NHID_URL",
    authorizationEnv: "NHID_AUTH",
    timeoutMs: 1000,
  },
  validation: { urlEnv: "VALIDATOR_URL" },
};
const integration = () => parseIntegrations([definition], env)[0];
const context = { clientId: "national-app", correlationId: "test-request-1" };
const input = {
  name: "Example Person",
  gender: "female",
  dob: "2000-02-29",
  nationalId: "00123",
};
const patient = {
  resourceType: "Patient",
  id: "patient-1",
  identifier: [
    { system: "https://example.test/nid", value: "00123" },
    { system: "https://example.test/nhid", value: "NH0001" },
  ],
};
const nagarikInput = {
  requestId: "NAG-2026-09-14-0001842",
  source: "nagarik-app",
  citizen: {
    nationalId: "1234-5678-9012-3",
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

test("registration accepts no health ID, preserves names and leading zeroes", () => {
  const original = structuredClone(input);
  const output = mappings["patient-registration-v1"].toFhir(
    input,
    integration().options,
  );
  assert.equal(output.resourceType, "Patient");
  assert.deepEqual(output.name, [{ text: "Example Person" }]);
  assert.deepEqual(output.identifier, [
    { system: "https://example.test/nid", value: "00123" },
  ]);
  assert.equal(output.meta, undefined);
  assert.deepEqual(input, original);
  assert.throws(() =>
    mappings["patient-registration-v1"].toFhir(
      { ...input, dob: "2001-02-29" },
      integration().options,
    ),
  );
  assert.throws(() =>
    mappings["patient-registration-v1"].toFhir(
      { ...input, destination: "http://evil.test" },
      integration().options,
    ),
  );
});

test("response selects NHID by system and rejects missing or ambiguous identifiers", () => {
  const mapper = mappings["patient-registration-v1"];
  assert.deepEqual(mapper.fromFhir(patient, integration().options), {
    patientReference: "Patient/patient-1",
    healthId: "NH0001",
  });
  for (const identifier of [
    [],
    [patient.identifier[1], { ...patient.identifier[1], value: "NH0002" }],
  ]) {
    assert.throws(() =>
      mapper.fromFhir({ ...patient, identifier }, integration().options),
    );
  }
});

test("Nagarik registration maps the complete citizen payload to NP Core fields", () => {
  const mapper = mappings["nagarik-app-registration-v1"];
  const output = mapper.toFhir(nagarikInput, {});
  assert.deepEqual(output.identifier, [
    {
      use: "official",
      type: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v2-0203",
            code: "NI",
            display: "National unique individual identifier",
          },
        ],
      },
      system: "http://donidcr.gov.np",
      value: "1234-5678-9012-3",
    },
    {
      use: "official",
      type: {
        coding: [
          {
            system:
              "http://fhir.digitalhealth.gov.np/core/CodeSystem/np-core-identifier-type",
            code: "citizenship-number",
            display: "Nepal Citizenship Certificate Number",
          },
        ],
      },
      system: "http://moha.gov.np",
      value: "12-34-56-78901",
    },
    {
      use: "official",
      type: {
        coding: [
          {
            system:
              "http://fhir.digitalhealth.gov.np/core/CodeSystem/np-core-identifier-type",
            code: "health-insurance-id",
            display: "Nepal Health Insurance ID",
          },
        ],
      },
      system: "http://hib.gov.np",
      value: "HIB-000123456",
    },
  ]);
  assert.deepEqual(output.name, [
    { use: "official", given: ["Aarav"], family: "Shrestha" },
    { use: "official", given: ["आरव"], family: "श्रेष्ठ" },
  ]);
  assert.deepEqual(output.meta, {
    profile: [
      "http://fhir.digitalhealth.gov.np/core/StructureDefinition/np-core-patient",
    ],
  });
  assert.equal(output.active, true);
  assert.equal(output.gender, "male");
  assert.equal(output.birthDate, "1990-05-15");
  assert.equal(
    (output._birthDate as any).extension[0].valueString,
    "2047-02-01",
  );
  assert.deepEqual(
    (output.address as any)[0].extension.map((x: any) => x.valueCoding.code),
    ["3", "306", "30608"],
  );
  assert.deepEqual(
    mapper.fromFhir(
      {
        resourceType: "Patient",
        id: "patient-1",
        identifier: [
          {
            system:
              "http://fhir.digitalhealth.gov.np/core/NamingSystem/nepal-health-id",
            value: "NH0001",
          },
        ],
      },
      {},
    ),
    { patientReference: "Patient/patient-1", healthId: "NH0001" },
  );
  assert.throws(() =>
    mapper.toFhir(
      { ...nagarikInput, citizen: { ...nagarikInput.citizen, gender: "X" } },
      {},
    ),
  );
});

test("a distinct encounter mapping works without patient lookups or NHID logic", () => {
  const mapper = mappings["hospital-encounter-v1"];
  const result = mapper.toFhir(
    {
      encounterId: "0007",
      patientReference: "Patient/patient-1",
      status: "finished",
      classCode: "AMB",
      start: "2026-09-14T10:00:00+05:45",
    },
    { encounterIdentifierSystem: "https://example.test/hospital-a/encounter" },
  );
  assert.equal(result.resourceType, "Encounter");
  assert.deepEqual(result.identifier, [
    { system: "https://example.test/hospital-a/encounter", value: "0007" },
  ]);
  assert.deepEqual(mapper.fromFhir({ ...result, id: "enc-1" }, {}), {
    encounterReference: "Encounter/enc-1",
    status: "finished",
  });
});

test("configuration rejects unknown mappings, unsafe URLs, missing secrets and duplicate integrations", () => {
  assert.throws(() =>
    parseIntegrations([{ ...definition, mapping: "missing" }], env),
  );
  assert.throws(() => parseIntegrations([definition, definition], env));
  assert.throws(() =>
    parseIntegrations([definition, { ...definition, id: "another" }], env),
  );
  assert.throws(() =>
    parseIntegrations([definition], { ...env, NHID_URL: "file:///etc/passwd" }),
  );
  assert.throws(() =>
    parseIntegrations([definition], {
      ...env,
      NHID_URL: "https://user:secret@example.test/",
    }),
  );
  assert.throws(() =>
    parseIntegrations([definition], { ...env, NHID_AUTH: "" }),
  );
  assert.throws(() =>
    parseIntegrations([{ ...definition, validation: undefined }], env),
  );
  assert.equal(
    parseConfig({
      OPENHIM_REGISTER: "false",
      OPENHIM_TRUST_SELF_SIGNED: "false",
    }).OPENHIM_REGISTER,
    false,
  );
  assert.throws(() => parseConfig({ OPENHIM_REGISTER: "maybe" }));
});

test("execution validates, submits once, validates response, and returns JSON with metadata", async () => {
  const calls: any[] = [];
  const result = await execute(
    integration(),
    input,
    context,
    async (request: any) => {
      calls.push(request);
      return request.url === env.NHID_URL ? reply(patient, 201) : reply(valid);
    },
  );
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, {
    patientReference: "Patient/patient-1",
    healthId: "NH0001",
  });
  assert.deepEqual(
    calls.map((c) => c.url),
    [env.VALIDATOR_URL, env.NHID_URL, env.VALIDATOR_URL],
  );
  assert.equal(calls[1].headers.Authorization, env.NHID_AUTH);
  assert.equal(calls[1].headers["X-Correlation-ID"], context.correlationId);
  assert.equal(calls[1].headers["X-OpenHIM-ClientID"], undefined);
  assert.equal(result.orchestrations.length, 3);
  assert.ok(!JSON.stringify(result.orchestrations).includes("service-secret"));
  assert.ok(!JSON.stringify(result.orchestrations).includes("Example Person"));
});

test("FHIR lookup returns an existing health ID and prevents duplicate generation", async () => {
  const lookupIntegration = () =>
    parseIntegrations(
      [
        {
          ...definition,
          lookup: {
            urlEnv: "FHIR_SERVER_URL",
            authorizationEnv: "FHIR_SERVER_AUTH",
            timeoutMs: 1000,
            matchIdentifierSystems: ["https://example.test/nid"],
          },
        },
      ],
      {
        ...env,
        FHIR_SERVER_URL: "http://example.test/fhir",
        FHIR_SERVER_AUTH: "Bearer fhir-secret",
      },
    )[0];
  for (const [entries, expectedStatus, expectedWrites] of [
    [[{ resource: patient }], 200, 0],
    [[], 201, 1],
    [[{ resource: patient }, { resource: patient }], 409, 0],
  ] as const) {
    let writes = 0;
    const calls: any[] = [];
    const result = await execute(
      lookupIntegration(),
      input,
      context,
      async (request: any) => {
        calls.push(request);
        if (request.method === "GET")
          return reply({
            resourceType: "Bundle",
            type: "searchset",
            entry: entries,
          });
        if (request.url === env.NHID_URL) {
          writes++;
          return reply(patient, 201);
        }
        return reply(valid);
      },
    );
    assert.equal(result.status, expectedStatus);
    assert.equal(writes, expectedWrites);
    assert.equal(calls[1].method, "GET");
    assert.match(calls[1].url, /\/fhir\/Patient\?identifier=/);
    assert.equal(calls[1].headers.Authorization, "Bearer fhir-secret");
    if (entries.length === 1)
      assert.deepEqual(result.body, {
        patientReference: "Patient/patient-1",
        healthId: "NH0001",
      });
    if (entries.length === 2)
      assert.equal(result.body.error, "multiple_existing_patients");
  }
});

test("invalid input and invalid generated FHIR never reach the destination", async () => {
  let calls = 0;
  const invalidInput = await execute(
    integration(),
    { name: "" },
    context,
    async () => {
      calls++;
      return reply(valid);
    },
  );
  assert.equal(invalidInput.status, 400);
  assert.equal(calls, 0);
  const invalidFhir = await execute(integration(), input, context, async () => {
    calls++;
    return reply({
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "error",
          code: "required",
          expression: ["Patient.identifier"],
        },
      ],
    });
  });
  assert.equal(invalidFhir.status, 422);
  assert.equal(calls, 1);
});

test("downstream errors retain status and safe issue details without being retried", async () => {
  let writes = 0;
  const result = await execute(
    integration(),
    input,
    context,
    async (request: any) => {
      if (request.url !== env.NHID_URL) return reply(valid);
      writes++;
      return reply(
        {
          resourceType: "OperationOutcome",
          issue: [
            {
              severity: "error",
              code: "conflict",
              diagnostics: "private demographics",
              expression: ["Patient.identifier"],
            },
          ],
        },
        409,
      );
    },
  );
  assert.equal(result.status, 409);
  assert.equal(writes, 1);
  assert.equal(result.body.error, "downstream_rejected");
  assert.ok(!JSON.stringify(result).includes("private demographics"));
});

test("upstream issue codes and expressions cannot echo private data", async () => {
  const result = await execute(
    integration(),
    input,
    context,
    async (request: any) => {
      if (request.url !== env.NHID_URL) return reply(valid);
      return reply(
        {
          resourceType: "OperationOutcome",
          issue: [
            {
              severity: "error",
              code: "private-patient-name",
              expression: ["Patient.name.where(text='private-patient-name')"],
            },
          ],
        },
        422,
      );
    },
  );
  assert.equal(result.status, 422);
  assert.deepEqual(result.body.issues, [
    { severity: "error", code: "processing" },
  ]);
  assert.ok(!JSON.stringify(result).includes("private-patient-name"));
});

test("a bad response after successful submission records success without submitting twice", async () => {
  let writes = 0;
  const result = await execute(
    integration(),
    input,
    context,
    async (request: any) => {
      if (request.url !== env.NHID_URL) return reply(valid);
      writes++;
      return reply({ ...patient, identifier: [] }, 201);
    },
  );
  assert.equal(result.status, 502);
  assert.equal(writes, 1);
  assert.equal(result.body.error, "response_mapping_failed");
  assert.equal(result.body.downstreamOutcome, "success");
});

test("accepted-but-incomplete submissions are unknown outcomes and skip response validation", async () => {
  let calls = 0;
  const result = await execute(
    integration(),
    input,
    context,
    async (request: any) => {
      calls++;
      return request.url === env.NHID_URL
        ? reply({ resourceType: "OperationOutcome" }, 202)
        : reply(valid);
    },
  );
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "unexpected_success_status");
  assert.equal(result.body.downstreamOutcome, "unknown");
  assert.equal(calls, 2);
});

test("timeouts record uncertain destination outcomes and never retry writes", async () => {
  let writes = 0;
  const result = await execute(
    integration(),
    input,
    context,
    async (request: any) => {
      if (request.url !== env.NHID_URL) return reply(valid);
      writes++;
      throw new TransportError(true);
    },
  );
  assert.equal(result.status, 504);
  assert.equal(result.body.stage, "destination");
  assert.equal(result.body.downstreamOutcome, "unknown");
  assert.equal(writes, 1);
  assert.equal(result.orchestrations.at(-1)?.response.status, 0);
});

test("malformed validator responses block submission, including empty outcomes", async () => {
  for (const body of [
    null,
    { resourceType: "OperationOutcome", issue: [] },
    { resourceType: "Patient" },
  ]) {
    let calls = 0;
    const result = await execute(integration(), input, context, async () => {
      calls++;
      return reply(body);
    });
    assert.equal(result.status, 502);
    assert.equal(result.body.error, "validator_failed");
    assert.equal(result.body.downstreamOutcome, "not-called");
    assert.equal(calls, 1);
  }
});

test("idempotency forwarding is opt-in and keys are scoped by integration and client", async () => {
  const keys: Array<string | undefined> = [];
  const transport = async (request: any) => {
    if (request.url !== env.NHID_URL) return reply(valid);
    keys.push(request.headers["Idempotency-Key"]);
    return reply(patient);
  };
  const requestContext = { ...context, idempotencyKey: "same-key" };
  await execute(integration(), input, requestContext, transport);
  const enabled = { ...integration(), forwardIdempotencyKey: true };
  await execute(enabled, input, requestContext, transport);
  await execute(enabled, input, requestContext, transport);
  await execute(
    enabled,
    input,
    { ...requestContext, clientId: "another-app" },
    transport,
  );
  assert.equal(keys[0], undefined);
  assert.ok(keys[1] && keys[1] !== "same-key");
  assert.equal(keys[1], keys[2]);
  assert.notEqual(keys[2], keys[3]);
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

test("real HTTP round trip returns an OpenHIM envelope and enforces client isolation", async () => {
  let writes = 0;
  const external = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/fhir+json");
    if (req.url === "/validate") return res.end(JSON.stringify(valid));
    writes++;
    assert.equal(JSON.parse(body).resourceType, "Patient");
    assert.equal(req.headers.authorization, "Bearer service-secret");
    res.writeHead(201).end(JSON.stringify(patient));
  });
  const externalUrl = await listen(external);
  const integrations = parseIntegrations([definition], {
    ...env,
    NHID_URL: `${externalUrl}/register`,
    VALIDATOR_URL: `${externalUrl}/validate`,
  });
  const config = parseConfig({ OPENHIM_REGISTER: "false" });
  const server = createServer(createApp(config, integrations));
  const url = await listen(server);
  try {
    const post = (path: string, client: string, body: unknown = input) =>
      fetch(url + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenHIM-ClientID": client,
          Authorization: "Bearer caller-secret",
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post("/integrations/national-registration-v1", "other-app"))
        .status,
      403,
    );
    assert.equal(writes, 0);
    const converted = await post(
      "/transform/national-registration-v1/request",
      "national-app",
    );
    assert.equal(
      JSON.parse((await converted.json()).response.body).resourceType,
      "Patient",
    );
    assert.equal(writes, 0);
    const response = await post(
      "/integrations/national-registration-v1",
      "national-app",
    );
    assert.equal(response.status, 201);
    assert.match(
      response.headers.get("content-type")!,
      /application\/json\+openhim/,
    );
    const envelope = await response.json();
    assert.deepEqual(JSON.parse(envelope.response.body), {
      patientReference: "Patient/patient-1",
      healthId: "NH0001",
    });
    assert.equal(envelope.response.headers["Content-Type"], "application/json");
    assert.equal(writes, 1);
  } finally {
    await close(server);
    await close(external);
  }
});

test("registration describes one explicit middleware channel per integration", () => {
  const config = parseConfig({ OPENHIM_REGISTER: "false" });
  const definition = mediatorDefinition(config, [integration()]);
  assert.equal(definition.defaultChannelConfig.length, 1);
  assert.deepEqual(
    definition.endpoints.map((endpoint) => endpoint.path),
    ["/nagarik/registration"],
  );
  for (const channel of definition.defaultChannelConfig) {
    assert.deepEqual(channel.allow, ["national-app-clients"]);
    assert.equal(channel.requestBody, false);
    assert.equal(channel.responseBody, false);
    assert.equal(channel.autoRetryEnabled, false);
    assert.equal(channel.authType, "private");
    assert.ok(channel.timeout > 31000);
    assert.ok(new RegExp(channel.urlPattern).test("/nagarik/registration"));
    assert.ok(!new RegExp(channel.urlPattern).test("/emr/fhir"));
  }
});

test("HTTP boundary handles malformed JSON, missing identity and payload limits", async () => {
  const server = createServer(
    createApp(
      parseConfig({ OPENHIM_REGISTER: "false", MAX_BODY_BYTES: "1024" }),
      [integration()],
    ),
  );
  const url = await listen(server);
  try {
    for (const [body, client, type, expected] of [
      ["{", "national-app", "application/json", 400],
      [JSON.stringify(input), "", "application/json", 403],
      [JSON.stringify(input), "national-app", "text/plain", 415],
      [
        JSON.stringify({ name: "a".repeat(2000) }),
        "national-app",
        "application/json",
        413,
      ],
    ] as const) {
      const response = await fetch(
        `${url}/integrations/national-registration-v1`,
        {
          method: "POST",
          headers: { "Content-Type": type, "X-OpenHIM-ClientID": client },
          body,
        },
      );
      assert.equal(response.status, expected);
      assert.match(
        response.headers.get("content-type")!,
        /application\/json\+openhim/,
      );
      const envelope = await response.json();
      assert.equal(envelope.response.status, expected);
      assert.equal(envelope.status, "Failed");
    }
  } finally {
    await close(server);
  }
});

test("HTTP transport refuses redirects, caps response size and enforces a deadline", async () => {
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect")
      return res.writeHead(307, { Location: "/write" }).end();
    if (req.url === "/large") return res.end("a".repeat(1048577));
    if (req.url === "/slow") return;
    redirected++;
    res.end("{}");
  });
  const url = await listen(server);
  try {
    assert.equal(
      (await postJson({ url: `${url}/redirect`, body: {}, timeoutMs: 1000 }))
        .status,
      307,
    );
    assert.equal(redirected, 0);
    await assert.rejects(
      postJson({ url: `${url}/large`, body: {}, timeoutMs: 1000 }),
      TransportError,
    );
    await assert.rejects(
      postJson({ url: `${url}/slow`, body: {}, timeoutMs: 25 }),
      (error: any) => error instanceof TransportError && error.timeout,
    );
  } finally {
    await close(server);
  }
});
