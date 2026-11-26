// @ts-nocheck
import { SYS } from '../fhir/identifiers.js';
import { hapi } from '../fhir/hapiClient.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { fhirQueries, orch } from '../lib/orchestration.js';
import { search, wrap } from './patientPortal.js';

// Staff Patient Record System API, behind its own OpenHIM channel (/prs/*, role
// prs-clients). It returns FHIR R4 as read from HAPI; it does NOT reshape anything.
// Turning the Bundle into screens is the client's job (prs/ui/src/fhir.js).
//
//   GET /prs/search?hid=|nid=|imis=   -> Bundle (searchset) of Patient
//   GET /prs/patients/:id             -> Bundle (collection): the Patient and everything about
//                                        them HAPI holds (Encounter, Condition, DiagnosticReport,
//                                        Observation, DocumentReference) plus the Organizations
//                                        those point at, and an OperationOutcome when a section
//                                        failed or was cut (see below).
//
// Unlike the patient routes it is not tied to one logged-in patient: the caller is the PRS
// portal's system client and may look up any patient, but only by one exact identifier, and
// HAPI's access rules still apply.

const IDENTIFIER_SYSTEMS = { hid: SYS.NEPAL_HEALTH_ID, nid: SYS.NATIONAL_ID, imis: SYS.INSURANCE_NUMBER };
const VALUE = /^[A-Za-z0-9._-]{3,40}$/;
const PATIENT_ID = /^[A-Za-z0-9.-]{1,64}$/;
const PAGE = 100; // HAPI's max_page_size; a longer section is flagged `too-long`, never silently cut.
const MAX_ORGS = 20;

// The FHIR queries travel in a header so the Bundle stays pure FHIR.
const trace = (orchestrations) =>
  ({ 'X-FHIR-Queries': encodeURIComponent(JSON.stringify(fhirQueries(orchestrations, config.HAPI_FHIR_BASE_URL))) });
const who = (req) => String(req.headers['x-prs-user'] || 'unknown').slice(0, 80);
const refId = (ref) => (ref ? String(ref).split('/').pop() : null);
const entry = (r) => ({ fullUrl: `${r.resourceType}/${r.id}`, resource: r });
const bundle = (type, resources, extra = {}) => ({ resourceType: 'Bundle', type, ...extra, entry: resources.map(entry) });

// An OperationOutcome the client MUST show: it says the record is not the whole story.
//   code "incomplete": HAPI failed to return that resource type (the record has a hole)
//   code "too-long":   more than one page exists; only the latest 100 are included
function outcome(partial, truncated) {
  const issue = [
    ...partial.map((t) => ({ severity: 'warning', code: 'incomplete', expression: [t], diagnostics: `${t} could not be loaded; this record is incomplete` })),
    ...truncated.map((t) => ({ severity: 'information', code: 'too-long', expression: [t], diagnostics: `${t}: only the latest ${PAGE} are included` })),
  ];
  return issue.length ? { resourceType: 'OperationOutcome', issue } : null;
}

// GET /prs/search?hid=|nid=|imis=   (one or more; results are merged)
export async function prsSearchHandler(req, res) {
  const orchestrations = [];
  const asked = Object.keys(IDENTIFIER_SYSTEMS).filter((k) => req.query[k] != null && req.query[k] !== '');
  if (asked.length === 0) {
    return res.status(400).json(wrap(400, { error: 'one of hid, nid, imis is required' }, orchestrations));
  }
  for (const k of asked) {
    if (!VALUE.test(String(req.query[k]))) {
      return res.status(400).json(wrap(400, { error: `${k} must be 3-40 letters, digits, . _ -` }, orchestrations));
    }
  }
  try {
    const found = new Map();
    const bundles = await Promise.all(asked.map((k) =>
      search('Patient', { identifier: `${IDENTIFIER_SYSTEMS[k]}|${req.query[k]}`, _count: 20 }, orchestrations, `Patient by ${k}`)));
    for (const b of bundles) for (const e of b.entry || []) if (e.resource?.id) found.set(e.resource.id, e.resource);

    // A merged (retired) Patient points at its survivor: return the survivor.
    for (const p of [...found.values()]) {
      if (p.active !== false) continue;
      found.delete(p.id);
      const survivor = (p.link || []).find((l) => l.type === 'replaced-by')?.other?.reference;
      const sid = survivor && refId(survivor);
      if (!sid || found.has(sid)) continue;
      try {
        const { data } = await hapi.get(`/Patient/${encodeURIComponent(sid)}`);
        found.set(data.id, data);
      } catch { /* survivor unreadable: the retired record is dropped, not shown as live */ }
    }
    logger.info({ by: who(req), via: asked, hits: found.size }, 'prs search');
    const patients = [...found.values()];
    return res.status(200).json(wrap(200, bundle('searchset', patients, { total: patients.length }), orchestrations, trace(orchestrations)));
  } catch (err) {
    logger.error({ err: err.message }, 'prs search failed');
    return res.status(502).json(wrap(502, { error: 'search failed' }, orchestrations));
  }
}

// GET /prs/patients/:id
export async function prsPatientHandler(req, res) {
  const { id } = req.params;
  const orchestrations = [];
  if (!PATIENT_ID.test(id)) return res.status(400).json(wrap(400, { error: 'invalid patient id' }, orchestrations));
  try {
    let patient;
    try {
      const r = await hapi.get(`/Patient/${encodeURIComponent(id)}`);
      patient = r.data;
      orchestrations.push(orch('HAPI Patient', 'GET', `/Patient/${id}`, null, r.status, { id }));
    } catch (err) {
      if (err.response?.status === 404 || err.response?.status === 410) {
        return res.status(404).json(wrap(404, { error: 'patient not found' }, orchestrations));
      }
      throw err;
    }

    const subject = `Patient/${id}`;
    const kinds = ['Encounter', 'Condition', 'DiagnosticReport', 'Observation', 'DocumentReference'];
    const sort = { Encounter: '-date', DiagnosticReport: '-date', Observation: '-date' };
    const results = await Promise.allSettled(kinds.map((k) =>
      search(k, { subject, _count: PAGE, ...(sort[k] && { _sort: sort[k] }) }, orchestrations, `${k}/${id}`)));
    const partial = [], truncated = [], resources = [];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') { partial.push(kinds[i]); return; }
      resources.push(...(r.value.entry || []).map((e) => e.resource).filter(Boolean));
      if ((r.value.link || []).some((l) => l.relation === 'next')) truncated.push(kinds[i]);
    });

    // The Organizations the clinical resources point at (facility names), so the client needs no second call.
    const orgIds = new Set();
    for (const r of resources) {
      for (const ref of [r.serviceProvider, ...(r.performer || [])]) {
        if (ref?.reference?.startsWith('Organization/')) orgIds.add(refId(ref.reference));
      }
    }
    const orgs = await Promise.allSettled([...orgIds].slice(0, MAX_ORGS).map(async (oid) => {
      const { data } = await hapi.get(`/Organization/${encodeURIComponent(oid)}`);
      orchestrations.push(orch('HAPI Organization', 'GET', `/Organization/${oid}`, null, 200, { name: data.name }));
      return data;
    }));

    const outcomeEntry = outcome(partial, truncated);
    logger.info({ by: who(req), patient: id }, 'prs patient opened');
    return res.status(200).json(wrap(200, bundle('collection', [
      patient,
      ...resources,
      ...orgs.filter((o) => o.status === 'fulfilled').map((o) => o.value),
      ...(outcomeEntry ? [outcomeEntry] : []),
    ].map((r) => (r.id ? r : { ...r, id: 'outcome' }))), orchestrations, trace(orchestrations)));
  } catch (err) {
    logger.error({ err: err.message, patient: id }, 'prs patient failed');
    return res.status(502).json(wrap(502, { error: 'could not load the record' }, orchestrations));
  }
}
