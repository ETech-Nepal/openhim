import { hapi, postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

export async function observationHandler(req, res) {
  const obs = req.body;
  const orchestrations = [];
  const refField = obs.subject?.reference ? 'subject' : (obs.patient?.reference ? 'patient' : null);

  if (refField && obs[refField].reference.startsWith('Patient?')) {
    const query = obs[refField].reference.substring('Patient?'.length);
    const search = await hapi.get(`/Patient?${query}&_count=1`);
    orchestrations.push(orch('GET HAPI Patient search', 'GET', `/Patient?${query}`, null, search.status, search.data));
    const entry = search.data.entry?.[0];
    if (!entry) {
      return res.status(404).json(buildOpenHIMResponse({
        status: 404, body: oo(`No Patient matched ${obs[refField].reference}`),
        orchestrations, urn: config.MEDIATOR_URN,
      }));
    }
    obs[refField].reference = `Patient/${entry.resource.id}`;
  }

  const result = await postResource('Observation', obs);
  orchestrations.push(orch('POST HAPI Observation', 'POST', '/Observation', obs, result.status, result.data));
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics }] }; }
