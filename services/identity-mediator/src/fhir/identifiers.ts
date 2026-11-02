import type { Resource } from './types.js';

// Identifier systems shared with the transform mediator and the HAPI interceptor
// module. Keep them identical across services.
export const SYS = {
  NEPAL_HEALTH_ID: 'http://fhir.digitalhealth.gov.np/core/NamingSystem/nepal-health-id',
  JEMPI_GOLDEN_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-golden-uid',
  NATIONAL_ID: 'http://donidcr.gov.np',
  INSURANCE_NUMBER: 'http://hib.gov.np',
  NHFR: 'http://nhfr.digitalhealth.gov.np',
  // Provenance stamped on writes; lets a future split reassign clinical resources.
  JEMPI_INTERACTION_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-interaction-uid',
  SOURCE_FACILITY: 'http://mohp.gov.np/fhir/NamingSystem/source-facility',
  // Bare prefix. Stored MRNs are always scoped to the issuing facility: mrnSystem().
  HOSPITAL_MRN: 'http://mohp.gov.np/fhir/NamingSystem/hospital-mrn',
  V2_0203: 'http://terminology.hl7.org/CodeSystem/v2-0203',
};

/** The MRN namespace of one facility: MRN 1001 at two hospitals is two identifiers. */
export const mrnSystem = (nhfr: string) => `${SYS.HOSPITAL_MRN}/${nhfr}`;
export const isMrnSystem = (system?: string) =>
  system === SYS.HOSPITAL_MRN || !!system?.startsWith(`${SYS.HOSPITAL_MRN}/`);

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
