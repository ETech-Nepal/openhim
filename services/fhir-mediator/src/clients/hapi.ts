import type { Resource } from '../fhir/types.js';
import { upstreamError } from '../lib/errors.js';
import axios from 'axios';
import { config } from '../config.js';

export const hapi = axios.create({
  baseURL: config.HAPI_FHIR_BASE_URL,
  timeout: config.HAPI_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/fhir+json',
    Accept: 'application/fhir+json',
  },
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

export async function postResource(resourceType: string, body: Resource) {
  const { data, status } = await hapi.post<Resource>(`/${resourceType}`, body);
  return { data, status };
}

// Read a resource by id. Returns { resource: null, status: 404 } when absent
// (instead of throwing) so callers can branch on existence.
export async function getResource(resourceType: string, id: string) {
  try {
    const { data, status } = await hapi.get<Resource>(`/${resourceType}/${id}`);
    return { data, status, resource: data };
  } catch (caught) {
    const err = upstreamError(caught);
    if (err.response?.status === 404) return { data: null, status: 404, resource: null };
    throw err;
  }
}

// Idempotent upsert by client-assigned id (requires HAPI client_id_strategy: ANY).
export async function putResource(resourceType: string, id: string, body: Resource) {
  const { data, status } = await hapi.put<Resource>(`/${resourceType}/${id}`, body);
  return { data, status };
}

export async function conditionalUpdate(
  resourceType: string,
  system: string,
  value: string,
  body: Resource,
) {
  const q = encodeURIComponent(`${system}|${value}`);
  const { id: _drop, ...clean } = body;
  const { data, status } = await hapi.put<Resource>(`/${resourceType}?identifier=${q}`, clean);
  return { data, status };
}

export async function postBinary(buffer: Buffer, contentType: string) {
  const { data, status } = await hapi.post<Resource>('/Binary', buffer, {
    headers: { 'Content-Type': contentType, Accept: 'application/fhir+json' },
  });
  return { data, status };
}

export async function searchByIdentifier(resourceType: string, system: string, value: string) {
  const q = encodeURIComponent(`${system}|${value}`);
  const { data, status } = await hapi.get<Resource>(`/${resourceType}?identifier=${q}&_count=1`);
  return { data, status, resource: data.entry?.[0]?.resource };
}

export async function passthroughGet(resourceType: string, queryString?: string) {
  const path = queryString ? `/${resourceType}?${queryString}` : `/${resourceType}`;
  const { data, status } = await hapi.get<Resource>(path);
  return { data, status, path };
}

export async function postBundle(bundle: Resource) {
  const { data, status } = await hapi.post<Resource>('/', bundle);
  return { data, status };
}
