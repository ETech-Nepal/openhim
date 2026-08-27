import axios from 'axios';
import { config, facilityRegistry } from '../config.js';
import { logger } from '../lib/logger.js';
import { SYS } from '../fhir/identifiers.js';
import { orch } from '../lib/orchestration.js';

const client = axios.create({
  baseURL: config.JEMPI_BASE_URL,
  timeout: config.JEMPI_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
});

/**
 * Register a new patient interaction with JeMPI.
 * On success returns { ok, goldenUid, interactionUid, raw, orchestration }.
 *
 * <<CONFIRM in Phase 0:
 *   - exact route (likely `/crRegister`)
 *   - request body shape — typical JeMPI v2 envelope:
 *       { sourceId: { facility, patient },
 *         uniqueInteractionData: { auxDateCreated, auxId, ... },
 *         demographicData: { givenName, familyName, gender, dob, nationalId, ... } }
 *   - response body shape — typical:
 *       { linkInfo: { goldenUID, interactionID, score } }  OR
 *       { goldenUID, interactionID }
 * >>
 */
// Register (or dedup) a Patient with JeMPI. `healthId` is stored as the JeMPI
// interaction's auxId, which propagates to the golden record's auxId — JeMPI's
// consistent 1:1 handle for the person. Returns { ok, goldenUid, healthAux,
// matched, interactionUid, orchestrations }. `healthAux` is the Health ID JeMPI
// already holds for this golden record (so re-registration reuses it without a
// HAPI search); the caller falls back to `healthId` for a brand-new person.
export async function registerInteraction(fhirPatient, healthId, clientId) {
  const payload = {
    candidateThreshold: config.JEMPI_CANDIDATE_THRESHOLD,
    ...mapFhirPatientToJempi(fhirPatient, healthId, clientId),
  };
  const path = config.JEMPI_REGISTER_ROUTE;
  const orchestrations = [];

  const result = (uid, auxId, matched, interactionUid, raw) => ({
    ok: !!uid, goldenUid: uid, healthAux: auxId, matched, interactionUid,
    error: uid ? undefined : 'JeMPI returned no goldenUID', raw, orchestrations,
  });

  try {
    const { data, status } = await client.post(path, payload);
    logger.debug({ status, data }, 'JeMPI register response');
    orchestrations.push(orch('JeMPI register', 'POST', path, payload, status, data));

    // New golden or probabilistic link → we know the golden UID; read its stored
    // auxId (the person's Health ID) back for consistent reuse.
    const linked = extractGoldenUid(data);
    if (linked) {
      const g = await lookupGolden(payload.demographicData, orchestrations, linked);
      return result(linked, g.auxId, false, extractInteractionUid(data), data);
    }
    // Some versions return 200 with an `exists` body for a deterministic dup.
    if (Array.isArray(data?.exists) && data.exists.length > 0) {
      const g = await lookupGolden(payload.demographicData, orchestrations);
      return result(g.uid, g.auxId, true, null, data);
    }
    return result(null, null, false, null, data);
  } catch (err) {
    const status = err.response?.status ?? 0;
    const body = err.response?.data ?? { message: err.message };
    orchestrations.push(orch('JeMPI register', 'POST', path, payload, status, body));

    // A deterministic duplicate comes back as HTTP 409 with an `exists` body (no
    // goldenUID). Not a failure — resolve the golden UID + its stored Health ID.
    if (Array.isArray(body?.exists) && body.exists.length > 0) {
      const g = await lookupGolden(payload.demographicData, orchestrations);
      if (g.uid) return result(g.uid, g.auxId, true, null, body);
      logger.error({ body }, 'JeMPI deterministic dup but crCandidates returned no golden UID');
      return { ok: false, error: 'deterministic dup could not be resolved to a golden UID', orchestrations };
    }
    logger.error({ status, body }, 'JeMPI register failed');
    return { ok: false, error: err.message, orchestrations };
  }
}

// Resolve a golden record (and its stored auxId = Health ID) by demographics via
// crCandidates — a consistent Dgraph read, unlike a HAPI search. When `targetUid`
// is given (probabilistic/link path), pick that exact golden; otherwise take the
// top-ranked candidate (deterministic-dup path).
async function lookupGolden(demographicData, orchestrations, targetUid) {
  const path = config.JEMPI_CANDIDATES_ROUTE;
  const body = { candidateThreshold: config.JEMPI_CANDIDATE_THRESHOLD, demographicData };
  try {
    const { data, status } = await client.post(path, body);
    orchestrations.push(orch('JeMPI candidates', 'POST', path, body, status, data));
    const recs = data?.goldenRecords ?? [];
    const g = (targetUid && recs.find(r => r.uid === targetUid)) || recs[0];
    return { uid: g?.uid ?? null, auxId: g?.uniqueGoldenRecordData?.auxId ?? null };
  } catch (err) {
    orchestrations.push(orch('JeMPI candidates', 'POST', path, body, err.response?.status ?? 0, err.response?.data ?? { message: err.message }));
    logger.error({ err: err.message }, 'JeMPI crCandidates lookup failed');
    return { uid: null, auxId: null };
  }
}

/**
 * Probabilistic find — used before registering to check if the patient already exists.
 * Optional; depending on JeMPI config, `crRegister` may already handle the find-or-create
 * semantics internally. <<CONFIRM in Phase 0>>
 */
export async function findInteraction(fhirPatient) {
  const payload = mapFhirPatientToJempi(fhirPatient);
  const path = config.JEMPI_FIND_ROUTE;
  try {
    const { data, status } = await client.post(path, payload);
    return {
      ok: true,
      candidates: extractCandidates(data),
      raw: data,
      orchestration: orch('JeMPI find', 'POST', path, payload, status, data),
    };
  } catch (err) {
    const status = err.response?.status ?? 0;
    return {
      ok: false,
      error: err.message,
      orchestration: orch('JeMPI find', 'POST', path, payload, status, err.response?.data),
    };
  }
}

// JeMPI's /expandedGoldenRecord is a POST taking { gid }.
export async function getGoldenRecord(goldenUid) {
  const path = config.JEMPI_GOLDEN_GET_ROUTE;
  const body = { gid: goldenUid };
  try {
    const { data, status } = await client.post(path, body);
    return {
      ok: true,
      record: data,
      orchestration: orch('JeMPI getGoldenRecord', 'POST', path, body, status, data),
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      orchestration: orch('JeMPI getGoldenRecord', 'POST', path, body, err.response?.status ?? 0, err.response?.data),
    };
  }
}

// ─── Mapping ─────────────────────────────────────────────────────────────────
// Maps a FHIR Patient to JeMPI's crRegister demographicData. The JeMPI link
// config (jempi-config/) keys on: given_name, family_name, gender, dob, city,
// phone_number, national_id. National ID is optional — JeMPI skips blank fields.

function mapFhirPatientToJempi(p, healthId, clientId) {
  const name = (p.name || []).find(n => n.use === 'official') || p.name?.[0] || {};
  // Deterministic matching runs on NID or BIMA (Health Insurance Board number) —
  // NID preferred when both are present. Neither is the mediator's own Health ID
  // (SYS.NEPAL_HEALTH_ID); that was a bug here — this field must carry a real
  // government-issued identifier or matching silently degrades to demographics-only.
  const nid = (p.identifier || []).find(i => i.system === SYS.NATIONAL_ID);
  const bima = (p.identifier || []).find(i => i.system === SYS.INSURANCE_NUMBER);
  const nationalId = nid?.value || bima?.value || '';
  const phone = (p.telecom || []).find(t => t.system === 'phone');
  const address = (p.address || [])[0] || {};
  const facility = resolveFacility(p, clientId);
  // Store the Health ID as the JeMPI auxId — it propagates to the golden record's
  // auxId (JeMPI's consistent 1:1 handle) and is read back on re-registration.
  const auxId = healthId || nationalId || `${name.family || ''}-${p.birthDate || ''}`;
  return {
    sourceId: {
      facility,
      patient: nationalId,
    },
    uniqueInteractionData: {
      auxDateCreated: jempiTimestamp(),
      auxId,
    },
    demographicData: {
      givenName: (name.given || []).join(' '),
      familyName: name.family || '',
      gender: p.gender || '',
      dob: normalizeDob(p.birthDate),     // FHIR YYYY-MM-DD -> JeMPI YYYYMMDD
      city: address.city || '',
      phoneNumber: phone?.value || '',
      nationalId,
    },
  };
}

// JeMPI dob is a plain string compared with Jaro-Winkler; normalise to YYYYMMDD
// so values from different sources align.
function normalizeDob(birthDate) {
  return birthDate ? String(birthDate).replace(/-/g, '') : '';
}

// auxDateCreated must survive JeMPI's round-trip. The API requires fractional
// seconds (`.SSS`), but JeMPI stores via Java LocalDateTime.toString(), which
// DROPS the seconds field when BOTH seconds and millis are zero — producing
// `...THH:mm`, which Dgraph's dateTime parser rejects (`cannot parse "" as ":"`).
// Guaranteeing non-zero milliseconds forces the seconds field to always be
// emitted, so `...THH:mm:ss.SSS` is always well-formed.
function jempiTimestamp(d = new Date()) {
  if (d.getMilliseconds() === 0) d = new Date(d.getTime() + 1);
  return d.toISOString();
}

// Facility = the registering organisation. Server-derived: the authenticated
// OpenHIM clientID (set by OpenHIM via X-OpenHIM-ClientID, not forgeable by the
// caller) IS the facility's NHFR code (keycloak/onboard-hospital.sh). A hospital
// can only ever be stamped as its own client's NHFR code, regardless of what it
// puts in Patient.managingOrganization.
//   - FACILITY_REGISTRY_JSON is an optional override, only for legacy clients
//     whose clientID isn't an NHFR code.
//   - Callers with no clientID (local scripts, bulk tooling) fall back to the
//     payload's managingOrganization — weaker, but keeps them working.
// Exported so written resources are stamped with the same facility JeMPI recorded
// as the interaction's source (see fhir/provenance.js).
export function resolveFacility(p, clientId) {
  if (clientId && facilityRegistry[clientId]) return facilityRegistry[clientId];
  if (clientId) return clientId;
  const mo = p.managingOrganization;
  return mo?.identifier?.value
    || mo?.reference?.split('/').pop()
    || config.JEMPI_DEFAULT_FACILITY;
}

function extractGoldenUid(data)      { return data?.linkInfo?.goldenUID ?? data?.goldenUID ?? data?.goldenUid ?? null; }
function extractInteractionUid(data) { return data?.linkInfo?.interactionUID ?? data?.interactionUID ?? data?.interactionUid ?? data?.linkInfo?.interactionID ?? null; }
function extractCandidates(data)     { return data?.candidates ?? data?.goldenRecords ?? []; }
