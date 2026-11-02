// @ts-nocheck
import axios from 'axios';
import { config } from '../config.js';
import { createServiceToken } from '../auth/serviceToken.js';

// Read-only HAPI client. The portal mediator only ever GETs. HAPI accepts no request
// without a token, so every call carries the mediator's own read-only client token.
export const hapi = axios.create({
  baseURL: config.HAPI_FHIR_BASE_URL,
  timeout: config.HAPI_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/fhir+json',
    'Accept': 'application/fhir+json',
  },
});

const authHeaders = createServiceToken({
  tokenUrl: config.KEYCLOAK_TOKEN_URL,
  audience: config.KEYCLOAK_ISSUER,
  clientId: config.PORTAL_CLIENT_ID,
  keyPath: config.PORTAL_CLIENT_KEY_PATH,
});

hapi.interceptors.request.use(async (cfg) => {
  Object.assign(cfg.headers, await authHeaders(cfg.method ?? 'get', `${config.HAPI_FHIR_BASE_URL}${cfg.url}`));
  return cfg;
});
// @ts-nocheck
