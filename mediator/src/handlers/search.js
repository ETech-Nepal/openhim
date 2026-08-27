import { hapi } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

const ALLOWED = new Set([
  'Patient', 'Encounter', 'Observation', 'Organization', 'Practitioner',
  'DocumentReference', 'Binary',
]);

export async function searchHandler(req, res) {
  const { resourceType, id } = req.params;
  if (!ALLOWED.has(resourceType)) {
    return res.status(404).json(buildOpenHIMResponse({
      status: 404, body: oo(`Resource type ${resourceType} not supported`),
      urn: config.MEDIATOR_URN,
    }));
  }

  const qs = new URLSearchParams(req.query).toString();
  const path = id
    ? `/${resourceType}/${id}${qs ? '?' + qs : ''}`
    : `/${resourceType}${qs ? '?' + qs : ''}`;

  try {
    const { data, status } = await hapi.get(path);
    res.status(status).json(buildOpenHIMResponse({
      status, body: data,
      orchestrations: [orch(`GET HAPI ${resourceType}`, 'GET', path, null, status, data)],
      urn: config.MEDIATOR_URN,
    }));
  } catch (err) {
    const status = err.response?.status ?? 502;
    res.status(status).json(buildOpenHIMResponse({
      status, body: err.response?.data ?? oo(err.message),
      orchestrations: [orch(`GET HAPI ${resourceType}`, 'GET', path, null, status, err.response?.data)],
      urn: config.MEDIATOR_URN,
    }));
  }
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics }] }; }
