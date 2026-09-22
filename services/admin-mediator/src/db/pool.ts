// @ts-nocheck
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const base = {
  host: config.REVIEW_DB_HOST,
  port: config.REVIEW_DB_PORT,
  user: config.REVIEW_DB_USER,
  password: config.REVIEW_DB_PASSWORD,
};

export const pool = new pg.Pool({ ...base, database: config.REVIEW_DB_NAME });

pool.on('error', (err) => logger.error({ err: err.message }, 'idle postgres client error'));

// The review queue lives in its own database on the existing Postgres container, so it
// is never mixed into HAPI's schema. The container's volume already exists, so its
// docker-entrypoint initdb hooks will never re-run — the database has to be created at
// boot instead. Postgres has no CREATE DATABASE IF NOT EXISTS, hence the catalog probe.
async function ensureDatabase() {
  const admin = new pg.Client({ ...base, database: 'postgres' });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.REVIEW_DB_NAME]);
    if (rowCount === 0) {
      // Identifier can't be parameterised; it comes from our own validated config.
      await admin.query(`CREATE DATABASE "${config.REVIEW_DB_NAME}"`);
      logger.info({ db: config.REVIEW_DB_NAME }, 'created review database');
    }
  } catch (err) {
    // Two replicas booting together can race between the probe and the CREATE.
    if (err.code !== '42P04') throw err;
  } finally {
    await admin.end();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS review_tasks (
  id            UUID PRIMARY KEY,
  -- Canonical (sorted) pair of golden UIDs. UNIQUE so repeated scans update a task
  -- rather than piling up duplicates of the same pair.
  pair_key      TEXT NOT NULL UNIQUE,
  golden_a      TEXT NOT NULL,
  golden_b      TEXT NOT NULL,
  score         NUMERIC(6,4) NOT NULL,
  band          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN',
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution    JSONB,
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_tasks_status_score_idx ON review_tasks (status, score DESC);
CREATE INDEX IF NOT EXISTS review_tasks_goldens_idx ON review_tasks (golden_a, golden_b);
`;

export async function migrate() {
  await ensureDatabase();
  await pool.query(SCHEMA);
  logger.info('review_tasks schema ready');
}
// @ts-nocheck
