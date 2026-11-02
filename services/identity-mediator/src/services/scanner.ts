// @ts-nocheck
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { scorePair, bandFor } from '../lib/scoring.js';
import { findCandidates, listGoldenIds, getExpandedGoldens } from '../providers/jempiProvider.js';
import { upsertTask, pairKey } from '../db/reviewRepo.js';

// ─── What this does ──────────────────────────────────────────────────────────
// JeMPI's linker never scores our records (crRegister is deterministic find-or-create),
// so duplicates that fall short of the deterministic rule just sit in the registry as
// separate golden records with nothing flagging them. This sweep finds them: for every
// golden, block on the config's probabilistic rule via /customSearch/golden, score each
// candidate pair ourselves, and queue whatever lands at or above REVIEW_LOW_THRESHOLD.

const summarise = (g) => ({
  uid: g.uid,
  healthId: g.uniqueGoldenRecordData?.auxId ?? null, // auxId carries the Nepal Health ID
  demographics: g.demographicData ?? {},
  facilities: (g.sourceId ?? []).map((s) => s.facility).filter(Boolean),
});

/**
 * Scan for duplicate candidates and enqueue them.
 * Returns { scanned, pairsConsidered, queued, skipped, errors }.
 */
export async function scanForDuplicates({ goldenIds = null } = {}) {
  const stats = { scanned: 0, pairsConsidered: 0, queued: 0, skipped: 0, skippedCommonOnly: 0, errors: [] };

  let ids = goldenIds;
  if (!ids) {
    const listed = await listGoldenIds();
    if (!listed.ok) {
      stats.errors.push(`gidsAll: ${listed.error}`);
      return stats;
    }
    ids = listed.ids;
  }
  logger.info({ count: ids.length }, 'scanning golden records for duplicates');

  // Each pair surfaces from both sides; score it once.
  const seen = new Set();

  for (let i = 0; i < ids.length; i += config.SCAN_PAGE_SIZE) {
    const page = ids.slice(i, i + config.SCAN_PAGE_SIZE);
    const { ok, records, error } = await getExpandedGoldens(page);
    if (!ok) {
      stats.errors.push(`expandedGoldenRecords: ${error}`);
      continue;
    }

    for (const entry of records) {
      const golden = entry?.goldenRecord;
      if (!golden?.uid) continue;
      stats.scanned++;

      const demo = golden.demographicData ?? {};
      const found = await findCandidates(demo);
      if (!found.ok) {
        stats.errors.push(`customSearch for ${golden.uid}: ${found.error}`);
        continue;
      }

      for (const cand of found.records) {
        const other = cand?.goldenRecord;
        if (!other?.uid || other.uid === golden.uid) continue;

        const key = pairKey(golden.uid, other.uid);
        if (seen.has(key)) continue;
        seen.add(key);
        stats.pairsConsidered++;

        const result = scorePair(demo, other.demographicData ?? {});
        // Nothing comparable (both records blank on every scorable field) — no evidence
        // either way, so there is nothing to show an admin.
        if (result.score === null) { stats.skipped++; continue; }

        // No rare field agreed — only a common name/city/gender collision. Queueing
        // these floods the admin at population scale. See lib/scoring.js.
        if (!result.discriminating) { stats.skippedCommonOnly++; continue; }

        const band = bandFor(result.score);
        if (band === 'below') { stats.skipped++; continue; }

        const task = await upsertTask({
          goldenA: golden.uid,
          goldenB: other.uid,
          score: result.score,
          band,
          detail: {
            scoredAt: new Date().toISOString(),
            bits: result.bits,
            comparedCount: result.comparedCount,
            fields: result.fields,
            a: summarise(golden),
            b: summarise(other),
          },
        });
        // null => the pair was already resolved (DISMISSED/MERGED); leave it resolved.
        if (task) stats.queued++;
      }
    }
  }

  logger.info(stats, 'duplicate scan complete');
  return stats;
}
// @ts-nocheck
