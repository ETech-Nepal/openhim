import test from 'node:test';
import assert from 'node:assert/strict';
import { dammCheck, dammValid, encodeHealthIdBody, generateHealthId, isValidHealthId } from '../src/fhir/healthId.js';

test('maps letters as two decimal values before Damm calculation', () => {
  assert.equal(encodeHealthIdBody('AA481242'), '0000481242');
  assert.equal(encodeHealthIdBody('BZ000000'), '0125000000');
});

test('uses the deployed Damm table over the mapped numeric body', () => {
  const mapped = encodeHealthIdBody('AA481242');
  assert.equal(dammCheck(mapped), 3);
  assert.equal(dammValid(`${mapped}3`), true);
});

test('generates a complete visible Health ID', () => {
  const value = generateHealthId();
  assert.match(value, /^[A-Z]{2}\d{7}$/);
  assert.equal(isValidHealthId(value), true);
});

test('rejects invalid new-format IDs', () => {
  assert.equal(isValidHealthId('AA4812423'), true);
  assert.equal(isValidHealthId('AA4812424'), false);
  assert.equal(isValidHealthId('Aa4812423'), false);
  assert.equal(isValidHealthId('A14812423'), false);
  assert.equal(isValidHealthId('AA481242'), false);
});

test('keeps valid legacy numeric Health IDs valid', () => {
  const body = '1234567890';
  const legacy = `${body}${dammCheck(body)}`;
  assert.match(legacy, /^\d{11}$/);
  assert.equal(isValidHealthId(legacy), true);
});
