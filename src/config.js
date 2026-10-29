// Runtime configuration, all from environment (.env is loaded by `npm start`).
function int(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

const schema = process.env.DB_SCHEMA || 'nodemon';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
  throw new Error(`DB_SCHEMA must match ^[a-z_][a-z0-9_]*$, got "${schema}"`);
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres',
  dbSsl: process.env.DATABASE_SSL === '1',
  schema,
  // Set TIMESCALE=off to force a plain table even when the extension exists.
  timescale: process.env.TIMESCALE !== 'off',
  host: process.env.HOST || '0.0.0.0',
  port: int('PORT', 8787, 1, 65535),
  // Browser session length. Access tokens never expire; the session does,
  // so the token must be re-entered every SESSION_DAYS.
  sessionDays: int('SESSION_DAYS', 7, 1, 365),
  // Set COOKIE_SECURE=1 when the UI is served over HTTPS (e.g. tailscale serve).
  cookieSecure: process.env.COOKIE_SECURE === '1',
  retentionDays: int('RETENTION_DAYS', 30, 1, 3650),
  // Default for the seeded "offline" alert rule (editable later in the UI).
  offlineAfterSec: int('OFFLINE_AFTER_SEC', 20, 6, 3600),
  // Optional webhook for alert open/resolve. Payload has both `content` (Discord) and `text` (Slack).
  alertWebhook: process.env.ALERT_WEBHOOK_URL || '',
  // Hub URL agents should use (e.g. http://my-hub:8787). Pre-fills install commands in the UI.
  publicUrl: process.env.PUBLIC_URL || '',
};
