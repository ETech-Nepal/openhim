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

test('search maps hid/nid/imis to their identifier systems and merges hits', async (t) => {
  const calls = fakeHapi(t, () => bundle([patient]));
  const res = response();
  await prsSearchHandler({ query: { hid: '1234', nid: '99-88', imis: '818485780' }, headers: {} }, res);
  assert.deepEqual(calls.map((c) => c.params.identifier).sort(), [
    `${SYS.INSURANCE_NUMBER}|818485780`, `${SYS.NATIONAL_ID}|99-88`, `${SYS.NEPAL_HEALTH_ID}|1234`,
  ].sort());
  const { patients } = body(res);
  assert.equal(patients.length, 1);
  assert.deepEqual(patients[0].identifiers, { healthId: '1234', nationalId: '99-88', imis: '818485780' });
  assert.deepEqual(patients[0].mrns, [{ facilityCode: '3130400221', mrn: 'M-1' }]);
});

test('search shows the survivor of a merged patient, not the retired one', async (t) => {
  const retired = { ...patient, id: 'old', active: false, link: [{ type: 'replaced-by', other: { reference: 'Patient/p1' } }] };
  fakeHapi(t, (c) => (c.url === '/Patient/p1' ? patient : bundle([retired])));
  const res = response();
  await prsSearchHandler({ query: { hid: '1234' }, headers: {} }, res);
  assert.deepEqual(body(res).patients.map((p) => p.id), ['p1']);
});

test('record groups diagnoses, reports and loose results under their encounter, and flags gaps', async (t) => {
  const calls = fakeHapi(t, (c) => {
    if (c.url === '/Patient/p1') return patient;
    if (c.url === '/Encounter') return bundle([{ id: 'e1', status: 'finished', period: { start: '2026-01-05' }, serviceProvider: { reference: 'Organization/o1', display: 'Bharatpur Hospital' } }], true);
    if (c.url === '/Condition') return bundle([{ id: 'c1', code: { text: 'Hypertension' }, encounter: { reference: 'Encounter/e1' } }]);
    if (c.url === '/DiagnosticReport') return bundle([{ id: 'r1', code: { text: 'CBC' }, encounter: { reference: 'Encounter/e1' }, result: [{ reference: 'Observation/o1' }] }]);
    if (c.url === '/Observation') return bundle([
      { id: 'o1', code: { text: 'Hb' }, valueQuantity: { value: 12, unit: 'g/dL' } },
      { id: 'o2', code: { text: 'Pulse' }, valueQuantity: { value: 80 }, encounter: { reference: 'Encounter/e1' } },
    ]);
    return new Error('DocumentReference unavailable');
  });
  const res = response();
  await prsPatientHandler({ params: { id: 'p1' }, headers: { 'x-prs-user': 'staff' } }, res);
  assert.ok(calls.filter((c) => c.url !== '/Patient/p1').every((c) => c.params?.subject === 'Patient/p1'));
  const out = body(res);
  const [enc] = out.encounters;
  assert.equal(enc.hospital, 'Bharatpur Hospital');
  assert.deepEqual(enc.diagnoses.map((d) => d.name), ['Hypertension']);
  assert.deepEqual(enc.reports.map((r) => r.results[0].name), ['Hb']);
  assert.deepEqual(enc.observations.map((o) => o.name), ['Pulse']);
  assert.deepEqual(out.truncated, ['Encounter']);
  assert.deepEqual(out.partial, ['DocumentReference']);
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
