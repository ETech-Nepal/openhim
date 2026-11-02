import { pool } from './pool.js';
import { generateHealthId, isValidHealthId } from '../patient/healthId.js';
import { HttpError } from '../lib/httpError.js';

// Health ID issuing. Uniqueness is the table's primary key, not a search of HAPI, so
// two concurrent registrations can never receive the same ID, and a failure to
// allocate fails the request instead of accepting an unchecked candidate.

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

/** Reserve a fresh random Health ID before JeMPI is called (it becomes the auxId). */
export async function reserveHealthId(generate = generateHealthId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generate();
    const { rowCount } = await pool.query(
      `INSERT INTO health_ids (health_id) VALUES ($1) ON CONFLICT (health_id) DO NOTHING`,
      [candidate],
    );
    if (rowCount) return candidate;
  }
  throw new HttpError(502, 'exception', 'Could not allocate a unique Health ID after 5 attempts');
}

export async function releaseReservation(healthId: string) {
  await pool.query(`DELETE FROM health_ids WHERE health_id = $1 AND status = 'reserved'`, [healthId]);
}

async function activeFor(goldenUid: string) {
  const { rows } = await pool.query<{ health_id: string }>(
    `SELECT health_id FROM health_ids WHERE golden_uid = $1 AND status = 'active'`,
    [goldenUid],
  );
  return rows[0]?.health_id ?? null;
}

/**
 * The Health ID of a golden record, once JeMPI has named it. Reuses the golden's
 * existing ID; adopts a valid ID JeMPI already holds as the golden's auxId (records
 * from before this table existed); otherwise binds the reservation.
 */
export async function bindHealthId({
  reserved,
  goldenUid,
  jempiAuxId,
}: {
  reserved: string;
  goldenUid: string;
  jempiAuxId?: string | null;
}) {
  // Two passes: a concurrent registration of the same new person may bind first.
  for (let pass = 0; pass < 2; pass++) {
    const existing = await activeFor(goldenUid);
    if (existing) {
      await releaseReservation(reserved);
      return existing;
    }
    try {
      if (jempiAuxId && jempiAuxId !== reserved && isValidHealthId(jempiAuxId)) {
        await pool.query(
          `INSERT INTO health_ids (health_id, golden_uid, status) VALUES ($1, $2, 'active')
           ON CONFLICT (health_id) DO NOTHING`,
          [jempiAuxId, goldenUid],
        );
        const { rows } = await pool.query<{ golden_uid: string | null; status: string }>(
          `SELECT golden_uid, status FROM health_ids WHERE health_id = $1`,
          [jempiAuxId],
        );
        await releaseReservation(reserved);
        if (rows[0]?.golden_uid === goldenUid && rows[0].status === 'active') return jempiAuxId;
        throw new HttpError(
          409,
          'conflict',
          `Health ID ${jempiAuxId} on golden record ${goldenUid} is registered to another person`,
        );
      }
      const { rowCount } = await pool.query(
        `UPDATE health_ids SET golden_uid = $2, status = 'active', updated_at = now()
          WHERE health_id = $1 AND status = 'reserved'`,
        [reserved, goldenUid],
      );
      if (rowCount) return reserved;
      throw new HttpError(500, 'exception', `Health ID reservation ${reserved} was lost`);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  await releaseReservation(reserved);
  throw new HttpError(409, 'conflict', `Golden record ${goldenUid} is being registered concurrently; resend`);
}

export async function healthIdRecord(healthId: string) {
  const { rows } = await pool.query<{ golden_uid: string | null; status: string; replaced_by: string | null }>(
    `SELECT golden_uid, status, replaced_by FROM health_ids WHERE health_id = $1`,
    [healthId],
  );
  return rows[0] ?? null;
}

/** After a merge: the loser's ID is retired and forwards to the survivor's, never reissued. */
export async function retireHealthId({
  loserHealthId,
  survivorHealthId,
  survivorGoldenUid,
}: {
  loserHealthId: string;
  survivorHealthId: string;
  survivorGoldenUid: string;
}) {
  await pool.query(
    `INSERT INTO health_ids (health_id, golden_uid, status) VALUES ($1, $2, 'active')
     ON CONFLICT (health_id) DO NOTHING`,
    [survivorHealthId, survivorGoldenUid],
  );
  await pool.query(
    `INSERT INTO health_ids (health_id, status, replaced_by) VALUES ($1, 'retired', $2)
     ON CONFLICT (health_id) DO UPDATE
       SET status = 'retired', replaced_by = EXCLUDED.replaced_by, updated_at = now()`,
    [loserHealthId, survivorHealthId],
  );
}

/** Backfill: record an ID that already exists in HAPI. Returns false if it conflicts. */
export async function importHealthId(healthId: string, goldenUid: string | null, active: boolean) {
  const { rowCount } = await pool.query(
    `INSERT INTO health_ids (health_id, golden_uid, status) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [healthId, active ? goldenUid : null, active ? 'active' : 'retired'],
  );
  return rowCount === 1;
}
