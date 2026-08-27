import { hapi, postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

export async function encounterHandler(req, res) {
  const enc = req.body;
  const orchestrations = [];

  // If subject is a conditional reference (Patient?identifier=...), resolve in HAPI
  if (enc.subject?.reference?.startsWith('Patient?')) {
    const query = enc.subject.reference.substring('Patient?'.length);
    const search = await hapi.get(`/Patient?${query}&_count=1`);
    orchestrations.push(orch('GET HAPI Patient search', 'GET', `/Patient?${query}`, null, search.status, search.data));
    const entry = search.data.entry?.[0];
    if (!entry) {
      return res.status(404).json(buildOpenHIMResponse({
        status: 404, body: oo(`No Patient matched ${enc.subject.reference}`),
        orchestrations, urn: config.MEDIATOR_URN,
      }));
    }
    enc.subject.reference = `Patient/${entry.resource.id}`;
  }

  const result = await postResource('Encounter', enc);
  orchestrations.push(orch('POST HAPI Encounter', 'POST', '/Encounter', enc, result.status, result.data));
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics }] }; }
