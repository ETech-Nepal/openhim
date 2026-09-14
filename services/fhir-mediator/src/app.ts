import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { FhirRequest, FhirResponse, Resource } from './fhir/types.js';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import { patientHandler } from './modules/patient/handler.js';
import { encounterHandler } from './modules/resources/encounter.js';
import { observationHandler } from './modules/resources/observation.js';
import { organizationHandler } from './modules/resources/organization.js';
import { practitionerHandler } from './modules/resources/practitioner.js';
import { documentReferenceHandler } from './modules/resources/documentReference.js';
import { bundleHandler } from './modules/bundle/handler.js';
import { searchHandler } from './modules/search/handler.js';

function handle(
  handler: (req: FhirRequest, res: FhirResponse) => Promise<unknown>,
): RequestHandler<Record<string, string>, unknown, Resource, Record<string, string>> {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export function createApp() {
  const app = express();
  app.use(
    express.json({
      limit: '50mb',
      type: [
        'application/json',
        'application/fhir+json',
        'application/json+fhir',
        'application/*+json',
      ],
    }),
  );
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/fhir', (_req, res, next) => {
    res.type('application/json+openhim');
    next();
  });

  app.post('/fhir', handle(bundleHandler)); // POST /fhir with type=transaction|batch
  app.post('/fhir/', handle(bundleHandler));

  app.post('/fhir/Patient', handle(patientHandler));
  app.post('/fhir/Encounter', handle(encounterHandler));
  app.post('/fhir/Observation', handle(observationHandler));
  app.post('/fhir/Organization', handle(organizationHandler));
  app.post('/fhir/Practitioner', handle(practitionerHandler));
  app.post('/fhir/DocumentReference', handle(documentReferenceHandler));

  app.get('/fhir/:resourceType', handle(searchHandler));
  app.get('/fhir/:resourceType/:id', handle(searchHandler));

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(500).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'exception', diagnostics: err.message }],
    });
  };

  app.use(errorHandler);
  return app;
}
