import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestHandler } from '../src/handlers/ingest.js';

const trustedConfig = { MEDIATOR_URN: 'urn:test:fhir-intake' };

function validRow(overrides = {}) {
  return {
    hospital_patient_number: '2405078',
    encounter_number: '2110732',
    first_name: 'Chandrika',
    last_name: 'Kandel',
    sex: 'Female',
    department_type: 'C',
    department_id: '22',
    department_name: 'Family Medicine',
    visit_date_ad_time: '2026-07-28 00:02:00.000',
    ...overrides,
  };
}

function outcome(code, diagnostics) {
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code, diagnostics }],
  };
}

function organizationLookup(organization = { id: 'org-uuid-3', name: 'Bharatpur Hospital' }, lookupError = null) {
  return {
    status: 200,
    body: { resourceType: 'Bundle', type: 'searchset' },
    organization,
    lookupError: organization ? lookupError : (lookupError || 'missing'),
    orchestrations: [
      { name: 'GET FHIR orchestrator Organization search' },
      { name: 'GET HAPI Organization' },
    ],
  };
}

function successfulForward(status = 201) {
  return {
    status,
    body: { resourceType: 'Bundle', type: 'transaction-response' },
    orchestrations: [
      { name: 'POST FHIR orchestrator Bundle' },
      { name: 'POST JeMPI' },
      { name: 'POST HAPI Bundle' },
    ],
  };
}

function fakeClient({ lookup = organizationLookup(), forward = successfulForward() } = {}) {
  const calls = [];
  return {
    calls,
    async findOrganizationByNhfr(nhfrId, headers) {
      calls.push({ kind: 'lookup', nhfrId, headers });
      if (lookup instanceof Error) throw lookup;
      return lookup;
    },
    async forward(resource, path, headers) {
      calls.push({ kind: 'forward', resource, path, headers });
      if (forward instanceof Error) throw forward;
      return forward;
    },
  };
}

async function invokeHandler(request, config = trustedConfig, fhirClient = fakeClient()) {
  const sent = {};
  const req = {
    headers: request.headers || { 'x-openhim-clientid': 'hospital-1' },
    inputKind: request.inputKind,
    body: request.body,
  };
  const res = {
    status(statusCode) {
      sent.statusCode = statusCode;
      return this;
    },
    json(body) {
      sent.body = body;
      return this;
    },
  };
  await createIngestHandler({ config, fhirClient })(req, res);
  return sent;
}

function fhirRequest(body) {
  return {
    headers: { 'x-openhim-clientid': 'hospital-1' },
    inputKind: 'fhir',
    body,
  };
}

test('rejects a request with no authenticated client identity before downstream calls', async () => {
  const fhirClient = fakeClient();
  const response = await invokeHandler({
    headers: { 'x-nhfr-id': 'forged' },
    inputKind: 'raw',
    body: validRow(),
  }, trustedConfig, fhirClient);

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.response.status, 403);
  assert.equal(response.body.status, 'Failed');
  assert.equal(fhirClient.calls.length, 0);
});

test('uses X-OpenHIM-ClientID as the facility and ignores forged X-NHFR-ID and organization_id', async () => {
  const fhirClient = fakeClient();
  await invokeHandler({
    headers: { 'x-openhim-clientid': 'hospital-1', 'x-nhfr-id': 'attacker-facility' },
    inputKind: 'raw',
    body: validRow({ organization_id: 'attacker-facility' }),
  }, trustedConfig, fhirClient);

  assert.equal(fhirClient.calls[0].nhfrId, 'hospital-1');
  assert.equal(fhirClient.calls[0].headers['x-openhim-clientid'], 'hospital-1');
  assert.equal(fhirClient.calls[0].headers['x-nhfr-id'], undefined);
  assert.equal(fhirClient.calls[1].headers['x-nhfr-id'], undefined);
  assert.equal(fhirClient.calls[1].resource.entry[0].resource.managingOrganization.reference, 'Organization/org-uuid-3');
});

test('rejects an invalid raw row before Organization lookup', async () => {
  const fhirClient = fakeClient();
  const response = await invokeHandler({ inputKind: 'raw', body: validRow({ sex: 'invalid' }) }, trustedConfig, fhirClient);

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body.response.body).resourceType, 'OperationOutcome');
  assert.equal(fhirClient.calls.length, 0);
});

test('returns 422 when no Organization has the NHFR identifier and does not forward', async () => {
  const fhirClient = fakeClient({ lookup: organizationLookup(null, 'missing') });
  const response = await invokeHandler({ inputKind: 'raw', body: validRow() }, trustedConfig, fhirClient);

  assert.equal(response.statusCode, 422);
  assert.equal(JSON.parse(response.body.response.body).resourceType, 'OperationOutcome');
  assert.deepEqual(fhirClient.calls.map(({ kind }) => kind), ['lookup']);
});

test('returns 422 when more than one Organization has the NHFR identifier', async () => {
  const fhirClient = fakeClient({ lookup: organizationLookup(null, 'ambiguous') });
  const response = await invokeHandler({ inputKind: 'raw', body: validRow() }, trustedConfig, fhirClient);

  assert.equal(response.statusCode, 422);
  assert.match(JSON.parse(response.body.response.body).issue[0].diagnostics, /More than one/);
  assert.deepEqual(fhirClient.calls.map(({ kind }) => kind), ['lookup']);
});

test('preserves a downstream Organization lookup OperationOutcome and status', async () => {
  const downstreamBody = outcome('exception', 'HAPI unavailable');
  const fhirClient = fakeClient({ lookup: {
    status: 503,
    body: downstreamBody,
    organization: null,
    lookupError: 'downstream',
    orchestrations: [{ name: 'GET FHIR orchestrator Organization search' }],
  } });
  const response = await invokeHandler({ inputKind: 'raw', body: validRow() }, trustedConfig, fhirClient);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body.response.body), downstreamBody);
  assert.equal(fhirClient.calls.length, 1);
});

test('maps a valid raw row into one Bundle addressed to the authenticated facility', async () => {
  const fhirClient = fakeClient();
  const response = await invokeHandler({ inputKind: 'raw', body: validRow() }, trustedConfig, fhirClient);
  const forwarded = fhirClient.calls[1];

  assert.equal(response.statusCode, 201);
  assert.equal(forwarded.path, '/fhir');
  assert.equal(forwarded.resource.resourceType, 'Bundle');
  assert.equal(forwarded.resource.type, 'transaction');
  assert.equal(forwarded.resource.entry[0].resource.managingOrganization.reference, 'Organization/org-uuid-3');
  assert.equal(forwarded.resource.entry[0].resource.managingOrganization.display, 'Bharatpur Hospital');
  assert.equal(forwarded.resource.entry[1].resource.serviceProvider.reference, 'Organization/org-uuid-3');
});

test('merges Organization lookup and downstream orchestration entries into one envelope', async () => {
  const response = await invokeHandler({ inputKind: 'raw', body: validRow() });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body.orchestrations.map(({ name }) => name), [
    'GET FHIR orchestrator Organization search',
    'GET HAPI Organization',
    'POST FHIR orchestrator Bundle',
    'POST JeMPI',
    'POST HAPI Bundle',
  ]);
});

test('turns a raw workflow transport exception into a 502 OperationOutcome', async () => {
  const fhirClient = fakeClient({ lookup: new Error('connect ECONNREFUSED') });
  const response = await invokeHandler({ inputKind: 'raw', body: validRow() }, trustedConfig, fhirClient);

  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body.response.body).resourceType, 'OperationOutcome');
});

test('retains the completed lookup orchestration when raw forwarding has a transport failure', async () => {
  const fhirClient = fakeClient({ forward: new Error('connect ECONNREFUSED') });
  const response = await invokeHandler({ inputKind: 'raw', body: validRow() }, trustedConfig, fhirClient);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body.orchestrations.map(({ name }) => name), [
    'GET FHIR orchestrator Organization search',
    'GET HAPI Organization',
  ]);
});

test('forwards a supported FHIR resource by object identity without Organization lookup', async () => {
  const patient = { resourceType: 'Patient', name: [{ family: 'Kandel' }] };
  const fhirClient = fakeClient({ forward: {
    status: 201,
    body: { resourceType: 'Patient', id: 'patient-1' },
    orchestrations: [{ name: 'POST FHIR orchestrator Patient' }],
  } });
  const response = await invokeHandler(fhirRequest(patient), trustedConfig, fhirClient);

  assert.equal(fhirClient.calls[0].resource, patient);
  assert.deepEqual(fhirClient.calls.map(({ kind }) => kind), ['forward']);
  assert.equal(response.statusCode, 201);
});

test('rejects an unsupported FHIR resource without downstream calls', async () => {
  const fhirClient = fakeClient();
  const response = await invokeHandler(fhirRequest({ resourceType: 'Condition' }), trustedConfig, fhirClient);

  assert.equal(response.statusCode, 400);
  assert.equal(fhirClient.calls.length, 0);
});

test('rejects an unsupported FHIR Bundle type without downstream calls', async () => {
  const fhirClient = fakeClient();
  const response = await invokeHandler(fhirRequest({ resourceType: 'Bundle', type: 'collection' }), trustedConfig, fhirClient);

  assert.equal(response.statusCode, 400);
  assert.equal(fhirClient.calls.length, 0);
});

test('preserves downstream 400 and 422 FHIR responses', async () => {
  for (const status of [400, 422]) {
    const downstreamBody = outcome('invalid', `downstream ${status}`);
    const fhirClient = fakeClient({ forward: {
      status,
      body: downstreamBody,
      orchestrations: [{ name: 'POST FHIR orchestrator Organization' }],
    } });
    const response = await invokeHandler(fhirRequest({ resourceType: 'Organization', name: 'KMC' }), trustedConfig, fhirClient);

    assert.equal(response.statusCode, status);
    assert.deepEqual(JSON.parse(response.body.response.body), downstreamBody);
  }
});

test('forwards a valid FHIR Organization without Organization lookup', async () => {
  const organization = { resourceType: 'Organization', name: 'KMC' };
  const fhirClient = fakeClient({ forward: {
    status: 201,
    body: { ...organization, id: 'org-9' },
    orchestrations: [{ name: 'POST FHIR orchestrator Organization' }],
  } });
  const response = await invokeHandler(fhirRequest(organization), trustedConfig, fhirClient);

  assert.equal(response.statusCode, 201);
  assert.equal(fhirClient.calls[0].resource, organization);
  assert.equal(fhirClient.calls[0].path, '/fhir/Organization');
  assert.deepEqual(fhirClient.calls.map(({ kind }) => kind), ['forward']);
});
