import type { Request, Response } from 'express';
import type { Caller } from '../auth/token.js';
import type { Resource } from '../fhir/types.js';
import { registerPatient } from '../patient/register.js';
import { buildOpenHIMResponse, type Orchestration } from '../lib/orchestration.js';
import { HttpError, operationOutcome } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

// POST /fhir/Patient and PUT /fhir/Patient/:id. The client may not choose the
// resource id: a Patient is found by its Health ID, which this mediator assigns.
export async function patientHandler(req: Request, res: Response) {
  const orchestrations: Orchestration[] = [];
  const caller = res.locals.caller as Caller;
  try {
    const { status, patient } = await registerPatient(req.body as Resource, caller, orchestrations);
    const location = `Patient/${patient.id}/_history/${(patient.meta as { versionId?: string })?.versionId ?? '1'}`;
    res.status(status).send(
      buildOpenHIMResponse({
        status,
        body: patient,
        orchestrations,
        headers: { 'Content-Type': 'application/fhir+json', Location: location },
      }),
    );
  } catch (err) {
    const e = err instanceof HttpError ? err : new HttpError(500, 'exception', (err as Error).message);
    if (e.status >= 500) logger.error({ err: e.message, caller: caller.clientId }, 'patient registration failed');
    res.status(e.status).send(
      buildOpenHIMResponse({
        status: e.status,
        body: operationOutcome(e.code, e.message),
        orchestrations,
        headers: { 'Content-Type': 'application/fhir+json' },
      }),
    );
  }
}
