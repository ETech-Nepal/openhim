import './fixtures/env.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

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

test('admin app serves health as plain JSON', async () => {
  const response = await get(createApp(), '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true);
});
