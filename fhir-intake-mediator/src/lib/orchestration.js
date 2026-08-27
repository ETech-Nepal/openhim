function bodyForOrchestration(body) {
  if (body === undefined || body === null) return undefined;
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  return serialized.slice(0, 8000);
}

export function orch(name, method, path, requestBody, status, responseBody) {
  return {
    name,
    request: {
      method,
      path,
      timestamp: new Date().toISOString(),
      body: bodyForOrchestration(requestBody),
    },
    response: {
      status,
      timestamp: new Date().toISOString(),
      body: bodyForOrchestration(responseBody),
    },
  };
}

export function buildOpenHimResponse({ status, body, orchestrations = [], urn }) {
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

// Keep compatibility with existing mediators, which use the all-caps acronym.
export const buildOpenHIMResponse = buildOpenHimResponse;
