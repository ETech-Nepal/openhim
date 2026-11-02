import './fixtures/env.js';
import test from 'node:test';
import { pool, migrate } from '../src/db/pool.js';
import assert from 'node:assert/strict';
import axios from 'axios';

let state;
axios.defaults.adapter = async config => {
  const url = new URL(config.url, config.baseURL);
  const body = config.data ? JSON.parse(config.data) : null;
  state.calls.push({ method: config.method, path: url.pathname, body });
  let status = 200;
  let data;
  if (url.host === 'jempi.invalid' && url.pathname === '/expandedGoldenRecord') {
    if (body.gid === '0x2' && state.lookupFailure) { status = 503; data = { error: 'service unavailable' }; }
    else if (body.gid === '0x2' && state.interactions.length === 0) { status = 400; data = { error: 'Golden Record does not exist', goldenID: '0x2' }; }
    else data = {
      goldenRecord: { uid: body.gid, uniqueGoldenRecordData: { auxId: body.gid === '0x1' ? 'AA4812423' : 'BB0000000' } },
      interactionsWithScore: body.gid === '0x2' ? state.interactions.map(uid => ({ interaction: { uid }, score: 1 })) : [],
    };
  } else if (url.host === 'jempi.invalid' && url.pathname === '/relink') {
    if (body.interactionId === state.failInteraction) { status = 503; data = { message: 'relink unavailable' }; }
    else { state.interactions = state.interactions.filter(id => id !== body.interactionId); data = { goldenUID: '0x1' }; }
  } else if (url.host === 'hapi.invalid' && config.method === 'get' && url.pathname === '/Patient') {
    const identifier = url.searchParams.get('identifier');
    const resources = Object.values(state.patients).filter(p => p.identifier.some(id => `${id.system}|${id.value}` === identifier));
    data = { resourceType: 'Bundle', type: 'searchset', entry: resources.map(resource => ({ resource })) };
  } else if (url.host === 'hapi.invalid' && config.method === 'get' && url.pathname.startsWith('/Patient/')) {
    data = state.patients[url.pathname.slice('/Patient/'.length)];
    if (!data) { status = 404; data = { resourceType: 'OperationOutcome', issue: [] }; }
  } else if (url.host === 'hapi.invalid' && config.method === 'get' && ['/Encounter', '/Observation', '/DocumentReference'].includes(url.pathname)) {
    const resources = url.pathname === '/Encounter' && state.encounter.subject.reference === url.searchParams.get('patient') ? [state.encounter] : [];
    data = { resourceType: 'Bundle', type: 'searchset', entry: resources.map(resource => ({ resource })) };
  } else if (url.host === 'hapi.invalid' && config.method === 'put') {
    const stored = url.pathname === '/Encounter/enc-1' ? state.encounter : state.patients[url.pathname.slice('/Patient/'.length)];
    if (!stored) assert.fail(`Unexpected write: ${url}`);
    if (state.raceEncounter && stored === state.encounter) { state.raceEncounter = false; stored.meta.versionId = '2'; }
    const bumped = { ...body, meta: { versionId: String(Number(stored.meta.versionId) + 1) } };
    if (state.failWrite) { state.failWrite = false; status = 503; data = { resourceType: 'OperationOutcome', issue: [] }; }
    else if (config.headers['If-Match'] !== `W/"${stored.meta.versionId}"`) { status = 412; data = { resourceType: 'OperationOutcome', issue: [] }; }
    else if (url.pathname === '/Encounter/enc-1') { state.encounter = bumped; data = bumped; }
    else { state.patients[url.pathname.slice('/Patient/'.length)] = bumped; data = bumped; }
  } else assert.fail(`Unexpected request: ${config.method} ${url}`);
  const response = { config, status, data: structuredClone(data), headers: {}, statusText: '' };
  if (status >= 400) throw new axios.AxiosError('synthetic upstream failure', 'ERR_BAD_RESPONSE', config, null, response);
  return response;
};

const { mergeGoldenRecords } = await import('../src/services/mergeService.js');
const { SYS } = await import('../src/fhir/identifiers.js');
const merge = () => mergeGoldenRecords({ survivorUid: '0x1', loserUid: '0x2', score: 0.8 });

function reset(opaque = false) {
  const survivorId = opaque ? 'opaque-survivor' : 'AA4812423';
  const loserId = opaque ? 'opaque-loser' : 'BB0000000';
  state = {
    calls: [], interactions: ['0xa'], failWrite: false,
    patients: {
      [survivorId]: { resourceType: 'Patient', id: survivorId, meta: { versionId: '1' }, active: true, identifier: [{ system: SYS.NEPAL_HEALTH_ID, value: 'AA4812423' }, { system: SYS.JEMPI_GOLDEN_UID, value: '0x1' }] },
      [loserId]: { resourceType: 'Patient', id: loserId, meta: { versionId: '1' }, active: true, identifier: [{ system: SYS.NEPAL_HEALTH_ID, value: 'BB0000000' }, { system: SYS.JEMPI_GOLDEN_UID, value: '0x2' }, { system: 'urn:synthetic:mrn', value: 'old-mrn' }] },
    },
    encounter: { resourceType: 'Encounter', id: 'enc-1', meta: { versionId: '1' }, subject: { reference: `Patient/${loserId}` } },
  };
}

test.before(async () => {
  assert.ok(process.env.TEST_IDENTITY_DB_PORT, 'Set TEST_IDENTITY_DB_PORT to the disposable PostgreSQL port');
  await migrate();
});
test.after(() => pool.end());
test.beforeEach(async () => {
  reset();
  await pool.query(`DELETE FROM health_ids WHERE health_id IN ('AA4812423', 'BB0000000')`);
});

test('legacy-ID merge moves references before retiring the loser and preserves foreign identifiers', async () => {
  const result = await merge();
  assert.equal(result.status, 'MERGED');
  assert.equal(state.encounter.subject.reference, 'Patient/AA4812423');
  assert.equal(state.patients.BB0000000.active, false);
  assert.deepEqual(state.patients.BB0000000.link, [{ other: { reference: 'Patient/AA4812423' }, type: 'replaced-by' }]);
  assert.ok(state.patients.AA4812423.identifier.some(id => id.value === 'old-mrn'));
  assert.equal(state.patients.AA4812423.identifier.some(id => id.value === 'BB0000000'), false);
  const mutations = state.calls.filter(call => call.path === '/relink' || call.method === 'put').map(call => call.path);
  assert.deepEqual(mutations, ['/relink', '/Encounter/enc-1', '/Patient/AA4812423', '/Patient/BB0000000']);
});

test('merge resolves Health IDs to opaque HAPI IDs before moving references', async () => {
  reset(true);
  const result = await merge();
  assert.equal(result.status, 'MERGED', result.error);
  assert.equal(state.encounter.subject.reference, 'Patient/opaque-survivor');
  assert.equal(state.patients['opaque-loser'].active, false);
});

test('HAPI write failure is partial and leaves the losing Patient active', async () => {
  state.failWrite = true;
  const result = await merge();
  assert.equal(result.status, 'MERGE_PARTIAL');
  assert.equal(state.interactions.length, 0);
  assert.equal(state.patients.BB0000000.active, true);
  assert.equal(state.encounter.subject.reference, 'Patient/BB0000000');
});

test('retry completes HAPI reconciliation after JeMPI deleted the losing golden record', async () => {
  state.failWrite = true;
  assert.equal((await merge()).status, 'MERGE_PARTIAL');
  const result = await merge();
  assert.equal(result.status, 'MERGED', result.error);
  assert.equal(state.patients.BB0000000.active, false);
  assert.equal(state.encounter.subject.reference, 'Patient/AA4812423');
});

test('unavailable JeMPI lookup is a failure rather than evidence of a completed relink', async () => {
  state.lookupFailure = true;
  const result = await merge();
  assert.equal(result.status, 'FAILED');
  assert.equal(state.calls.some(call => call.path === '/relink' || call.method === 'put'), false);
});

test('failure after one interaction moved is partial, not an untouched failed merge', async () => {
  state.interactions = ['0xa', '0xb'];
  state.failInteraction = '0xb';
  const result = await merge();
  assert.equal(result.status, 'MERGE_PARTIAL');
  assert.deepEqual(state.interactions, ['0xb']);
  assert.equal(state.calls.some(call => call.method === 'put'), false);
});

test('failure on the first relink leaves HAPI untouched', async () => {
  state.failInteraction = '0xa';
  assert.equal((await merge()).status, 'FAILED');
  assert.equal(state.calls.some(call => call.method === 'put'), false);
  assert.deepEqual(state.interactions, ['0xa']);
});
// @ts-nocheck

test('a record changed during the merge fails the step instead of being overwritten', async () => {
  state.raceEncounter = true; // another writer updates the Encounter after the merge read it
  const result = await merge();
  assert.equal(result.status, 'MERGE_PARTIAL');
  assert.equal(state.patients.BB0000000.active, true);
});

test('a completed merge retires the losing Health ID in the register', async () => {
  assert.equal((await merge()).status, 'MERGED');
  const { rows } = await pool.query(`SELECT health_id, status, replaced_by FROM health_ids WHERE health_id IN ('AA4812423', 'BB0000000') ORDER BY health_id`);
  assert.deepEqual(rows, [
    { health_id: 'AA4812423', status: 'active', replaced_by: null },
    { health_id: 'BB0000000', status: 'retired', replaced_by: 'AA4812423' },
  ]);
});
