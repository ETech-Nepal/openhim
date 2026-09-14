import './fixtures/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pool, migrate } from '../src/db/pool.js';
import { upsertTask, claimOpenTask, resolveTask, STATUS } from '../src/db/reviewRepo.js';

test.before(async () => {
  assert.ok(process.env.TEST_REVIEW_DB_PORT, 'Set TEST_REVIEW_DB_PORT to the disposable PostgreSQL port');
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
  const claims = await Promise.all([claimOpenTask(task.id), claimOpenTask(task.id)]);
  assert.equal(claims.filter(Boolean).length, 1, 'both callers acquired the same task');
});

test('rescanning cannot reopen a dismissed review pair', async t => {
  const task = await createTask(t);
  await resolveTask(task.id, { status: STATUS.DISMISSED, resolution: {}, resolvedBy: 'synthetic-reviewer' });
  assert.equal(await upsertTask({ goldenA: task.goldenB, goldenB: task.goldenA, score: 0.9, band: 'likely', detail: {} }), null);
  assert.equal(await claimOpenTask(task.id), null);
});
