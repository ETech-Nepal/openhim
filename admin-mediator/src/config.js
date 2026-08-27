import 'dotenv/config';
import { z } from 'zod';

const csv = (def) =>
  z.string().default(def).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

// NOT z.coerce.boolean(): that applies JS truthiness, so the string 'false' — which is
// exactly what an env var carries — coerces to TRUE. Env booleans must be parsed by value.
const bool = (def) =>
  z.enum(['true', 'false', '1', '0']).default(def).transform((s) => s === 'true' || s === '1');

const schema = z.object({
  MEDIATOR_PORT: z.coerce.number().default(4002),
  MEDIATOR_URN: z.string().min(1),
  MEDIATOR_ROUTE_HOST: z.string().default('admin-mediator'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  OPENHIM_API_URL: z.string().url(),
  OPENHIM_USERNAME: z.string().min(1),
  OPENHIM_PASSWORD: z.string().min(1),
  OPENHIM_TRUST_SELF_SIGNED: bool('false'),
  OPENHIM_CHANNEL_ROLE: z.string().default('np-admin-clients'),

  HAPI_FHIR_BASE_URL: z.string().url(),
  HAPI_TIMEOUT_MS: z.coerce.number().default(15000),

  JEMPI_BASE_URL: z.string().url(),
  JEMPI_TIMEOUT_MS: z.coerce.number().default(15000),

  REVIEW_DB_HOST: z.string().default('hapi-db'),
  REVIEW_DB_PORT: z.coerce.number().default(5432),
  REVIEW_DB_USER: z.string().min(1),
  REVIEW_DB_PASSWORD: z.string().min(1),
  REVIEW_DB_NAME: z.string().default('admin_review'),

  // The same link config JeMPI itself uses — we read its m/u probabilities rather
  // than inventing weights, so our score means what JeMPI's would mean.
  SCORING_CONFIG_PATH: z.string().default('/config/config-reference-link-dp.json'),

  REVIEW_LOW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
  REVIEW_HIGH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),

  PLACEHOLDER_PHONES: csv('9800000000'),
  // Fields compared with exact equality instead of the config's Jaro-Winkler.
  // Identifiers and dates have no edit-distance semantics for identity, and their
  // agreement weights are large enough that a near-miss would saturate the score.
  // See the header note in lib/scoring.js.
  EXACT_MATCH_FIELDS: csv('dob,national_id,phone_number'),
  // A pair must agree on at least ONE of these to be queued. They are the fields rare
  // enough to identify a person (low `u` in the link config: dob 4.65e-05, phone 4e-07,
  // national_id 2e-07). Name/city/gender are common (u 0.003-0.44) — agreeing on those
  // alone says "two people share a common name in a big city", which at population
  // scale is thousands of pairs and no evidence at all. See lib/scoring.js.
  DISCRIMINATING_FIELDS: csv('dob,national_id,phone_number'),
  MERGE_REFERENCING_TYPES: csv('Encounter,Observation,DocumentReference'),

  SCAN_ON_BOOT: bool('false'),
  SCAN_PAGE_SIZE: z.coerce.number().default(50),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid env config:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

if (config.REVIEW_LOW_THRESHOLD > config.REVIEW_HIGH_THRESHOLD) {
  console.error('REVIEW_LOW_THRESHOLD must be <= REVIEW_HIGH_THRESHOLD');
  process.exit(1);
}
