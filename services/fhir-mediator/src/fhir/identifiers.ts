import type { Resource } from './types.js';
// Centralised identifier system URLs. Keep this file as the single source of truth.
export const SYS = {
  NEPAL_HEALTH_ID: 'http://fhir.digitalhealth.gov.np/core/NamingSystem/nepal-health-id',
  JEMPI_GOLDEN_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-golden-uid',
  NATIONAL_ID: 'http://donidcr.gov.np',
  INSURANCE_NUMBER: 'http://hib.gov.np',
  JEMPI_INTERACTION_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-interaction-uid',
  SOURCE_FACILITY: 'http://mohp.gov.np/fhir/NamingSystem/source-facility',
  REGISTRATION_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/registration-number',
  HOSPITAL_MRN: 'http://mohp.gov.np/fhir/NamingSystem/hospital-mrn',
  // Practitioner councils
  NMC: 'http://nmc.org.np',
  NNC: 'http://nnc.org.np',
  NAMC: 'http://namc.org.np',
  NHPC: 'http://nhpc.org.np',
  NPC: 'http://nepalpharmacycouncil.org.np',
};

// All identifier systems that should trigger Practitioner dedup
export const PRACTITIONER_DEDUP_SYSTEMS = [SYS.NMC, SYS.NNC, SYS.NAMC, SYS.NHPC, SYS.NPC];

// NP Core's nepal-health-id profile requires use and type, not just system + value.
export function healthIdIdentifier(value: string) {
  return {
    use: 'official',
    type: {
      coding: [
        {
          system: 'http://fhir.digitalhealth.gov.np/core/CodeSystem/np-core-identifier-type',
          code: 'health-id',
          display: 'Nepal Health ID',
        },
      ],
    },
    system: SYS.NEPAL_HEALTH_ID,
    value,
  };
}

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
