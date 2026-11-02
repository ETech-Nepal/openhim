import axios from 'axios';
import type { Identifier, Resource } from '../fhir/types.js';
import type { Caller } from '../auth/token.js';
import { hasScope } from '../auth/token.js';
import { hapi } from '../fhir/hapiClient.js';
import {
  SYS,
  findIdentifier,
  hasIdentifier,
  healthIdIdentifier,
  isMrnSystem,
  mrnSystem,
} from '../fhir/identifiers.js';
import { stampProvenance } from '../fhir/provenance.js';
import { registerInteraction } from '../providers/jempiProvider.js';
import { bindHealthId, healthIdRecord, releaseReservation, reserveHealthId } from '../db/healthIds.js';
import { isValidHealthId } from './healthId.js';
import { HttpError } from '../lib/httpError.js';
import { orch, type Orchestration } from '../lib/orchestration.js';

// Every Patient write in the platform comes through here. HAPI refuses Patient
// writes from any other client, so JeMPI, the Health ID register and HAPI cannot
// drift apart.

type Reference = { reference: string; display?: string };

/**
 * Register or update one Patient for the calling facility.
 * Returns the stored Patient, its Health ID, and whether it was created.
 */
export async function registerPatient(
  input: Resource,
  caller: Caller,
  orchestrations: Orchestration[],
): Promise<{ status: number; patient: Resource; healthId: string; created: boolean }> {
  if (input?.resourceType !== 'Patient') throw new HttpError(400, 'invalid', 'Expected a Patient resource');
  if (!hasScope(caller.scopes, 'Patient', 'c') && !hasScope(caller.scopes, 'Patient', 'u')) {
    throw new HttpError(403, 'forbidden', `Client ${caller.clientId} may not register patients`);
  }
  const patient: Resource = structuredClone(input);
  const facility = caller.clientId;
  const orgRef = await facilityOrganization(facility, orchestrations);

  scopeMrns(patient, facility, orgRef);
  await checkHealthIdHint(patient);

  // Identity is owned here: whatever the client sent for these is replaced.
  patient.identifier = (patient.identifier ?? []).filter(
    (i) => i.system !== SYS.NEPAL_HEALTH_ID && i.system !== SYS.JEMPI_GOLDEN_UID,
  );
  const hint = findIdentifier(input, SYS.NEPAL_HEALTH_ID)?.value;

  const reserved = await reserveHealthId();
  let healthId: string;
  let goldenUid: string;
  let interactionUid: string | null;
  try {
    const link = await registerInteraction(patient, reserved, facility, orchestrations);
    if (!link.ok) throw new HttpError(502, 'exception', `JeMPI register failed: ${link.error}`);
    goldenUid = link.goldenUid;
    interactionUid = link.interactionUid;
    healthId = await bindHealthId({ reserved, goldenUid, jempiAuxId: link.auxId });
  } catch (err) {
    await releaseReservation(reserved);
    throw err;
  }
  if (hint && isValidHealthId(hint) && hint !== healthId) {
    throw new HttpError(
      409,
      'conflict',
      `Health ID ${hint} does not belong to this person (the registry matched Health ID ${healthId}); send it for admin review`,
    );
  }

  patient.identifier.push({ system: SYS.JEMPI_GOLDEN_UID, value: goldenUid }, healthIdIdentifier(healthId));
  delete patient.id;
  stampProvenance(patient, { interactionUid, facility });

  const existing = await findByHealthId(healthId, orchestrations);
  const action = existing ? 'u' : 'c';
  if (!hasScope(caller.scopes, 'Patient', action)) {
    throw new HttpError(403, 'forbidden', `Client ${caller.clientId} may not ${existing ? 'update' : 'create'} patients`);
  }

  if (existing) {
    mergeIdentifiers(patient, existing);
    // The Patient is shared across facilities: the first registering facility stays
    // its managing organization; later facilities add MRNs, they do not take it over.
    patient.managingOrganization = existing.managingOrganization ?? orgRef;
    patient.id = existing.id;
    const path = `/Patient/${existing.id}`;
    const res = await write(() =>
      hapi.put<Resource>(path, patient, {
        headers: { 'If-Match': `W/"${(existing.meta as { versionId?: string })?.versionId}"` },
      }),
    );
    orchestrations.push(orch('HAPI update Patient', 'PUT', path, null, res.status, { id: res.data.id }));
    return { status: res.status, patient: res.data, healthId, created: false };
  }

  patient.managingOrganization = orgRef;
  const res = await write(() =>
    hapi.post<Resource>('/Patient', patient, {
      headers: { 'If-None-Exist': `identifier=${SYS.NEPAL_HEALTH_ID}|${healthId}` },
    }),
  );
  orchestrations.push(orch('HAPI create Patient', 'POST', '/Patient', null, res.status, { id: res.data.id }));
  return { status: res.status, patient: res.data, healthId, created: res.status === 201 };
}

/**
 * MRNs are scoped to the issuing facility. A bare hospital-mrn system becomes the
 * caller's own namespace; another facility's namespace is refused.
 */
export function scopeMrns(patient: Resource, facility: string, orgRef: Reference) {
  for (const id of patient.identifier ?? []) {
    if (!isMrnSystem(id.system)) continue;
    const own = mrnSystem(facility);
    if (id.system !== SYS.HOSPITAL_MRN && id.system !== own) {
      throw new HttpError(403, 'forbidden', `MRN namespace ${id.system} does not belong to ${facility}`);
    }
    id.system = own;
    id.use ??= 'usual';
    id.type = { coding: [{ system: SYS.V2_0203, code: 'MR' }] };
    id.assigner = orgRef;
  }
}

// A Health ID the client sends must be one this register issued.
async function checkHealthIdHint(patient: Resource) {
  const hint = findIdentifier(patient, SYS.NEPAL_HEALTH_ID)?.value;
  if (!hint) return;
  const record = isValidHealthId(hint) ? await healthIdRecord(hint) : null;
  if (!record) throw new HttpError(422, 'invalid', `Unknown Health ID ${hint}`);
  if (record.status === 'retired') {
    throw new HttpError(409, 'conflict', `Health ID ${hint} was retired; use ${record.replaced_by}`);
  }
}

const IDENTITY_SYSTEMS = new Set([SYS.NEPAL_HEALTH_ID, SYS.JEMPI_GOLDEN_UID]);

/**
 * Keep what other facilities contributed. Every facility's MRN namespace and any
 * system the incoming resource does not mention are carried over from the stored
 * Patient; for other systems the incoming value is authoritative.
 */
export function mergeIdentifiers(target: Resource, stored: Resource) {
  const incomingSystems = new Set((target.identifier ?? []).map((i) => i.system));
  for (const id of stored.identifier ?? []) {
    if (!id.system || !id.value || IDENTITY_SYSTEMS.has(id.system)) continue;
    if (hasIdentifier(target, id.system, id.value)) continue;
    if (incomingSystems.has(id.system) && !isMrnSystem(id.system)) continue;
    (target.identifier ??= []).push(id as Identifier);
  }
}

async function findByHealthId(healthId: string, orchestrations: Orchestration[]) {
  const path = `/Patient?identifier=${encodeURIComponent(`${SYS.NEPAL_HEALTH_ID}|${healthId}`)}`;
  const { data, status } = await read(() => hapi.get<Resource>(path));
  const found = data.entry?.find((e) => e.resource?.active !== false)?.resource ?? null;
  orchestrations.push(orch('HAPI read Patient by Health ID', 'GET', path, null, status, found ? { id: found.id } : {}));
  return found;
}

// The caller's Organization, found by its NHFR code. Cached for 5 minutes.
const orgCache = new Map<string, { ref: Reference; at: number }>();
export async function facilityOrganization(nhfr: string, orchestrations: Orchestration[]) {
  const hit = orgCache.get(nhfr);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ref;
  const path = `/Organization?identifier=${encodeURIComponent(`${SYS.NHFR}|${nhfr}`)}&_count=2`;
  const { data, status } = await read(() => hapi.get<Resource>(path));
  orchestrations.push(orch('HAPI read caller Organization', 'GET', path, null, status, { total: data.entry?.length ?? 0 }));
  const orgs = (data.entry ?? []).map((e) => e.resource).filter(Boolean) as Resource[];
  if (orgs.length !== 1) {
    throw new HttpError(
      422,
      orgs.length ? 'multiple-matches' : 'not-found',
      `${orgs.length ? 'More than one' : 'No'} Organization has NHFR identifier ${nhfr}`,
    );
  }
  const ref = { reference: `Organization/${orgs[0].id}`, display: orgs[0].name as string | undefined };
  orgCache.set(nhfr, { ref, at: Date.now() });
  return ref;
}

// HAPI failures never fall through to a write: a failed read fails the request.
async function read<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    throw upstream(err, 'HAPI read failed');
  }
}

async function write<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 412) {
      throw new HttpError(409, 'conflict', 'Patient was changed concurrently; resend the request');
    }
    if (axios.isAxiosError(err) && (err.response?.status === 400 || err.response?.status === 422)) {
      const body = err.response.data as { issue?: { diagnostics?: string }[] };
      throw new HttpError(422, 'processing', body?.issue?.map((i) => i.diagnostics).join('; ') || 'HAPI rejected the Patient');
    }
    throw upstream(err, 'HAPI write failed');
  }
}

function upstream(err: unknown, what: string) {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined;
  return new HttpError(502, 'exception', `${what}${status ? ` (${status})` : ''}: ${(err as Error).message}`);
}
