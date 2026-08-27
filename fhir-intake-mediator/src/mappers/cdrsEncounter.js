import { randomUUID } from 'node:crypto';
import { optionalString } from '../lib/sentinels.js';

const SYS = {
  BIMA: 'http://mohp.gov.np/fhir/NamingSystem/bima-insurance-number',
  HOSPITAL_MRN: 'http://mohp.gov.np/fhir/NamingSystem/hospital-mrn',
  ENCOUNTER: 'http://mohp.gov.np/fhir/NamingSystem/encounter-number',
  REGISTRATION: 'http://mohp.gov.np/fhir/NamingSystem/registration-number',
  ACT_CLASS: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
};

const CLASS = { C: 'AMB', E: 'EMER', N: 'IMP' };

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function buildPatient(row, organizationRef) {
  const identifiers = [
    ...(row.imis_id ? [{ system: SYS.BIMA, value: row.imis_id }] : []),
    {
      system: SYS.HOSPITAL_MRN,
      value: row.hospital_patient_number,
      assigner: organizationRef,
    },
  ];

  return compact({
    resourceType: 'Patient',
    identifier: identifiers,
    name: [compact({
      use: 'official',
      family: row.last_name,
      given: row.first_name === undefined ? undefined : [row.first_name],
    })],
    gender: row.sex,
    birthDate: row.dob,
    telecom: row.phone_number === undefined
      ? undefined
      : [{ system: 'phone', value: row.phone_number, use: 'mobile' }],
    managingOrganization: organizationRef,
  });
}

function buildEncounter(row, nhfrId, organizationRef, patientFullUrl) {
  const registrationNumber = optionalString(row.registration_number);
  // Department codes are the hospital's own internal numbering, so scope the
  // CodeSystem by the facility (its NHFR code) to keep codes distinct per site.
  const departmentSystem = `http://mohp.gov.np/fhir/CodeSystem/${nhfrId}/department`;

  return {
    resourceType: 'Encounter',
    identifier: [
      { system: SYS.ENCOUNTER, value: row.encounter_number },
      ...(registrationNumber ? [{ system: SYS.REGISTRATION, value: registrationNumber }] : []),
    ],
    status: 'finished',
    class: { system: SYS.ACT_CLASS, code: CLASS[row.department_type] },
    type: [{
      coding: [{
        system: departmentSystem,
        code: row.department_id,
        display: row.department_name,
      }],
      text: row.department_name,
    }],
    subject: { reference: patientFullUrl },
    period: { start: `${row.visit_date_ad_time.replace(' ', 'T')}+05:45` },
    serviceProvider: organizationRef,
  };
}

// organizationId is the resolved FHIR Organization.id (a server UUID); nhfrId is
// the facility's NHFR code (the trusted OpenHIM clientID), used only to scope the
// department CodeSystem.
export function toFhirBundle(row, { organizationId, organizationName, nhfrId }) {
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
          ifNoneExist: `identifier=${encodeURIComponent(`${SYS.ENCOUNTER}|${row.encounter_number}`)}`,
        },
      },
    ],
  };
}
