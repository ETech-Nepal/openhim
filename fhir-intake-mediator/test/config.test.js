import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';

const validEnv = {
  MEDIATOR_URN: 'urn:mediator:fhir-intake',
  OPENHIM_API_URL: 'https://openhim-core:8080',
  OPENHIM_USERNAME: 'root@openhim.org',
  OPENHIM_PASSWORD: 'secret',
  FHIR_ORCHESTRATOR_BASE_URL: 'http://mediator:4000',
};

test('parseConfig applies defaults and freezes the result', () => {
  const config = parseConfig(validEnv);
  assert.equal(config.MEDIATOR_PORT, 4003);
  assert.equal(config.NODE_ENV, 'development');
  assert.equal(config.OPENHIM_CHANNEL_ROLE, 'np-fhir-intake-clients');
  assert.equal(config.FHIR_ORCHESTRATOR_TIMEOUT_MS, 20000);
  assert.equal(Object.isFrozen(config), true);
});

test('parseConfig rejects a missing mediator URN', () => {
  const { MEDIATOR_URN: _omit, ...withoutUrn } = validEnv;
  assert.throws(() => parseConfig(withoutUrn));
});

test('parseConfig rejects a non-URL orchestrator base', () => {
  assert.throws(() => parseConfig({ ...validEnv, FHIR_ORCHESTRATOR_BASE_URL: 'not-a-url' }));
});
