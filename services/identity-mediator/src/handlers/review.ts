// @ts-nocheck
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { buildOpenHIMResponse } from '../lib/orchestration.js';
import { scoringFields } from '../lib/scoring.js';
import * as repo from '../db/reviewRepo.js';
import { STATUS } from '../db/reviewRepo.js';
import { scanForDuplicates } from '../services/scanner.js';
import { mergeGoldenRecords } from '../services/mergeService.js';
import { getExpandedGolden, goldenAuditTrail } from '../providers/jempiProvider.js';
import { findPatient, searchAll } from '../fhir/hapiClient.js';
import { SYS } from '../fhir/identifiers.js';

const reply = (res, status, body, orchestrations = []) =>
  res.status(status).send(buildOpenHIMResponse({ status, body, orchestrations }));

// Who resolved a pair. The admin portal BFF sets this from the verified session;
// merges are irreversible, so a resolution without a named administrator is refused.
const ADMIN_USER = /^[A-Za-z0-9._@-]{1,128}$/;
const actor = (req) => {
  const user = req.get('X-Admin-User');
  return user && ADMIN_USER.test(user) ? user : null;
};

// The task could not be locked: resolved already, or another administrator is on it.
async function lockConflict(res, id) {
  const current = await repo.getTask(id);
  if (!current) return reply(res, 404, { error: 'review task not found' });
  const busy = [STATUS.OPEN, STATUS.MERGE_PARTIAL].includes(current.status);
  return reply(res, 409, {
    error: busy ? 'task is being resolved by another administrator' : `task already resolved (${current.status})`,
  });
}

export async function listHandler(req, res, next) {
  try {
    const status = String(req.query.status ?? STATUS.OPEN).toUpperCase();
    const { tasks, counts } = await repo.listTasks({
      status,
      limit: Math.min(Number(req.query.limit) || 50, 200),
      offset: Number(req.query.offset) || 0,
    });
    reply(res, 200, {
      tasks,
      counts,
      thresholds: { low: config.REVIEW_LOW_THRESHOLD, high: config.REVIEW_HIGH_THRESHOLD },
      fields: scoringFields,
    });
  } catch (err) { next(err); }
}

/**
 * Full context for one pair: the scored comparison plus what each side actually holds
 * in HAPI. An admin cannot judge a merge from demographics alone — "this one has 4
 * encounters and that one has none" is usually the deciding evidence.
 */
export async function detailHandler(req, res, next) {
  const orchestrations = [];
  try {
    const task = await repo.getTask(req.params.id);
    if (!task) return reply(res, 404, { error: 'review task not found' });

    const sides = {};
    for (const [side, uid] of [['a', task.goldenA], ['b', task.goldenB]]) {
      const golden = await getExpandedGolden(uid, orchestrations);
      const snapshot = task.detail?.[side] ?? {};
      const healthId = golden.ok
        ? golden.record?.goldenRecord?.uniqueGoldenRecordData?.auxId ?? null
        : snapshot.healthId ?? null;

      let patient = null;
      const clinical = {};
      if (healthId) {
        patient = await findPatient(SYS.NEPAL_HEALTH_ID, healthId).catch(() => null);
        for (const type of patient ? config.MERGE_REFERENCING_TYPES : []) {
          try {
            const found = await searchAll(type, { patient: `Patient/${patient.id}`, _count: '200' });
            if (found.length) clinical[type] = found.length;
          } catch (err) {
            logger.warn({ err: err.message, type, healthId }, 'clinical count failed');
          }
        }
      }

      sides[side] = {
        goldenUid: uid,
        // A golden may have been consumed by an earlier merge; show the scan snapshot.
        exists: golden.ok,
        healthId,
        demographics: golden.ok ? golden.record?.goldenRecord?.demographicData : snapshot.demographics,
        interactions: golden.ok ? (golden.record?.interactionsWithScore ?? []).length : null,
        facilities: golden.ok
          ? (golden.record?.goldenRecord?.sourceId ?? []).map((s) => s.facility).filter(Boolean)
          : snapshot.facilities ?? [],
        patient: patient && {
          id: patient.id,
          active: patient.active !== false,
          name: patient.name,
          identifiers: patient.identifier ?? [],
          link: patient.link ?? [],
        },
        clinical,
      };
    }

    reply(res, 200, { task, sides, thresholds: { low: config.REVIEW_LOW_THRESHOLD, high: config.REVIEW_HIGH_THRESHOLD } }, orchestrations);
  } catch (err) { next(err); }
}

export async function scanHandler(req, res, next) {
  try {
    const stats = await scanForDuplicates({});
    reply(res, 200, stats);
  } catch (err) { next(err); }
}

/**
 * Resolve a pair as "same person": merge in JeMPI AND reconcile HAPI.
 * Body: { survivorUid }
 */
export async function mergeHandler(req, res, next) {
  try {
    const by = actor(req);
    if (!by) return reply(res, 400, { error: 'X-Admin-User is required' });
    const task = await repo.getTask(req.params.id);
    if (!task) return reply(res, 404, { error: 'review task not found' });

    const survivorUid = req.body?.survivorUid;
    if (![task.goldenA, task.goldenB].includes(survivorUid)) {
      return reply(res, 400, { error: `survivorUid must be one of ${task.goldenA}, ${task.goldenB}` });
    }
    const loserUid = survivorUid === task.goldenA ? task.goldenB : task.goldenA;

    // The row lock is held for the whole merge: a merge cannot be undone, so two
    // admins resolving the same pair concurrently must not both proceed.
    const outcome = await repo.withTaskLock(task.id, async (locked, db) => {
      const result = await mergeGoldenRecords({ survivorUid, loserUid, score: locked.score });
      if (!result.ok) {
        if (result.status === 'MERGE_PARTIAL') {
          await repo.resolveTask(locked.id, {
            status: STATUS.MERGE_PARTIAL,
            resolution: { survivorUid, loserUid, error: result.error, at: new Date().toISOString() },
            resolvedBy: by,
          }, db);
        }
        return { result };
      }
      const resolved = await repo.resolveTask(locked.id, {
        status: STATUS.MERGED,
        resolution: { ...result.result, at: new Date().toISOString() },
        resolvedBy: by,
      }, db);
      return { result, resolved };
    });
    if (!outcome) return lockConflict(res, task.id);

    const { result, resolved } = outcome;
    if (!result.ok) {
      if (result.status === 'MERGE_PARTIAL') {
        return reply(res, 500, {
          error: result.error,
          status: 'MERGE_PARTIAL',
          detail: 'Identity was merged in JeMPI but HAPI reconciliation did not complete. Retry this merge — the HAPI steps are idempotent.',
        }, result.orchestrations);
      }
      return reply(res, 400, { error: result.error, status: result.status }, result.orchestrations);
    }

    // The losing golden no longer exists; any other OPEN pair naming it is now moot.
    const purged = await repo.purgeOpenTasksForGolden(loserUid);
    logger.info({ survivorUid, loserUid, by, purged }, 'merge complete');
    reply(res, 200, { task: resolved, result: result.result, purgedStaleTasks: purged }, result.orchestrations);
  } catch (err) { next(err); }
}

/** Resolve a pair as "not the same person". Records the decision so rescans respect it. */
export async function dismissHandler(req, res, next) {
  try {
    const by = actor(req);
    if (!by) return reply(res, 400, { error: 'X-Admin-User is required' });
    const task = await repo.getTask(req.params.id);
    if (!task) return reply(res, 404, { error: 'review task not found' });

    const resolved = await repo.withTaskLock(task.id, (locked, db) =>
      repo.resolveTask(locked.id, {
        status: STATUS.DISMISSED,
        resolution: { reason: req.body?.reason ?? null, at: new Date().toISOString() },
        resolvedBy: by,
      }, db),
    );
    if (!resolved) return lockConflict(res, task.id);
    reply(res, 200, { task: resolved });
  } catch (err) { next(err); }
}

/** Audit trail for a golden record — how it came to hold the interactions it has. */
export async function auditHandler(req, res, next) {
  const orchestrations = [];
  try {
    const { entries } = await goldenAuditTrail(req.params.gid, orchestrations);
    reply(res, 200, { goldenUid: req.params.gid, entries }, orchestrations);
  } catch (err) { next(err); }
}
// @ts-nocheck
