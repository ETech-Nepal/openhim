import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChannels } from '../src/channels.js';

const ch = buildChannels({ host: 'gw', port: 4004 });
const find = (name: string) => ch.find((c) => c.name === name)!;
const hits = (name: string, method: string, path: string) =>
  find(name).methods.includes(method) && new RegExp(find(name).urlPattern).test(path);

test('ehr create: listed types + $validate only, POST only', () => {
  assert.ok(hits('FHIR ehr create', 'POST', '/fhir/Patient'));
  assert.ok(hits('FHIR ehr create', 'POST', '/fhir/Patient/$validate'));
  assert.ok(!hits('FHIR ehr create', 'POST', '/fhir'));            // no transaction bundles
  assert.ok(!hits('FHIR ehr create', 'POST', '/fhir/Medication'));
  assert.ok(!hits('FHIR ehr create', 'PUT', '/fhir/Patient'));
});

test('ehr read: search, read by id, $meta; never write', () => {
  assert.ok(hits('FHIR ehr read', 'GET', '/fhir/Encounter'));
  assert.ok(hits('FHIR ehr read', 'GET', '/fhir/Encounter/abc'));
  assert.ok(hits('FHIR ehr read', 'GET', '/fhir/Encounter/abc/$meta'));
  assert.ok(!hits('FHIR ehr read', 'GET', '/fhir/Encounter/abc/_history'));
  assert.ok(!hits('FHIR ehr read', 'DELETE', '/fhir/Encounter/abc'));
});

test('patient role has no create channel', () => {
  assert.equal(ch.find((c) => c.name === 'FHIR patient create'), undefined);
  assert.deepEqual(find('FHIR patient read').allow, ['patient']);
});
