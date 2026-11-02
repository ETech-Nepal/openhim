// @ts-nocheck
import './fixtures/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import axios from 'axios';
import { createTokenVerifier, hasScope } from '../src/auth/token.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'http://keycloak.invalid/realms/openhie';
const jwksUri = `${issuer}/protocol/openid-connect/certs`;
axios.defaults.adapter = async (config) => ({
  config, status: 200, headers: {}, statusText: '',
  data: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] },
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims, { kid = 'k1', key = privateKey } = {}) {
  const input = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(claims)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: issuer, exp: now() + 300, azp: '3130400221', scope: 'system/Patient.crus openid' });
const verify = createTokenVerifier({ issuer, jwksUri });

test('a valid DPoP or Bearer token yields the client and its scopes', async () => {
  for (const scheme of ['DPoP', 'Bearer']) {
    const caller = await verify(`${scheme} ${jwt(good())}`);
    assert.deepEqual(caller, { clientId: '3130400221', scopes: ['system/Patient.crus', 'openid'] });
  }
});

test('tokens that are missing, forged, foreign or expired are refused', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const cases = [
    undefined,
    'Basic abc',
    `DPoP ${jwt(good(), { key: other })}`,
    `DPoP ${jwt({ ...good(), iss: 'http://evil.invalid' })}`,
    `DPoP ${jwt({ ...good(), exp: now() - 120 })}`,
    `DPoP ${jwt(good(), { kid: 'unknown' })}`,
  ];
  for (const header of cases) await assert.rejects(verify(header), { status: 401 }, String(header));
});

test('SMART v2 and v1 system scopes', () => {
  assert.equal(hasScope(['system/Patient.cru'], 'Patient', 'c'), true);
  assert.equal(hasScope(['system/Patient.rs'], 'Patient', 'c'), false);
  assert.equal(hasScope(['system/*.cruds'], 'Encounter', 'u'), true);
  assert.equal(hasScope(['system/Patient.write'], 'Patient', 'u'), true);
  assert.equal(hasScope(['system/Patient.read'], 'Patient', 'u'), false);
  assert.equal(hasScope(['user/Patient.cruds', 'patient/Patient.c'], 'Patient', 'c'), false);
  assert.equal(hasScope(['system/Patient.rc'], 'Patient', 'c'), false, 'v2 letters must be in order');
});
