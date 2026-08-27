import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { orch } from '../lib/orchestration.js';

const client = axios.create({
  baseURL: config.JEMPI_BASE_URL,
  timeout: config.JEMPI_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
});

async function call(name, path, body, orchestrations) {
  try {
    const { data, status } = await client.post(path, body);
    orchestrations?.push(orch(name, 'POST', path, body, status, data));
    return { ok: true, data, status };
  } catch (err) {
    const status = err.response?.status ?? 0;
    const data = err.response?.data ?? { message: err.message };
    orchestrations?.push(orch(name, 'POST', path, body, status, data));
    logger.error({ path, status, data }, `JeMPI ${name} failed`);
    return { ok: false, data, status, error: err.message };
  }
}

/** All golden record ids. */
export async function listGoldenIds(orchestrations) {
  try {
    const { data, status } = await client.get('/gidsAll');
    orchestrations?.push(orch('JeMPI gidsAll', 'GET', '/gidsAll', null, status, data));
    return { ok: true, ids: data?.records ?? [] };
  } catch (err) {
    logger.error({ err: err.message }, 'JeMPI gidsAll failed');
    return { ok: false, ids: [], error: err.message };
  }
}

/** A golden record plus every interaction linked to it. */
export async function getExpandedGolden(gid, orchestrations) {
  const r = await call('JeMPI expandedGoldenRecord', '/expandedGoldenRecord', { gid }, orchestrations);
  // JeMPI answers 200 with an { error } body for a gid that no longer exists (e.g. a
  // golden consumed by an earlier merge), so success needs an explicit shape check.
  if (!r.ok || r.data?.error) return { ok: false, error: r.data?.error ?? r.error, record: null };
  return { ok: true, record: r.data };
}

export async function getExpandedGoldens(uidList, orchestrations) {
  if (!uidList.length) return { ok: true, records: [] };
  const r = await call('JeMPI expandedGoldenRecords', '/expandedGoldenRecords', { uidList }, orchestrations);
  return { ok: r.ok, records: Array.isArray(r.data) ? r.data : [], error: r.error };
}

export async function goldenAuditTrail(gid, orchestrations) {
  const r = await call('JeMPI goldenRecordAuditTrail', '/goldenRecordAuditTrail', { gid }, orchestrations);
  const entries = Array.isArray(r.data) ? r.data : (r.data?.entries ?? []);
  return { ok: r.ok, entries };
}

/**
 * Candidate discovery.
 *
 * Mirrors the `rules.link.probabilistic` blocking expression from the deployed JeMPI
 * config as an OR of AND-groups:
 *   match(given_name,3) and match(family_name,3)
 *   or match(given_name,3) and match(dob,3)
 *   or match(family_name,3) and match(dob,3)
 *   or match(phone_number,2)
 *   or match(national_id,3)
 *
 * NOTE: crCandidates cannot do this. It is driven by the DETERMINISTIC rules, so it
 * only ever returns records that already match exactly — lowering its candidateThreshold
 * to 0.3 still returns nothing new (verified). /customSearch/golden is the only endpoint
 * that performs the fuzzy blocking we need.
 */
export async function findCandidates(demographics, orchestrations) {
  const { givenName, familyName, dob, phoneNumber, nationalId } = demographics;
  const p = (fieldName, value, distance) => ({ fieldName, value, distance });
  const groups = [];

  if (givenName && familyName) groups.push({ parameters: [p('givenName', givenName, 3), p('familyName', familyName, 3)] });
  if (givenName && dob) groups.push({ parameters: [p('givenName', givenName, 3), p('dob', dob, 3)] });
  if (familyName && dob) groups.push({ parameters: [p('familyName', familyName, 3), p('dob', dob, 3)] });
  // A placeholder phone must not be a blocking key: it would pull in every record that
  // shares the placeholder and blow the candidate set up to the whole registry.
  if (phoneNumber && !config.PLACEHOLDER_PHONES.includes(phoneNumber)) {
    groups.push({ parameters: [p('phoneNumber', phoneNumber, 2)] });
  }
  if (nationalId) groups.push({ parameters: [p('nationalId', nationalId, 3)] });

  if (!groups.length) return { ok: true, records: [] };

  const body = { $or: groups, sortBy: 'givenName', sortAsc: true, offset: 0, limit: 100 };
  const r = await call('JeMPI customSearch/golden', '/customSearch/golden', body, orchestrations);
  return { ok: r.ok, records: r.data?.data ?? [], error: r.error };
}

/**
 * Move an interaction onto a different golden record.
 *
 * `notificationId` is a UUID we generate. JeMPI does NOT validate it against its own
 * notification table — verified live: a fabricated UUID is accepted and the relink is
 * performed. That is what lets us own the review queue while JeMPI's own notification
 * queue stays empty (crRegister never emits notifications).
 *
 * Side effect worth knowing: when the last interaction leaves a golden record, JeMPI
 * DELETES that golden, and its auxId (the person's Health ID) goes with it. HAPI must
 * therefore keep the retired Health ID resolvable — see services/mergeService.js.
 */
export async function relinkInteraction({ interactionId, fromGoldenId, toGoldenId, score = 1 }, orchestrations) {
  const body = {
    notificationId: randomUUID(),
    notificationType: 'THRESHOLD',
    interactionId,
    currentGoldenId: fromGoldenId,
    resolutionState: 'RELINKED',
    currentCandidates: [toGoldenId],
    newGoldenId: toGoldenId,
    score,
  };
  const r = await call('JeMPI relink', '/relink', body, orchestrations);
  if (!r.ok) return { ok: false, error: r.data?.message ?? r.error };
  return { ok: true, goldenUid: r.data?.goldenUID ?? null, raw: r.data };
}

export async function countRecords() {
  const { data } = await client.get('/countRecords');
  return data;
}
