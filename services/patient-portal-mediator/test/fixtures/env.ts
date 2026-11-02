import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

// Shared test environment: the mediator's own client key (synthetic, generated per run)
// and a stub token endpoint, so HAPI calls carry a token without a Keycloak.
const keyPath = join(mkdtempSync(join(tmpdir(), 'portal-test-')), 'client.key.pem');
writeFileSync(keyPath, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test',
  MEDIATOR_URN: 'urn:test:portal', OPENHIM_API_URL: 'http://openhim.invalid',
  OPENHIM_USERNAME: 'test', OPENHIM_PASSWORD: 'test', HAPI_FHIR_BASE_URL: 'http://hapi.invalid',
  KEYCLOAK_TOKEN_URL: 'http://keycloak.invalid/token', KEYCLOAK_ISSUER: 'http://keycloak.invalid/realms/test',
  PORTAL_CLIENT_KEY_PATH: keyPath,
  PORTAL_PATIENT_SHARED_SECRET: 'synthetic-test-secret-at-least-32-bytes',
  PORTAL_PATIENT_TOKEN_ISSUER: 'urn:test:issuer', PORTAL_GID_CLAIM: 'gid',
});
delete process.env.PORTAL_PATIENT_JWKS_URL;

axios.defaults.adapter = async (config) => ({
  config, status: 200, statusText: 'OK', headers: {},
  data: { access_token: 'synthetic-service-token', expires_in: 300 },
});
