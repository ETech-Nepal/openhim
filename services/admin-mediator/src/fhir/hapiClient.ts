// @ts-nocheck
import axios from 'axios';
import { config } from '../config.js';

export const hapi = axios.create({
  baseURL: config.HAPI_FHIR_BASE_URL,
  timeout: config.HAPI_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/fhir+json',
    Accept: 'application/fhir+json',
  },
});

/** GET a resource by id, or null on 404 (rather than throwing). */
export async function readResource(type, id) {
  try {
    const { data } = await hapi.get(`/${type}/${encodeURIComponent(id)}`);
    return data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
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
// @ts-nocheck
