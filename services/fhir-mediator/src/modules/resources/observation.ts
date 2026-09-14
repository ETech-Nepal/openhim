import type { FhirRequest, FhirResponse, Resource } from '../../fhir/types.js';
import { hapi, postResource } from '../../clients/hapi.js';
import { buildOpenHIMResponse, orch } from '../../lib/orchestration.js';
import { config } from '../../config.js';

export async function observationHandler(req: FhirRequest, res: FhirResponse) {
  const obs = req.body;
  const orchestrations = [];
  const refField = obs.subject?.reference ? 'subject' : obs.patient?.reference ? 'patient' : null;

  const subject = refField ? obs[refField] : undefined;
  if (subject?.reference?.startsWith('Patient?')) {
    const query = subject.reference.substring('Patient?'.length);
    const search = await hapi.get<Resource>(`/Patient?${query}&_count=1`);
    orchestrations.push(
      orch('GET HAPI Patient search', 'GET', `/Patient?${query}`, null, search.status, search.data),
    );
    const entry = search.data.entry?.[0];
    if (!entry?.resource) {
      return res.status(404).json(
        buildOpenHIMResponse({
          status: 404,
          body: oo(`No Patient matched ${subject.reference}`),
          orchestrations,
          urn: config.MEDIATOR_URN,
        }),
      );
    }
    subject.reference = `Patient/${entry.resource.id}`;
  }

  const result = await postResource('Observation', obs);
  orchestrations.push(
    orch('POST HAPI Observation', 'POST', '/Observation', obs, result.status, result.data),
  );
  res.status(result.status).json(
    buildOpenHIMResponse({
      status: result.status,
      body: result.data,
      orchestrations,
      urn: config.MEDIATOR_URN,
    }),
  );
}

function oo(diagnostics: string) {
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: 'not-found', diagnostics }],
  };
}
