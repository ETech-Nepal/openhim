import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyContentType } from '../src/middleware/contentType.js';

test('classifies only the two approved JSON media types', () => {
  assert.equal(classifyContentType('application/json'), 'raw');
  assert.equal(classifyContentType('application/json; charset=utf-8'), 'raw');
  assert.equal(classifyContentType('application/fhir+json'), 'fhir');
  assert.equal(classifyContentType('application/fhir+json; charset=UTF-8'), 'fhir');
  assert.equal(classifyContentType('application/json+fhir'), null);
  assert.equal(classifyContentType('text/json'), null);
  assert.equal(classifyContentType(undefined), null);
});

test('accepts one syntactically valid charset parameter', () => {
  assert.equal(classifyContentType('application/json; charset = utf-8'), 'raw');
  assert.equal(classifyContentType('application/fhir+json; charset="UTF-8"'), 'fhir');
});

test('rejects unapproved, duplicate, and malformed media type parameters', () => {
  for (const contentType of [
    'application/json; profile=fhir',
    'application/json; charset=utf-8; profile=fhir',
    'application/json; charset=utf-8; charset=UTF-8',
    'application/json; charset',
    'application/json; charset=',
    'application/json; charset=""',
    'application/json; charset=utf-8;',
  ]) {
    assert.equal(classifyContentType(contentType), null);
  }
});
