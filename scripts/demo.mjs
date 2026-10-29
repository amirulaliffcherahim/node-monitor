// Demo data: registers a few fake nodes and pushes synthetic metrics every 5 s,
// so you can explore the UI before installing a real agent.
//   npm run demo                                   (hub on http://127.0.0.1:8787)
//   docker compose exec hub node scripts/demo.mjs
//   npm run demo -- --remove                       (delete the demo nodes)
// Demo nodes are named demo-*. Ctrl+C stops the pushes.
import { migrate, pool, q, S } from '../src/db.js';
import { hintOf, newSecret, sha256 } from '../src/auth.js';

const HUB = (process.env.HUB_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, '');
const GiB = 2 ** 30;
const NODES = {
  'demo-web-01': { cpu: 35, mem: 62, disk: 48, os: 'Ubuntu 24.04.1 LTS', memT: 8 },
  'demo-db-01': { cpu: 18, mem: 78, disk: 71, os: 'Debian GNU/Linux 12 (bookworm)', memT: 32 },
  'demo-gpu-box': { cpu: 88, mem: 93, disk: 92, os: 'Fedora Linux 44 (Server Edition)', memT: 64 },
  'demo-win-desk': { cpu: 12, mem: 55, disk: 60, os: 'Microsoft Windows 11 Pro 64-bit', memT: 16, win: true },
};

await migrate();

if (process.argv.includes('--remove')) {
  const r = await q(`DELETE FROM ${S}.nodes WHERE name LIKE 'demo-%' RETURNING id`);
  const ids = r.rows.map((x) => x.id);
  if (ids.length) {
    await q(`DELETE FROM ${S}.metrics WHERE node_id = ANY($1)`, [ids]);
    await q(`DELETE FROM ${S}.alerts WHERE node_id = ANY($1)`, [ids]);
  }
  console.log(`Removed ${ids.length} demo nodes. Restart the hub to clear their cached alert state.`);
  await pool.end();
  process.exit(0);
}

// (Re)issue a token per demo node: tokens are stored hashed, so a fresh one is minted each run.
const tokens = {};
for (const name of Object.keys(NODES)) {
  const token = newSecret('nmn');
  await q(
    `INSERT INTO ${S}.nodes (name, token_hash, token_hint) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET token_hash = EXCLUDED.token_hash, token_hint = EXCLUDED.token_hint`,
    [name, sha256(token), hintOf(token)],
  );
  tokens[name] = token;
}
await pool.end();

let k = 0;
const jitter = (base, amp = 8) => Math.max(0, Math.min(100, base + Math.sin(k / 4 + base) * amp + (Math.random() * 6 - 3)));

async function tick() {
  k++;
  await Promise.all(Object.entries(NODES).map(async ([name, p]) => {
    const memT = p.memT * GiB;
    const dT = 512 * GiB;
    const cpu = jitter(p.cpu);
    const body = {
      agent_version: 'demo', hostname: name, os: p.os, kernel: p.win ? '10.0.26100' : '6.8.0-45-generic',
      cpu, load1: p.win ? null : (cpu / 25),
      mem_total: memT, mem_used: Math.round((memT * jitter(p.mem, 3)) / 100),
      swap_total: 4 * GiB, swap_used: Math.round(GiB * (0.2 + Math.random() * 0.1)),
      net_rx: Math.round(2e5 + Math.random() * 3e6), net_tx: Math.round(1e5 + Math.random() * 8e5),
      procs: 180 + (k % 11), uptime: 86400 * 9 + k * 5,
      disks: p.win
        ? [{ mount: 'C:', total: dT, used: Math.round((dT * p.disk) / 100) }]
        : [{ mount: '/', total: dT, used: Math.round((dT * p.disk) / 100) }, { mount: '/data', total: 2 * dT, used: Math.round(0.4 * dT) }],
    };
    try {
      const r = await fetch(`${HUB}/api/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens[name]}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status !== 204 && r.status !== 429) console.warn(`${name}: HTTP ${r.status}`);
    } catch (e) {
      console.warn(`${name}: hub unreachable at ${HUB} (${e.cause?.code || e.message})`);
    }
  }));
}

console.log(`Pushing demo metrics for ${Object.keys(NODES).length} nodes to ${HUB} every 5 s. Ctrl+C to stop.`);
await tick();
setInterval(tick, 5000);
