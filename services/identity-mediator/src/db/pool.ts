// @ts-nocheck
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// The identity database (role and database `identity`) is created by
// single_stack/hapi-db/init/10-roles.sh; this mediator only owns its tables.
export const pool = new pg.Pool({
  host: config.IDENTITY_DB_HOST,
  port: config.IDENTITY_DB_PORT,
  user: config.IDENTITY_DB_USER,
  password: config.IDENTITY_DB_PASSWORD,
  database: config.IDENTITY_DB_NAME,
});

pool.on('error', (err) => logger.error({ err: err.message }, 'idle postgres client error'));

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

-- The Health ID register. This mediator is the only issuer. The primary key makes it
-- impossible to hand one ID to two people; golden_uid UNIQUE gives one ID per person.
-- A row is 'reserved' (no golden yet) while its registration is in flight.
CREATE TABLE IF NOT EXISTS health_ids (
  health_id   TEXT PRIMARY KEY,
  golden_uid  TEXT UNIQUE,
  status      TEXT NOT NULL DEFAULT 'reserved'
              CHECK (status IN ('reserved', 'active', 'retired')),
  replaced_by TEXT REFERENCES health_ids (health_id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrate() {
  await pool.query(SCHEMA);
  logger.info('identity schema ready');
}
