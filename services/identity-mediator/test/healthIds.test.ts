import './fixtures/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, migrate } from '../src/db/pool.js';
import { bindHealthId, healthIdRecord, reserveHealthId, retireHealthId } from '../src/db/healthIds.js';
import { generateHealthId } from '../src/patient/healthId.js';

test.before(async () => {
  assert.ok(process.env.TEST_IDENTITY_DB_PORT, 'Set TEST_IDENTITY_DB_PORT to the disposable PostgreSQL port');
  await migrate();
});
test.after(() => pool.end());
test.beforeEach(() => pool.query('DELETE FROM health_ids'));

test('allocation fails closed after five collisions', async () => {
  const taken = generateHealthId();
  await pool.query(`INSERT INTO health_ids (health_id, golden_uid, status) VALUES ($1, '0x9', 'active')`, [taken]);
  await assert.rejects(reserveHealthId(() => taken), { status: 502 });
  const fresh = await reserveHealthId(() => generateHealthId());
  assert.notEqual(fresh, taken);
});

test('a new golden record binds its reservation', async () => {
  const reserved = await reserveHealthId();
  assert.equal(await bindHealthId({ reserved, goldenUid: '0x10' }), reserved);
  assert.equal((await healthIdRecord(reserved))?.status, 'active');
});

test('an existing golden record keeps its ID and the reservation is released', async () => {
  const first = await bindHealthId({ reserved: await reserveHealthId(), goldenUid: '0x11' });
  const reserved = await reserveHealthId();
  assert.equal(await bindHealthId({ reserved, goldenUid: '0x11', jempiAuxId: first }), first);
  assert.equal(await healthIdRecord(reserved), null);
});

test('two concurrent registrations of one new person get one Health ID', async () => {
  const [a, b] = await Promise.all([reserveHealthId(), reserveHealthId()]);
  const ids = await Promise.all([
    bindHealthId({ reserved: a, goldenUid: '0x12' }),
    bindHealthId({ reserved: b, goldenUid: '0x12' }),
  ]);
  assert.equal(ids[0], ids[1]);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM health_ids`);
  assert.equal(rows[0].n, 1);
});

test('a legacy auxId already held by another golden record is a conflict', async () => {
  const held = await bindHealthId({ reserved: await reserveHealthId(), goldenUid: '0x13' });
  const reserved = await reserveHealthId();
  await assert.rejects(bindHealthId({ reserved, goldenUid: '0x14', jempiAuxId: held }), { status: 409 });
  assert.equal(await healthIdRecord(reserved), null);
});

test('a legacy auxId not yet in the register is adopted', async () => {
  const legacy = generateHealthId();
  const reserved = await reserveHealthId();
  assert.equal(await bindHealthId({ reserved, goldenUid: '0x15', jempiAuxId: legacy }), legacy);
});

test('a retired ID forwards to the survivor and is never active again', async () => {
  const survivor = await bindHealthId({ reserved: await reserveHealthId(), goldenUid: '0x16' });
  const loser = await bindHealthId({ reserved: await reserveHealthId(), goldenUid: '0x17' });
  await retireHealthId({ loserHealthId: loser, survivorHealthId: survivor, survivorGoldenUid: '0x16' });
  assert.deepEqual(await healthIdRecord(loser), { golden_uid: '0x17', status: 'retired', replaced_by: survivor });
});
