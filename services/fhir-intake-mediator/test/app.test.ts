import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';

const config = {
  MEDIATOR_URN: 'urn:test:fhir-intake',
  MEDIATOR_PORT: 0,
  NODE_ENV: 'test',
};

function fakeFhirClient() {
  return {
    async findOrganizationByNhfr(nhfrId) {
      return {
        status: 200,
        body: { resourceType: 'Bundle', type: 'searchset' },
        organization: { id: `org-for-${nhfrId}`, name: 'Bharatpur Hospital' },
        lookupError: null,
        orchestrations: [],
      };
    },
    async forward(resource, path) {
      return {
        status: 201,
        body: { resourceType: resource.resourceType || 'Bundle', forwardedTo: path },
        orchestrations: [],
      };
    },
  };
}

function startApp() {
  const app = createApp({
    config,
    fhirClient: fakeFhirClient(),
    logger: createLogger('test'),
  });
  const server = app.listen(0);
  return new Promise((resolve) => {
    server.on('listening', () => {
      const { port } = server.address();
      resolve({
        server,
        request: (path, options) => fetch(`http://127.0.0.1:${port}${path}`, options),
      });
    });
  });
}

test('rejects text/plain before workflow execution', async (t) => {
  const { server, request } = await startApp();
  t.after(() => server.close());
  const response = await request('/ingest', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-openhim-clientid': 'hospital-1' },
    body: '{}',
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).response.status, 415);
});

test('the application/json+fhir alias returns 415', async (t) => {
  const { server, request } = await startApp();
  t.after(() => server.close());
  const response = await request('/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json+fhir', 'x-openhim-clientid': 'hospital-1' },
    body: '{}',
  });
  assert.equal(response.status, 415);
});

test('returns 400 for malformed approved JSON', async (t) => {
  const { server, request } = await startApp();
  t.after(() => server.close());
  const response = await request('/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openhim-clientid': 'hospital-1' },
    body: '{bad json',
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-type'), 'application/json+openhim; charset=utf-8');
  assert.equal((await response.json()).response.status, 400);
});

test('accepts application/fhir+json with charset', async (t) => {
  const { server, request } = await startApp();
  t.after(() => server.close());
  const response = await request('/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/fhir+json; charset=utf-8',
      'x-openhim-clientid': 'hospital-1',
    },
    body: JSON.stringify({ resourceType: 'Patient' }),
  });
  assert.equal(response.status, 201);
});

test('accepts application/json and runs the raw workflow', async (t) => {
  const { server, request } = await startApp();
  t.after(() => server.close());
  const response = await request('/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openhim-clientid': 'hospital-1' },
    body: JSON.stringify({
      hospital_patient_number: '2405078',
      encounter_number: '2110732',
      first_name: 'Chandrika',
      last_name: 'Kandel',
      sex: 'Female',
      department_type: 'C',
      department_id: '22',
      department_name: 'Family Medicine',
      visit_date_ad_time: '2026-07-28 00:02:00.000',
    }),
  });
  assert.equal(response.status, 201);
});

test('an array body is rejected as invalid input, not a crash', async (t) => {
  const { server, request } = await startApp();
  t.after(() => server.close());
  const response = await request('/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/fhir+json', 'x-openhim-clientid': 'hospital-1' },
    body: '[]',
  });
  assert.equal(response.status, 400);
});

test('GET /health returns ok', async (t) => {
  const { server, request } = await startApp();
  t.after(() => server.close());
  const response = await request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('GET /ingest is not routed', async (t) => {
  const { server, request } = await startApp();
  t.after(() => server.close());
  const response = await request('/ingest');
  assert.ok([404, 405].includes(response.status));
});

test('missing X-OpenHIM-ClientID returns 403', async (t) => {
  const { server, request } = await startApp();
  t.after(() => server.close());
  const response = await request('/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
});
