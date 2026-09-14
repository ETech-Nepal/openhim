import type { FhirRequest, FhirResponse, Resource } from '../../fhir/types.js';
import { upstreamError } from '../../lib/errors.js';
import { hapi } from '../../clients/hapi.js';
import { buildOpenHIMResponse, orch } from '../../lib/orchestration.js';
import { config } from '../../config.js';

const ALLOWED = new Set([
  'Patient',
  'Encounter',
  'Observation',
  'Organization',
  'Practitioner',
  'DocumentReference',
  'Binary',
]);

export async function searchHandler(req: FhirRequest, res: FhirResponse) {
  const { resourceType, id } = req.params;
  if (!ALLOWED.has(resourceType)) {
    return res.status(404).json(
      buildOpenHIMResponse({
        status: 404,
        body: oo(`Resource type ${resourceType} not supported`),
        urn: config.MEDIATOR_URN,
      }),
    );
  }

  const qs = new URLSearchParams(req.query).toString();
  const path = id
    ? `/${resourceType}/${id}${qs ? '?' + qs : ''}`
    : `/${resourceType}${qs ? '?' + qs : ''}`;

  try {
    const { data, status } = await hapi.get<Resource>(path);
    res.status(status).json(
      buildOpenHIMResponse({
        status,
        body: data,
        orchestrations: [orch(`GET HAPI ${resourceType}`, 'GET', path, null, status, data)],
        urn: config.MEDIATOR_URN,
      }),
    );
  } catch (caught) {
    const err = upstreamError(caught);
    const status = err.response?.status ?? 502;
    res.status(status).json(
      buildOpenHIMResponse({
        status,
        body: err.response?.data ?? oo(err.message),
        orchestrations: [
          orch(`GET HAPI ${resourceType}`, 'GET', path, null, status, err.response?.data),
        ],
        urn: config.MEDIATOR_URN,
      }),
    );
  }
}

function oo(diagnostics: string) {
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: 'not-found', diagnostics }],
  };
}
