// @ts-nocheck
import axios from 'axios';
import { config } from '../config.js';
import { createServiceToken } from '../auth/serviceToken.js';

export const hapi = axios.create({
  baseURL: config.HAPI_FHIR_BASE_URL,
  timeout: config.HAPI_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/fhir+json',
    Accept: 'application/fhir+json',
  },
});

// HAPI accepts Patient writes only from this mediator's client (interceptor module),
// so every call carries this mediator's own DPoP-bound token.
if (config.IDENTITY_CLIENT_KEY_PATH) {
  const authHeaders = createServiceToken({
    tokenUrl: config.KEYCLOAK_TOKEN_URL,
    audience: config.KEYCLOAK_ISSUER,
    clientId: config.IDENTITY_CLIENT_ID,
    keyPath: config.IDENTITY_CLIENT_KEY_PATH,
  });
  hapi.interceptors.request.use(async (req) => {
    // axios joins baseURL and a relative url by concatenation; `next` links are absolute.
    const url = /^https?:/.test(req.url) ? req.url : `${req.baseURL.replace(/\/$/, '')}/${req.url.replace(/^\//, '')}`;
    Object.assign(req.headers, await authHeaders(req.method, url));
    return req;
  });
}

/**
 * The Patient carrying an identifier, or null. Patients are looked up by Health ID or
 * golden UID, never by resource id: the write path lets HAPI assign opaque ids.
 */
export async function findPatient(system, value) {
  const { data } = await hapi.get(`/Patient?${new URLSearchParams({ identifier: `${system}|${value}` })}`);
  return data.entry?.[0]?.resource ?? null;
}

/** Every entry across a paged search, following `next` links. */
export async function searchAll(type, params) {
  const out = [];
  let url = `/${type}?${new URLSearchParams(params).toString()}`;
  while (url) {
    const { data } = await hapi.get(url);
    out.push(...(data.entry ?? []).map((e) => e.resource).filter(Boolean));
    const next = (data.link ?? []).find((l) => l.relation === 'next');
    // HAPI returns absolute next links; axios baseURL only applies to relative ones.
    url = next?.url ?? null;
  }
  return out;
}

/** PUT a resource only if it still has the version that was read (W/"<versionId>"). */
export function putIfMatch(resource) {
  const { resourceType, id, meta } = resource;
  return hapi.put(`/${resourceType}/${id}`, resource, {
    headers: { 'If-Match': `W/"${meta.versionId}"` },
  });
}
