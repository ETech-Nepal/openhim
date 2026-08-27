import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { registerWithOpenHIM } from './openhim.js';
import { logger } from './lib/logger.js';
import { patientHandler } from './handlers/patient.js';
import { encounterHandler } from './handlers/encounter.js';
import { observationHandler } from './handlers/observation.js';
import { organizationHandler } from './handlers/organization.js';
import { practitionerHandler } from './handlers/practitioner.js';
import { documentReferenceHandler } from './handlers/documentReference.js';
import { bundleHandler } from './handlers/bundle.js';
import { searchHandler } from './handlers/search.js';

const app = express();
// FHIR clients send `application/fhir+json` (and some `application/json+fhir`).
// express.json() only parses `application/json` by default, which would leave
// req.body empty for real FHIR traffic — parse all JSON-family content types.
app.use(express.json({
  limit: '50mb',
  type: ['application/json', 'application/fhir+json', 'application/json+fhir', 'application/*+json'],
}));
app.use(pinoHttp({ logger }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Every reply on /fhir is an OpenHIM envelope (buildOpenHIMResponse). OpenHIM only
// unwraps it — returning response.body to the caller — when the reply carries this
// content type; otherwise the client receives the raw envelope and any lookup of a
// FHIR field silently misses. Mirrors patient-portal-mediator/src/index.js.
app.use('/fhir', (_req, res, next) => {
  res.type('application/json+openhim');
  next();
});

// ── Bundle (transaction or batch) — must come BEFORE individual /fhir/<Type> routes
app.post('/fhir', bundleHandler);             // POST /fhir with type=transaction|batch
app.post('/fhir/', bundleHandler);

// ── Writes
app.post('/fhir/Patient',           patientHandler);
app.post('/fhir/Encounter',         encounterHandler);
app.post('/fhir/Observation',       observationHandler);
app.post('/fhir/Organization',      organizationHandler);
app.post('/fhir/Practitioner',      practitionerHandler);
app.post('/fhir/DocumentReference', documentReferenceHandler);

// ── Patient portal now lives in its own mediator (urn:mediator:patient-portal),
//    which owns the /patient-portal channel. See ../patient-portal-mediator.

// ── Reads (Pattern A: all GETs through the mediator)
app.get('/fhir/:resourceType',      searchHandler);
app.get('/fhir/:resourceType/:id',  searchHandler);

app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
  res.status(500).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: err.message }] });
});

async function start() {
  try {
    await registerWithOpenHIM();
  } catch (err) {
    logger.warn({ err: err.message }, 'OpenHIM registration failed — starting in standalone mode');
  }
  app.listen(config.MEDIATOR_PORT, () => {
    logger.info(`Mediator listening on :${config.MEDIATOR_PORT}`);
  });
}
start();
