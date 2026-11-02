// @ts-nocheck
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
  // JeMPI answers a gid that no longer exists (e.g. a golden consumed by an earlier
  // merge) with an { error } body, as 400 or 200 depending on version. `gone` separates
  // that from JeMPI being down (5xx or no answer), which proves nothing.
  if (!r.ok || r.data?.error) {
    const gone = Boolean(r.data?.error) && r.status > 0 && r.status < 500;
    return { ok: false, gone, error: r.data?.error ?? r.error, record: null };
  }
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
// @ts-nocheck

// ─── Registration (write path) ───────────────────────────────────────────────

/**
 * Register one patient interaction. JeMPI links it to an existing golden record or
 * creates one; the Health ID travels as the interaction's auxId, which becomes the
 * golden record's auxId when the golden is new.
 * Returns { ok, goldenUid, auxId (the golden's stored Health ID), interactionUid }.
 */
export async function registerInteraction(patient, healthId, facility, orchestrations) {
  const payload = {
    candidateThreshold: config.JEMPI_CANDIDATE_THRESHOLD,
    ...toJempi(patient, healthId, facility),
  };
  const r = await call('JeMPI register', config.JEMPI_REGISTER_ROUTE, payload, orchestrations);
  const exists = Array.isArray(r.data?.exists) && r.data.exists.length > 0;
  // A deterministic duplicate comes back as 409 (or 200 on some versions) with an
  // `exists` body and no golden UID. Not a failure: resolve the golden by demographics.
  if (!r.ok && !exists) return { ok: false, error: r.data?.message ?? r.error };

  const linked = r.data?.linkInfo?.goldenUID ?? r.data?.goldenUID ?? r.data?.goldenUid ?? null;
  const interactionUid =
    r.data?.linkInfo?.interactionUID ?? r.data?.interactionUID ?? r.data?.interactionUid ?? null;
  if (!linked && !exists) return { ok: false, error: 'JeMPI returned no golden UID' };

  const g = await lookupGolden(payload.demographicData, linked, orchestrations);
  const goldenUid = linked ?? g.uid;
  if (!goldenUid) return { ok: false, error: 'deterministic duplicate could not be resolved to a golden UID' };
  return { ok: true, goldenUid, auxId: g.auxId, interactionUid: linked ? interactionUid : null };
}

// crCandidates gives the golden's stored auxId (its Health ID).
async function lookupGolden(demographicData, targetUid, orchestrations) {
  const body = { candidateThreshold: config.JEMPI_CANDIDATE_THRESHOLD, demographicData };
  const r = await call('JeMPI candidates', config.JEMPI_CANDIDATES_ROUTE, body, orchestrations);
  const recs = r.data?.goldenRecords ?? [];
  const g = (targetUid && recs.find((x) => x.uid === targetUid)) || (targetUid ? null : recs[0]);
  return { uid: g?.uid ?? null, auxId: g?.uniqueGoldenRecordData?.auxId ?? null };
}

const NATIONAL_ID = 'http://donidcr.gov.np';
const INSURANCE_NUMBER = 'http://hib.gov.np';

function toJempi(p, healthId, facility) {
  const name = (p.name || []).find((n) => n.use === 'official') || p.name?.[0] || {};
  const nid = (p.identifier || []).find((i) => i.system === NATIONAL_ID);
  const bima = (p.identifier || []).find((i) => i.system === INSURANCE_NUMBER);
  const nationalId = nid?.value || bima?.value || '';
  const phone = (p.telecom || []).find((t) => t.system === 'phone');
  const address = (p.address || [])[0] || {};
  return {
    sourceId: { facility, patient: nationalId },
    uniqueInteractionData: { auxDateCreated: jempiTimestamp(), auxId: healthId },
    demographicData: {
      givenName: (name.given || []).join(' '),
      familyName: name.family || '',
      gender: p.gender || '',
      // JeMPI compares dob as a plain string; FHIR YYYY-MM-DD becomes YYYYMMDD.
      dob: p.birthDate ? String(p.birthDate).replace(/-/g, '') : '',
      city: address.city || '',
      phoneNumber: phone?.value || '',
      nationalId,
    },
  };
}

// Nonzero milliseconds prevent Java from dropping seconds on the JeMPI round-trip.
function jempiTimestamp(d = new Date()) {
  if (d.getMilliseconds() === 0) d = new Date(d.getTime() + 1);
  return d.toISOString();
}
