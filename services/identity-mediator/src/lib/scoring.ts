// @ts-nocheck
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from './logger.js';
import { jaroWinkler } from './jaroWinkler.js';

// ─── Why this file exists ────────────────────────────────────────────────────
// JeMPI's probabilistic linker never runs on our write path: the mediator registers
// via POST /crRegister, which is a deterministic find-or-create. It emits no scores
// and no review notifications, so JeMPI's own review queue is permanently empty.
// /calculateScores is also 404 on this deployment. So we compute the match score
// ourselves, here.
//
// We do NOT invent weights. We read the m/u probabilities out of the very same
// link config JeMPI is deployed with (jempi-config/config-reference-link-dp.json,
// mounted read-only), so a score here means what a score there would mean, and the
// two stay in sync when the config is retuned.
//
// Model: Fellegi-Sunter. For each field, compare the two values against the config's
// agreement level (0.92):
//   agree    -> weight = log2(m / u)          (evidence they are the same person)
//   disagree -> weight = log2((1-m) / (1-u))  (evidence they are not)
// m = P(fields agree | same person); u = P(fields agree | different people). A field
// that is rare (low u) contributes enormous positive weight when it agrees — which is
// exactly why the blank/placeholder handling below matters so much.
//
// ─── One deliberate deviation from the JeMPI config: EXACT_MATCH_FIELDS ──────
// The config names JARO_WINKLER_SIMILARITY for EVERY field. That is right for names,
// and unsafe for identifiers and dates. Worked example: dob '19900101' vs '19900102'
// (one day apart) scores JW 0.95 — above the 0.92 agreement level — so it counts as a
// FULL agreement worth +14 bits. Siblings or twins then present to an admin as a near
// certain duplicate. national_id is worse: two IDs differing in the last digit score
// JW 0.97 and agreement is worth +22 bits, which alone saturates the score.
//
// Dates and ID numbers have no meaningful edit-distance semantics for identity —
// prefix-boosting a date is nonsense; '19900101' and '19900102' are simply different
// days. So those fields are compared with EXACT equality. This makes us STRICTER than
// stock JeMPI, which is the correct direction: we ship merge WITHOUT split, so a wrong
// merge is effectively irreversible. A near-miss dob now scores a mild disagreement
// (-2.2 bits) instead of a decisive agreement, and the pair can still reach the queue
// on the strength of its other fields.

const CAMEL = (snake) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function loadFields() {
  const raw = JSON.parse(readFileSync(config.SCORING_CONFIG_PATH, 'utf8'));
  const exact = new Set(config.EXACT_MATCH_FIELDS);
  const fields = (raw.demographicFields || [])
    .filter((f) => f.linkMetaData)
    .map((f) => {
      const { m, u, comparisonLevels } = f.linkMetaData;
      // Guard the logs: m of exactly 1 or u of exactly 0 would produce Infinity and
      // poison every score with NaN.
      const mm = Math.min(Math.max(m, 1e-9), 1 - 1e-9);
      const uu = Math.min(Math.max(u, 1e-9), 1 - 1e-9);
      return {
        name: f.fieldName,
        key: CAMEL(f.fieldName),
        comparison: exact.has(f.fieldName) ? 'exact' : 'jaro-winkler',
        threshold: comparisonLevels?.[0] ?? 0.92,
        agreeWeight: Math.log2(mm / uu),
        disagreeWeight: Math.log2((1 - mm) / (1 - uu)),
      };
    });

  if (!fields.length) throw new Error(`No scorable demographicFields in ${config.SCORING_CONFIG_PATH}`);
  logger.info(
    {
      path: config.SCORING_CONFIG_PATH,
      fields: fields.map((f) => `${f.name}:+${f.agreeWeight.toFixed(1)}/${f.disagreeWeight.toFixed(1)}:${f.comparison}`),
    },
    'loaded link weights from JeMPI config',
  );
  return fields;
}

const FIELDS = loadFields();
const PLACEHOLDER_PHONES = new Set(config.PLACEHOLDER_PHONES);

// A field is only evidence when BOTH sides have a real value.
//
// Two traps this closes:
//  1. Blank on either side must be SKIPPED, not scored as disagreement. Our records
//     very often carry an empty national_id; counting that as a disagreement would
//     subtract ~2.7 bits from every honest pair and sink real duplicates below the band.
//  2. The placeholder phone (9800000000) must count as blank. phone_number has
//     u = 4e-07, so an agreement is worth ~21 bits — more than every other field
//     combined. Two strangers who both carry the placeholder would score as a near
//     certain match. See the linking-rules notes: the placeholder is common in our data.
function usableValue(field, value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (field.name === 'phone_number' && PLACEHOLDER_PHONES.has(v)) return null;
  return v.toLowerCase();
}

/**
 * Score a candidate pair of demographic records.
 *
 * Returns { score, bits, comparedCount, fields[] } where `score` is normalised to
 * 0..1 across only the fields that were actually comparable, so the configured
 * hold band (0.65-0.75) is meaningful regardless of how much data a record has.
 * `score` is null when nothing was comparable — the caller must not queue those.
 */
export function scorePair(demoA, demoB) {
  let total = 0;
  let best = 0;   // all comparable fields agreeing
  let worst = 0;  // all comparable fields disagreeing
  const fields = [];

  for (const f of FIELDS) {
    const a = usableValue(f, demoA?.[f.key]);
    const b = usableValue(f, demoB?.[f.key]);

    if (a === null || b === null) {
      fields.push({
        field: f.name,
        label: f.key,
        a: demoA?.[f.key] ?? '',
        b: demoB?.[f.key] ?? '',
        compared: false,
        reason: 'missing or placeholder on at least one side',
      });
      continue;
    }

    // Identifier/date fields are judged on exact equality; name-like fields on
    // Jaro-Winkler against the config's agreement level. See the header note.
    const similarity = f.comparison === 'exact' ? (a === b ? 1 : 0) : jaroWinkler(a, b);
    const agree = f.comparison === 'exact' ? a === b : similarity >= f.threshold;
    const weight = agree ? f.agreeWeight : f.disagreeWeight;

    total += weight;
    best += f.agreeWeight;
    worst += f.disagreeWeight;

    fields.push({
      field: f.name,
      label: f.key,
      a: demoA?.[f.key] ?? '',
      b: demoB?.[f.key] ?? '',
      compared: true,
      comparison: f.comparison,
      similarity: Number(similarity.toFixed(4)),
      agree,
      weight: Number(weight.toFixed(4)),
    });
  }

  const comparedCount = fields.filter((f) => f.compared).length;
  // Did anything RARE agree? Agreement on common fields (name/city/gender) is not
  // evidence of identity at population scale — millions of records means thousands of
  // "same common name, same city, same gender" pairs, and queueing them buries the real
  // duplicates. A pair needs at least one rare field (dob/phone/national_id) to agree
  // before a human is asked to look. Without that there is genuinely nothing to judge.
  const discriminating = fields.some(
    (f) => f.compared && f.agree && config.DISCRIMINATING_FIELDS.includes(f.field),
  );

  if (comparedCount === 0 || best === worst) {
    return { score: null, bits: total, comparedCount, discriminating, fields };
  }

  // Min-max normalise against what THIS pair could have scored, given which fields
  // were comparable. Without this the raw bit total is unbounded and the band means
  // nothing.
  const score = (total - worst) / (best - worst);
  return {
    score: Number(Math.min(Math.max(score, 0), 1).toFixed(4)),
    bits: Number(total.toFixed(4)),
    comparedCount,
    discriminating,
    fields,
  };
}

// 'likely' vs 'possible' is a label for the admin only. Nothing auto-merges: a human
// resolves every pair.
export function bandFor(score) {
  if (score >= config.REVIEW_HIGH_THRESHOLD) return 'likely';
  if (score >= config.REVIEW_LOW_THRESHOLD) return 'possible';
  return 'below';
}

export const scoringFields = FIELDS.map((f) => ({ field: f.name, label: f.key, comparison: f.comparison }));
// @ts-nocheck
