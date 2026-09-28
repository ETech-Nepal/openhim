import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { Express } from 'express';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test',
  MEDIATOR_URN: 'urn:test:portal', OPENHIM_API_URL: 'http://openhim.invalid',
  OPENHIM_USERNAME: 'test', OPENHIM_PASSWORD: 'test', HAPI_FHIR_BASE_URL: 'http://hapi.invalid',
  PORTAL_PATIENT_SHARED_SECRET: 'synthetic-test-secret-at-least-32-bytes',
  PORTAL_PATIENT_TOKEN_ISSUER: 'urn:test:issuer', PORTAL_GID_CLAIM: 'gid',
});
delete process.env.PORTAL_PATIENT_JWKS_URL;

const { createApp } = await import('../src/app.js');

async function get(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`);
  } finally {
    server.close();
  }
}

test('portal app serves health without an OpenHIM envelope', async () => {
  const response = await get(createApp(), '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true);
});
