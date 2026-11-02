import type { Resource } from './types.js';
import { SYS } from './identifiers.js';

// Keep interaction and facility tags so later identity corrections can trace source records.
export function stampProvenance(
  resource: Resource,
  { interactionUid, facility }: { interactionUid?: string | null; facility?: string } = {},
) {
  if (!resource || typeof resource !== 'object') return resource;

  const tags: { system: string; code: string }[] = [];
  // The deterministic-duplicate path yields no interactionUid: JeMPI answers 409
  // `exists` and does not persist an interaction. Facility may be all we have.
  if (interactionUid) tags.push({ system: SYS.JEMPI_INTERACTION_UID, code: interactionUid });
  if (facility) tags.push({ system: SYS.SOURCE_FACILITY, code: facility });
  if (!tags.length) return resource;

  resource.meta = resource.meta || {};
  resource.meta.tag = resource.meta.tag || [];
  for (const tag of tags) {
    const at = resource.meta.tag.findIndex((t) => t.system === tag.system);
    if (at >= 0)
      resource.meta.tag[at] = tag; // one value per system
    else resource.meta.tag.push(tag);
  }
  return resource;
}
