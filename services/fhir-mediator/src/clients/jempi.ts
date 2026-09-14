import type { Resource, JempiResponse } from '../fhir/types.js';
import type { Orchestration } from '../lib/orchestration.js';
type RegistrationResult = {
  ok: boolean;
  goldenUid?: string | null;
  healthAux?: string | null;
  matched?: boolean;
  interactionUid?: string | null;
  error?: string;
  raw?: unknown;
  orchestrations: Orchestration[];
};

import { upstreamError } from '../lib/errors.js';
import axios from 'axios';
import { config, facilityRegistry } from '../config.js';
import { logger } from '../lib/logger.js';
import { SYS } from '../fhir/identifiers.js';
import { orch } from '../lib/orchestration.js';

const client = axios.create({
  baseURL: config.JEMPI_BASE_URL,
  timeout: config.JEMPI_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
});

export async function registerInteraction(
  fhirPatient: Resource,
  healthId?: string,
  clientId?: string | string[],
): Promise<RegistrationResult> {
  const payload = {
    candidateThreshold: config.JEMPI_CANDIDATE_THRESHOLD,
    ...mapFhirPatientToJempi(fhirPatient, healthId, clientId),
  };
  const path = config.JEMPI_REGISTER_ROUTE;
  const orchestrations: Orchestration[] = [];

  const result = (
    uid: string | null,
    auxId: string | null,
    matched: boolean,
    interactionUid: string | null,
    raw: unknown,
  ) => ({
    ok: !!uid,
    goldenUid: uid,
    healthAux: auxId,
    matched,
    interactionUid,
    error: uid ? undefined : 'JeMPI returned no goldenUID',
    raw,
    orchestrations,
  });

  try {
    const { data, status } = await client.post<JempiResponse>(path, payload);
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
  } catch (caught) {
    const err = upstreamError(caught);
    const status = err.response?.status ?? 0;
    const body = err.response?.data ?? { message: err.message };
    orchestrations.push(orch('JeMPI register', 'POST', path, payload, status, body));

    // A deterministic duplicate comes back as HTTP 409 with an `exists` body (no
    // goldenUID). Not a failure — resolve the golden UID + its stored Health ID.
    if (
      body &&
      typeof body === 'object' &&
      'exists' in body &&
      Array.isArray(body.exists) &&
      body.exists.length > 0
    ) {
      const g = await lookupGolden(payload.demographicData, orchestrations);
      if (g.uid) return result(g.uid, g.auxId, true, null, body);
      logger.error({ body }, 'JeMPI deterministic dup but crCandidates returned no golden UID');
      return {
        ok: false,
        error: 'deterministic dup could not be resolved to a golden UID',
        orchestrations,
      };
    }
    logger.error({ status, body }, 'JeMPI register failed');
    return { ok: false, error: err.message, orchestrations };
  }
}

async function lookupGolden(
  demographicData: Record<string, string>,
  orchestrations: Orchestration[],
  targetUid?: string,
) {
  const path = config.JEMPI_CANDIDATES_ROUTE;
  const body = { candidateThreshold: config.JEMPI_CANDIDATE_THRESHOLD, demographicData };
  try {
    const { data, status } = await client.post<JempiResponse>(path, body);
    orchestrations.push(orch('JeMPI candidates', 'POST', path, body, status, data));
    const recs = data?.goldenRecords ?? [];
    const g = (targetUid && recs.find((r) => r.uid === targetUid)) || recs[0];
    return { uid: g?.uid ?? null, auxId: g?.uniqueGoldenRecordData?.auxId ?? null };
  } catch (caught) {
    const err = upstreamError(caught);
    orchestrations.push(
      orch(
        'JeMPI candidates',
        'POST',
        path,
        body,
        err.response?.status ?? 0,
        err.response?.data ?? { message: err.message },
      ),
    );
    logger.error({ err: err.message }, 'JeMPI crCandidates lookup failed');
    return { uid: null, auxId: null };
  }
}

export async function findInteraction(fhirPatient: Resource) {
  const payload = mapFhirPatientToJempi(fhirPatient);
  const path = config.JEMPI_FIND_ROUTE;
  try {
    const { data, status } = await client.post<JempiResponse>(path, payload);
    return {
      ok: true,
      candidates: extractCandidates(data),
      raw: data,
      orchestration: orch('JeMPI find', 'POST', path, payload, status, data),
    };
  } catch (caught) {
    const err = upstreamError(caught);
    const status = err.response?.status ?? 0;
    return {
      ok: false,
      error: err.message,
      orchestration: orch('JeMPI find', 'POST', path, payload, status, err.response?.data),
    };
  }
}

// JeMPI's /expandedGoldenRecord is a POST taking { gid }.
export async function getGoldenRecord(goldenUid: string) {
  const path = config.JEMPI_GOLDEN_GET_ROUTE;
  const body = { gid: goldenUid };
  try {
    const { data, status } = await client.post<JempiResponse>(path, body);
    return {
      ok: true,
      record: data,
      orchestration: orch('JeMPI getGoldenRecord', 'POST', path, body, status, data),
    };
  } catch (caught) {
    const err = upstreamError(caught);
    return {
      ok: false,
      error: err.message,
      orchestration: orch(
        'JeMPI getGoldenRecord',
        'POST',
        path,
        body,
        err.response?.status ?? 0,
        err.response?.data,
      ),
    };
  }
}

function mapFhirPatientToJempi(p: Resource, healthId?: string, clientId?: string | string[]) {
  const name = (p.name || []).find((n) => n.use === 'official') || p.name?.[0] || {};
  const nid = (p.identifier || []).find((i) => i.system === SYS.NATIONAL_ID);
  const bima = (p.identifier || []).find((i) => i.system === SYS.INSURANCE_NUMBER);
  const nationalId = nid?.value || bima?.value || '';
  const phone = (p.telecom || []).find((t) => t.system === 'phone');
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
      dob: normalizeDob(p.birthDate), // FHIR YYYY-MM-DD -> JeMPI YYYYMMDD
      city: address.city || '',
      phoneNumber: phone?.value || '',
      nationalId,
    },
  };
}

// JeMPI dob is a plain string compared with Jaro-Winkler; normalise to YYYYMMDD
// so values from different sources align.
function normalizeDob(birthDate?: string) {
  return birthDate ? String(birthDate).replace(/-/g, '') : '';
}

// Nonzero milliseconds prevent Java from dropping seconds on the JeMPI round-trip.
function jempiTimestamp(d = new Date()) {
  if (d.getMilliseconds() === 0) d = new Date(d.getTime() + 1);
  return d.toISOString();
}

// The authenticated client owns facility attribution; payload fallback is for local tooling.
export function resolveFacility(p: Resource, clientId?: string | string[]) {
  if (Array.isArray(clientId)) clientId = clientId.join(',');
  if (clientId && facilityRegistry[clientId]) return facilityRegistry[clientId];
  if (clientId) return clientId;
  const mo = p.managingOrganization;
  return mo?.identifier?.value || mo?.reference?.split('/').pop() || config.JEMPI_DEFAULT_FACILITY;
}

function extractGoldenUid(data: JempiResponse) {
  return data?.linkInfo?.goldenUID ?? data?.goldenUID ?? data?.goldenUid ?? null;
}
function extractInteractionUid(data: JempiResponse) {
  return (
    data?.linkInfo?.interactionUID ??
    data?.interactionUID ??
    data?.interactionUid ??
    data?.linkInfo?.interactionID ??
    null
  );
}
function extractCandidates(data: JempiResponse) {
  return data?.candidates ?? data?.goldenRecords ?? [];
}
