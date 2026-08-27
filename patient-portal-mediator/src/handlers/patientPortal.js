import { hapi } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { SYS } from '../fhir/identifiers.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// ─── GET /patient-portal/resolve?healthId=|phone= ────────────────────────────
// System-authed identity lookup used by the BFF to send an OTP. Returns the
// minimum the BFF needs: golden UID (to key the challenge), the phone to text,
// and a display name. No clinical data.
export async function portalResolveHandler(req, res) {
  const { healthId, phone } = req.query;
  const orchestrations = [];
  if (!healthId && !phone) {
    return res.status(400).json(wrap(400, { found: false, error: 'healthId or phone required' }, orchestrations));
  }

  const params = healthId
    ? { identifier: `${SYS.NEPAL_HEALTH_ID}|${healthId}`, _count: 1 }
    : { telecom: String(phone), _count: 5 };
  try {
    const bundle = await search('Patient', params, orchestrations, 'resolve Patient');
    const patient = (bundle.entry || []).map(e => e.resource).find(p => getGoldenUid(p));
    if (!patient) return res.status(200).json(wrap(200, { found: false }, orchestrations));
    return res.status(200).json(wrap(200, {
      found: true,
      goldenUid: getGoldenUid(patient),
      phone: getPhone(patient),
      displayName: formatName(patient),
    }, orchestrations));
  } catch (err) {
    logger.error({ err: err.message }, 'portal resolve failed');
    return res.status(502).json(wrap(502, { found: false, error: 'lookup failed' }, orchestrations));
  }
}

// ─── GET /patient-portal/summary  (patientContext middleware runs first) ─────
// One person = one golden UID = potentially many Patient records. Fan out across
// all linked records and merge encounters, reports and documents. Every query is
// bound to req.patientContext.goldenUid — nothing un-scoped can leak.
export async function portalSummaryHandler(req, res) {
  const { goldenUid } = req.patientContext;
  const orchestrations = [];
  try {
    const linked = await search('Patient',
      { identifier: `${SYS.JEMPI_GOLDEN_UID}|${goldenUid}`, _count: 50 },
      orchestrations, 'linked Patients');
    const patients = (linked.entry || []).map(e => e.resource).filter(Boolean);
    if (patients.length === 0) {
      return res.status(200).json(wrap(200,
        { profile: null, hospitals: [], encounters: [], reports: [], documents: [] }, orchestrations));
    }
    const patientIds = patients.map(p => p.id).filter(Boolean);

    // Observations are fetched alongside the reports so a report can carry its
    // actual measured values — a report the patient cannot read the results of is
    // not much use. A lab-heavy patient has a few hundred, hence the high _count.
    const results = await Promise.allSettled(
      patientIds.flatMap(pid => [
        search('Encounter', { subject: `Patient/${pid}`, _count: 100 }, orchestrations, `Encounter/${pid}`),
        search('DiagnosticReport', { subject: `Patient/${pid}`, _count: 100 }, orchestrations, `DiagnosticReport/${pid}`),
        search('DocumentReference', { subject: `Patient/${pid}`, _count: 100 }, orchestrations, `DocumentReference/${pid}`),
        search('Observation', { subject: `Patient/${pid}`, _count: 1000 }, orchestrations, `Observation/${pid}`),
      ]),
    );
    const encounters = [], reports = [], docs = [], observations = [];
    const buckets = [encounters, reports, docs, observations];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      buckets[i % 4].push(...(r.value.entry || []).map(e => e.resource).filter(Boolean));
    });

    const hospitals = await resolveOrgs(encounters, orchestrations);
    // reference -> display name, so no caller has to touch a raw resource id.
    const orgNames = new Map(hospitals.map(h => [h.reference, h.name]));
    const obsByRef = new Map(observations.map(o => [`Observation/${o.id}`, o]));

    const shapedEncounters = encounters.map(e => shapeEncounter(e, orgNames)).sort(byDateDesc);
    const shapedReports = reports.map(r => shapeReport(r, obsByRef, orgNames)).sort(byDateDesc);

    const summary = {
      profile: mergeProfile(patients),
      // Names only — the resource reference stays server-side. Nothing the browser
      // receives should contain an id a patient could be shown by mistake.
      hospitals: hospitals.filter(h => h.name).map(h => ({ name: h.name })),
      encounters: attachReports(shapedEncounters, shapedReports),
      reports: shapedReports,
      documents: docs.map(shapeDocument).sort(byDateDesc),
    };
    return res.status(200).json(wrap(200, summary, orchestrations));
  } catch (err) {
    logger.error({ err: err.message }, 'portal summary failed');
    return res.status(502).json(wrap(502, { error: 'could not load records' }, orchestrations));
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function search(resourceType, params, orchestrations, label) {
  const { data, status } = await hapi.get(`/${resourceType}`, { params });
  orchestrations.push(orch(`HAPI ${label}`, 'GET', `/${resourceType}`, params, status, { total: data.total }));
  return data;
}

async function resolveOrgs(encounters, orchestrations) {
  const byRef = new Map();
  for (const e of encounters) {
    const ref = e.serviceProvider?.reference;
    if (ref && !byRef.has(ref)) byRef.set(ref, e.serviceProvider.display || null);
  }
  // An unresolvable facility yields name: null, never the raw reference. Falling
  // back to the reference rendered a bare UUID as if it were the hospital's name.
  // The UI shows "Unknown facility" for null, which is at least honest.
  const out = await Promise.allSettled([...byRef.entries()].map(async ([ref, display]) => {
    if (display) return { reference: ref, name: display };
    const [type, id] = ref.split('/');
    if (type !== 'Organization' || !id) return { reference: ref, name: null };
    try {
      const { data, status } = await hapi.get(`/Organization/${id}`);
      orchestrations.push(orch('HAPI Organization', 'GET', `/Organization/${id}`, null, status, { name: data.name }));
      return { reference: ref, name: data.name || null };
    } catch { return { reference: ref, name: null }; }
  }));
  return out.filter(r => r.status === 'fulfilled').map(r => r.value);
}

function wrap(status, body, orchestrations) {
  return buildOpenHIMResponse({ status, body, orchestrations, urn: config.MEDIATOR_URN });
}

function getGoldenUid(p) { return (p.identifier || []).find(i => i.system === SYS.JEMPI_GOLDEN_UID)?.value || null; }
function getPhone(p) { return (p.telecom || []).find(t => t.system === 'phone')?.value || null; }

function mergeProfile(patients) {
  const primary = patients.slice().sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0))[0];
  return {
    name: formatName(primary),
    gender: primary.gender || null,
    birthDate: primary.birthDate || null,
    phone: firstTelecom(patients, 'phone'),
    email: firstTelecom(patients, 'email'),
    address: formatAddress(primary.address?.[0]),
    healthId: firstIdentifier(patients, SYS.NEPAL_HEALTH_ID),
    linkedRecords: patients.length,
  };
}
// `id` is included as a stable key for the UI to link a report to its visit. It is
// an internal resource id and must never be rendered — nothing here exposes one as
// a user-facing label. `visitNumber` is the hospital's own encounter number, which
// is the meaningful thing to show a patient.
function shapeEncounter(e, orgNames = new Map()) {
  return {
    id: e.id, status: e.status || null,
    visitNumber: identifierValue(e, SYS.ENCOUNTER_NUMBER),
    class: e.class?.display || e.class?.code || null,
    type: e.type?.[0]?.text || e.type?.[0]?.coding?.[0]?.display || null,
    reason: e.reasonCode?.[0]?.text || e.reasonCode?.[0]?.coding?.[0]?.display || null,
    start: e.period?.start || null, end: e.period?.end || null,
    hospital: hospitalName(e.serviceProvider, orgNames),
    date: e.period?.start || null,
  };
}

function shapeReport(r, obsByRef = new Map(), orgNames = new Map()) {
  return {
    id: r.id, status: r.status || null,
    code: r.code?.text || r.code?.coding?.[0]?.display || 'Report',
    category: r.category?.[0]?.text || r.category?.[0]?.coding?.[0]?.display || null,
    conclusion: r.conclusion || null, issued: r.issued || null,
    date: r.effectiveDateTime || r.issued || null,
    encounterId: refId(r.encounter?.reference),
    hospital: hospitalName(r.performer?.[0], orgNames),
    // The measured values themselves. A DiagnosticReport is only a header; the
    // numbers live in the Observations it references.
    results: (r.result || [])
      .map(ref => obsByRef.get(ref.reference))
      .filter(Boolean)
      .map(shapeResult),
  };
}

// One analyte: what was measured, what came out, and whether that is normal.
function shapeResult(o) {
  const q = o.valueQuantity;
  return {
    name: o.code?.text || o.code?.coding?.[0]?.display || 'Result',
    value: q?.value ?? o.valueString ?? o.valueCodeableConcept?.text ?? null,
    unit: q?.unit || null,
    interpretation: o.interpretation?.[0]?.coding?.[0]?.display
      || o.interpretation?.[0]?.coding?.[0]?.code || null,
    referenceRange: formatRange(o.referenceRange?.[0]),
    performer: o.performer?.[0]?.display || null,
    date: o.effectiveDateTime || null,
  };
}

function formatRange(rr) {
  if (!rr) return null;
  // The EMR uses filler like "." or "-" where it has no range. Rendering that as a
  // reference range is worse than showing nothing, so require an actual character.
  if (rr.text && /[0-9a-z]/i.test(rr.text)) return rr.text;
  const lo = rr.low?.value, hi = rr.high?.value;
  const unit = rr.low?.unit || rr.high?.unit || '';
  if (lo != null && hi != null) return `${lo} – ${hi} ${unit}`.trim();
  if (lo != null) return `> ${lo} ${unit}`.trim();
  if (hi != null) return `< ${hi} ${unit}`.trim();
  return null;
}

// Group each visit's reports onto it, so a visit can be opened and read on its own
// without the UI having to re-derive the relationship.
function attachReports(encounters, reports) {
  const byEncounter = new Map();
  for (const r of reports) {
    if (!r.encounterId) continue;
    if (!byEncounter.has(r.encounterId)) byEncounter.set(r.encounterId, []);
    byEncounter.get(r.encounterId).push(r);
  }
  return encounters.map(e => ({ ...e, reports: byEncounter.get(e.id) || [] }));
}

// A facility is always named, never identified by a resource id: falling back to a
// raw reference put a UUID in front of the patient.
function hospitalName(ref, orgNames) {
  if (!ref) return null;
  return ref.display || orgNames.get(ref.reference) || null;
}

function identifierValue(res, system) {
  return (res.identifier || []).find(i => i.system === system)?.value || null;
}
function shapeDocument(d) {
  const c = d.content?.[0];
  return {
    id: d.id, title: d.description || d.type?.text || d.type?.coding?.[0]?.display || 'Document',
    contentType: c?.attachment?.contentType || null, url: c?.attachment?.url || null,
    date: d.date || null,
  };
}
function byDateDesc(a, b) { return String(b.date || '').localeCompare(String(a.date || '')); }
function refId(ref) { return ref ? ref.split('/').pop() : null; }
function firstIdentifier(ps, sys) { for (const p of ps) { const v = (p.identifier || []).find(i => i.system === sys)?.value; if (v) return v; } return null; }
function firstTelecom(ps, sys) { for (const p of ps) { const v = (p.telecom || []).find(t => t.system === sys)?.value; if (v) return v; } return null; }
function formatName(p) {
  const n = (p.name || []).find(x => x.use === 'official') || p.name?.[0];
  if (!n) return '';
  return n.text || [(n.given || []).join(' '), n.family].filter(Boolean).join(' ').trim();
}
function formatAddress(a) {
  if (!a) return null;
  return a.text || [a.line?.join(', '), a.city, a.district, a.state, a.country].filter(Boolean).join(', ');
}
