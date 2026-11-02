import { execFileSync } from 'node:child_process';
const dir = new URL('.', import.meta.url).pathname;
const tok = (c, s) => execFileSync('node', [dir + 'mint.mjs', c, s]).toString();
const H = 'system/Patient.crus system/Encounter.crus system/Observation.crus system/DocumentReference.crus system/Organization.rs system/Practitioner.rs system/Binary.r';
const run = Date.now() % 100000;
const C1 = String(10000 + run), C2 = String(20000 + run);
const T = {
  onb: tok('onboarding', 'system/Organization.cru system/Practitioner.cru'),
  id: tok('identity-mediator', 'system/*.crus'),
  h1: tok(C1, H), h2: tok(C2, H),
};
const base = process.env.FHIR_BASE ?? 'http://localhost:18081/fhir';
async function call(who, method, path, body, extra = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/fhir+json', ...(who && { Authorization: `DPoP ${T[who]}` }), ...extra }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
let fails = 0;
function check(name, cond, info) { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' :: ' + String(JSON.stringify(info)).slice(0, 400)}`); if (!cond) fails++; }
const diag = (r) => r.body?.issue?.[0]?.diagnostics;
const NHFR = 'http://nhfr.digitalhealth.gov.np';
const MRN = 'http://mohp.gov.np/fhir/NamingSystem/hospital-mrn';
const HID = 'http://fhir.digitalhealth.gov.np/core/NamingSystem/nepal-health-id';

let r = await call(null, 'GET', '/Patient?identifier=x|1');
check('no token is 401', r.status === 401, r);
r = await call(null, 'POST', '/Encounter', { resourceType: 'Encounter' });
check('invalid body without token is 401, not a validation report', r.status === 401, r.status);
r = await call('h1', 'GET', '/metadata'); check('metadata open', r.status === 200, r.status);

const org = async (code) => (await call('onb', 'POST', '/Organization', { resourceType: 'Organization', name: 'H' + code, identifier: [{ system: NHFR, value: code }] })).body.id;
const o1 = await org(C1); const o2 = await org(C2);
check('onboarding client creates Organizations', !!o1 && !!o2, { o1, o2 });
r = await call('h1', 'POST', '/Organization', { resourceType: 'Organization', name: 'fake', identifier: [{ system: NHFR, value: C2 }] });
check('hospital cannot create Organization', r.status === 403, r);

const patient = (hid, mrnSys, mrn) => ({ resourceType: 'Patient', identifier: [{ system: HID, value: hid }, { system: mrnSys, value: mrn }], name: [{ family: 'K' + hid }] });
r = await call('h1', 'POST', '/Patient', patient('ZZ0000001', `${MRN}/${C1}`, 'M1'));
check('hospital cannot write Patient directly', r.status === 403 && /identity/.test(diag(r)), r);
const pa = (await call('id', 'POST', '/Patient', patient('AA'+run, `${MRN}/${C1}`, 'M1'))).body;
const pb = (await call('id', 'POST', '/Patient', patient('BB'+run, `${MRN}/${C1}`, 'M2'))).body;
check('identity mediator writes Patients', !!pa.id && !!pb.id, { pa, pb });

r = await call('h1', 'GET', '/Patient?_count=1000'); check('unscoped Patient search refused', r.status === 400, r);
r = await call('h1', 'GET', `/Patient?identifier=${encodeURIComponent(HID + '|AA' + run)}`); check('Patient search by identifier allowed', r.status === 200 && r.body.total === 1, r);
r = await call('h1', 'GET', '/Encounter?status=finished'); check('clinical search without patient refused', r.status === 400, r);
r = await call('h1', 'GET', `/Encounter?patient=Patient/${pa.id}&subject.name=x`); check('chained search refused', r.status === 400, r);
r = await call('h1', 'GET', `/Patient?_id=${pa.id}&_revinclude=*`); check('wildcard revinclude refused', r.status === 400, r);
r = await call('h1', 'GET', '/Binary?_id=1'); check('Binary search refused', r.status === 400 || r.status === 403, r);
r = await call('h1', 'GET', '/Patient/_history'); check('type history refused', r.status === 403, r);

const enc = (ns, subject, extra = {}) => ({ resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, identifier: [{ system: `${NHFR}/${ns}`, value: 'E-' + Math.random() }], subject: { reference: subject }, serviceProvider: { reference: `Organization/${o2}` }, ...extra });
r = await call('h1', 'POST', '/Encounter', enc(C1, `Patient/${pa.id}`));
const e1 = r.body;
check('hospital creates Encounter', r.status === 201, r);
check('facility tag stamped', e1.meta?.tag?.some((t) => t.code === C1), e1.meta);
check('serviceProvider forced to caller', e1.serviceProvider?.reference === `Organization/${o1}`, e1.serviceProvider);
r = await call('h2', 'PUT', `/Encounter/${e1.id}`, { ...e1, status: 'cancelled' });
check('other facility cannot update the Encounter', r.status === 403, r);
r = await call('h1', 'PUT', `/Encounter/${e1.id}`, { ...e1, status: 'cancelled', meta: undefined });
check('owner updates, tag kept', r.status === 200 && r.body.meta?.tag?.some((t) => t.code === C1), r);
r = await call('h2', 'POST', '/Encounter', enc(C1, `Patient/${pa.id}`));
check('foreign encounter namespace refused', r.status === 403, r);
r = await call('h1', 'DELETE', `/Encounter/${e1.id}`); check('delete refused', r.status === 403, r);

r = await call('h1', 'POST', '/Encounter', enc(C1, `Patient?identifier=${MRN}|M1`));
check('bare MRN conditional reference refused', r.status === 400, r);

const tx = (entries) => ({ resourceType: 'Bundle', type: 'transaction', entry: entries });
r = await call('h1', 'POST', '', tx([{ fullUrl: 'urn:uuid:6f1c2a9e-1b7d-4c1e-9a55-0d9e3c1b2a77', resource: enc(C1, `Patient/${pa.id}`), request: { method: 'POST', url: 'Encounter' } },
  { fullUrl: 'urn:uuid:9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', resource: { resourceType: 'Observation', status: 'final', code: { text: 'bp' }, subject: { reference: `Patient/${pa.id}` }, encounter: { reference: 'urn:uuid:6f1c2a9e-1b7d-4c1e-9a55-0d9e3c1b2a77' } }, request: { method: 'POST', url: 'Observation' } }]));
check('transaction of clinical entries', r.status === 200, r);
const obsLoc = r.body?.entry?.[1]?.response?.location;
const obs = obsLoc && (await call('h1', 'GET', '/' + obsLoc.split('/_history')[0])).body;
check('transaction entries stamped', obs?.meta?.tag?.some((t) => t.code === C1), obs?.meta);
r = await call('h1', 'POST', '', tx([{ fullUrl: 'urn:uuid:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', resource: patient('CC'+run, `${MRN}/${C1}`, 'X'), request: { method: 'POST', url: 'Patient' } }]));
check('transaction with a Patient refused', r.status === 403, r);
r = await call('h2', 'POST', '', tx([{ fullUrl: 'urn:uuid:0b6f5c1e-8a3d-4f2b-9c7e-5d4a3b2c1d0e', resource: enc(C1, `Patient/${pa.id}`), request: { method: 'POST', url: 'Encounter', ifNoneExist: `identifier=${NHFR}/${C1}|E1` } }]));
check('conditional create in foreign namespace refused', r.status === 403, r);

// merge: A retired, replaced by B
const paNow = (await call('id', 'GET', `/Patient/${pa.id}`)).body;
r = await call('id', 'PUT', `/Patient/${pa.id}`, { ...paNow, active: false, link: [{ other: { reference: `Patient/${pb.id}` }, type: 'replaced-by' }] });
check('identity retires Patient', r.status === 200, r);
r = await call('h1', 'POST', '/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: `Patient/${pa.id}` } });
check('write to retired Patient redirected to survivor', r.status === 201 && r.body.subject?.reference === `Patient/${pb.id}`, r.body?.subject ?? r);

// ambiguous conditional reference: two Patients with the same scoped MRN
await call('id', 'POST', '/Patient', patient('DD'+run, `${MRN}/${C1}`, 'DUP'));
await call('id', 'POST', '/Patient', patient('EE'+run, `${MRN}/${C1}`, 'DUP'));
r = await call('h1', 'POST', '/Encounter', enc(C1, `Patient?identifier=${encodeURIComponent(MRN + '/' + C1 + '|DUP')}`));
check('ambiguous conditional reference fails (HAPI native)', r.status === 412 || r.status === 400, { status: r.status, d: diag(r) });
console.log('ambiguous status:', r.status, diag(r));

const nid = (ref) => ({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: ref } });
r = await call('h1', 'POST', '/Observation', nid('Patient?identifier=http://donidcr.gov.np|NID-' + run));
check('unencoded path-less system in a conditional reference is a clear 400', r.status === 400 && /URL-encode/.test(diag(r)), r);
r = await call('h1', 'POST', '/Observation', nid('Patient?identifier=http%3A%2F%2Fdonidcr.gov.np%7CNID-' + run));
check('the encoded form reaches HAPI (404: no such patient), not a 500', r.status === 404, r);
r = await call('h1', 'GET', `/Encounter?patient=Patient/${pa.id}&_count=500`);
check('large _count allowed but capped', r.status === 200 && (r.body.entry?.length ?? 0) <= 100, r.status);
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
