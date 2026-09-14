import test from 'node:test';
import assert from 'node:assert/strict';
import { toFhirBundle } from '../src/modules/ingest/mapper.js';
import { parseCdrsEncounter } from '../src/modules/ingest/schema.js';

const context = {
  organizationId: 'org-uuid-3',
  organizationName: 'Bharatpur Hospital',
  nhfrId: '3130400221',
};

function validatedRow(overrides = {}) {
  const result = parseCdrsEncounter({
    imis_id: '771929535',
    hospital_patient_number: '2405078',
    encounter_number: '2110732',
    registration_number: 'REG-100',
    first_name: 'CHANDRIKA',
    last_name: 'KANDEL',
    sex: 'Female',
    dob: '1986-07-28',
    phone_number: '9864437500',
    department_type: 'C',
    department_id: '22',
    department_name: 'Family Medicine',
    visit_date_ad_time: '2026-07-28 00:02:00.000',
    ...overrides,
  });
  assert.equal(result.success, true);
  return result.data;
}

test('maps BIMA, facility MRN, demographics, and managing Organization', () => {
  const bundle = toFhirBundle(validatedRow(), context);
  const patient = bundle.entry[0].resource;

  assert.deepEqual(patient.identifier, [
    { system: 'http://mohp.gov.np/fhir/NamingSystem/bima-insurance-number', value: '771929535' },
    {
      system: 'http://mohp.gov.np/fhir/NamingSystem/hospital-mrn',
      value: '2405078',
      assigner: { reference: 'Organization/org-uuid-3', display: 'Bharatpur Hospital' },
    },
  ]);
  assert.deepEqual(patient.name, [{ use: 'official', family: 'KANDEL', given: ['CHANDRIKA'] }]);
  assert.equal(patient.gender, 'female');
  assert.equal(patient.birthDate, '1986-07-28');
  assert.deepEqual(patient.telecom, [{ system: 'phone', value: '9864437500', use: 'mobile' }]);
  assert.deepEqual(patient.managingOrganization, {
    reference: 'Organization/org-uuid-3',
    display: 'Bharatpur Hospital',
  });
});

test('omits absent BIMA, DOB, and phone', () => {
  const patient = toFhirBundle(
    validatedRow({ imis_id: undefined, dob: undefined, phone_number: undefined }),
    context,
  ).entry[0].resource;

  assert.equal(patient.identifier.length, 1);
  assert.equal('birthDate' in patient, false);
  assert.equal('telecom' in patient, false);
});

test('maps class, department, Nepal time, and conditional create', () => {
  const bundle = toFhirBundle(validatedRow({ department_type: 'E' }), context);
  const [patientEntry, encounterEntry] = bundle.entry;

  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.type, 'transaction');
  assert.match(patientEntry.fullUrl, /^urn:uuid:[0-9a-f-]{36}$/i);
  assert.match(encounterEntry.fullUrl, /^urn:uuid:[0-9a-f-]{36}$/i);
  assert.equal(encounterEntry.resource.class.code, 'EMER');
  assert.equal(
    encounterEntry.resource.class.system,
    'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  );
  assert.equal(encounterEntry.resource.period.start, '2026-07-28T00:02:00.000+05:45');
  assert.equal(encounterEntry.resource.subject.reference, patientEntry.fullUrl);
  assert.equal(encounterEntry.resource.serviceProvider.reference, 'Organization/org-uuid-3');
  assert.deepEqual(encounterEntry.resource.type, [
    {
      coding: [
        {
          system: 'http://mohp.gov.np/fhir/CodeSystem/3130400221/department',
          code: '22',
          display: 'Family Medicine',
        },
      ],
      text: 'Family Medicine',
    },
  ]);
  assert.equal(encounterEntry.request.method, 'POST');
  assert.equal(encounterEntry.request.url, 'Encounter');
  assert.match(encounterEntry.request.ifNoneExist, /^identifier=/);
});

test('maps C and N department types to their FHIR encounter classes', () => {
  for (const [departmentType, expectedClass] of [
    ['C', 'AMB'],
    ['N', 'IMP'],
  ]) {
    const encounter = toFhirBundle(validatedRow({ department_type: departmentType }), context)
      .entry[1].resource;
    assert.equal(encounter.class.code, expectedClass);
  }
});

test('maps encounter and registration identifiers without source workflow fields', () => {
  const row = validatedRow({
    encounter_number: '0002110732',
    registration_number: 'REG-0001',
    patient_type: 'Inpatient',
    registration_type: 'new',
    is_consultant: 1,
    is_doctor: 0,
    follow_up_date: '2026-08-01',
    updated_at: '2026-07-28 00:03:00.000',
    isSynced: 1,
    request_id: 'request-3',
    date_of_registration: '2026-07-28',
    visit_date_ad: '2083-04-13',
    registration_date_ad: '2083-04-13',
  });
  const encounter = toFhirBundle(row, context).entry[1].resource;

  assert.deepEqual(encounter.identifier, [
    { system: 'http://mohp.gov.np/fhir/NamingSystem/encounter-number', value: '0002110732' },
    { system: 'http://mohp.gov.np/fhir/NamingSystem/registration-number', value: 'REG-0001' },
  ]);
  for (const field of [
    'patient_type',
    'registration_type',
    'is_consultant',
    'is_doctor',
    'follow_up_date',
    'updated_at',
    'isSynced',
    'request_id',
    'date_of_registration',
    'visit_date_ad',
    'registration_date_ad',
    'age',
  ]) {
    assert.equal(field in encounter, false);
  }
});

test('URL-encodes reserved encounter-number characters and does not alter the normalized row', () => {
  const row = validatedRow({ encounter_number: '000|patient?replay=1&next' });
  const original = structuredClone(row);
  const bundle = toFhirBundle(row, context);

  assert.equal(
    bundle.entry[1].request.ifNoneExist,
    'identifier=http%3A%2F%2Fmohp.gov.np%2Ffhir%2FNamingSystem%2Fencounter-number%7C000%7Cpatient%3Freplay%3D1%26next',
  );
  assert.deepEqual(row, original);
});
