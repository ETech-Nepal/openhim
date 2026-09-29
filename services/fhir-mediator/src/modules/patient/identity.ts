type IdentityResult =
  | { ok: false; error: string }
  | {
      ok: true;
      healthId: string;
      goldenUid: string;
      matched?: boolean;
      interactionUid: string | null;
      facility: string;
    };
import type { Resource } from '../../fhir/types.js';
import type { Orchestration } from '../../lib/orchestration.js';
import { upstreamError } from '../../lib/errors.js';
import { registerInteraction, resolveFacility } from '../../clients/jempi.js';
import { searchByIdentifier } from '../../clients/hapi.js';
import { orch } from '../../lib/orchestration.js';
import {
  appendIdentifier,
  findIdentifier,
  hasIdentifier,
  healthIdIdentifier,
  SYS,
} from '../../fhir/identifiers.js';
import { stampProvenance } from '../../fhir/provenance.js';
import { generateHealthId, isValidHealthId } from './healthId.js';
import { logger } from '../../lib/logger.js';

// JeMPI owns the Health ID; HAPI assigns the resource ID.
export async function resolvePatientIdentity(
  patient: Resource,
  orchestrations: Orchestration[],
  clientId?: string | string[],
): Promise<IdentityResult> {
  const incoming = findIdentifier(patient, SYS.NEPAL_HEALTH_ID);
  const candidateHealthId =
    incoming?.value && isValidHealthId(incoming.value)
      ? incoming.value
      : await mintUniqueHealthId();

  const link = await registerInteraction(patient, candidateHealthId, clientId);
  orchestrations.push(...(link.orchestrations || []));
  if (!link.ok || !link.goldenUid) {
    return { ok: false, error: link.error ?? 'no goldenUid returned' };
  }

  const healthId = isValidHealthId(link.healthAux) ? link.healthAux : candidateHealthId;
  patient.identifier = (patient.identifier || []).filter(
    (i) => i.system !== SYS.NEPAL_HEALTH_ID && i.system !== SYS.JEMPI_GOLDEN_UID,
  );
  appendIdentifier(patient, SYS.JEMPI_GOLDEN_UID, link.goldenUid);
  patient.identifier.push(healthIdIdentifier(healthId));
  delete patient.id;

  const facility = resolveFacility(patient, clientId);
  stampProvenance(patient, { interactionUid: link.interactionUid, facility });

  try {
    const existing = await searchByIdentifier('Patient', SYS.NEPAL_HEALTH_ID, healthId);
    orchestrations.push(
      orch(
        'HAPI read Patient by Health ID',
        'GET',
        `/Patient?identifier=${SYS.NEPAL_HEALTH_ID}|${healthId}`,
        null,
        existing.status,
        existing.resource ? { id: existing.resource.id } : { notFound: true },
      ),
    );
    if (existing.resource) mergeIdentifiers(patient, existing.resource);
  } catch (caught) {
    const err = upstreamError(caught);
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

async function mintUniqueHealthId() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateHealthId();
    try {
      const found = await searchByIdentifier('Patient', SYS.NEPAL_HEALTH_ID, candidate);
      if (!found.resource) return candidate;
    } catch (caught) {
      const err = upstreamError(caught);
      logger.warn({ err: err.message }, 'Health ID uniqueness check failed; accepting candidate');
      return candidate;
    }
  }
  return generateHealthId();
}

const MULTI_VALUE_SYSTEMS = new Set([SYS.HOSPITAL_MRN]);

// Keep every facility MRN; incoming values replace other declared systems.
function mergeIdentifiers(target: Resource, source: Resource) {
  const incomingSystems = new Set((target.identifier || []).map((i) => i.system));
  for (const id of source.identifier || []) {
    if (!id.system || !id.value) continue;
    if (hasIdentifier(target, id.system, id.value)) continue; // exact dup
    const systemDeclared = incomingSystems.has(id.system);
    if (systemDeclared && !MULTI_VALUE_SYSTEMS.has(id.system)) continue; // incoming authoritative
    target.identifier = target.identifier || [];
    target.identifier.push(id);
  }
}
