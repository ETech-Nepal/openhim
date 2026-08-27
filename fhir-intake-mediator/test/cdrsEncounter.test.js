import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCdrsEncounter } from '../src/validators/cdrsEncounter.js';

function validRow(overrides = {}) {
  return {
    imis_id: '771929535',
    hospital_patient_number: '2405078',
    encounter_number: '2110732',
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
  };
}

test('normalizes a valid row without losing identifier zeroes', () => {
  const result = parseCdrsEncounter(validRow({ imis_id: '000000685' }));
  assert.equal(result.success, true);
  assert.equal(result.data.imis_id, '000000685');
  assert.equal(result.data.sex, 'female');
});

test('retains unselected encounter-table columns for the mapper boundary', () => {
  const result = parseCdrsEncounter(validRow({ registration_number: 'REG-100' }));
  assert.equal(result.success, true);
  assert.equal(result.data.registration_number, 'REG-100');
});

test('treats optional sentinels as absent', () => {
  const result = parseCdrsEncounter(validRow({ imis_id: '0', dob: 'None', phone_number: 'None' }));
  assert.equal(result.success, true);
  assert.equal(result.data.imis_id, undefined);
  assert.equal(result.data.dob, undefined);
  assert.equal(result.data.phone_number, undefined);
});

test('requires one name component', () => {
  const result = parseCdrsEncounter(validRow({ first_name: '', last_name: '' }));
  assert.equal(result.success, false);
  assert.deepEqual(result.issues[0].path, ['first_name']);
});

for (const value of ['X', 'OPD', null]) {
  test(`rejects department_type ${String(value)}`, () => {
    assert.equal(parseCdrsEncounter(validRow({ department_type: value })).success, false);
  });
}

test('rejects calendar dates that roll over', () => {
  const result = parseCdrsEncounter(validRow({ dob: '2026-02-30' }));
  assert.equal(result.success, false);
  assert.deepEqual(result.issues[0].path, ['dob']);
});

test('rejects malformed or impossible SQLite visit timestamps', () => {
  for (const timestamp of ['2026-07-28T00:02:00.000', '2026-02-30 00:02:00.000']) {
    assert.equal(parseCdrsEncounter(validRow({ visit_date_ad_time: timestamp })).success, false);
  }
});

test('enforces populated BIMA and phone number digit lengths', () => {
  assert.equal(parseCdrsEncounter(validRow({ imis_id: '12345678' })).success, false);
  assert.equal(parseCdrsEncounter(validRow({ imis_id: '000000000' })).success, false);
  assert.equal(parseCdrsEncounter(validRow({ phone_number: '986443750' })).success, false);
});

test('normalizes accepted gender values case-insensitively', () => {
  for (const [input, gender] of [['MALE', 'male'], ['other', 'other'], ['Unknown', 'unknown']]) {
    const result = parseCdrsEncounter(validRow({ sex: input }));
    assert.equal(result.success, true);
    assert.equal(result.data.sex, gender);
  }
  assert.equal(parseCdrsEncounter(validRow({ sex: 'unspecified' })).success, false);
});

test('validates optional consultant and doctor flags as integer zero or one', () => {
  assert.equal(parseCdrsEncounter(validRow({ is_consultant: 0, is_doctor: '1' })).success, true);
  assert.equal(parseCdrsEncounter(validRow({ is_consultant: 2 })).success, false);
  assert.equal(parseCdrsEncounter(validRow({ is_doctor: 'yes' })).success, false);
  assert.equal(parseCdrsEncounter(validRow({ is_doctor: 'None' })).success, true);
});

test('rejects arrays, objects, and booleans before scalar normalization', () => {
  for (const overrides of [
    { hospital_patient_number: [123] },
    { imis_id: { value: '123456789' } },
    { first_name: ['Alice'] },
    { department_id: false },
    { is_consultant: [0] },
    { is_doctor: { value: 1 } },
  ]) {
    assert.equal(parseCdrsEncounter(validRow(overrides)).success, false);
  }
});

test('continues to accept source strings and numbers', () => {
  const result = parseCdrsEncounter(validRow({
    hospital_patient_number: 2405078,
    department_id: 22,
    is_consultant: 1,
  }));
  assert.equal(result.success, true);
  assert.equal(result.data.hospital_patient_number, '2405078');
  assert.equal(result.data.department_id, '22');
  assert.equal(result.data.is_consultant, 1);
});

test('rejects an array request body', () => {
  const result = parseCdrsEncounter([validRow()]);
  assert.equal(result.success, false);
});
