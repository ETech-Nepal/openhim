import type { CdrsEncounter } from './schema.js';
type OrganizationReference = { reference: string; display?: string };
import { randomUUID } from 'node:crypto';
import { optionalString } from '../../lib/sentinels.js';

const SYS = {
  BIMA: 'http://hib.gov.np',
  HOSPITAL_MRN: 'http://mohp.gov.np/fhir/NamingSystem/hospital-mrn',
  REGISTRATION: 'http://mohp.gov.np/fhir/NamingSystem/registration-number',
  ACT_CLASS: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  IDENTIFIER_TYPE: 'http://fhir.digitalhealth.gov.np/core/CodeSystem/np-core-identifier-type',
};

// NP Core np-enc-1: the encounter number is namespaced under the facility's NHFR code.
const encounterSystem = (nhfrId: string) => `http://nhfr.digitalhealth.gov.np/${nhfrId}`;

const PROFILE = {
  PATIENT: 'http://fhir.digitalhealth.gov.np/core/StructureDefinition/np-core-patient',
  ENCOUNTER: 'http://fhir.digitalhealth.gov.np/core/StructureDefinition/np-core-encounter',
};

const CLASS = { C: 'AMB', E: 'EMER', N: 'IMP' };

function compact<T extends object>(object: T): T {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;
}

function buildPatient(row: CdrsEncounter, organizationRef: OrganizationReference) {
  const identifiers = [
    ...(row.imis_id
      ? [
          {
            use: 'official',
            type: { coding: [{ system: SYS.IDENTIFIER_TYPE, code: 'health-insurance-id' }] },
            system: SYS.BIMA,
            value: row.imis_id,
          },
        ]
      : []),
    {
      system: SYS.HOSPITAL_MRN,
      value: row.hospital_patient_number,
      assigner: organizationRef,
    },
  ];

  return compact({
    resourceType: 'Patient',
    meta: { profile: [PROFILE.PATIENT] },
    identifier: identifiers,
    name: [
      compact({
        use: 'official',
        family: row.last_name,
        given: row.first_name === undefined ? undefined : [row.first_name],
      }),
    ],
    gender: row.sex,
    birthDate: row.dob,
    telecom:
      row.phone_number === undefined
        ? undefined
        : [{ system: 'phone', value: row.phone_number, use: 'mobile' }],
    managingOrganization: organizationRef,
  });
}

function buildEncounter(
  row: CdrsEncounter,
  nhfrId: string,
  organizationRef: OrganizationReference,
  patientFullUrl: string,
) {
  const registrationNumber = optionalString(row.registration_number);
  // Department codes are the hospital's own internal numbering, so scope the
  // CodeSystem by the facility (its NHFR code) to keep codes distinct per site.
  const departmentSystem = `http://mohp.gov.np/fhir/CodeSystem/${nhfrId}/department`;

  return {
    resourceType: 'Encounter',
    meta: { profile: [PROFILE.ENCOUNTER] },
    identifier: [
      { use: 'official', system: encounterSystem(nhfrId), value: row.encounter_number },
      ...(registrationNumber ? [{ system: SYS.REGISTRATION, value: registrationNumber }] : []),
    ],
    status: 'finished',
    class: { system: SYS.ACT_CLASS, code: CLASS[row.department_type] },
    type: [
      {
        coding: [
          {
            system: departmentSystem,
            code: row.department_id,
            display: row.department_name,
          },
        ],
        text: row.department_name,
      },
    ],
    subject: { reference: patientFullUrl },
    period: { start: `${row.visit_date_ad_time.replace(' ', 'T')}+05:45` },
    serviceProvider: organizationRef,
  };
}

// Use the resolved Organization ID for references and the NHFR code for department systems.
export function toFhirBundle(
  row: CdrsEncounter,
  {
    organizationId,
    organizationName,
    nhfrId,
  }: { organizationId: string; organizationName?: string; nhfrId: string },
) {
  const patientFullUrl = `urn:uuid:${randomUUID()}`;
  const encounterFullUrl = `urn:uuid:${randomUUID()}`;
  const organizationRef = compact({
    reference: `Organization/${organizationId}`,
    display: organizationName,
  });

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        fullUrl: patientFullUrl,
        resource: buildPatient(row, organizationRef),
        request: { method: 'POST', url: 'Patient' },
      },
      {
        fullUrl: encounterFullUrl,
        resource: buildEncounter(row, nhfrId, organizationRef, patientFullUrl),
        request: {
          method: 'POST',
          url: 'Encounter',
          ifNoneExist: `identifier=${encodeURIComponent(`${encounterSystem(nhfrId)}|${row.encounter_number}`)}`,
        },
      },
    ],
  };
}
