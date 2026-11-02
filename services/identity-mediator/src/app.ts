import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { buildOpenHIMResponse } from './lib/orchestration.js';
import { HttpError, operationOutcome } from './lib/httpError.js';
import { createTokenVerifier, type Caller } from './auth/token.js';
import { patientHandler } from './handlers/patient.js';
import {
  auditHandler,
  detailHandler,
  dismissHandler,
  listHandler,
  mergeHandler,
  scanHandler,
} from './handlers/review.js';

type Verify = (header: string | undefined) => Promise<Caller>;

// Every route except /health needs the client's own token, forwarded by OpenHIM.
function authenticate(verify: Verify, allow?: (caller: Caller) => boolean): RequestHandler {
  return (req, res, next) => {
    verify(req.get('Authorization'))
      .then((caller) => {
        if (allow && !allow(caller)) {
          throw new HttpError(403, 'forbidden', `Client ${caller.clientId} may not use ${req.path}`);
        }
        res.locals.caller = caller;
        next();
      })
      .catch((err) => {
        const e = err instanceof HttpError ? err : new HttpError(503, 'transient', `Token check failed: ${err.message}`);
        res
          .status(e.status)
          .type('application/json+openhim')
          .send(buildOpenHIMResponse({ status: e.status, body: operationOutcome(e.code, e.message) }));
      });
  };
}

export function createApp(
  verify: Verify = createTokenVerifier({ issuer: config.KEYCLOAK_ISSUER, jwksUri: config.KEYCLOAK_JWKS_URI }),
) {
  const app = express();
  app.use(
    express.json({
      limit: '5mb',
      type: ['application/json', 'application/fhir+json', 'application/*+json'],
    }),
  );
  app.use(pinoHttp({ logger }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use(['/fhir', '/admin'], (_req, res, next) => {
    res.type('application/json+openhim');
    next();
  });

  const patients = authenticate(verify);
  app.post('/fhir/Patient', patients, patientHandler);
  app.put('/fhir/Patient/:id', patients, patientHandler);

  const admins = authenticate(verify, (caller) => config.ADMIN_CLIENT_IDS.includes(caller.clientId));
  app.get('/admin/review/tasks', admins, listHandler);
  app.get('/admin/review/tasks/:id', admins, detailHandler);
  app.post('/admin/review/tasks/:id/merge', admins, mergeHandler);
  app.post('/admin/review/tasks/:id/dismiss', admins, dismissHandler);
  app.post('/admin/review/scan', admins, scanHandler);
  app.get('/admin/review/golden/:gid/audit', admins, auditHandler);

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    const message = err instanceof Error ? err.message : 'internal server error';
    logger.error({ err: message }, 'unhandled error');
    const body = { error: message };
    if (req.path.startsWith('/admin') || req.path.startsWith('/fhir')) {
      res.status(500).type('application/json+openhim').send(buildOpenHIMResponse({ status: 500, body }));
      return;
    }
    res.status(500).json(body);
  };
  app.use(onError);
  return app;
}
