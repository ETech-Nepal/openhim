import { config } from '../config.js';

// OpenHIM only unwraps this envelope (returning response.body to the caller) when the
// reply carries Content-Type: application/json+openhim — see src/index.js.
export function buildOpenHIMResponse({ status, body, orchestrations = [] }) {
  return {
    'x-mediator-urn': config.MEDIATOR_URN,
    status: status >= 200 && status < 300 ? 'Successful' : 'Failed',
    response: {
      status,
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      timestamp: new Date().toISOString(),
    },
    orchestrations,
  };
}

export function orch(name, method, path, reqBody, status, resBody) {
  return {
    name,
    request: {
      method, path,
      timestamp: new Date().toISOString(),
      body: reqBody ? JSON.stringify(reqBody).slice(0, 8000) : undefined,
    },
    response: {
      status,
      timestamp: new Date().toISOString(),
      body: resBody ? JSON.stringify(resBody).slice(0, 8000) : undefined,
    },
  };
}
