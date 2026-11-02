// @ts-nocheck
import './fixtures/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { pool, migrate } from '../src/db/pool.js';

// Synthetic JeMPI and HAPI behind axios. JeMPI links to state.matchGolden when set,
// otherwise creates a golden record whose auxId is the registration's auxId.
let state;
axios.defaults.adapter = async (config) => {
  const url = new URL(config.url, config.baseURL);
  const body = config.data ? JSON.parse(config.data) : null;
  state.calls.push({ method: config.method, host: url.host, path: url.pathname, headers: config.headers, body });
  let status = 200;
  let data;
  const fail = (s) => {
    const response = { config, status: s, data: { resourceType: 'OperationOutcome', issue: [{ diagnostics: 'synthetic' }] }, headers: {}, statusText: '' };
    throw new axios.AxiosError('synthetic upstream failure', 'ERR_BAD_RESPONSE', config, null, response);
  };
  if (url.host === 'jempi.invalid' && url.pathname === '/crRegister') {
    const uid = state.matchGolden ?? `0x${state.goldens.size + 100}`;
    if (!state.goldens.has(uid)) state.goldens.set(uid, body.uniqueInteractionData.auxId);
    data = { linkInfo: { goldenUID: uid, interactionUID: '0xi1' } };
  } else if (url.host === 'jempi.invalid' && url.pathname === '/crCandidates') {
    data = { goldenRecords: [...state.goldens].map(([uid, auxId]) => ({ uid, uniqueGoldenRecordData: { auxId } })) };
  } else if (url.host === 'hapi.invalid' && url.pathname === '/Organization') {
    data = { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Organization', id: `org-${url.searchParams.get('identifier').split('|')[1]}`, name: 'Hospital' } }] };
  } else if (url.host === 'hapi.invalid' && config.method === 'get' && url.pathname === '/Patient') {
    if (state.searchFails) fail(500);
    const ident = url.searchParams.get('identifier');
    data = { resourceType: 'Bundle', entry: state.patients.filter((p) => p.identifier.some((i) => `${i.system}|${i.value}` === ident)).map((resource) => ({ resource: structuredClone(resource) })) };
  } else if (url.host === 'hapi.invalid' && config.method === 'post' && url.pathname === '/Patient') {
    const created = { ...body, id: `pat-${state.patients.length + 1}`, meta: { ...body.meta, versionId: '1' } };
    state.patients.push(created);
    status = 201;
    data = created;
  } else if (url.host === 'hapi.invalid' && config.method === 'put' && url.pathname.startsWith('/Patient/')) {
    const at = state.patients.findIndex((p) => `/Patient/${p.id}` === url.pathname);
    if (state.putConflict || config.headers['If-Match'] !== `W/"${state.patients[at].meta.versionId}"`) fail(412);
    state.patients[at] = { ...body, meta: { ...body.meta, versionId: String(Number(state.patients[at].meta.versionId) + 1) } };
    data = state.patients[at];
  } else assert.fail(`Unexpected request: ${config.method} ${url}`);
  return { config, status, data: structuredClone(data), headers: {}, statusText: '' };
};

const { registerPatient } = await import('../src/patient/register.js');
const { SYS, mrnSystem } = await import('../src/fhir/identifiers.js');

const hospital = (clientId, scopes = 'system/Patient.crus') => ({ clientId, scopes: scopes.split(' ') });
const patient = (mrn, extra = []) => ({
  resourceType: 'Patient',
  identifier: [{ system: SYS.HOSPITAL_MRN, value: mrn }, ...extra],
  name: [{ use: 'official', family: 'Kandel', given: ['Chandrika'] }],
  gender: 'female',
  birthDate: '1990-01-15',
});
const register = (input, caller = hospital('1001')) => registerPatient(input, caller, []);
const jempiCalls = () => state.calls.filter((c) => c.host === 'jempi.invalid');

test.before(async () => {
  assert.ok(process.env.TEST_IDENTITY_DB_PORT, 'Set TEST_IDENTITY_DB_PORT to the disposable PostgreSQL port');
  await migrate();
});
test.after(() => pool.end());
test.beforeEach(async () => {
  state = { calls: [], goldens: new Map(), patients: [] };
  await pool.query('DELETE FROM health_ids');
});

test('a new person gets a Health ID, a facility-scoped MRN and a conditional create', async () => {
  const result = await register(patient('A-1'));
  assert.equal(result.created, true);
  const stored = state.patients[0];
  const mrn = stored.identifier.find((i) => i.value === 'A-1');
  assert.equal(mrn.system, mrnSystem('1001'));
  assert.deepEqual(mrn.type.coding[0], { system: SYS.V2_0203, code: 'MR' });
  assert.equal(mrn.assigner.reference, 'Organization/org-1001');
  assert.equal(stored.managingOrganization.reference, 'Organization/org-1001');
  assert.equal(stored.identifier.find((i) => i.system === SYS.NEPAL_HEALTH_ID).value, result.healthId);
  const post = state.calls.find((c) => c.method === 'post' && c.path === '/Patient');
  assert.equal(post.headers['If-None-Exist'], `identifier=${SYS.NEPAL_HEALTH_ID}|${result.healthId}`);
  const { rows } = await pool.query('SELECT golden_uid, status FROM health_ids WHERE health_id = $1', [result.healthId]);
  assert.deepEqual(rows, [{ golden_uid: '0x100', status: 'active' }]);
});

test('the same person at a second hospital keeps one Patient, both MRNs and the first manager', async () => {
  const first = await register(patient('1001'));
  state.matchGolden = '0x100';
  const second = await register(patient('1001'), hospital('2002'));
  assert.equal(second.healthId, first.healthId);
  assert.equal(second.created, false);
  assert.equal(state.patients.length, 1);
  const systems = state.patients[0].identifier.filter((i) => i.value === '1001').map((i) => i.system).sort();
  assert.deepEqual(systems, [mrnSystem('1001'), mrnSystem('2002')]);
  assert.equal(state.patients[0].managingOrganization.reference, 'Organization/org-1001');
  const put = state.calls.find((c) => c.method === 'put');
  assert.equal(put.headers['If-Match'], 'W/"1"');
});

test('another facility\'s MRN namespace is refused before JeMPI', async () => {
  const input = patient('X');
  input.identifier[0].system = mrnSystem('2002');
  await assert.rejects(register(input), { status: 403 });
  assert.equal(jempiCalls().length, 0);
});

test('a client without Patient scopes is refused', async () => {
  await assert.rejects(register(patient('A'), hospital('1001', 'system/Encounter.crus')), { status: 403 });
  assert.equal(jempiCalls().length, 0);
});

test('a failed HAPI read fails the request instead of writing blind', async () => {
  state.searchFails = true;
  await assert.rejects(register(patient('A')), { status: 502 });
  assert.equal(state.calls.some((c) => c.host === 'hapi.invalid' && c.method !== 'get'), false);
});

test('a concurrent change to the Patient is a 409, not a lost update', async () => {
  await register(patient('A'));
  state.matchGolden = '0x100';
  state.putConflict = true;
  await assert.rejects(register(patient('B'), hospital('2002')), { status: 409 });
});

test('an unknown Health ID is refused before JeMPI; one belonging to someone else is a conflict', async () => {
  const bogus = { system: SYS.NEPAL_HEALTH_ID, value: 'AA4812423' };
  await assert.rejects(register(patient('A', [bogus])), { status: 422 });
  assert.equal(jempiCalls().length, 0);

  const other = await register(patient('B'));
  state.matchGolden = undefined; // JeMPI decides this is a different, new person
  await assert.rejects(
    register(patient('C', [{ system: SYS.NEPAL_HEALTH_ID, value: other.healthId }])),
    { status: 409 },
  );
});

test('client-supplied golden UIDs are dropped', async () => {
  await register(patient('A', [{ system: SYS.JEMPI_GOLDEN_UID, value: '0xforged' }]));
  const golden = state.patients[0].identifier.filter((i) => i.system === SYS.JEMPI_GOLDEN_UID);
  assert.deepEqual(golden.map((i) => i.value), ['0x100']);
});
