import axios from 'axios';
import { config } from '../config.js';

// Read-only HAPI client. The portal mediator only ever GETs.
export const hapi = axios.create({
  baseURL: config.HAPI_FHIR_BASE_URL,
  timeout: config.HAPI_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/fhir+json',
    'Accept': 'application/fhir+json',
  },
});
