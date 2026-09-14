import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import axios from 'axios';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null',
  NODE_ENV: 'test',
  MEDIATOR_URN: 'urn:test:fhir',
  OPENHIM_API_URL: 'http://openhim.invalid',
  OPENHIM_USERNAME: 'test',
  OPENHIM_PASSWORD: 'test',
  HAPI_FHIR_BASE_URL: 'http://hapi.invalid',
  JEMPI_BASE_URL: 'http://jempi.invalid',
  JEMPI_REGISTER_ROUTE: '/crRegister',
  JEMPI_FIND_ROUTE: '/find',
  JEMPI_GOLDEN_GET_ROUTE: '/expandedGoldenRecord',
  FACILITY_REGISTRY_JSON: '{}',
});
let calls = 0;
axios.defaults.adapter = async () => {
  calls++;
  throw new Error('synthetic upstream unavailable');
};
const { createApp } = await import('../src/app.js');

test('app factory serves health without registration or upstream calls', async (t) => {
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(calls, 0);
});

test('asynchronous upstream errors reach HTTP error handling instead of hanging', async (t) => {
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/fhir/Organization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json' },
    body: JSON.stringify({ resourceType: 'Organization', name: 'Synthetic facility' }),
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.resourceType, 'OperationOutcome');
});
