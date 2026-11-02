// @ts-nocheck
import './fixtures/env.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { HttpError } from '../src/lib/httpError.js';

// Token checks are covered in token.test.ts; here a stub decides who the caller is.
const callers = { 'DPoP hospital': { clientId: '1001', scopes: [] }, 'DPoP admin': { clientId: 'admin-portal', scopes: [] } };
const verify = async (header) => {
  if (!callers[header]) throw new HttpError(401, 'login', 'Missing or malformed access token');
  return callers[header];
};

async function call(method, path, headers = {}, body) {
  const server = createApp(verify).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type'), body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

test('identity app serves health as plain JSON', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'ok' });
});

test('patient writes need a token', async () => {
  const r = await call('POST', '/fhir/Patient', {}, { resourceType: 'Patient' });
  assert.equal(r.status, 401);
  assert.ok(r.type.startsWith('application/json+openhim'));
  assert.equal(JSON.parse(r.body.response.body).resourceType, 'OperationOutcome');
});

test('only the admin portal may use the admin API', async () => {
  assert.equal((await call('GET', '/admin/review/tasks', { Authorization: 'DPoP hospital' })).status, 403);
});

test('merge and dismiss refuse a request without a named administrator', async () => {
  for (const [path, headers] of [
    ['/admin/review/tasks/00000000-0000-0000-0000-000000000000/merge', {}],
    ['/admin/review/tasks/00000000-0000-0000-0000-000000000000/dismiss', { 'X-Admin-User': 'bad user!' }],
  ]) {
    const r = await call('POST', path, { Authorization: 'DPoP admin', ...headers }, {});
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body.response.body).error, 'X-Admin-User is required');
  }
});
