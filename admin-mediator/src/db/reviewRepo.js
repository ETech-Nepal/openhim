import { randomUUID } from 'node:crypto';
import { pool } from './pool.js';

export const STATUS = {
  OPEN: 'OPEN',
  MERGED: 'MERGED',
  DISMISSED: 'DISMISSED',
  // JeMPI relinked but HAPI reconciliation did not finish. The two stores disagree
  // until this is retried, so it is a distinct, visible state — never silently 'MERGED'.
  MERGE_PARTIAL: 'MERGE_PARTIAL',
};

// Golden UIDs are Dgraph hex ids ('0x51'). Sorting them numerically gives one stable
// key per unordered pair, so {A,B} and {B,A} can never both be queued.
export function pairKey(a, b) {
  const [x, y] = [a, b].sort((p, q) => parseInt(p, 16) - parseInt(q, 16));
  return `${x}|${y}`;
}

const map = (r) => r && ({
  id: r.id,
  pairKey: r.pair_key,
  goldenA: r.golden_a,
  goldenB: r.golden_b,
  score: Number(r.score),
  band: r.band,
  status: r.status,
  detail: r.detail,
  resolution: r.resolution,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Insert a discovered pair, or refresh its score if it is still OPEN.
 *
 * A pair an admin already decided on must never come back: DO NOTHING on conflict for
 * any non-OPEN row keeps DISMISSED ('not the same person') and MERGED final. Without
 * that guard every rescan would resurrect dismissed pairs and the queue would never
 * drain.
 */
export async function upsertTask({ goldenA, goldenB, score, band, detail }) {
  const key = pairKey(goldenA, goldenB);
  const [a, b] = key.split('|');
  const { rows } = await pool.query(
    `INSERT INTO review_tasks (id, pair_key, golden_a, golden_b, score, band, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (pair_key) DO UPDATE
       SET score = EXCLUDED.score,
           band = EXCLUDED.band,
           detail = EXCLUDED.detail,
           updated_at = now()
       WHERE review_tasks.status = '${STATUS.OPEN}'
     RETURNING *`,
    [randomUUID(), key, a, b, score, band, detail],
  );
  return map(rows[0]) ?? null; // null => conflict on an already-resolved pair
}

export async function listTasks({ status = STATUS.OPEN, limit = 50, offset = 0 } = {}) {
  const all = status === 'ALL';
  const { rows } = await pool.query(
    `SELECT * FROM review_tasks
      ${all ? '' : 'WHERE status = $3'}
      ORDER BY score DESC, created_at ASC
      LIMIT $1 OFFSET $2`,
    all ? [limit, offset] : [limit, offset, status],
  );
  const { rows: counts } = await pool.query('SELECT status, count(*)::int AS n FROM review_tasks GROUP BY status');
  return {
    tasks: rows.map(map),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  };
}

export async function getTask(id) {
  const { rows } = await pool.query('SELECT * FROM review_tasks WHERE id = $1', [id]);
  return map(rows[0]) ?? null;
}

export async function resolveTask(id, { status, resolution, resolvedBy }) {
  const { rows } = await pool.query(
    `UPDATE review_tasks
        SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, status, resolution, resolvedBy],
  );
  return map(rows[0]) ?? null;
}

/**
 * Claim an OPEN task for resolution.
 *
 * Conditional on status so two admins hitting Merge on the same pair cannot both
 * proceed — the second update matches no row and the caller reports a conflict. Merges
 * are irreversible here, so a lost update is not acceptable.
 */
export async function claimOpenTask(id) {
  const { rows } = await pool.query(
    `UPDATE review_tasks SET updated_at = now()
      WHERE id = $1 AND status IN ($2, $3)
      RETURNING *`,
    [id, STATUS.OPEN, STATUS.MERGE_PARTIAL],
  );
  return map(rows[0]) ?? null;
}

/** Drop OPEN tasks referencing a golden that no longer exists (consumed by a merge). */
export async function purgeOpenTasksForGolden(goldenUid) {
  const { rowCount } = await pool.query(
    `DELETE FROM review_tasks
      WHERE status = $2 AND (golden_a = $1 OR golden_b = $1)`,
    [goldenUid, STATUS.OPEN],
  );
  return rowCount;
}
