export function buildOpenHIMResponse({
  status,
  body,
  orchestrations = [],
  urn,
}: {
  status: number;
  body: unknown;
  orchestrations?: Orchestration[];
  urn: string;
}) {
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

export function orch(
  name: string,
  method: string,
  path: string,
  reqBody: unknown,
  status: number,
  resBody: unknown,
) {
  return {
    name,
    request: {
      method,
      path,
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

export type Orchestration = ReturnType<typeof orch>;
