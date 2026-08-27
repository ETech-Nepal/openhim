import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { orch } from '../lib/orchestration.js';
import { hapi, readResource, searchAll } from '../fhir/hapiClient.js';
import { SYS, appendIdentifier } from '../fhir/identifiers.js';
import { getExpandedGolden, relinkInteraction } from '../providers/jempiProvider.js';

// ─── Merging two people into one ─────────────────────────────────────────────
// A resolution has to land in BOTH stores or the deployment silently corrupts:
//   * JeMPI only  -> HAPI still has two Patients and two Health IDs, encounters split.
//   * HAPI only   -> JeMPI still hands out two golden UIDs and re-splits on next write.
//
// Order is JeMPI first, then HAPI, because JeMPI is the identity source of truth: if
// HAPI then fails we are in a knowable, retryable state (MERGE_PARTIAL) with identity
// already correct. The reverse order would leave JeMPI issuing a golden UID that HAPI
// has already retired. Every HAPI step below is idempotent so a retry is safe.

const patientRef = (id) => `Patient/${id}`;

function addLink(patient, otherId, type) {
  patient.link = patient.link || [];
  const ref = patientRef(otherId);
  if (!patient.link.some((l) => l.other?.reference === ref && l.type === type)) {
    patient.link.push({ other: { reference: ref }, type });
  }
  return patient;
}

// Rewrite every Patient reference to `fromId` anywhere in the resource. Walking the
// whole object rather than just `subject` catches the other places a patient is cited
// (Encounter.subject, Observation.performer, DocumentReference.context, ...) without
// hard-coding a field list per resource type.
function repointReferences(node, fromId, toId, counter = { n: 0 }) {
  if (Array.isArray(node)) {
    for (const item of node) repointReferences(item, fromId, toId, counter);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'reference' && v === patientRef(fromId)) {
        node[k] = patientRef(toId);
        counter.n++;
      } else {
        repointReferences(v, fromId, toId, counter);
      }
    }
  }
  return counter.n;
}

/** Step 1 — move every interaction off the losing golden record in JeMPI. */
async function relinkInJempi(loserUid, survivorUid, score, orchestrations) {
  const loser = await getExpandedGolden(loserUid, orchestrations);
  if (!loser.ok) {
    // JeMPI deletes a golden once its last interaction leaves. On a retry after a
    // partial merge the losing golden is simply gone — that is success, not failure.
    logger.info({ loserUid, reason: loser.error }, 'losing golden absent — treating JeMPI side as already merged');
    return { ok: true, relinked: [], alreadyMerged: true };
  }

  const interactions = (loser.record?.interactionsWithScore ?? [])
    .map((i) => i.interaction?.uid)
    .filter(Boolean);

  const relinked = [];
  for (const interactionId of interactions) {
    const r = await relinkInteraction(
      { interactionId, fromGoldenId: loserUid, toGoldenId: survivorUid, score },
      orchestrations,
    );
    if (!r.ok) return { ok: false, error: `relink ${interactionId}: ${r.error}`, relinked };
    relinked.push({ interactionId, goldenUid: r.goldenUid });
  }
  return { ok: true, relinked, alreadyMerged: false };
}

/** Step 2 — make HAPI agree: one active Patient, all clinical records on it. */
async function reconcileHapi({ survivorHealthId, loserHealthId }, orchestrations) {
  const moved = {};
  if (!survivorHealthId || !loserHealthId) {
    return { ok: false, error: 'missing Health ID on one of the golden records — cannot reconcile HAPI' };
  }
  if (survivorHealthId === loserHealthId) {
    return { ok: true, moved, note: 'both golden records already share one Health ID' };
  }

  const survivor = await readResource('Patient', survivorHealthId);
  const loser = await readResource('Patient', loserHealthId);
  if (!survivor) return { ok: false, error: `survivor Patient/${survivorHealthId} not found in HAPI` };
  if (!loser) {
    logger.warn({ loserHealthId }, 'losing Patient not in HAPI — nothing to reconcile');
    return { ok: true, moved, note: 'losing Patient absent from HAPI' };
  }

  // 2a. Move clinical records onto the survivor. Done BEFORE deactivating the loser so
  // a failure here leaves the loser active and the records still reachable.
  for (const type of config.MERGE_REFERENCING_TYPES) {
    const resources = await searchAll(type, { patient: patientRef(loserHealthId), _count: '200' });
    let count = 0;
    for (const resource of resources) {
      if (repointReferences(resource, loserHealthId, survivorHealthId) === 0) continue;
      const { status } = await hapi.put(`/${type}/${resource.id}`, resource);
      orchestrations.push(orch(`HAPI move ${type}/${resource.id}`, 'PUT', `/${type}/${resource.id}`, null, status, null));
      count++;
    }
    if (count) moved[type] = count;
  }

  // 2b. Carry the losing record's FOREIGN identifiers (other facilities' MRNs) to the
  // survivor, so a lookup by any of them still finds the person.
  //
  // Identity-owning systems are deliberately NOT copied:
  //  * nepal-health-id — the survivor's Health ID is its resource id, 1:1 with its
  //    golden record. Copying the retired one makes `Patient?identifier=...|<oldId>`
  //    return two records (survivor + retired) and breaks that 1:1 invariant, which is
  //    what the whole write path relies on to converge duplicates.
  //  * jempi-golden-uid — the losing golden no longer exists in JeMPI, so copying it
  //    leaves a dangling pointer, and golden-UID fan-out (the patient portal) would
  //    scope on a dead UID.
  // The retired Patient plus its `replaced-by` link is the forwarding mechanism for the
  // old Health ID; it does not need a duplicate identifier on the survivor.
  const IDENTITY_SYSTEMS = new Set([SYS.NEPAL_HEALTH_ID, SYS.JEMPI_GOLDEN_UID]);
  for (const ident of loser.identifier ?? []) {
    if (!ident.system || !ident.value) continue;
    if (IDENTITY_SYSTEMS.has(ident.system)) continue;
    appendIdentifier(survivor, ident.system, ident.value);
  }
  addLink(survivor, loserHealthId, 'replaces');
  const { status: sStatus } = await hapi.put(`/Patient/${survivorHealthId}`, survivor);
  orchestrations.push(orch('HAPI update survivor', 'PUT', `/Patient/${survivorHealthId}`, null, sStatus, null));

  // 2c. Retire the loser — but KEEP the resource. JeMPI deleted the losing golden and
  // its auxId, so this inactive Patient is the only thing left that can resolve the
  // retired Health ID. Deleting it would permanently break every existing reference to
  // that ID; `replaced-by` is the FHIR-standard way to forward callers to the survivor.
  // The loser keeps its OWN identifiers untouched — including its now-dead golden UID,
  // which is the historical record of where it came from. The survivor's golden UID is
  // deliberately NOT stamped here: that would make golden-UID fan-out return both this
  // inactive shell and the survivor. `replaces`/`replaced-by` already expresses the
  // relationship, and it is the link a consumer is meant to follow.
  loser.active = false;
  addLink(loser, survivorHealthId, 'replaced-by');
  const { status: lStatus } = await hapi.put(`/Patient/${loserHealthId}`, loser);
  orchestrations.push(orch('HAPI retire loser', 'PUT', `/Patient/${loserHealthId}`, null, lStatus, null));

  return { ok: true, moved, retiredHealthId: loserHealthId, survivingHealthId: survivorHealthId };
}

/**
 * Merge two golden records into one.
 *
 * @param {object} p
 * @param {string} p.survivorUid  golden record that survives
 * @param {string} p.loserUid     golden record whose interactions move to the survivor
 * @param {number} p.score        review score, recorded on the JeMPI audit trail
 * @returns {{ok, status, result?, error?, orchestrations}}
 */
export async function mergeGoldenRecords({ survivorUid, loserUid, score = 1 }) {
  const orchestrations = [];
  if (survivorUid === loserUid) {
    return { ok: false, status: 'INVALID', error: 'survivor and loser are the same golden record', orchestrations };
  }

  // Read Health IDs BEFORE relinking: JeMPI deletes the losing golden the moment its
  // last interaction leaves, taking its auxId (the Health ID) with it. Afterwards there
  // is no way to learn which Health ID to retire.
  const survivorGolden = await getExpandedGolden(survivorUid, orchestrations);
  if (!survivorGolden.ok) {
    return { ok: false, status: 'INVALID', error: `survivor golden ${survivorUid} not found: ${survivorGolden.error}`, orchestrations };
  }
  const loserGolden = await getExpandedGolden(loserUid, orchestrations);

  const survivorHealthId = survivorGolden.record?.goldenRecord?.uniqueGoldenRecordData?.auxId ?? null;
  const loserHealthId = loserGolden.ok
    ? loserGolden.record?.goldenRecord?.uniqueGoldenRecordData?.auxId ?? null
    : null;

  const jempi = await relinkInJempi(loserUid, survivorUid, score, orchestrations);
  if (!jempi.ok) {
    return { ok: false, status: 'FAILED', error: jempi.error, orchestrations };
  }

  try {
    const hapiResult = await reconcileHapi({ survivorHealthId, loserHealthId }, orchestrations);
    if (!hapiResult.ok) {
      // Identity is already merged in JeMPI; HAPI is not. Surface it as PARTIAL so it
      // stays visible and retryable rather than being reported as a clean success.
      logger.error({ survivorUid, loserUid, error: hapiResult.error }, 'JeMPI merged but HAPI reconciliation failed');
      return { ok: false, status: 'MERGE_PARTIAL', error: hapiResult.error, result: { jempi }, orchestrations };
    }
    return {
      ok: true,
      status: 'MERGED',
      result: { survivorUid, loserUid, survivorHealthId, retiredHealthId: loserHealthId, jempi, hapi: hapiResult },
      orchestrations,
    };
  } catch (err) {
    logger.error({ err: err.message, survivorUid, loserUid }, 'HAPI reconciliation threw after JeMPI relink');
    return { ok: false, status: 'MERGE_PARTIAL', error: err.message, result: { jempi }, orchestrations };
  }
}
