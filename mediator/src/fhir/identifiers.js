// Centralised identifier system URLs. Keep this file as the single source of truth.
export const SYS = {
  NEPAL_HEALTH_ID: 'http://mohp.gov.np/fhir/NamingSystem/nepal-health-id',
  JEMPI_GOLDEN_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-golden-uid',
  // Real government-issued identifiers, distinct from our own Health ID. Both feed
  // JeMPI's deterministic matching (see providers/jempiProvider.js) — NID preferred,
  // BIMA (Health Insurance Board number) as fallback when NID isn't known yet.
  NATIONAL_ID: 'http://mohp.gov.np/fhir/NamingSystem/national-id',
  INSURANCE_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/bima-insurance-number',
  // Provenance stamped on written resources (see fhir/provenance.js): which JeMPI
  // interaction and which facility a record came from, so a golden record that later
  // proves to be two people can be split apart.
  JEMPI_INTERACTION_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-interaction-uid',
  SOURCE_FACILITY: 'http://mohp.gov.np/fhir/NamingSystem/source-facility',
  ENCOUNTER_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/encounter-number',
  REGISTRATION_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/registration-number',
  // Local hospital medical-record number. One value PER facility on a golden
  // Patient (each hospital that registers the person assigns its own), told apart
  // by identifier.assigner. See MULTI_VALUE_SYSTEMS in fhir/patientIdentity.js.
  HOSPITAL_MRN: 'http://mohp.gov.np/fhir/NamingSystem/hospital-mrn',
  // Practitioner councils
  NMC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-medical-council',
  NNC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-nursing-council',
  NAMC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-ayurveda-medical-council',
  NHPC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-health-professional-council',
  NPC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-pharmacy-council',
};

// All identifier systems that should trigger Practitioner dedup
export const PRACTITIONER_DEDUP_SYSTEMS = [SYS.NMC, SYS.NNC, SYS.NAMC, SYS.NHPC, SYS.NPC];

export function findIdentifier(resource, system) {
  return (resource.identifier || []).find(i => i.system === system);
}

export function hasIdentifier(resource, system, value) {
  return (resource.identifier || []).some(i => i.system === system && i.value === value);
}

export function appendIdentifier(resource, system, value) {
  resource.identifier = resource.identifier || [];
  if (!hasIdentifier(resource, system, value)) {
    resource.identifier.push({ system, value });
  }
  return resource;
}
