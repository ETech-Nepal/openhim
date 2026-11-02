import './fixtures/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool, migrate } from '../src/db/pool.js';
import { upsertTask, withTaskLock, resolveTask, getTask, STATUS } from '../src/db/reviewRepo.js';

test.before(async () => {
  assert.ok(process.env.TEST_IDENTITY_DB_PORT, 'Set TEST_IDENTITY_DB_PORT to the disposable PostgreSQL port');
  await migrate();
});
test.after(() => pool.end());

async function createTask(t) {
  const task = await upsertTask({ goldenA: `0x${randomBytes(5).toString('hex')}`, goldenB: '0x1', score: 0.8, band: 'likely', detail: {} });
  t.after(() => pool.query('DELETE FROM review_tasks WHERE id = $1', [task.id]));
  return task;
}

test('only one simultaneous claimant may own an open review task', async t => {
  const task = await createTask(t);
  const work = async (locked, db) => {
    await sleep(100); // hold the lock while the other caller tries
    return resolveTask(locked.id, { status: STATUS.DISMISSED, resolution: {}, resolvedBy: 'a' }, db);
  };
  const results = await Promise.all([withTaskLock(task.id, work), withTaskLock(task.id, work)]);
  assert.equal(results.filter(Boolean).length, 1, 'both callers acquired the same task');
  assert.equal((await getTask(task.id)).status, STATUS.DISMISSED);
});

test('a failed resolution rolls back and leaves the task open', async t => {
  const task = await createTask(t);
  await assert.rejects(withTaskLock(task.id, async (locked, db) => {
    await resolveTask(locked.id, { status: STATUS.MERGED, resolution: {}, resolvedBy: 'a' }, db);
    throw new Error('merge failed');
  }));
  assert.equal((await getTask(task.id)).status, STATUS.OPEN);
  assert.ok(await withTaskLock(task.id, async () => true), 'the lock was released');
});

test('rescanning cannot reopen a dismissed review pair', async t => {
  const task = await createTask(t);
  await resolveTask(task.id, { status: STATUS.DISMISSED, resolution: {}, resolvedBy: 'synthetic-reviewer' });
  assert.equal(await upsertTask({ goldenA: task.goldenB, goldenB: task.goldenA, score: 0.9, band: 'likely', detail: {} }), null);
  assert.equal(await withTaskLock(task.id, async () => true), null);
});
