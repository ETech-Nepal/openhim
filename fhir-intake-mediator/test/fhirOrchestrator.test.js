import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DownstreamEnvelopeError,
  createFhirOrchestratorClient,
  unwrapOpenHimEnvelope,
} from '../src/clients/fhirOrchestrator.js';

const trustedHeaders = {
  'x-openhim-clientid': 'cdrs-hospital-a',
};

function envelopeResponse(status, body, orchestrations = [{ name: 'GET HAPI Organization' }]) {
  return {
    data: {
      response: { status, body: JSON.stringify(body) },
      orchestrations,
    },
  };
}

function searchBundle(resources) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: resources.length,
    entry: resources.map((resource) => ({ resource })),
  };
}

test('unwraps an OpenHIM envelope and parses its FHIR body', () => {
  const result = unwrapOpenHimEnvelope({
    response: { status: 200, body: '{"resourceType":"Bundle","total":1}' },
    orchestrations: [{ name: 'GET HAPI Organization' }],
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.resourceType, 'Bundle');
  assert.equal(result.orchestrations.length, 1);
});

test('rejects an invalid downstream envelope', () => {
  assert.throws(
    () => unwrapOpenHimEnvelope({ status: 200 }),
    (error) => error instanceof DownstreamEnvelopeError && /OpenHIM response envelope/.test(error.message),
  );
});

test('rejects a downstream envelope with a non-JSON application body', () => {
  assert.throws(
    () => unwrapOpenHimEnvelope({ response: { status: 200, body: 'not json' } }),
    (error) => error instanceof DownstreamEnvelopeError && /non-JSON application body/.test(error.message),
  );
});

const NHFR = 'http://mohp.gov.np/fhir/NamingSystem/nhfr';

test('findOrganizationByNhfr searches by identifier and returns the one match', async () => {
  const http = { get: async (path, options) => {
    assert.equal(path, '/fhir/Organization');
    assert.deepEqual(options.params, { identifier: `${NHFR}|3130400221`, _count: 2 });
    assert.deepEqual(options.headers, trustedHeaders);
    return envelopeResponse(200, searchBundle([
      { resourceType: 'Organization', id: 'uuid-3', name: 'Bharatpur Hospital' },
    ]));
  } };
  const client = createFhirOrchestratorClient({ baseURL: 'http://mediator:4000', timeoutMs: 1000, http });

  const result = await client.findOrganizationByNhfr('3130400221', trustedHeaders);

  assert.equal(result.organization.id, 'uuid-3');
  assert.equal(result.organization.name, 'Bharatpur Hospital');
  assert.equal(result.lookupError, null);
  assert.equal(result.status, 200);
  assert.deepEqual(result.orchestrations.map(({ name }) => name), [
    'GET FHIR orchestrator Organization search',
    'GET HAPI Organization',
  ]);
  assert.equal(result.orchestrations[0].request.path, '/fhir/Organization');
});

test('findOrganizationByNhfr returns missing when no Organization matches', async () => {
  const http = { get: async () => envelopeResponse(200, searchBundle([])) };
  const client = createFhirOrchestratorClient({ baseURL: 'http://mediator:4000', timeoutMs: 1000, http });

  const result = await client.findOrganizationByNhfr('3130400221', trustedHeaders);
  assert.equal(result.organization, null);
  assert.equal(result.lookupError, 'missing');
});

test('findOrganizationByNhfr returns ambiguous when more than one matches', async () => {
  const http = { get: async () => envelopeResponse(200, searchBundle([
    { resourceType: 'Organization', id: 'uuid-a' },
    { resourceType: 'Organization', id: 'uuid-b' },
  ])) };
  const client = createFhirOrchestratorClient({ baseURL: 'http://mediator:4000', timeoutMs: 1000, http });

  const result = await client.findOrganizationByNhfr('3130400221', trustedHeaders);
  assert.equal(result.organization, null);
  assert.equal(result.lookupError, 'ambiguous');
});

test('findOrganizationByNhfr preserves a downstream non-2xx status', async () => {
  const body = { resourceType: 'OperationOutcome', issue: [{ code: 'exception' }] };
  const http = { get: async () => envelopeResponse(503, body) };
  const client = createFhirOrchestratorClient({ baseURL: 'http://mediator:4000', timeoutMs: 1000, http });

  const result = await client.findOrganizationByNhfr('3130400221', trustedHeaders);
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, body);
  assert.equal(result.organization, null);
  assert.equal(result.lookupError, 'downstream');
});

test('findOrganizationByNhfr rejects malformed downstream envelopes', async () => {
  const http = { get: async () => ({ data: { response: { status: 200 } } }) };
  const client = createFhirOrchestratorClient({ baseURL: 'http://mediator:4000', timeoutMs: 1000, http });

  await assert.rejects(
    () => client.findOrganizationByNhfr('3130400221', trustedHeaders),
    DownstreamEnvelopeError,
  );
});

test('forward routes a Bundle to /fhir and preserves headers and nested orchestrations', async () => {
  const bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
  const http = { post: async (path, resource, options) => {
    assert.equal(path, '/fhir');
    assert.equal(resource, bundle);
    assert.deepEqual(options.headers, trustedHeaders);
    return envelopeResponse(201, { resourceType: 'Bundle', type: 'transaction-response' }, [{ name: 'POST HAPI Bundle' }]);
  } };
  const client = createFhirOrchestratorClient({ baseURL: 'http://mediator:4000', timeoutMs: 1000, http });

  const result = await client.forward(bundle, '/fhir', trustedHeaders);

  assert.equal(result.status, 201);
  assert.equal(result.body.type, 'transaction-response');
  assert.deepEqual(result.orchestrations.map(({ name }) => name), [
    'POST FHIR orchestrator Bundle',
    'POST HAPI Bundle',
  ]);
  assert.equal(result.orchestrations[0].request.path, '/fhir');
});

test('forward routes a Patient to /fhir/Patient and preserves downstream errors', async () => {
  const patient = { resourceType: 'Patient', name: [{ family: 'Kandel' }] };
  const body = { resourceType: 'OperationOutcome', issue: [{ code: 'invalid' }] };
  const http = { post: async (path, resource, options) => {
    assert.equal(path, '/fhir/Patient');
    assert.equal(resource, patient);
    assert.deepEqual(options.headers, trustedHeaders);
    return envelopeResponse(422, body, []);
  } };
  const client = createFhirOrchestratorClient({ baseURL: 'http://mediator:4000', timeoutMs: 1000, http });

  const result = await client.forward(patient, '/fhir/Patient', trustedHeaders);

  assert.equal(result.status, 422);
  assert.deepEqual(result.body, body);
  assert.equal(result.orchestrations.length, 1);
  assert.equal(result.orchestrations[0].name, 'POST FHIR orchestrator Patient');
  assert.equal(result.orchestrations[0].response.status, 422);
});
