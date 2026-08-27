import { hapi, postBinary, postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

const VALID_MIME = /^(application\/pdf|image\/(png|jpe?g)|application\/fhir\+json|text\/plain)$/;

export async function documentReferenceHandler(req, res) {
  const docRef = req.body;
  const orchestrations = [];

  const att = docRef.content?.[0]?.attachment;
  if (!att) return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo('attachment is required'), urn: config.MEDIATOR_URN }));
  if (!att.contentType || !VALID_MIME.test(att.contentType))
    return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo(`Invalid contentType: ${att.contentType}`), urn: config.MEDIATOR_URN }));
  if (!att.data && !att.url)
    return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo('attachment.data or .url required'), urn: config.MEDIATOR_URN }));

  // Resolve conditional patient reference
  if (docRef.subject?.reference?.startsWith('Patient?')) {
    const query = docRef.subject.reference.substring('Patient?'.length);
    const search = await hapi.get(`/Patient?${query}&_count=1`);
    orchestrations.push(orch('GET HAPI Patient search', 'GET', `/Patient?${query}`, null, search.status, search.data));
    const entry = search.data.entry?.[0];
    if (!entry) return res.status(404).json(buildOpenHIMResponse({ status: 404, body: oo(`No Patient matched ${docRef.subject.reference}`), orchestrations, urn: config.MEDIATOR_URN }));
    docRef.subject.reference = `Patient/${entry.resource.id}`;
  }

  // Upload Binary if inline data
  if (att.data) {
    const buf = Buffer.from(att.data, 'base64');
    const bin = await postBinary(buf, att.contentType);
    orchestrations.push(orch('POST HAPI Binary', 'POST', '/Binary', { size: buf.length, contentType: att.contentType }, bin.status, { id: bin.data.id }));
    delete att.data;
    att.url = `Binary/${bin.data.id}`;
  }

  const result = await postResource('DocumentReference', docRef);
  orchestrations.push(orch('POST HAPI DocumentReference', 'POST', '/DocumentReference', docRef, result.status, result.data));
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', diagnostics }] }; }
