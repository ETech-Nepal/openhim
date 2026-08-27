import { resolvePatientIdentity } from '../fhir/patientIdentity.js';
import { postBundle } from '../fhir/hapiClient.js';
import { SYS } from '../fhir/identifiers.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { stampProvenance } from '../fhir/provenance.js';
import { config } from '../config.js';

export async function bundleHandler(req, res) {
  const bundle = req.body;
  if (bundle.resourceType !== 'Bundle')
    return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo('Expected resourceType=Bundle'), urn: config.MEDIATOR_URN }));
  if (!['transaction', 'batch'].includes(bundle.type))
    return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo(`Bundle.type=${bundle.type} not supported`), urn: config.MEDIATOR_URN }));

  const orchestrations = [];

  // Preprocess every Patient entry through JeMPI: resolve golden UID + Health ID,
  // stamp identifiers, read-merge, and rewrite the entry to a conditional update
  // keyed on the Health-ID identifier so duplicates converge on one record (with
  // an opaque HAPI id). Other entries that reference the Patient by its fullUrl
  // (urn:uuid:…) resolve to that id within the transaction.
  const patientEntries = (bundle.entry || []).filter((e) => e.resource?.resourceType === 'Patient');
  const clientId = req.headers['x-openhim-clientid'];
  let provenance = null;
  for (const entry of patientEntries) {

    const idres = await resolvePatientIdentity(entry.resource, orchestrations, clientId);
    if (!idres.ok) {
      return res.status(502).json(buildOpenHIMResponse({
        status: 502,
        body: oo(`JeMPI register failed for Patient ${entry.fullUrl ?? '(no fullUrl)'}: ${idres.error}`),
        orchestrations, urn: config.MEDIATOR_URN,
      }));
    }
    entry.request = { method: 'PUT', url: `Patient?identifier=${SYS.NEPAL_HEALTH_ID}|${idres.healthId}` };
    provenance = { interactionUid: idres.interactionUid, facility: idres.facility };
  }

  // Stamp the clinical entries with the same provenance as the Patient they arrived
  // with. These are the resources a future split has to reassign — the Patient itself
  // is not the hard part.
  //
  // Only when the bundle carries exactly ONE Patient. With none there is nothing to
  // attribute the resources to; with several there is no way to tell which Patient a
  // given Encounter belongs to from the entry list alone, and a wrong provenance tag is
  // worse than an absent one — a future split would trust it and move records onto the
  // wrong person. Leave those unstamped rather than guess.
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
  } catch (err) {
    const status = err.response?.status ?? 502;
    return res.status(status).json(buildOpenHIMResponse({
      status, body: err.response?.data ?? oo(err.message),
      orchestrations, urn: config.MEDIATOR_URN,
    }));
  }

  orchestrations.push(orch('POST HAPI Bundle', 'POST', '/', { type: bundle.type, entryCount: bundle.entry?.length ?? 0 }, result.status, result.data));
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', diagnostics }] }; }
