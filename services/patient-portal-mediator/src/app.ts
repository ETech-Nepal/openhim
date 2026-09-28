import express, { type ErrorRequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { portalResolveHandler, portalSummaryHandler } from './handlers/patientPortal.js';
import { logger } from './lib/logger.js';
import { patientContext } from './middleware/patientContext.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/patient-portal', (_req, res, next) => {
    res.type('application/json+openhim');
    next();
  });
  app.get('/patient-portal/resolve', portalResolveHandler);
  app.get('/patient-portal/summary', patientContext, portalSummaryHandler);
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : 'internal server error';
    logger.error({ err: message }, 'unhandled error');
    res.status(500).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: message }] });
  };
  app.use(onError);
  return app;
}
