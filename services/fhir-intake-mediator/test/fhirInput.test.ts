import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFhirInput } from '../src/modules/ingest/input.js';

test('routes a supported resource and returns the same object', () => {
  const patient = { resourceType: 'Patient', name: [{ family: 'Kandel' }] };
  const result = validateFhirInput(patient);
  assert.equal(result.success, true);
  assert.equal(result.resource, patient);
  assert.equal(result.path, '/fhir/Patient');
});

test('routes transaction and batch Bundles to the FHIR base', () => {
  for (const type of ['transaction', 'batch']) {
    const bundle = { resourceType: 'Bundle', type, entry: [] };
    assert.equal(validateFhirInput(bundle).path, '/fhir');
  }
});

test('rejects unsupported resources and Bundle types', () => {
  assert.equal(validateFhirInput({ resourceType: 'Condition' }).success, false);
  assert.equal(validateFhirInput({ resourceType: 'Bundle', type: 'collection' }).success, false);
});

test('rejects non-object FHIR request bodies', () => {
  for (const input of [null, [], 'Patient']) {
    const result = validateFhirInput(input);
    assert.equal(result.success, false);
    assert.equal(result.diagnostics, 'FHIR request body must be a JSON object');
  }
});
