// One-off, after a backup: rewrite every MRN stored with the shared hospital-mrn
// system to the issuing facility's own namespace (hospital-mrn/<NHFR>) and add the
// v2-0203 MR type. The facility comes from the identifier's assigner Organization,
// falling back to the Patient's source-facility tag. Dry run unless --apply.
//   docker compose exec identity-mediator node dist/scripts/migrate-mrn-systems.js [--apply]
import { hapi, putIfMatch, searchAll } from '../fhir/hapiClient.js';
import { SYS, findIdentifier, mrnSystem } from '../fhir/identifiers.js';
import type { Resource } from '../fhir/types.js';

const apply = process.argv.includes('--apply');
const nhfrOfOrg = new Map<string, string | undefined>();
async function orgNhfr(reference?: string) {
  if (!reference?.startsWith('Organization/')) return undefined;
  if (!nhfrOfOrg.has(reference)) {
    const { data } = await hapi.get<Resource>(`/${reference}`);
    nhfrOfOrg.set(reference, findIdentifier(data, SYS.NHFR)?.value);
  }
  return nhfrOfOrg.get(reference);
}

const patients: Resource[] = await searchAll('Patient', { identifier: `${SYS.HOSPITAL_MRN}|`, _count: '200' });
let changed = 0;
const unresolved: string[] = [];
for (const p of patients) {
  const tag = p.meta?.tag?.find((t) => t.system === SYS.SOURCE_FACILITY)?.code;
  let touched = false;
  for (const id of p.identifier ?? []) {
    if (id.system !== SYS.HOSPITAL_MRN) continue;
    const nhfr = (await orgNhfr(id.assigner?.reference)) ?? tag;
    if (!nhfr) {
      unresolved.push(`Patient/${p.id} MRN ${id.value}`);
      continue;
    }
    id.system = mrnSystem(nhfr);
    id.type = { coding: [{ system: SYS.V2_0203, code: 'MR' }] };
    touched = true;
  }
  if (!touched) continue;
  changed++;
  if (apply) await putIfMatch(p);
}
console.log(JSON.stringify({ apply, patients: patients.length, changed, unresolved }, null, 2));
