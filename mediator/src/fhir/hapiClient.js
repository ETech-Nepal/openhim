import axios from 'axios';
import { config } from '../config.js';

export const hapi = axios.create({
  baseURL: config.HAPI_FHIR_BASE_URL,
  timeout: config.HAPI_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/fhir+json',
    'Accept': 'application/fhir+json',
  },
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

export async function postResource(resourceType, body) {
  const { data, status } = await hapi.post(`/${resourceType}`, body);
  return { data, status };
}

// Read a resource by id. Returns { resource: null, status: 404 } when absent
// (instead of throwing) so callers can branch on existence.
export async function getResource(resourceType, id) {
  try {
    const { data, status } = await hapi.get(`/${resourceType}/${id}`);
    return { data, status, resource: data };
  } catch (err) {
    if (err.response?.status === 404) return { data: null, status: 404, resource: null };
    throw err;
  }
}

// Idempotent upsert by client-assigned id (requires HAPI client_id_strategy: ANY).
export async function putResource(resourceType, id, body) {
  const { data, status } = await hapi.put(`/${resourceType}/${id}`, body);
  return { data, status };
}

// FHIR conditional update: PUT /<type>?identifier=<system>|<value> with a body
// that carries NO id. HAPI creates it with a server-assigned id if nothing
// matches, updates the single match in place, or 412s if two already match.
// Race-safe on a unique identifier, and keeps Resource.id opaque.
export async function conditionalUpdate(resourceType, system, value, body) {
  const q = encodeURIComponent(`${system}|${value}`);
  const { id: _drop, ...clean } = body;
  const { data, status } = await hapi.put(`/${resourceType}?identifier=${q}`, clean);
  return { data, status };
}

export async function postBinary(buffer, contentType) {
  const { data, status } = await hapi.post('/Binary', buffer, {
    headers: { 'Content-Type': contentType, 'Accept': 'application/fhir+json' },
  });
  return { data, status };
}

export async function searchByIdentifier(resourceType, system, value) {
  const q = encodeURIComponent(`${system}|${value}`);
  const { data, status } = await hapi.get(`/${resourceType}?identifier=${q}&_count=1`);
  return { data, status, resource: data.entry?.[0]?.resource };
}

export async function passthroughGet(resourceType, queryString) {
  const path = queryString ? `/${resourceType}?${queryString}` : `/${resourceType}`;
  const { data, status } = await hapi.get(path);
  return { data, status, path };
}

export async function postBundle(bundle) {
  const { data, status } = await hapi.post('/', bundle);
  return { data, status };
}
