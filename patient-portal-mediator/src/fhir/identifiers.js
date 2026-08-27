// Identifier system URLs — kept in sync with the write-side FHIR mediator's
// identifiers.js so the portal reads the same nepal-health-id / jempi-golden-uid.
export const SYS = {
  NEPAL_HEALTH_ID: 'http://mohp.gov.np/fhir/NamingSystem/nepal-health-id',
  JEMPI_GOLDEN_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-golden-uid',
  // The hospital's own visit number — what a patient is told at the desk, and the
  // only visit label safe to show (the resource id is an internal UUID).
  ENCOUNTER_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/encounter-number',
};

export function findIdentifier(resource, system) {
  return (resource.identifier || []).find(i => i.system === system);
}
