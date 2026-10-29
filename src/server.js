import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { caps, migrate, pool, q, S } from './db.js';
import * as auth from './auth.js';
import {
  checkOffline, evaluateSample, forgetNode, getRules, initAlerts, offlineAfterSec, reloadRules, RULE_METRICS,
} from './alerts.js';
import { sanitizeSample, validName } from './validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const AGENT = path.join(ROOT, 'agent');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.sh': 'text/x-shellscript; charset=utf-8', '.ps1': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    ...(isJson ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req, limit = 64 * 1024) {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'content-type must be application/json');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const clientIp = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

function hubUrl(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function installCommands(base, token) {
  return {
    linux: `curl -fsSL ${base}/install.sh | sudo sh -s -- --url ${base} --token ${token}`,
    windows:
      `irm ${base}/install.ps1 -OutFile $env:TEMP\nm-install.ps1; ` +
      `powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\nm-install.ps1 -Url ${base} -Token ${token}`,
  };
}

// ---------- live stream (SSE) ----------

const clients = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.res.write(data);
}

function closeStreamsFor(predicate) {
  for (const c of clients) if (predicate(c)) c.res.end();
}

// ---------- node summaries ----------

const NODE_COLS = `id, name, hostname, os, agent_version, ip, token_hint, created_at, last_seen, last,
  extract(epoch FROM now() - last_seen)::float AS age`;

function shapeNode(n, openAlerts = 0) {
  const off = offlineAfterSec();
  const status = n.last_seen === null ? 'pending' : n.age > off ? 'offline' : 'online';
  return {
    id: n.id, name: n.name, hostname: n.hostname, os: n.os, agent_version: n.agent_version, ip: n.ip,
    token_hint: n.token_hint, created_at: n.created_at, last_seen: n.last_seen, status, open_alerts: openAlerts,
    last: n.last,
  };
}

async function listNodes() {
  const [nodes, alerts, spark] = await Promise.all([
    q(`SELECT ${NODE_COLS} FROM ${S}.nodes ORDER BY name`),
    q(`SELECT node_id, count(*)::int AS n FROM ${S}.alerts WHERE resolved_at IS NULL GROUP BY node_id`),
    // Last 5 minutes of CPU + memory for the card sparklines.
    q(`SELECT node_id, array_agg(cpu ORDER BY time) AS cpu,
              array_agg(CASE WHEN mem_total > 0 THEN round(100.0 * mem_used / mem_total, 1) END ORDER BY time) AS mem
       FROM ${S}.metrics WHERE time > now() - interval '5 minutes' GROUP BY node_id`),
  ]);
  const a = Object.fromEntries(alerts.rows.map((r) => [r.node_id, r.n]));
  const sp = Object.fromEntries(spark.rows.map((r) => [r.node_id, { cpu: r.cpu, mem: r.mem.map(Number) }]));
  return nodes.rows.map((n) => ({ ...shapeNode(n, a[n.id] || 0), spark: sp[n.id] || { cpu: [], mem: [] } }));
}

// Range -> bucket seconds. Keeps every chart at <= ~720 points.
const RANGES = { '15m': [900, 5], '1h': [3600, 5], '6h': [21600, 30], '24h': [86400, 120], '7d': [604800, 900], '30d': [2592000, 3600] };

async function nodeMetrics(id, range) {
  const [span, bucket] = RANGES[range] || RANGES['1h'];
  const r = await q(
    `SELECT to_timestamp(floor(extract(epoch FROM time) / $3) * $3) AS t,
            avg(cpu)::real AS cpu, avg(load1)::real AS load1,
            avg(CASE WHEN mem_total > 0 THEN 100.0 * mem_used / mem_total END)::real AS mem,
            avg(CASE WHEN swap_total > 0 THEN 100.0 * swap_used / swap_total END)::real AS swap,
            max(disk_pct)::real AS disk,
            avg(net_rx)::real AS rx, avg(net_tx)::real AS tx
     FROM ${S}.metrics
     WHERE node_id = $1 AND time > now() - make_interval(secs => $2::int)
     GROUP BY 1 ORDER BY 1`,
    [id, span, bucket],
  );
  return { range, bucket, span, points: r.rows.map((p) => ({ ...p, t: new Date(p.t).getTime() })) };
}

// ---------- ingest ----------

const lastPush = new Map();

async function ingest(req, res) {
  const node = await auth.nodeFromBearer(req);
  if (!node) throw new HttpError(401, 'invalid node token');
  const now = Date.now();
  if (now - (lastPush.get(node.id) || 0) < 2000) throw new HttpError(429, 'too many pushes (min 2s interval)');
  lastPush.set(node.id, now);

  let s;
  try {
    s = sanitizeSample(await readJson(req));
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(400, e.message);
  }

  await q(
    `INSERT INTO ${S}.metrics (time, node_id, cpu, load1, mem_used, mem_total, swap_used, swap_total,
                               disk_used, disk_total, disk_pct, net_rx, net_tx, procs, uptime)
     VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [node.id, s.cpu, s.load1, s.mem_used, s.mem_total, s.swap_used, s.swap_total,
      s.disk_used, s.disk_total, s.disk_pct, s.net_rx, s.net_tx, s.procs, s.uptime],
  );
  const last = {
    cpu: s.cpu, load1: s.load1, mem_used: s.mem_used, mem_total: s.mem_total, mem_pct: s.mem_pct,
    swap_used: s.swap_used, swap_total: s.swap_total, swap_pct: s.swap_pct, disk_pct: s.disk_pct,
    disks: s.disks, net_rx: s.net_rx, net_tx: s.net_tx, procs: s.procs, uptime: s.uptime, kernel: s.kernel,
  };
  const upd = await q(
    `UPDATE ${S}.nodes SET last_seen = now(), last = $2, ip = $3,
       hostname = COALESCE($4, hostname), os = COALESCE($5, os), agent_version = COALESCE($6, agent_version)
     WHERE id = $1 RETURNING ${NODE_COLS}`,
    [node.id, last, clientIp(req), s.hostname, s.os, s.agent_version],
  );
  await evaluateSample(node, s);
  broadcast({ type: 'sample', node: shapeNode(upd.rows[0]), t: now });
  send(res, 204, '');
}

// ---------- routing ----------

const routes = [];
const route = (method, pattern, handler, { open = false } = {}) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, re, keys, handler, open });
};

// Public
route('POST', '/api/ingest', (req, res) => ingest(req, res), { open: true });

route('POST', '/api/login', async (req, res) => {
  const ip = clientIp(req);
  if (!auth.loginAllowed(ip)) throw new HttpError(429, 'too many attempts, wait 15 minutes');
  const { token } = await readJson(req, 4096);
  const s = await auth.login(typeof token === 'string' ? token.trim() : '', ip, req.headers['user-agent']);
  if (!s) {
    auth.loginFailed(ip);
    throw new HttpError(401, 'invalid or revoked token');
  }
  auth.loginSucceeded(ip);
  send(res, 200, { ok: true, expires_at: s.expiresAt }, { 'set-cookie': auth.sessionCookie(s.sid, s.expiresAt) });
}, { open: true });

route('POST', '/api/logout', async (req, res) => {
  await auth.logout(req);
  send(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() });
}, { open: true });

route('GET', '/api/me', async (req, res) => {
  const s = await auth.sessionFrom(req);
  if (!s) return send(res, 401, { error: 'not signed in' });
  send(res, 200, {
    token_label: s.label, expires_at: s.expires_at, session_days: config.sessionDays,
    retention_days: config.retentionDays, timescale: caps.timescale, hub_url: hubUrl(req),
  });
}, { open: true });

// Session required
route('GET', '/api/nodes', async (_req, res) => send(res, 200, await listNodes()));

route('GET', '/api/nodes/:id', async (_req, res, p) => {
  const r = await q(`SELECT ${NODE_COLS} FROM ${S}.nodes WHERE id = $1`, [p.id]);
  if (!r.rowCount) throw new HttpError(404, 'node not found');
  send(res, 200, shapeNode(r.rows[0]));
});

route('GET', '/api/nodes/:id/metrics', async (req, res, p, url) => {
  send(res, 200, await nodeMetrics(p.id, url.searchParams.get('range')));
});

route('POST', '/api/nodes', async (req, res) => {
  const name = validName((await readJson(req, 4096)).name);
  if (!name) throw new HttpError(400, 'name: 1-63 chars, letters, digits, space . _ -');
  const token = auth.newSecret('nmn');
  try {
    const r = await q(
      `INSERT INTO ${S}.nodes (name, token_hash, token_hint) VALUES ($1, $2, $3) RETURNING id, name`,
      [name, auth.sha256(token), auth.hintOf(token)],
    );
    broadcast({ type: 'nodes' });
    send(res, 201, { ...r.rows[0], token, install: installCommands(hubUrl(req), token) });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'a node with that name exists');
    throw e;
  }
});

route('POST', '/api/nodes/:id/rotate', async (req, res, p) => {
  const token = auth.newSecret('nmn');
  const r = await q(
    `UPDATE ${S}.nodes SET token_hash = $2, token_hint = $3 WHERE id = $1 RETURNING id, name`,
    [p.id, auth.sha256(token), auth.hintOf(token)],
  );
  if (!r.rowCount) throw new HttpError(404, 'node not found');
  send(res, 200, { ...r.rows[0], token, install: installCommands(hubUrl(req), token) });
});

route('DELETE', '/api/nodes/:id', async (_req, res, p) => {
  const id = Number(p.id);
  const r = await q(`DELETE FROM ${S}.nodes WHERE id = $1 RETURNING id`, [id]);
  if (!r.rowCount) throw new HttpError(404, 'node not found');
  await q(`DELETE FROM ${S}.alerts WHERE node_id = $1`, [id]);
  await q(`DELETE FROM ${S}.metrics WHERE node_id = $1`, [id]);
  forgetNode(id);
  lastPush.delete(id);
  broadcast({ type: 'nodes' });
  send(res, 200, { ok: true });
});

route('GET', '/api/alerts', async (req, res, _p, url) => {
  const node = url.searchParams.get('node');
  const r = await q(
    `SELECT a.*, n.name AS node_name FROM ${S}.alerts a JOIN ${S}.nodes n ON n.id = a.node_id
     WHERE ($1::int IS NULL OR a.node_id = $1) ORDER BY a.resolved_at IS NOT NULL, a.opened_at DESC LIMIT 200`,
    [node ? Number(node) : null],
  );
  send(res, 200, r.rows);
});

route('GET', '/api/rules', async (_req, res) => send(res, 200, getRules()));

route('PUT', '/api/rules/:id', async (req, res, p) => {
  const b = await readJson(req, 4096);
  const threshold = Number(b.threshold);
  const forSec = Number(b.for_sec ?? 0);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100000) throw new HttpError(400, 'bad threshold');
  if (!Number.isInteger(forSec) || forSec < 0 || forSec > 86400) throw new HttpError(400, 'bad for_sec');
  const rule = getRules().find((r) => r.id === Number(p.id));
  if (!rule || !RULE_METRICS.includes(rule.metric)) throw new HttpError(404, 'rule not found');
  if (rule.metric !== 'offline' && threshold > 100) throw new HttpError(400, 'percent threshold must be 0-100');
  if (rule.metric === 'offline' && threshold < 6) throw new HttpError(400, 'offline threshold must be >= 6s');
  await q(`UPDATE ${S}.alert_rules SET threshold = $2, for_sec = $3, enabled = $4 WHERE id = $1`,
    [rule.id, threshold, forSec, b.enabled !== false]);
  await reloadRules();
  broadcast({ type: 'nodes' });
  send(res, 200, getRules());
});

route('GET', '/api/tokens', async (_req, res) => {
  const r = await q(
    `SELECT t.id, t.label, t.token_hint, t.created_at, t.last_used_at, t.revoked_at,
            (SELECT count(*)::int FROM ${S}.sessions s WHERE s.token_id = t.id AND s.expires_at > now()) AS sessions
     FROM ${S}.ui_tokens t ORDER BY t.revoked_at IS NOT NULL, t.id`,
  );
  send(res, 200, r.rows);
});

route('POST', '/api/tokens', async (req, res) => {
  const label = validName((await readJson(req, 4096)).label);
  if (!label) throw new HttpError(400, 'label: 1-63 chars, letters, digits, space . _ -');
  send(res, 201, await auth.createUiToken(label));
});

route('DELETE', '/api/tokens/:id', async (_req, res, p, _url, session) => {
  const id = Number(p.id);
  if (id === session.token_id && (await auth.activeUiTokenCount()) <= 1) {
    throw new HttpError(409, 'cannot revoke the last active token');
  }
  if (!(await auth.revokeUiToken(id))) throw new HttpError(404, 'token not found or already revoked');
  closeStreamsFor((c) => c.tokenId === id);
  send(res, 200, { ok: true, self: id === session.token_id });
});

route('GET', '/api/events', async (req, res, _p, _url, session) => {
  res.writeHead(200, {
    ...SECURITY_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const client = { res, tokenId: session.token_id };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  // Close the stream when the session expires so the browser is forced back to login.
  const ms = Math.min(new Date(session.expires_at) - Date.now(), 2 ** 31 - 1);
  const expire = setTimeout(() => res.end(), Math.max(0, ms));
  req.on('close', () => { clients.delete(client); clearInterval(ping); clearTimeout(expire); });
});

// Agent scripts + installers (contain no secrets).
const AGENT_FILES = {
  '/install.sh': 'install.sh', '/install.ps1': 'install.ps1',
  '/agent/nodemon-agent.sh': 'nodemon-agent.sh', '/agent/nodemon-agent.ps1': 'nodemon-agent.ps1',
};

async function serveFile(res, file, root) {
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(root + path.sep)) throw new HttpError(404, 'not found');
  let data;
  try {
    data = await fs.readFile(resolved);
  } catch {
    throw new HttpError(404, 'not found');
  }
  send(res, 200, data, { 'content-type': MIME[path.extname(resolved)] || 'application/octet-stream', 'cache-control': 'no-cache' });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      if (params.id !== undefined && !/^\d{1,9}$/.test(params.id)) throw new HttpError(404, 'not found');
      let session = null;
      if (!r.open) {
        session = await auth.sessionFrom(req);
        if (!session) throw new HttpError(401, 'session expired, sign in with your access token');
        // CSRF: cookie is SameSite=Strict; also reject cross-origin browser writes.
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) {
          throw new HttpError(403, 'cross-origin request blocked');
        }
      }
      return await r.handler(req, res, params, url, session);
    }
    throw new HttpError(404, 'not found');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
  if (AGENT_FILES[pathname]) return serveFile(res, AGENT_FILES[pathname], AGENT);
  return serveFile(res, pathname === '/' ? 'index.html' : pathname.slice(1), PUBLIC);
}

// ---------- boot ----------

async function prune() {
  if (caps.retentionPolicy) return;
  const r = await q(`DELETE FROM ${S}.metrics WHERE time < now() - make_interval(days => $1::int)`, [config.retentionDays]);
  await q(`DELETE FROM ${S}.alerts WHERE resolved_at < now() - make_interval(days => $1::int)`, [config.retentionDays]);
  await q(`DELETE FROM ${S}.sessions WHERE expires_at < now()`);
  if (r.rowCount) console.log(`[prune] removed ${r.rowCount} metric rows older than ${config.retentionDays}d`);
}

async function main() {
  await migrate();
  await initAlerts(broadcast);

  if ((await auth.activeUiTokenCount()) === 0) {
    const t = await auth.createUiToken('bootstrap');
    console.log('\n  No UI access token exists. Created one (shown once, store it safely):\n');
    console.log(`    ${t.token}\n`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e.status || 500;
      if (status === 500) console.error('[http]', req.method, req.url, e);
      // Body left unread (e.g. 413): close the socket so the client does not hang on keep-alive.
      const extra = req.complete ? {} : { connection: 'close' };
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : e.message }, extra);
      else res.end();
      if (!req.complete) res.on('finish', () => req.destroy());
    });
  });
  server.requestTimeout = 30_000;
  server.listen(config.port, config.host, () => {
    console.log(`node-monitor hub on http://${config.host}:${config.port}  ` +
      `(db schema "${config.schema}", timescale: ${caps.timescale ? 'yes' : 'no'}, session: ${config.sessionDays}d)`);
  });

  setInterval(() => checkOffline().catch((e) => console.error('[offline]', e.message)), 5000).unref();
  // Tell browsers to re-evaluate online/offline even when nobody pushes.
  setInterval(() => broadcast({ type: 'tick' }), 5000).unref();
  setInterval(() => prune().catch((e) => console.error('[prune]', e.message)), 3600_000).unref();
  prune().catch((e) => console.error('[prune]', e.message));

  const stop = () => {
    console.log('shutting down');
    for (const c of clients) c.res.end();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
