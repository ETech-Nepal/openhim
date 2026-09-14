import type { FhirRequest, FhirResponse, Resource } from '../../fhir/types.js';
import { hapi, postResource } from '../../clients/hapi.js';
import { buildOpenHIMResponse, orch } from '../../lib/orchestration.js';
import { PRACTITIONER_DEDUP_SYSTEMS } from '../../fhir/identifiers.js';
import { config } from '../../config.js';

export async function practitionerHandler(req: FhirRequest, res: FhirResponse) {
  const prac = req.body;
  const orchestrations = [];

  // Check every registered council identifier the resource carries
  const councilIds = (prac.identifier || []).filter(
    (i) => PRACTITIONER_DEDUP_SYSTEMS.includes(i.system ?? '') && i.value,
  );

  for (const ident of councilIds) {
    const q = encodeURIComponent(`${ident.system}|${ident.value}`);
    const search = await hapi.get<Resource>(`/Practitioner?identifier=${q}&_count=1`);
    orchestrations.push(
      orch(
        'GET HAPI Practitioner dedup',
        'GET',
        `/Practitioner?identifier=${q}`,
        null,
        search.status,
        search.data,
      ),
    );
    const existing = search.data.entry?.[0]?.resource;
    if (existing) {
      // Merge: keep existing id, union identifiers, prefer incoming name/telecom/etc.
      const merged = mergePractitioners(existing, prac);
      const { data, status } = await hapi.put(`/Practitioner/${existing.id}`, merged);
      orchestrations.push(
        orch('PUT HAPI Practitioner', 'PUT', `/Practitioner/${existing.id}`, merged, status, data),
      );
      return res.status(status).json(
        buildOpenHIMResponse({
          status,
          body: data,
          orchestrations,
          urn: config.MEDIATOR_URN,
        }),
      );
    }
  }

  // No dedup hit — create new
  const result = await postResource('Practitioner', prac);
  orchestrations.push(
    orch('POST HAPI Practitioner', 'POST', '/Practitioner', prac, result.status, result.data),
  );
  res.status(result.status).json(
    buildOpenHIMResponse({
      status: result.status,
      body: result.data,
      orchestrations,
      urn: config.MEDIATOR_URN,
    }),
  );
}

function mergePractitioners(existing: Resource, incoming: Resource) {
  const idMap = new Map();
  for (const i of existing.identifier || []) idMap.set(`${i.system}|${i.value}`, i);
  for (const i of incoming.identifier || []) idMap.set(`${i.system}|${i.value}`, i);
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    identifier: Array.from(idMap.values()),
    meta: existing.meta,
  };
}
