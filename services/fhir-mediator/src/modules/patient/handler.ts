import type { Orchestration } from '../../lib/orchestration.js';
import type { FhirRequest, FhirResponse } from '../../fhir/types.js';
import { upstreamError } from '../../lib/errors.js';
import { resolvePatientIdentity } from './identity.js';
import { conditionalUpdate } from '../../clients/hapi.js';
import { SYS } from '../../fhir/identifiers.js';
import { buildOpenHIMResponse, orch } from '../../lib/orchestration.js';
import { logger } from '../../lib/logger.js';
import { config } from '../../config.js';

export async function patientHandler(req: FhirRequest, res: FhirResponse) {
  const patient = req.body;
  const orchestrations: Orchestration[] = [];

  const clientId = req.headers['x-openhim-clientid'];
  const idres = await resolvePatientIdentity(patient, orchestrations, clientId);
  if (!idres.ok) {
    return res.status(502).json(
      buildOpenHIMResponse({
        status: 502,
        body: oo(`JeMPI register failed: ${idres.error}`),
        orchestrations,
        urn: config.MEDIATOR_URN,
      }),
    );
  }
  const { healthId } = idres;
  const upsertPath = `/Patient?identifier=${SYS.NEPAL_HEALTH_ID}|${healthId}`;

  // Conditional update keyed on the Health-ID identifier — idempotent, race-safe,
  // and HAPI keeps Patient.id opaque (see patientIdentity.js / hapiClient.js).
  let hapi;
  try {
    hapi = await conditionalUpdate('Patient', SYS.NEPAL_HEALTH_ID, healthId, patient);
  } catch (caught) {
    const err = upstreamError(caught);
    const hapiStatus = err.response?.status ?? 502;
    const hapiBody = err.response?.data ?? { message: err.message };
    orchestrations.push(orch('PUT HAPI Patient', 'PUT', upsertPath, patient, hapiStatus, hapiBody));
    logger.error({ status: hapiStatus, body: hapiBody }, 'HAPI Patient write failed');
    return res.status(502).json(
      buildOpenHIMResponse({
        status: 502,
        body: oo(`HAPI write failed (${hapiStatus}): ${JSON.stringify(hapiBody).slice(0, 500)}`),
        orchestrations,
        urn: config.MEDIATOR_URN,
      }),
    );
  }
  orchestrations.push(orch('PUT HAPI Patient', 'PUT', upsertPath, patient, hapi.status, hapi.data));

  res.status(hapi.status).json(
    buildOpenHIMResponse({
      status: hapi.status,
      body: hapi.data,
      orchestrations,
      urn: config.MEDIATOR_URN,
    }),
  );
}

function oo(diagnostics: string) {
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: 'exception', diagnostics }],
  };
}
