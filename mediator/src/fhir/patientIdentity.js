import { registerInteraction, resolveFacility } from '../providers/jempiProvider.js';
import { searchByIdentifier } from './hapiClient.js';
import { orch } from '../lib/orchestration.js';
import { appendIdentifier, findIdentifier, hasIdentifier, SYS } from './identifiers.js';
import { stampProvenance } from './provenance.js';
import { generateHealthId, isValidHealthId } from './healthId.js';
import { logger } from '../lib/logger.js';

// Resolve a Patient's identity through JeMPI (race-safe) and prepare it for an
// idempotent upsert. Mutates `patient` in place:
//   - resolves the golden UID + Health ID (reusing JeMPI's stored auxId so repeat
//     registrations get the SAME Health ID without a lagging HAPI search),
//   - stamps exactly the authoritative golden-UID + Health-ID identifiers,
//   - leaves Resource.id unset — the caller does a conditional update keyed on the
//     Health-ID identifier, so HAPI assigns an opaque id,
//   - read-merges identifiers already on the existing record (other facilities' MRNs),
//   - stamps JeMPI provenance (interaction UID + source facility) — see provenance.js.
// Returns { ok, healthId, goldenUid, matched, interactionUid, facility, error }.
// Pushes orchestrations.
// Shared by the single-Patient handler and the bundle handler so both dedup identically.
export async function resolvePatientIdentity(patient, orchestrations, clientId) {
  const incoming = findIdentifier(patient, SYS.NEPAL_HEALTH_ID);
  const candidateHealthId = (incoming?.value && isValidHealthId(incoming.value))
    ? incoming.value
    : await mintUniqueHealthId(orchestrations);

  const link = await registerInteraction(patient, candidateHealthId, clientId);
  orchestrations.push(...(link.orchestrations || []));
  if (!link.ok || !link.goldenUid) {
    return { ok: false, error: link.error ?? 'no goldenUid returned' };
  }

  const healthId = isValidHealthId(link.healthAux) ? link.healthAux : candidateHealthId;
  patient.identifier = (patient.identifier || []).filter(
    i => i.system !== SYS.NEPAL_HEALTH_ID && i.system !== SYS.JEMPI_GOLDEN_UID);
  appendIdentifier(patient, SYS.JEMPI_GOLDEN_UID, link.goldenUid);
  appendIdentifier(patient, SYS.NEPAL_HEALTH_ID, healthId);
  delete patient.id;

  const facility = resolveFacility(patient, clientId);
  stampProvenance(patient, { interactionUid: link.interactionUid, facility });

  try {
    const existing = await searchByIdentifier('Patient', SYS.NEPAL_HEALTH_ID, healthId);
    orchestrations.push(orch(
      'HAPI read Patient by Health ID', 'GET',
      `/Patient?identifier=${SYS.NEPAL_HEALTH_ID}|${healthId}`,
      null, existing.status, existing.resource ? { id: existing.resource.id } : { notFound: true },
    ));
    if (existing.resource) mergeIdentifiers(patient, existing.resource);
  } catch (err) {
    logger.warn({ err: err.message }, 'HAPI read-before-merge failed; proceeding');
  }

  return {
    ok: true,
    healthId,
    goldenUid: link.goldenUid,
    matched: link.matched,
    interactionUid: link.interactionUid ?? null,
    facility,
  };
}

// Mint a Damm-checked Health ID no Patient already carries. A collision on a
// random 11-digit Damm number is astronomically rare, and the conditional update
// would 412 on a duplicate anyway — this search is just a courtesy check.
async function mintUniqueHealthId(orchestrations) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateHealthId();
    try {
      const found = await searchByIdentifier('Patient', SYS.NEPAL_HEALTH_ID, candidate);
      if (!found.resource) return candidate;
    } catch (err) {
      logger.warn({ err: err.message }, 'Health ID uniqueness check failed; accepting candidate');
      return candidate;
    }
  }
  return generateHealthId();
}

// Systems where a golden Patient legitimately holds one value PER facility — a
// local MRN assigned by every hospital that ever registered the person, kept side
// by side and told apart by identifier.assigner. For these an existing value is
// carried forward even when the incoming payload also declares the system.
const MULTI_VALUE_SYSTEMS = new Set([SYS.HOSPITAL_MRN]);

// Union identifiers from an existing record into the incoming Patient so prior
// facilities' MRNs survive the upsert.
//   - MULTI_VALUE_SYSTEMS (hospital MRN): union by (system, value) — a new
//     facility's MRN is added, existing ones are kept.
//   - every other system (NID, insurance number, …): the incoming Patient is
//     authoritative — if it declares the system, a stale existing value is NOT
//     carried forward (see [[national-id]] fix); existing values only backfill
//     systems the incoming payload doesn't mention at all.
function mergeIdentifiers(target, source) {
  const incomingSystems = new Set((target.identifier || []).map(i => i.system));
  for (const id of source.identifier || []) {
    if (!id.system || !id.value) continue;
    if (hasIdentifier(target, id.system, id.value)) continue;           // exact dup
    const systemDeclared = incomingSystems.has(id.system);
    if (systemDeclared && !MULTI_VALUE_SYSTEMS.has(id.system)) continue; // incoming authoritative
    target.identifier = target.identifier || [];
    target.identifier.push(id);
  }
}
