import { config } from './config.js';
import { q, S } from './db.js';

// Maps a rule metric to the value in a sanitised sample.
const PICK = {
  cpu: (s) => s.cpu,
  mem: (s) => s.mem_pct,
  disk: (s) => s.disk_pct,
  swap: (s) => s.swap_pct,
};
export const RULE_METRICS = ['cpu', 'mem', 'disk', 'swap', 'offline'];
const LABEL = { cpu: 'CPU', mem: 'Memory', disk: 'Disk', swap: 'Swap', offline: 'Offline' };

let rules = [];
// key `${nodeId}:${ruleId}` -> { since: ms } while breaching but not yet past for_sec
const pending = new Map();
// key -> alert id for currently open alerts (rebuilt from DB at boot)
const open = new Map();
let onChange = () => {};

export async function initAlerts(broadcast) {
  onChange = broadcast;
  await reloadRules();
  const r = await q(`SELECT id, node_id, rule_id FROM ${S}.alerts WHERE resolved_at IS NULL`);
  for (const a of r.rows) open.set(`${a.node_id}:${a.rule_id}`, a.id);
}

export async function reloadRules() {
  rules = (await q(`SELECT * FROM ${S}.alert_rules ORDER BY id`)).rows;
  // Drop state for rules that are now disabled.
  for (const key of pending.keys()) {
    const rid = Number(key.split(':')[1]);
    if (!rules.some((r) => r.id === rid && r.enabled)) pending.delete(key);
  }
  for (const [key] of open) {
    const rid = Number(key.split(':')[1]);
    if (!rules.some((r) => r.id === rid && r.enabled)) await resolve(key);
  }
}

export const getRules = () => rules;

const breach = (v, op, t) => (op === '<' ? v < t : v > t);

export async function evaluateSample(node, sample) {
  const now = Date.now();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const key = `${node.id}:${rule.id}`;
    if (rule.metric === 'offline') {
      // A push means the node is back.
      if (open.has(key)) await resolve(key);
      continue;
    }
    const v = PICK[rule.metric]?.(sample);
    if (v === null || v === undefined) continue;
    if (breach(v, rule.op, rule.threshold)) {
      if (open.has(key)) continue;
      const p = pending.get(key) ?? { since: now };
      pending.set(key, p);
      if (now - p.since >= rule.for_sec * 1000) {
        pending.delete(key);
        const forTxt = rule.for_sec ? ` for ${rule.for_sec}s` : '';
        await fire(node, rule, v, `${LABEL[rule.metric]} ${v.toFixed(1)}% ${rule.op} ${rule.threshold}%${forTxt}`);
      }
    } else {
      pending.delete(key);
      if (open.has(key)) await resolve(key);
    }
  }
}

// Called on a timer: opens "offline" alerts for silent nodes.
export async function checkOffline() {
  const rule = rules.find((r) => r.metric === 'offline' && r.enabled);
  if (!rule) return;
  const r = await q(
    `SELECT id, name, extract(epoch FROM now() - last_seen)::int AS age FROM ${S}.nodes
     WHERE last_seen IS NOT NULL AND last_seen < now() - make_interval(secs => $1::int)`,
    [rule.threshold],
  );
  for (const n of r.rows) {
    const key = `${n.id}:${rule.id}`;
    if (!open.has(key)) await fire(n, rule, n.age, `No data for ${n.age}s`);
  }
}

export const offlineAfterSec = () =>
  rules.find((r) => r.metric === 'offline' && r.enabled)?.threshold ?? config.offlineAfterSec;

export function forgetNode(nodeId) {
  for (const m of [pending, open]) for (const key of m.keys()) if (key.startsWith(`${nodeId}:`)) m.delete(key);
}

async function fire(node, rule, value, message) {
  const key = `${node.id}:${rule.id}`;
  const r = await q(
    `INSERT INTO ${S}.alerts (node_id, rule_id, metric, value, threshold, message)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [node.id, rule.id, rule.metric, value, rule.threshold, message],
  );
  open.set(key, r.rows[0].id);
  const alert = { ...r.rows[0], node_name: node.name };
  onChange({ type: 'alert', alert });
  notify(`🔴 [${node.name}] ${message}`);
}

async function resolve(key) {
  const id = open.get(key);
  open.delete(key);
  if (!id) return;
  const r = await q(
    `UPDATE ${S}.alerts a SET resolved_at = now() FROM ${S}.nodes n
     WHERE a.id = $1 AND n.id = a.node_id RETURNING a.*, n.name AS node_name`,
    [id],
  );
  if (!r.rowCount) return;
  const alert = r.rows[0];
  onChange({ type: 'alert', alert });
  notify(`🟢 [${alert.node_name}] resolved: ${alert.message}`);
}

function notify(text) {
  if (!config.alertWebhook) return;
  fetch(config.alertWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text, text }),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => console.warn('[alert] webhook failed:', e.message));
}
