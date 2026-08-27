import { SYS } from './identifiers.js';

// ─── Why we stamp provenance ─────────────────────────────────────────────────
// HAPI resources reference the *Patient*, not the JeMPI interaction that produced them.
// So if a golden record later turns out to be two different people, there is no way to
// take it apart: nothing records which Encounter arrived on which submission, from which
// facility. Merges are recoverable (the survivor is the union); splits are not.
//
// These tags are the missing provenance. They only help records written from now on —
// anything already in HAPI is unsplittable, which is exactly why this is stamped before
// the split feature exists rather than alongside it.
export function stampProvenance(resource, { interactionUid, facility } = {}) {
  if (!resource || typeof resource !== 'object') return resource;

  const tags = [];
  // The deterministic-duplicate path yields no interactionUid: JeMPI answers 409
  // `exists` and does not persist an interaction. Facility may be all we have.
  if (interactionUid) tags.push({ system: SYS.JEMPI_INTERACTION_UID, code: interactionUid });
  if (facility) tags.push({ system: SYS.SOURCE_FACILITY, code: facility });
  if (!tags.length) return resource;

  resource.meta = resource.meta || {};
  resource.meta.tag = resource.meta.tag || [];
  for (const tag of tags) {
    const at = resource.meta.tag.findIndex((t) => t.system === tag.system);
    if (at >= 0) resource.meta.tag[at] = tag; // one value per system
    else resource.meta.tag.push(tag);
  }
  return resource;
}
