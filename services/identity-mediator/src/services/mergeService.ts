// @ts-nocheck
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { orch } from '../lib/orchestration.js';
import { findPatient, putIfMatch, searchAll } from '../fhir/hapiClient.js';
import { retireHealthId } from '../db/healthIds.js';
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
// has already retired. Every HAPI step below is idempotent so a retry is safe, and
// every HAPI write carries If-Match on the version just read: a record changed
// meanwhile fails the step (MERGE_PARTIAL) instead of being overwritten.

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
  if (!loser.ok && !loser.gone) return { ok: false, error: `losing golden ${loserUid} unreadable: ${loser.error}`, relinked: [] };
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

async function moveRecords(loserId, survivorId, moved, orchestrations) {
  for (const type of config.MERGE_REFERENCING_TYPES) {
    const resources = await searchAll(type, { patient: patientRef(loserId), _count: '200' });
    for (const resource of resources) {
      if (repointReferences(resource, loserId, survivorId) === 0) continue;
      const { status } = await putIfMatch(resource);
      orchestrations.push(orch(`HAPI move ${type}/${resource.id}`, 'PUT', `/${type}/${resource.id}`, null, status, null));
      moved[type] = (moved[type] ?? 0) + 1;
    }
  }
}

/** Step 2 — make HAPI agree: one active Patient, all clinical records on it. */
async function reconcileHapi({ survivorHealthId, loserHealthId, loserUid }, orchestrations) {
  const moved = {};
  if (!survivorHealthId) {
    return { ok: false, error: 'missing Health ID on the surviving golden record — cannot reconcile HAPI' };
  }
  if (survivorHealthId === loserHealthId) {
    return { ok: true, moved, note: 'both golden records already share one Health ID' };
  }

  const survivor = await findPatient(SYS.NEPAL_HEALTH_ID, survivorHealthId);
  // On a retry JeMPI has already deleted the losing golden and its Health ID; the
  // retired Patient still carries the golden UID it came from.
  const loser = loserHealthId
    ? await findPatient(SYS.NEPAL_HEALTH_ID, loserHealthId)
    : await findPatient(SYS.JEMPI_GOLDEN_UID, loserUid);
  if (!survivor) return { ok: false, error: `survivor Patient with Health ID ${survivorHealthId} not found in HAPI` };
  if (!loser) {
    logger.warn({ loserHealthId, loserUid }, 'losing Patient not in HAPI — nothing to reconcile');
    return { ok: true, moved, note: 'losing Patient absent from HAPI' };
  }
  const survivorId = survivor.id;
  const loserId = loser.id;

  // 2a. Move clinical records onto the survivor. Done BEFORE deactivating the loser so
  // a failure here leaves the loser active and the records still reachable.
  await moveRecords(loserId, survivorId, moved, orchestrations);

  // 2b. Carry the losing record's FOREIGN identifiers (other facilities' MRNs) to the
  // survivor, so a lookup by any of them still finds the person.
  //
  // Identity-owning systems are deliberately NOT copied:
  //  * nepal-health-id — the survivor keeps exactly one Health ID, 1:1 with its
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
  addLink(survivor, loserId, 'replaces');
  const { status: sStatus } = await putIfMatch(survivor);
  orchestrations.push(orch('HAPI update survivor', 'PUT', `/Patient/${survivorId}`, null, sStatus, null));

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
  addLink(loser, survivorId, 'replaced-by');
  const { status: lStatus } = await putIfMatch(loser);
  orchestrations.push(orch('HAPI retire loser', 'PUT', `/Patient/${loserId}`, null, lStatus, null));

  // 2d. Move once more: records written to the loser while 2a-2c ran. From here on the
  // HAPI interceptor redirects writes that name the retired Patient to the survivor.
  await moveRecords(loserId, survivorId, moved, orchestrations);

  const retiredHealthId = loser.identifier?.find((i) => i.system === SYS.NEPAL_HEALTH_ID)?.value ?? loserHealthId;
  return { ok: true, moved, retiredHealthId, survivingHealthId: survivorHealthId };
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
  if (!loserGolden.ok && !loserGolden.gone) {
    return { ok: false, status: 'FAILED', error: `losing golden ${loserUid} unreadable: ${loserGolden.error}`, orchestrations };
  }

  const survivorHealthId = survivorGolden.record?.goldenRecord?.uniqueGoldenRecordData?.auxId ?? null;
  const loserHealthId = loserGolden.ok
    ? loserGolden.record?.goldenRecord?.uniqueGoldenRecordData?.auxId ?? null
    : null;

  const jempi = await relinkInJempi(loserUid, survivorUid, score, orchestrations);
  if (!jempi.ok) {
    // Once any interaction has moved, JeMPI is changed: retry, do not treat it as untouched.
    const status = jempi.relinked?.length ? 'MERGE_PARTIAL' : 'FAILED';
    return { ok: false, status, error: jempi.error, result: { jempi }, orchestrations };
  }

  try {
    const hapiResult = await reconcileHapi({ survivorHealthId, loserHealthId, loserUid }, orchestrations);
    if (!hapiResult.ok) {
      // Identity is already merged in JeMPI; HAPI is not. Surface it as PARTIAL so it
      // stays visible and retryable rather than being reported as a clean success.
      logger.error({ survivorUid, loserUid, error: hapiResult.error }, 'JeMPI merged but HAPI reconciliation failed');
      return { ok: false, status: 'MERGE_PARTIAL', error: hapiResult.error, result: { jempi }, orchestrations };
    }
    const retiredHealthId = hapiResult.retiredHealthId ?? loserHealthId;
    // Step 3 — the Health ID register: the loser's ID now forwards to the survivor's.
    if (retiredHealthId && retiredHealthId !== survivorHealthId) {
      await retireHealthId({ loserHealthId: retiredHealthId, survivorHealthId, survivorGoldenUid: survivorUid });
    }
    return {
      ok: true,
      status: 'MERGED',
      result: { survivorUid, loserUid, survivorHealthId, retiredHealthId, jempi, hapi: hapiResult },
      orchestrations,
    };
  } catch (err) {
    logger.error({ err: err.message, survivorUid, loserUid }, 'HAPI reconciliation threw after JeMPI relink');
    return { ok: false, status: 'MERGE_PARTIAL', error: err.message, result: { jempi }, orchestrations };
  }
}
// @ts-nocheck
