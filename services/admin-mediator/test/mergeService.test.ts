import './fixtures/env.js';
import test from 'node:test';
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
    else if (body.gid === '0x2' && state.interactions.length === 0) data = { error: 'golden record not found' };
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
    if (state.failWrite) { state.failWrite = false; status = 503; data = { resourceType: 'OperationOutcome', issue: [] }; }
    else if (url.pathname === '/Encounter/enc-1') { state.encounter = body; data = body; }
    else if (url.pathname.startsWith('/Patient/')) { state.patients[url.pathname.slice('/Patient/'.length)] = body; data = body; }
    else assert.fail(`Unexpected write: ${url}`);
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
      [survivorId]: { resourceType: 'Patient', id: survivorId, active: true, identifier: [{ system: SYS.NEPAL_HEALTH_ID, value: 'AA4812423' }, { system: SYS.JEMPI_GOLDEN_UID, value: '0x1' }] },
      [loserId]: { resourceType: 'Patient', id: loserId, active: true, identifier: [{ system: SYS.NEPAL_HEALTH_ID, value: 'BB0000000' }, { system: SYS.JEMPI_GOLDEN_UID, value: '0x2' }, { system: 'urn:synthetic:mrn', value: 'old-mrn' }] },
    },
    encounter: { resourceType: 'Encounter', id: 'enc-1', subject: { reference: `Patient/${loserId}` } },
  };
}

test.beforeEach(() => reset());

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
