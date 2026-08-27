import test from 'node:test';
import assert from 'node:assert/strict';
import { operationOutcome } from '../src/lib/operationOutcome.js';
import { buildOpenHimResponse, orch } from '../src/lib/orchestration.js';

test('operationOutcome builds a FHIR error issue with an optional expression', () => {
  assert.deepEqual(operationOutcome('invalid', 'Bad value', ['Patient.name']), {
    resourceType: 'OperationOutcome',
    issue: [{
      severity: 'error',
      code: 'invalid',
      diagnostics: 'Bad value',
      expression: ['Patient.name'],
    }],
  });
});

test('buildOpenHimResponse serializes the body and preserves orchestration status', () => {
  const response = buildOpenHimResponse({
    status: 201,
    body: { resourceType: 'Patient' },
    orchestrations: [],
    urn: 'urn:mediator:fhir-intake',
  });
  assert.equal(response['x-mediator-urn'], 'urn:mediator:fhir-intake');
  assert.equal(response.status, 'Successful');
  assert.equal(response.response.headers['Content-Type'], 'application/fhir+json');
  assert.equal(response.response.body, '{"resourceType":"Patient"}');
});

test('orch keeps string bodies and truncates serialized bodies to 8000 characters', () => {
  const entry = orch('FHIR', 'POST', '/fhir', 'request', 502, { body: 'x'.repeat(9000) });
  assert.equal(entry.request.body, 'request');
  assert.equal(entry.response.body.length, 8000);
});
