// One-off, before go-live and on every stack that already has Patients: record every
// Health ID already in HAPI in the health_ids register, so new IDs can never collide
// with old ones and existing people keep their IDs.
//   docker compose exec identity-mediator node dist/scripts/backfill-health-ids.js
// Idempotent. Conflicts (one golden record holding two active IDs) are printed for
// admin review and left out.
import { pool, migrate } from '../db/pool.js';
import { importHealthId, retireHealthId } from '../db/healthIds.js';
import { searchAll } from '../fhir/hapiClient.js';
import { SYS, findIdentifier } from '../fhir/identifiers.js';
import type { Resource } from '../fhir/types.js';

await migrate();
const patients: Resource[] = await searchAll('Patient', { identifier: `${SYS.NEPAL_HEALTH_ID}|`, _count: '200' });
const healthIdOf = new Map(patients.map((p) => [p.id, findIdentifier(p, SYS.NEPAL_HEALTH_ID)?.value]));

let imported = 0;
const conflicts: string[] = [];
for (const p of patients.filter((x) => x.active !== false)) {
  const healthId = healthIdOf.get(p.id);
  const golden = findIdentifier(p, SYS.JEMPI_GOLDEN_UID)?.value ?? null;
  if (!healthId) continue;
  if (await importHealthId(healthId, golden, true)) imported++;
  else {
    const { rows } = await pool.query('SELECT golden_uid FROM health_ids WHERE health_id = $1', [healthId]);
    if (rows[0]?.golden_uid !== golden) conflicts.push(`${healthId} (Patient/${p.id}, golden ${golden})`);
  }
}

let retired = 0;
for (const p of patients.filter((x) => x.active === false)) {
  const healthId = healthIdOf.get(p.id);
  const survivorRef = (p.link as { type?: string; other?: { reference?: string } }[] | undefined)
    ?.find((l) => l.type === 'replaced-by')?.other?.reference;
  const survivor = patients.find((x) => `Patient/${x.id}` === survivorRef);
  const survivorHealthId = survivor && healthIdOf.get(survivor.id);
  const survivorGolden = survivor && findIdentifier(survivor, SYS.JEMPI_GOLDEN_UID)?.value;
  if (!healthId) continue;
  if (survivorHealthId && survivorGolden) {
    await retireHealthId({ loserHealthId: healthId, survivorHealthId, survivorGoldenUid: survivorGolden });
  } else {
    await importHealthId(healthId, null, false);
  }
  retired++;
}

console.log(JSON.stringify({ patients: patients.length, imported, retired, conflicts }, null, 2));
await pool.end();
