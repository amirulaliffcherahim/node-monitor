import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 8,
  ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
});
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

export const S = `"${config.schema}"`;
export const q = (text, params) => pool.query(text, params);

// Filled by migrate(): what the connected Postgres supports.
export const caps = { timescale: false, retentionPolicy: false };

export async function migrate() {
  await q(`CREATE SCHEMA IF NOT EXISTS ${S}`);

  if (config.timescale) {
    try {
      const r = await q(`SELECT installed_version FROM pg_available_extensions WHERE name = 'timescaledb'`);
      if (r.rowCount) {
        if (!r.rows[0].installed_version) await q('CREATE EXTENSION IF NOT EXISTS timescaledb');
        caps.timescale = true;
      }
    } catch (e) {
      console.warn('[db] timescaledb not usable, falling back to plain table:', e.message);
    }
  }

  await q(`
    CREATE TABLE IF NOT EXISTS ${S}.nodes (
      id            serial PRIMARY KEY,
      name          text NOT NULL UNIQUE,
      token_hash    text NOT NULL UNIQUE,
      token_hint    text NOT NULL,
      hostname      text,
      os            text,
      agent_version text,
      ip            text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      last_seen     timestamptz,
      last          jsonb
    );
    CREATE TABLE IF NOT EXISTS ${S}.metrics (
      time       timestamptz NOT NULL,
      node_id    integer NOT NULL,
      cpu        real,
      load1      real,
      mem_used   bigint,
      mem_total  bigint,
      swap_used  bigint,
      swap_total bigint,
      disk_used  bigint,
      disk_total bigint,
      disk_pct   real,
      net_rx     real,
      net_tx     real,
      procs      integer,
      uptime     bigint
    );
    CREATE INDEX IF NOT EXISTS metrics_node_time ON ${S}.metrics (node_id, time DESC);
    CREATE TABLE IF NOT EXISTS ${S}.ui_tokens (
      id           serial PRIMARY KEY,
      label        text NOT NULL,
      token_hash   text NOT NULL UNIQUE,
      token_hint   text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at   timestamptz
    );
    CREATE TABLE IF NOT EXISTS ${S}.sessions (
      id_hash    text PRIMARY KEY,
      token_id   integer NOT NULL REFERENCES ${S}.ui_tokens(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      ip         text,
      user_agent text
    );
    CREATE TABLE IF NOT EXISTS ${S}.alert_rules (
      id        serial PRIMARY KEY,
      metric    text NOT NULL UNIQUE,
      op        text NOT NULL DEFAULT '>',
      threshold real NOT NULL,
      for_sec   integer NOT NULL DEFAULT 0,
      enabled   boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS ${S}.alerts (
      id          bigserial PRIMARY KEY,
      node_id     integer NOT NULL,
      rule_id     integer NOT NULL,
      metric      text NOT NULL,
      value       real,
      threshold   real,
      message     text NOT NULL,
      opened_at   timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS alerts_open ON ${S}.alerts (node_id) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS alerts_opened ON ${S}.alerts (opened_at DESC);
  `);

  await q(
    `INSERT INTO ${S}.alert_rules (metric, op, threshold, for_sec) VALUES
       ('cpu', '>', 90, 60), ('mem', '>', 90, 60), ('disk', '>', 90, 0),
       ('swap', '>', 80, 120), ('offline', '>', $1, 0)
     ON CONFLICT (metric) DO NOTHING`,
    [config.offlineAfterSec],
  );

  if (caps.timescale) await setupTimescale();
}

async function setupTimescale() {
  const rel = `'${S}.metrics'`;
  try {
    await q(`SELECT create_hypertable(${rel}, 'time', if_not_exists => TRUE, migrate_data => TRUE,
                                      chunk_time_interval => INTERVAL '1 day')`);
  } catch (e) {
    console.warn('[db] create_hypertable failed, using plain table:', e.message);
    caps.timescale = false;
    return;
  }
  // Compression + retention are TSL features; missing on Apache-only builds. Each is optional.
  try {
    await q(`ALTER TABLE ${S}.metrics SET (timescaledb.compress, timescaledb.compress_segmentby = 'node_id',
                                           timescaledb.compress_orderby = 'time DESC')`);
    await q(`SELECT add_compression_policy(${rel}, INTERVAL '2 days', if_not_exists => TRUE)`);
  } catch (e) {
    console.warn('[db] compression policy skipped:', e.message);
  }
  try {
    await q(`SELECT remove_retention_policy(${rel}, if_exists => TRUE)`);
    await q(`SELECT add_retention_policy(${rel}, make_interval(days => $1::int))`, [config.retentionDays]);
    caps.retentionPolicy = true;
  } catch (e) {
    console.warn('[db] retention policy skipped, hub will prune hourly:', e.message);
  }
}
