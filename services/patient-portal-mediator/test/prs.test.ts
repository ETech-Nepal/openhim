import test from 'node:test';
import assert from 'node:assert/strict';

await import('./fixtures/env.js');

const { prsPatientHandler, prsSearchHandler } = await import('../src/handlers/prs.js');
const { hapi } = await import('../src/fhir/hapiClient.js');
const { SYS } = await import('../src/fhir/identifiers.js');

const response = () => ({ status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } });
const body = (res) => JSON.parse(res.body.response.body);
const bundle = (resources, next = false) => ({ resourceType: 'Bundle', link: next ? [{ relation: 'next', url: 'x' }] : [], entry: resources.map((resource) => ({ resource })) });

const patient = {
  resourceType: 'Patient', id: 'p1', gender: 'female', birthDate: '1990-01-02', name: [{ given: ['Sita'], family: 'Rai' }],
  identifier: [
    { system: SYS.NEPAL_HEALTH_ID, value: '1234' }, { system: SYS.NATIONAL_ID, value: '99-88' },
    { system: SYS.INSURANCE_NUMBER, value: '818485780' }, { system: `${SYS.HOSPITAL_MRN_PREFIX}3130400221`, value: 'M-1' },
  ],
};

function fakeHapi(t, handlers) {
  const calls = [];
  const previous = hapi.defaults.adapter;
  t.after(() => { hapi.defaults.adapter = previous; });
  hapi.defaults.adapter = async (config) => {
    calls.push({ url: config.url, params: config.params });
    const out = handlers(config);
    if (out instanceof Error) throw out;
    return { config, status: 200, statusText: 'OK', headers: {}, data: out };
  };
  return calls;
}

test('search needs an identifier and rejects malformed values', async () => {
  for (const query of [{}, { hid: 'a b' }, { imis: '1' }]) {
    const res = response();
    await prsSearchHandler({ query, headers: {} }, res);
    assert.equal(res.statusCode, 400);
  }
});

test('search maps hid/nid/imis to their identifier systems and returns a FHIR searchset', async (t) => {
  const calls = fakeHapi(t, () => bundle([patient]));
  const res = response();
  await prsSearchHandler({ query: { hid: '1234', nid: '99-88', imis: '818485780' }, headers: {} }, res);
  assert.deepEqual(calls.map((c) => c.params.identifier).sort(), [
    `${SYS.INSURANCE_NUMBER}|818485780`, `${SYS.NATIONAL_ID}|99-88`, `${SYS.NEPAL_HEALTH_ID}|1234`,
  ].sort());
  const out = body(res);
  assert.equal(out.resourceType, 'Bundle');
  assert.equal(out.type, 'searchset');
  assert.equal(out.total, 1);
  const queries = JSON.parse(decodeURIComponent(res.body.response.headers['X-FHIR-Queries']));
  assert.equal(queries.length, 3);
  assert.ok(queries.every((q) => q.startsWith('GET http') && q.includes('/Patient?identifier=')));
  assert.equal(out.entry[0].resource.resourceType, 'Patient');
  assert.equal(out.entry[0].resource.id, 'p1');
});

test('search returns the survivor of a merged patient, not the retired one', async (t) => {
  const retired = { ...patient, id: 'old', active: false, link: [{ type: 'replaced-by', other: { reference: 'Patient/p1' } }] };
  fakeHapi(t, (c) => (c.url === '/Patient/p1' ? patient : bundle([retired])));
  const res = response();
  await prsSearchHandler({ query: { hid: '1234' }, headers: {} }, res);
  assert.deepEqual(body(res).entry.map((e) => e.resource.id), ['p1']);
});

test('record is one FHIR collection: patient, clinical resources, organizations, and an outcome for gaps', async (t) => {
  const calls = fakeHapi(t, (c) => {
    if (c.url === '/Patient/p1') return patient;
    if (c.url === '/Organization/o1') return { resourceType: 'Organization', id: 'o1', name: 'Bharatpur Hospital' };
    if (c.url === '/Encounter') return bundle([{ resourceType: 'Encounter', id: 'e1', status: 'finished', serviceProvider: { reference: 'Organization/o1' } }], true);
    if (c.url === '/Condition') return bundle([{ resourceType: 'Condition', id: 'c1' }]);
    if (c.url === '/DiagnosticReport') return bundle([{ resourceType: 'DiagnosticReport', id: 'r1' }]);
    if (c.url === '/Observation') return bundle([{ resourceType: 'Observation', id: 'o1x' }]);
    return new Error('DocumentReference unavailable');
  });
  const res = response();
  await prsPatientHandler({ params: { id: 'p1' }, headers: { 'x-prs-user': 'staff' } }, res);
  assert.ok(calls.filter((c) => c.url !== '/Patient/p1' && c.url !== '/Organization/o1').every((c) => c.params?.subject === 'Patient/p1'));
  const out = body(res);
  assert.equal(out.type, 'collection');
  const types = out.entry.map((e) => e.resource.resourceType);
  assert.deepEqual([...new Set(types)].sort(), ['Condition', 'DiagnosticReport', 'Encounter', 'Observation', 'Organization', 'OperationOutcome', 'Patient'].sort());
  const oo = out.entry.find((e) => e.resource.resourceType === 'OperationOutcome').resource;
  assert.deepEqual(oo.issue.map((i) => [i.code, i.expression[0]]).sort(), [['incomplete', 'DocumentReference'], ['too-long', 'Encounter']]);
});

test('a complete record carries no OperationOutcome', async (t) => {
  fakeHapi(t, (c) => (c.url === '/Patient/p1' ? patient : bundle([])));
  const res = response();
  await prsPatientHandler({ params: { id: 'p1' }, headers: {} }, res);
  assert.deepEqual(body(res).entry.map((e) => e.resource.resourceType), ['Patient']);
});

test('record rejects odd ids and reports an unknown patient as 404', async (t) => {
  let res = response();
  await prsPatientHandler({ params: { id: '../x' }, headers: {} }, res);
  assert.equal(res.statusCode, 400);
  fakeHapi(t, () => Object.assign(new Error('nf'), { response: { status: 404 } }));
  res = response();
  await prsPatientHandler({ params: { id: 'zz' }, headers: {} }, res);
  assert.equal(res.statusCode, 404);
});
