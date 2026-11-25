// @ts-nocheck
import { SYS } from '../fhir/identifiers.js';
import { logger } from '../lib/logger.js';
import {
  attachReports, byDateDesc, formatAddress, formatName, getPhone, refId, resolveOrgs, search,
  shapeEncounter, shapeReport, shapeResult, wrap,
} from './patientPortal.js';
import { hapi } from '../fhir/hapiClient.js';
import { orch } from '../lib/orchestration.js';

// Staff-facing Patient Record System API, behind its own OpenHIM channel (/prs/*,
// role prs-clients). Unlike the patient routes it is not tied to one logged-in
// patient: the caller is the PRS portal's system client and may look up any patient,
// but only by one exact identifier, and HAPI's access rules still apply.

const IDENTIFIER_SYSTEMS = { hid: SYS.NEPAL_HEALTH_ID, nid: SYS.NATIONAL_ID, imis: SYS.INSURANCE_NUMBER };
const VALUE = /^[A-Za-z0-9._-]{3,40}$/;
const PATIENT_ID = /^[A-Za-z0-9.-]{1,64}$/;
const PAGE = 100; // HAPI's max_page_size; a patient with more is flagged `truncated`, never silently cut.

const idOf = (p, system) => (p.identifier || []).find((i) => i.system === system)?.value || null;
const who = (req) => String(req.headers['x-prs-user'] || 'unknown').slice(0, 80);

export function shapePatient(p) {
  return {
    id: p.id,
    name: formatName(p) || null,
    gender: p.gender || null,
    birthDate: p.birthDate || null,
    active: p.active !== false,
    phone: getPhone(p),
    address: formatAddress(p.address?.[0]),
    identifiers: {
      healthId: idOf(p, SYS.NEPAL_HEALTH_ID),
      nationalId: idOf(p, SYS.NATIONAL_ID),
      imis: idOf(p, SYS.INSURANCE_NUMBER),
    },
    // One MRN per facility; the facility code is the NHFR code.
    mrns: (p.identifier || [])
      .filter((i) => i.system?.startsWith(SYS.HOSPITAL_MRN_PREFIX))
      .map((i) => ({ facilityCode: i.system.slice(SYS.HOSPITAL_MRN_PREFIX.length), mrn: i.value })),
  };
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

    // A merged (retired) Patient points at its survivor: show the survivor.
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
    logger.info({ by: who(req), by_id: asked, hits: found.size }, 'prs search');
    return res.status(200).json(wrap(200, { patients: [...found.values()].map(shapePatient) }, orchestrations));
  } catch (err) {
    logger.error({ err: err.message }, 'prs search failed');
    return res.status(502).json(wrap(502, { error: 'search failed' }, orchestrations));
  }
}

const shapeCondition = (c) => ({
  id: c.id,
  name: c.code?.text || c.code?.coding?.[0]?.display || c.code?.coding?.[0]?.code || 'Condition',
  status: c.clinicalStatus?.coding?.[0]?.code || null,
  onset: c.onsetDateTime || c.recordedDate || null,
  date: c.onsetDateTime || c.recordedDate || null,
  encounterId: refId(c.encounter?.reference),
});

// GET /prs/patients/:id → patient + every encounter with its diagnoses, results and reports.
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
    const partial = [], truncated = [], got = {};
    results.forEach((r, i) => {
      const kind = kinds[i];
      if (r.status !== 'fulfilled') { partial.push(kind); got[kind] = []; return; }
      got[kind] = (r.value.entry || []).map((e) => e.resource).filter(Boolean);
      if ((r.value.link || []).some((l) => l.relation === 'next')) truncated.push(kind);
    });

    const hospitals = await resolveOrgs(got.Encounter, orchestrations);
    const orgNames = new Map(hospitals.map((h) => [h.reference, h.name]));
    const obsByRef = new Map(got.Observation.map((o) => [`Observation/${o.id}`, o]));
    const reports = got.DiagnosticReport.map((r) => shapeReport(r, obsByRef, orgNames)).sort(byDateDesc);

    // Observations no report lists (vitals, bedside readings) hang off their encounter directly.
    const inReports = new Set(got.DiagnosticReport.flatMap((r) => (r.result || []).map((x) => x.reference)));
    const loose = new Map();
    for (const o of got.Observation) {
      const enc = refId(o.encounter?.reference);
      if (!enc || inReports.has(`Observation/${o.id}`)) continue;
      loose.set(enc, [...(loose.get(enc) || []), shapeResult(o)]);
    }
    const conditions = got.Condition.map(shapeCondition).sort(byDateDesc);
    const encounters = attachReports(got.Encounter.map((e) => shapeEncounter(e, orgNames)).sort(byDateDesc), reports)
      .map((e) => ({
        ...e,
        diagnoses: conditions.filter((c) => c.encounterId === e.id),
        observations: loose.get(e.id) || [],
      }));

    const shaped = shapePatient(patient);
    logger.info({ by: who(req), patient: id }, 'prs patient opened');
    return res.status(200).json(wrap(200, {
      patient: shaped,
      facilities: hospitals.filter((h) => h.name).map((h) => ({ name: h.name })),
      encounters,
      conditions,
      reports,
      documents: got.DocumentReference.map((d) => ({
        id: d.id, title: d.description || d.type?.text || 'Document', date: d.date || null,
        contentType: d.content?.[0]?.attachment?.contentType || null,
      })).sort(byDateDesc),
      partial,     // sections HAPI failed to return: the UI must say so
      truncated,   // sections cut at one page
    }, orchestrations));
  } catch (err) {
    logger.error({ err: err.message, patient: id }, 'prs patient failed');
    return res.status(502).json(wrap(502, { error: 'could not load the record' }, orchestrations));
  }
}
