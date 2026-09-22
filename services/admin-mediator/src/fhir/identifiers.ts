// @ts-nocheck
// Mirrors mediator/src/fhir/identifiers.js — keep the systems identical across services.
export const SYS = {
  NEPAL_HEALTH_ID: 'http://mohp.gov.np/fhir/NamingSystem/nepal-health-id',
  JEMPI_GOLDEN_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-golden-uid',
  // Provenance stamped by the write-side mediator; lets a future split reassign
  // clinical resources to the right person.
  JEMPI_INTERACTION_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-interaction-uid',
  SOURCE_FACILITY: 'http://mohp.gov.np/fhir/NamingSystem/source-facility',
};

export function hasIdentifier(resource, system, value) {
  return (resource.identifier || []).some((i) => i.system === system && i.value === value);
}

export function appendIdentifier(resource, system, value) {
  resource.identifier = resource.identifier || [];
  if (!hasIdentifier(resource, system, value)) resource.identifier.push({ system, value });
  return resource;
}
// @ts-nocheck
