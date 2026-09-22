import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test',
  MEDIATOR_URN: 'urn:test:portal', OPENHIM_API_URL: 'http://openhim.invalid',
  OPENHIM_USERNAME: 'test', OPENHIM_PASSWORD: 'test',
  HAPI_FHIR_BASE_URL: 'http://hapi.invalid',
  PORTAL_PATIENT_SHARED_SECRET: 'synthetic-test-secret-at-least-32-bytes',
  PORTAL_PATIENT_TOKEN_ISSUER: 'urn:test:issuer', PORTAL_GID_CLAIM: 'gid',
});
delete process.env.PORTAL_PATIENT_JWKS_URL;

const { patientContext } = await import('../src/middleware/patientContext.js');
const { portalSummaryHandler } = await import('../src/handlers/patientPortal.js');
const { hapi } = await import('../src/fhir/hapiClient.js');
const { SYS } = await import('../src/fhir/identifiers.js');
const key = new TextEncoder().encode(process.env.PORTAL_PATIENT_SHARED_SECRET);
const token = (claims = { gid: '0x1' }, signingKey = key, expiry = '5m') => new SignJWT(claims)
  .setProtectedHeader({ alg: 'HS256' }).setIssuer('urn:test:issuer').setExpirationTime(expiry).sign(signingKey);
const response = () => ({ status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });

for (const scenario of ['missing', 'malformed', 'expired', 'wrong signature', 'missing identity']) {
  test(`rejects ${scenario} patient token before summary access`, async () => {
    const tokens = {
      missing: undefined, malformed: 'invalid.jwt', expired: await token({ gid: '0x1' }, key, 1),
      'wrong signature': await token({ gid: '0x1' }, new TextEncoder().encode('wrong-synthetic-secret')),
      'missing identity': await token({}),
    };
    const req = { headers: { 'x-patient-token': tokens[scenario] } };
    const res = response();
    let nextCalls = 0;
    await patientContext(req, res, () => { nextCalls++; });
    assert.equal(nextCalls, 0);
    assert.equal(req.patientContext, undefined);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.response.status, 401);
    assert.equal(JSON.parse(res.body.response.body).issue[0].code, 'security');
  });
}

test('summary scopes all clinical reads to the signed identity despite forged request identity', async t => {
  const calls = [];
  const previous = hapi.defaults.adapter;
  t.after(() => { hapi.defaults.adapter = previous; });
  hapi.defaults.adapter = async config => {
    calls.push({ url: config.url, params: config.params });
    let resources = [];
    if (config.url === '/Patient') {
      assert.equal(config.params.identifier, `${SYS.JEMPI_GOLDEN_UID}|0x1`);
      resources = [{ resourceType: 'Patient', id: 'opaque-authorized', name: [{ given: ['Synthetic'], family: 'Patient' }] }];
    } else {
      assert.ok(['/Encounter', '/DiagnosticReport', '/DocumentReference', '/Observation'].includes(config.url));
      assert.equal(config.params.subject, 'Patient/opaque-authorized');
    }
    return { config, status: 200, statusText: 'OK', headers: {}, data: { resourceType: 'Bundle', type: 'searchset', entry: resources.map(resource => ({ resource })) } };
  };
  const req = {
    headers: { 'x-patient-token': await token(), 'x-golden-uid': '0xforged' },
    query: { goldenUid: '0xforged', patientId: 'other-patient' },
  };
  const res = response();
  let verified = false;
  await patientContext(req, res, () => { verified = true; });
  assert.equal(verified, true);
  await portalSummaryHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 5);
  assert.deepEqual(JSON.parse(res.body.response.body), {
    profile: { name: 'Synthetic Patient', gender: null, birthDate: null, phone: null, email: null, address: null, healthId: null, linkedRecords: 1 },
    hospitals: [], encounters: [], reports: [], documents: [],
  });
});
// @ts-nocheck
