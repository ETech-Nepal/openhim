import './fixtures/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePair, bandFor } from '../src/lib/scoring.js';

test('blank and placeholder fields provide no matching evidence', () => {
  const result = scorePair({ phoneNumber: '9800000000', nationalId: ' ' }, { phoneNumber: '9800000000' });
  assert.equal(result.score, null);
  assert.equal(result.comparedCount, 0);
  assert.equal(result.discriminating, false);
  assert.ok(result.fields.every(field => !field.compared));
});

test('near-miss dates and identifiers are disagreements, not fuzzy matches', () => {
  const result = scorePair(
    { dob: '19900101', nationalId: '1234567890', phoneNumber: '9812345678' },
    { dob: '19900102', nationalId: '1234567891', phoneNumber: '9812345679' },
  );
  assert.equal(result.comparedCount, 3);
  assert.equal(result.score, 0);
  assert.equal(result.discriminating, false);
});

test('exact rare-field agreement is discriminating but a common name alone is not', () => {
  assert.equal(scorePair({ dob: '19900101' }, { dob: '19900101' }).score, 1);
  assert.equal(scorePair({ dob: '19900101' }, { dob: '19900101' }).discriminating, true);
  assert.equal(scorePair({ givenName: 'Synthetic' }, { givenName: 'Synthetic' }).discriminating, false);
});

test('review bands include their configured lower boundaries', () => {
  for (const [score, band] of [[0.6499, 'below'], [0.65, 'possible'], [0.7499, 'possible'], [0.75, 'likely']]) {
    assert.equal(bandFor(score), band);
  }
});
// @ts-nocheck
