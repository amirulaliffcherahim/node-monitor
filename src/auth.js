import crypto from 'node:crypto';
import { config } from './config.js';
import { q, S } from './db.js';

// Tokens are high-entropy random strings, so a fast SHA-256 is enough for storage.
// Only the hash is kept; the plaintext is shown once at creation.
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newSecret = (prefix) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
export const hintOf = (t) => `${t.slice(0, 8)}…${t.slice(-4)}`;

export const COOKIE = 'nm_session';

// ---- UI access tokens (permanent until revoked) ----

export async function createUiToken(label) {
  const token = newSecret('nmui');
  const r = await q(
    `INSERT INTO ${S}.ui_tokens (label, token_hash, token_hint) VALUES ($1, $2, $3)
     RETURNING id, label, token_hint, created_at`,
    [label, sha256(token), hintOf(token)],
  );
  return { ...r.rows[0], token };
}

export async function activeUiTokenCount() {
  const r = await q(`SELECT count(*)::int AS n FROM ${S}.ui_tokens WHERE revoked_at IS NULL`);
  return r.rows[0].n;
}

export async function revokeUiToken(id) {
  const r = await q(
    `UPDATE ${S}.ui_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id],
  );
  // Kill every browser session opened with that token immediately.
  await q(`DELETE FROM ${S}.sessions WHERE token_id = $1`, [id]);
  return r.rowCount > 0;
}

// ---- Sessions: fixed lifetime from login, never extended. ----

export async function login(token, ip, userAgent) {
  if (typeof token !== 'string' || !token.startsWith('nmui_') || token.length > 200) return null;
  const t = await q(
    `UPDATE ${S}.ui_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id`,
    [sha256(token)],
  );
  if (!t.rowCount) return null;
  const sid = crypto.randomBytes(32).toString('base64url');
  const r = await q(
    `INSERT INTO ${S}.sessions (id_hash, token_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3::int), $4, $5) RETURNING expires_at`,
    [sha256(sid), t.rows[0].id, config.sessionDays, ip, (userAgent || '').slice(0, 200)],
  );
  return { sid, expiresAt: r.rows[0].expires_at };
}

export async function sessionFrom(req) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (!sid || sid.length > 100) return null;
  const r = await q(
    `SELECT s.token_id, s.expires_at, t.label FROM ${S}.sessions s
     JOIN ${S}.ui_tokens t ON t.id = s.token_id
     WHERE s.id_hash = $1 AND s.expires_at > now() AND t.revoked_at IS NULL`,
    [sha256(sid)],
  );
  return r.rows[0] ? { ...r.rows[0], idHash: sha256(sid) } : null;
}

export async function logout(req) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (sid) await q(`DELETE FROM ${S}.sessions WHERE id_hash = $1`, [sha256(sid)]);
}

export function sessionCookie(sid, expiresAt) {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
  return [
    `${COOKIE}=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`,
    config.cookieSecure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- Node (agent) tokens ----

export async function nodeFromBearer(req) {
  const m = /^Bearer\s+(nmn_[A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const r = await q(`SELECT id, name FROM ${S}.nodes WHERE token_hash = $1`, [sha256(m[1])]);
  return r.rows[0] || null;
}

// ---- Brute-force guard for /api/login (per IP, in memory). ----

const attempts = new Map();
export function loginAllowed(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.first > 15 * 60_000) return true;
  return a.count < 10;
}
export function loginFailed(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.first > 15 * 60_000) attempts.set(ip, { first: now, count: 1 });
  else a.count++;
}
export const loginSucceeded = (ip) => attempts.delete(ip);
setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [ip, a] of attempts) if (a.first < cutoff) attempts.delete(ip);
}, 5 * 60_000).unref();
