export function buildOpenHIMResponse({ status, body, orchestrations = [], urn }) {
  return {
    'x-mediator-urn': urn,
    status: status >= 200 && status < 300 ? 'Successful' : 'Failed',
    response: {
      status,
      headers: { 'Content-Type': 'application/fhir+json' },
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
