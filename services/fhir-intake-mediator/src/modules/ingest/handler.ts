import type { Request, Response } from 'express';
import type { Headers, IngestDependencies } from '../../types.js';
import { operationOutcome } from '../../lib/operationOutcome.js';
import { buildOpenHimResponse } from '../../lib/orchestration.js';
import { toFhirBundle } from './mapper.js';
import { parseCdrsEncounter } from './schema.js';
import { validateFhirInput } from './input.js';

function send(
  res: Response,
  config: IngestDependencies['config'],
  status: number,
  body: unknown,
  orchestrations: unknown[] = [],
) {
  return res.status(status).json(
    buildOpenHimResponse({
      status,
      body,
      orchestrations,
      urn: config.MEDIATOR_URN,
    }),
  );
}

function sendFailure(
  res: Response,
  config: IngestDependencies['config'],
  status: number,
  code: string,
  diagnostics: string,
  expression?: string[],
  orchestrations?: unknown[],
) {
  return send(res, config, status, operationOutcome(code, diagnostics, expression), orchestrations);
}

function transportFailure(
  res: Response,
  config: IngestDependencies['config'],
  orchestrations: unknown[] = [],
) {
  return sendFailure(
    res,
    config,
    502,
    'exception',
    'FHIR orchestrator could not be reached or returned an invalid response',
    undefined,
    orchestrations,
  );
}

function validationExpressions(issues: { path: (string | number)[] }[]) {
  return issues.map(({ path }) => path.join('.')).filter(Boolean);
}

async function convertRaw(
  body: unknown,
  nhfrId: string,
  headers: Headers,
  res: Response,
  { config, fhirClient }: IngestDependencies,
) {
  const parsed = parseCdrsEncounter(body);
  if (!parsed.success) {
    return sendFailure(
      res,
      config,
      400,
      'invalid',
      'Raw encounter input failed validation',
      validationExpressions(parsed.issues),
    );
  }

  let lookup;
  try {
    lookup = await fhirClient.findOrganizationByNhfr(nhfrId, headers);
  } catch {
    return transportFailure(res, config);
  }

  if (lookup.lookupError === 'downstream') {
    return send(res, config, lookup.status, lookup.body, lookup.orchestrations);
  }
  if (lookup.lookupError === 'missing') {
    return sendFailure(
      res,
      config,
      422,
      'not-found',
      `No Organization has NHFR identifier ${nhfrId}`,
      undefined,
      lookup.orchestrations,
    );
  }
  if (lookup.lookupError === 'ambiguous') {
    return sendFailure(
      res,
      config,
      422,
      'multiple-matches',
      `More than one Organization has NHFR identifier ${nhfrId}`,
      undefined,
      lookup.orchestrations,
    );
  }

  const bundle = toFhirBundle(parsed.data, {
    organizationId: lookup.organization.id,
    organizationName: lookup.organization.name,
    nhfrId,
  });
  let forwarded;
  try {
    forwarded = await fhirClient.forward(bundle, '/fhir', headers);
  } catch {
    return transportFailure(res, config, lookup.orchestrations);
  }

  return send(res, config, forwarded.status, forwarded.body, [
    ...lookup.orchestrations,
    ...forwarded.orchestrations,
  ]);
}

async function forwardFhir(
  body: unknown,
  headers: Headers,
  res: Response,
  { config, fhirClient }: IngestDependencies,
) {
  const validated = validateFhirInput(body);
  if (!validated.success) {
    return sendFailure(res, config, 400, 'invalid', validated.diagnostics);
  }

  try {
    const forwarded = await fhirClient.forward(validated.resource, validated.path, headers);
    return send(res, config, forwarded.status, forwarded.body, forwarded.orchestrations);
  } catch {
    return transportFailure(res, config);
  }
}

export function createIngestHandler({ config, fhirClient }: IngestDependencies) {
  return async function ingest(req: Request, res: Response) {
    // OpenHIM sets X-OpenHIM-ClientID from the authenticated client and strips any
    // inbound copy, so this is the trust anchor. It is the facility's NHFR code.
    const nhfrId = String(req.headers['x-openhim-clientid'] || '').trim();
    if (!nhfrId) {
      return sendFailure(
        res,
        config,
        403,
        'forbidden',
        'Request is missing the authenticated OpenHIM client identity',
      );
    }

    // Forward only the trusted identity downstream. Any client-supplied X-NHFR-ID
    // or organization_id in the payload is never used for facility attribution.
    const trustedHeaders = { 'x-openhim-clientid': nhfrId };

    if (req.inputKind === 'fhir') {
      return forwardFhir(req.body, trustedHeaders, res, { config, fhirClient });
    }
    return convertRaw(req.body, nhfrId, trustedHeaders, res, { config, fhirClient });
  };
}
