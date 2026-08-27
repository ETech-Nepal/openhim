import express from 'express';
import pinoHttp from 'pino-http';
import { classifyContentType } from './validators/contentType.js';
import { createIngestHandler } from './handlers/ingest.js';
import { operationOutcome } from './lib/operationOutcome.js';
import { buildOpenHimResponse } from './lib/orchestration.js';

function sendEnvelope(res, urn, status, body) {
  res.status(status).json(buildOpenHimResponse({ status, body, orchestrations: [], urn }));
}

function sendUnsupportedMediaType(res, urn) {
  sendEnvelope(res, urn, 415, operationOutcome(
    'not-supported',
    'Content-Type must be application/json or application/fhir+json',
  ));
}

function jsonErrorMiddleware(urn, logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return sendEnvelope(res, urn, 400, operationOutcome('invalid', 'Request body is not valid JSON'));
    }
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    return sendEnvelope(res, urn, 500, operationOutcome('exception', 'Unhandled mediator error'));
  };
}

export function createApp({ config, fhirClient, logger }) {
  const app = express();
  app.use(pinoHttp({ logger }));

  // Set the OpenHIM envelope content type before express.json runs, so malformed-JSON
  // errors are also unwrapped by OpenHIM.
  app.use('/ingest', (_req, res, next) => {
    res.type('application/json+openhim');
    next();
  });

  app.use((req, _res, next) => {
    req.inputKind = classifyContentType(req.headers['content-type']);
    next();
  });

  app.use(express.json({
    limit: '50mb',
    type: (req) => req.inputKind !== null,
  }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.post('/ingest', (req, res, next) => {
    if (!req.inputKind) return sendUnsupportedMediaType(res, config.MEDIATOR_URN);
    return Promise.resolve(createIngestHandler({ config, fhirClient })(req, res)).catch(next);
  });

  app.use(jsonErrorMiddleware(config.MEDIATOR_URN, logger));
  return app;
}
