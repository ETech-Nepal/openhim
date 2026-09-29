// @ts-nocheck
// Identifier system URLs — kept in sync with the write-side FHIR mediator's
// identifiers.js so the portal reads the same nepal-health-id / jempi-golden-uid.
export const SYS = {
  NEPAL_HEALTH_ID: 'http://fhir.digitalhealth.gov.np/core/NamingSystem/nepal-health-id',
  JEMPI_GOLDEN_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-golden-uid',
  // The hospital's own visit number — what a patient is told at the desk, and the
  // only visit label safe to show (the resource id is an internal UUID).
  // NP Core np-enc-1: encounter numbers live under http://nhfr.digitalhealth.gov.np/{nhfrCode}.
  ENCOUNTER_NUMBER_PREFIX: 'http://nhfr.digitalhealth.gov.np/',
};

export function findIdentifier(resource, system) {
  return (resource.identifier || []).find(i => i.system === system);
}
// @ts-nocheck
