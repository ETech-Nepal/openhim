import type { Orchestration } from '../../lib/orchestration.js';
import type { FhirRequest, FhirResponse, Resource } from '../../fhir/types.js';
import { upstreamError } from '../../lib/errors.js';
import { resolvePatientIdentity } from '../patient/identity.js';
import { postBundle } from '../../clients/hapi.js';
import { SYS } from '../../fhir/identifiers.js';
import { buildOpenHIMResponse, orch } from '../../lib/orchestration.js';
import { stampProvenance } from '../../fhir/provenance.js';
import { config } from '../../config.js';

export async function bundleHandler(req: FhirRequest, res: FhirResponse) {
  const bundle = req.body;
  if (bundle.resourceType !== 'Bundle')
    return res.status(400).json(
      buildOpenHIMResponse({
        status: 400,
        body: oo('Expected resourceType=Bundle'),
        urn: config.MEDIATOR_URN,
      }),
    );
  if (!['transaction', 'batch'].includes(bundle.type ?? ''))
    return res.status(400).json(
      buildOpenHIMResponse({
        status: 400,
        body: oo(`Bundle.type=${bundle.type} not supported`),
        urn: config.MEDIATOR_URN,
      }),
    );

  const orchestrations: Orchestration[] = [];

  const patientEntries = (bundle.entry || []).filter(
    (e): e is NonNullable<Resource['entry']>[number] & { resource: Resource } =>
      e.resource?.resourceType === 'Patient',
  );
  const clientId = req.headers['x-openhim-clientid'];
  let provenance = null;
  for (const entry of patientEntries) {
    const idres = await resolvePatientIdentity(entry.resource, orchestrations, clientId);
    if (!idres.ok) {
      return res.status(502).json(
        buildOpenHIMResponse({
          status: 502,
          body: oo(
            `JeMPI register failed for Patient ${entry.fullUrl ?? '(no fullUrl)'}: ${idres.error}`,
          ),
          orchestrations,
          urn: config.MEDIATOR_URN,
        }),
      );
    }
    entry.request = {
      method: 'PUT',
      url: `Patient?identifier=${SYS.NEPAL_HEALTH_ID}|${idres.healthId}`,
    };
    provenance = { interactionUid: idres.interactionUid, facility: idres.facility };
  }

  // A multi-Patient bundle cannot safely attribute all clinical entries to one interaction.
  if (provenance && patientEntries.length === 1) {
    for (const entry of bundle.entry || []) {
      if (entry.resource && entry.resource.resourceType !== 'Patient') {
        stampProvenance(entry.resource, provenance);
      }
    }
  }

  // Post the whole (preprocessed) bundle to HAPI as a single transaction
  let result;
  try {
    result = await postBundle(bundle);
  } catch (caught) {
    const err = upstreamError(caught);
    const status = err.response?.status ?? 502;
    return res.status(status).json(
      buildOpenHIMResponse({
        status,
        body: err.response?.data ?? oo(err.message),
        orchestrations,
        urn: config.MEDIATOR_URN,
      }),
    );
  }

  orchestrations.push(
    orch(
      'POST HAPI Bundle',
      'POST',
      '/',
      { type: bundle.type, entryCount: bundle.entry?.length ?? 0 },
      result.status,
      result.data,
    ),
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
    issue: [{ severity: 'error', code: 'invalid', diagnostics }],
  };
}
