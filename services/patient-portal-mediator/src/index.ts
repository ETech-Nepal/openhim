// @ts-nocheck
import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { registerWithOpenHIM } from './openhim.js';
import { logger } from './lib/logger.js';
import { portalResolveHandler, portalSummaryHandler } from './handlers/patientPortal.js';
import { patientContext } from './middleware/patientContext.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Mediator replies are OpenHIM envelopes. OpenHIM only unwraps them (returning
// response.body to the caller) when the reply carries this content type —
// otherwise the client receives the raw envelope.
app.use('/patient-portal', (_req, res, next) => {
  res.type('application/json+openhim');
  next();
});

// OpenHIM confirms the portal system-client before routing here. The
// patientContext middleware then verifies the forwarded patient token per request.
app.get('/patient-portal/resolve',  portalResolveHandler);                 // system-authed identity lookup for OTP
app.get('/patient-portal/summary',  patientContext, portalSummaryHandler); // patient-scoped aggregate

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
    logger.info(`Patient-portal mediator listening on :${config.MEDIATOR_PORT}`);
  });
}
start();
// @ts-nocheck
