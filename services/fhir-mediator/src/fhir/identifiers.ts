import type { Resource } from './types.js';
// Centralised identifier system URLs. Keep this file as the single source of truth.
export const SYS = {
  NEPAL_HEALTH_ID: 'http://mohp.gov.np/fhir/NamingSystem/nepal-health-id',
  JEMPI_GOLDEN_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-golden-uid',
  NATIONAL_ID: 'http://mohp.gov.np/fhir/NamingSystem/national-id',
  INSURANCE_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/bima-insurance-number',
  JEMPI_INTERACTION_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-interaction-uid',
  SOURCE_FACILITY: 'http://mohp.gov.np/fhir/NamingSystem/source-facility',
  ENCOUNTER_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/encounter-number',
  REGISTRATION_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/registration-number',
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

export function findIdentifier(resource: Resource, system: string) {
  return (resource.identifier || []).find((i) => i.system === system);
}

export function hasIdentifier(resource: Resource, system: string, value: string) {
  return (resource.identifier || []).some((i) => i.system === system && i.value === value);
}

export function appendIdentifier(resource: Resource, system: string, value: string) {
  resource.identifier = resource.identifier || [];
  if (!hasIdentifier(resource, system, value)) {
    resource.identifier.push({ system, value });
  }
  return resource;
}
