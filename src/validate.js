// Pure input sanitising for agent pushes. Never trust the agent payload.

const MAX_BIG = Number.MAX_SAFE_INTEGER;

export function num(v, min = 0, max = MAX_BIG) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

const int = (v, min, max) => {
  const n = num(v, min, max);
  return n === null ? null : Math.round(n);
};

export function str(v, max = 128) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return s || null;
}

export function pct(used, total) {
  if (used === null || used === undefined || !total) return null;
  return Math.round((1000 * used) / total) / 10;
}

export function sanitizeSample(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('body must be a JSON object');

  const disks = (Array.isArray(b.disks) ? b.disks.slice(0, 32) : [])
    .map((d) => {
      const total = int(d?.total, 0, MAX_BIG);
      const used = int(d?.used, 0, MAX_BIG);
      return { mount: str(d?.mount, 128) ?? '?', total, used: used === null || total === null ? null : Math.min(used, total) };
    })
    .filter((d) => d.total > 0 && d.used !== null);

  const s = {
    cpu: num(b.cpu, 0, 100),
    load1: num(b.load1, 0, 1e6),
    mem_total: int(b.mem_total, 0, MAX_BIG),
    mem_used: int(b.mem_used, 0, MAX_BIG),
    swap_total: int(b.swap_total, 0, MAX_BIG),
    swap_used: int(b.swap_used, 0, MAX_BIG),
    net_rx: num(b.net_rx, 0, 1e12),
    net_tx: num(b.net_tx, 0, 1e12),
    procs: int(b.procs, 0, 1e7),
    uptime: int(b.uptime, 0, 1e10),
    hostname: str(b.hostname),
    os: str(b.os),
    kernel: str(b.kernel),
    agent_version: str(b.agent_version, 32),
    disks,
  };
  if (s.mem_used !== null && s.mem_total !== null) s.mem_used = Math.min(s.mem_used, s.mem_total);
  if (s.swap_used !== null && s.swap_total !== null) s.swap_used = Math.min(s.swap_used, s.swap_total);

  s.disk_total = disks.length ? disks.reduce((a, d) => a + d.total, 0) : null;
  s.disk_used = disks.length ? disks.reduce((a, d) => a + d.used, 0) : null;
  // Alert on the fullest volume, not the fleet average.
  s.disk_pct = disks.length ? Math.max(...disks.map((d) => pct(d.used, d.total))) : null;
  s.mem_pct = pct(s.mem_used, s.mem_total);
  s.swap_pct = pct(s.swap_used, s.swap_total);
  return s;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;
export function validName(v) {
  return typeof v === 'string' && NAME_RE.test(v.trim()) ? v.trim() : null;
}
