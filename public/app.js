// Node Monitor web UI. No framework, no build step.
// All agent/user-supplied text goes through textContent (h()), never innerHTML.

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    // CSSOM, not the style attribute: CSP style-src 'self' blocks inline style attributes.
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

// ---------- formatting ----------

const fmtPct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);
function fmtBytes(b, digits = 1) {
  if (b === null || b === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}
const fmtRate = (b) => (b === null || b === undefined ? '—' : `${fmtBytes(b)}/s`);
function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '—';
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400); const hr = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}
function fmtAgo(ts) {
  if (!ts) return 'never';
  const sec = (Date.now() - new Date(ts).getTime()) / 1000;
  return sec < 5 ? 'just now' : `${fmtDuration(sec)} ago`;
}
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const level = (v) => (v >= 90 ? 'crit' : v >= 75 ? 'warn' : '');

// ---------- API ----------

class AuthError extends Error {}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !opts.allow401) { showLogin('Your session expired. Enter your access token again.'); throw new AuthError('signed out'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ---------- state ----------

const state = {
  me: null,
  nodes: new Map(),
  openAlerts: 0,
  view: null,          // { name, cleanup?, onSample?, onTick? }
  es: null,
};

// ---------- login / session ----------

function showLogin(message = '') {
  stopStream();
  state.me = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = message;
  $('#login-token').value = '';
  $('#login-token').focus();
}

async function boot() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#login-form button');
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { token: $('#login-token').value }, allow401: true });
      $('#login-token').value = '';
      await start();
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', allow401: true }).catch(() => {});
    showLogin('Signed out.');
  });
  window.addEventListener('hashchange', () => state.me && route());

  try {
    await start();
  } catch (e) {
    if (!(e instanceof AuthError)) showLogin(e.message);
  }
}

async function start() {
  const me = await api('/api/me', { allow401: true }).catch(() => null);
  if (!me || me.error) { showLogin(); return; }
  state.me = me;
  $('#login-days').textContent = me.session_days;
  $('#login').hidden = true;
  $('#app').hidden = false;
  updateSessionLeft();
  // Offline threshold lives in the rules; client-side status must match the hub.
  const [rules] = await Promise.all([api('/api/rules').catch(() => []), loadNodes()]);
  const off = rules.find((r) => r.metric === 'offline' && r.enabled);
  state.offlineAfter = off ? off.threshold : 1e9;
  startStream();
  route();
}

function updateSessionLeft() {
  if (!state.me) return;
  const left = (new Date(state.me.expires_at) - Date.now()) / 1000;
  if (left <= 0) { showLogin('Your session expired. Enter your access token again.'); return; }
  $('#session-left').textContent = `Session ends in ${fmtDuration(left)}`;
  $('#session-left').title = `Signed in with "${state.me.token_label}" until ${fmtTime(state.me.expires_at)}`;
}

// ---------- data + live stream ----------

async function loadNodes() {
  const list = await api('/api/nodes');
  state.nodes = new Map(list.map((n) => [n.id, n]));
  updateAlertBadge();
}

function updateAlertBadge() {
  state.openAlerts = [...state.nodes.values()].reduce((a, n) => a + (n.open_alerts || 0), 0);
  const b = $('#alert-badge');
  b.hidden = state.openAlerts === 0;
  b.textContent = state.openAlerts;
  b.setAttribute('aria-label', `${state.openAlerts} open alerts`);
}

function setLive(on) {
  $('#live').className = `live ${on ? 'on' : 'off'}`;
  $('#live-text').textContent = on ? 'Live' : 'Reconnecting';
}

function startStream() {
  stopStream();
  const es = new EventSource('/api/events');
  state.es = es;
  es.onopen = () => setLive(true);
  es.onerror = async () => {
    setLive(false);
    // Stream ends when the session expires or the token is revoked: check before auto-retrying.
    const me = await api('/api/me', { allow401: true }).catch(() => null);
    if (!me || me.error) showLogin('Your session expired. Enter your access token again.');
  };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'sample') {
      const prev = state.nodes.get(ev.node.id);
      const node = { ...prev, ...ev.node, open_alerts: prev?.open_alerts ?? 0, spark: prev?.spark ?? { cpu: [], mem: [] } };
      node.spark = {
        cpu: [...node.spark.cpu, node.last?.cpu ?? null].slice(-60),
        mem: [...node.spark.mem, node.last?.mem_pct ?? null].slice(-60),
      };
      state.nodes.set(node.id, node);
      state.view?.onSample?.(node, ev.t);
    } else if (ev.type === 'alert' || ev.type === 'nodes') {
      loadNodes().then(() => state.view?.onRefresh?.()).catch(() => {});
      if (ev.type === 'alert' && !ev.alert.resolved_at) toast(`Alert on ${ev.alert.node_name}: ${ev.alert.message}`, true);
    } else if (ev.type === 'tick') {
      updateSessionLeft();
      state.view?.onTick?.();
    }
  };
}

function stopStream() {
  state.es?.close();
  state.es = null;
}

// Offline status is computed client-side between pushes so cards flip without a reload.
function liveStatus(n) {
  if (!n.last_seen) return 'pending';
  const off = state.offlineAfter ?? 20;
  return (Date.now() - new Date(n.last_seen).getTime()) / 1000 > off ? 'offline' : 'online';
}

// ---------- router ----------

function route() {
  state.view?.cleanup?.();
  state.view = null;
  const hash = location.hash.replace(/^#/, '') || '/';
  const main = $('#main');
  main.replaceChildren();
  let nav = 'fleet';
  let m;
  if ((m = /^\/node\/(\d+)$/.exec(hash))) state.view = viewNode(main, Number(m[1]));
  else if (hash === '/alerts') { nav = 'alerts'; state.view = viewAlerts(main); }
  else if (hash === '/settings') { nav = 'settings'; state.view = viewSettings(main); }
  else state.view = viewFleet(main);
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// ---------- fleet ----------

function meter(name, value, title) {
  return h('div', { class: 'meter-row', title },
    h('span', { class: 'name' }, name),
    h('div', { class: 'bar', role: 'meter', 'aria-label': name, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': value ?? 0 },
      h('span', { class: level(value), style: `width:${Math.min(100, value ?? 0)}%` })),
    h('span', { class: 'val' }, fmtPct(value)));
}

function sparkline(cpu, mem) {
  const W = 300; const H = 36;
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  for (const [vals, color] of [[mem, 'var(--mem)'], [cpu, 'var(--cpu)']]) {
    const pts = vals.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
    if (pts.length < 2) continue;
    const n = Math.max(vals.length - 1, 1);
    const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${((i / n) * W).toFixed(1)},${(H - 2 - (v / 100) * (H - 4)).toFixed(1)}`).join('');
    svg.append(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
  }
  return svg;
}

function nodeCard(n) {
  const st = liveStatus(n);
  const L = n.last || {};
  const memTitle = L.mem_total ? `${fmtBytes(L.mem_used)} of ${fmtBytes(L.mem_total)}` : '';
  const diskTitle = (L.disks || []).map((d) => `${d.mount}: ${fmtBytes(d.used)} / ${fmtBytes(d.total)}`).join('\n');
  return h('a', {
    class: `card ${st}${n.open_alerts ? ' alerting' : ''}`, href: `#/node/${n.id}`, 'data-id': n.id,
    'aria-label': `${n.name}, ${st}${n.open_alerts ? `, ${n.open_alerts} open alerts` : ''}`,
  },
  h('div', { class: 'card-head' },
    h('h3', {}, n.name),
    n.open_alerts ? h('span', { class: 'alert-pill' }, `${n.open_alerts} alert${n.open_alerts > 1 ? 's' : ''}`) : null,
    h('span', { class: `status ${st}` }, st)),
  h('div', { class: 'card-sub' }, n.last_seen ? `${n.hostname || '?'} · ${n.os || '?'} · ${n.ip || ''}` : 'Waiting for first push from agent'),
  n.last_seen ? [
    h('div', { class: 'meters' },
      meter('CPU', L.cpu),
      meter('Mem', L.mem_pct, memTitle),
      meter('Disk', L.disk_pct, diskTitle)),
    sparkline(n.spark?.cpu || [], n.spark?.mem || []),
    h('div', { class: 'card-foot' },
      h('span', {}, '↓ ', h('b', {}, fmtRate(L.net_rx))),
      h('span', {}, '↑ ', h('b', {}, fmtRate(L.net_tx))),
      L.load1 !== null && L.load1 !== undefined ? h('span', {}, 'load ', h('b', {}, Number(L.load1).toFixed(2))) : null,
      h('span', {}, 'up ', h('b', {}, fmtDuration(L.uptime))),
      h('span', { class: 'seen', style: 'margin-left:auto' }, fmtAgo(n.last_seen))),
  ] : h('p', { class: 'muted small' }, 'Install the agent with the command from Settings → Nodes.'));
}

function viewFleet(main) {
  const summary = h('div', { class: 'summary' });
  const grid = h('div', { class: 'grid' });
  main.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Fleet'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: () => addNodeDialog() }, '+ Add node')),
    summary, grid);

  function renderSummary() {
    const nodes = [...state.nodes.values()];
    const online = nodes.filter((n) => liveStatus(n) === 'online').length;
    const offline = nodes.filter((n) => liveStatus(n) === 'offline').length;
    const stat = (label, value, cls = '') => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: `stat-value ${cls}` }, value));
    summary.replaceChildren(
      stat('Nodes', nodes.length),
      stat('Online', online, online ? 'ok' : ''),
      stat('Offline', offline, offline ? 'bad' : ''),
      stat('Open alerts', state.openAlerts, state.openAlerts ? 'bad' : ''));
  }

  function render() {
    renderSummary();
    const nodes = [...state.nodes.values()];
    if (!nodes.length) {
      grid.replaceChildren(h('div', { class: 'empty', style: 'grid-column:1/-1' },
        h('h2', {}, 'No nodes yet'),
        h('p', {}, 'Add a node to get its install command. The agent runs from cron and pushes metrics every 5 seconds over your LAN or Tailscale.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => addNodeDialog() }, '+ Add your first node')));
      return;
    }
    // Problems first, then by name.
    const rank = (n) => (liveStatus(n) === 'offline' ? 0 : n.open_alerts ? 1 : liveStatus(n) === 'pending' ? 3 : 2);
    nodes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    grid.replaceChildren(...nodes.map(nodeCard));
  }

  render();
  return {
    onSample(node) {
      const old = grid.querySelector(`[data-id="${node.id}"]`);
      if (old && old.classList.contains(liveStatus(node))) old.replaceWith(nodeCard(node));
      else render();
      renderSummary();
    },
    onTick: render,
    onRefresh: render,
  };
}

// ---------- line chart ----------

function lineChart(container, { series, max = null, fmt, span }) {
  let points = [];
  let tEnd = Date.now();
  const W = 600; const H = 180; const PL = 44; const PR = 8; const PT = 8; const PB = 20;

  function scaleMax() {
    if (max !== null) return max;
    let m = 0;
    for (const p of points) for (const se of series) if (p[se.key] > m) m = p[se.key];
    if (m <= 0) return 1;
    const pow = 1024 ** Math.floor(Math.log(m) / Math.log(1024));
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((x) => x * pow * 4 >= m) || 1000;
    return step * pow * 4;
  }

  function draw() {
    container.replaceChildren();
    if (!points.length) { container.append(h('div', { class: 'chart-empty' }, 'No data in this range')); return; }
    const t0 = tEnd - span * 1000; const top = scaleMax();
    const x = (t) => PL + ((t - t0) / (span * 1000)) * (W - PL - PR);
    const y = (v) => PT + (1 - Math.min(v, top) / top) * (H - PT - PB);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
    for (let i = 0; i <= 4; i++) {
      const v = (top / 4) * i;
      svg.append(s('line', { class: 'grid-line', x1: PL, x2: W - PR, y1: y(v), y2: y(v), 'vector-effect': 'non-scaling-stroke' }));
      svg.append(s('text', { class: 'axis', x: PL - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmt(v, true)));
    }
    for (let i = 0; i <= 3; i++) {
      const t = t0 + (span * 1000 * i) / 3;
      const d = new Date(t);
      const lbl = span > 86400 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      svg.append(s('text', { class: 'axis', x: x(t), y: H - 4, 'text-anchor': i === 0 ? 'start' : i === 3 ? 'end' : 'middle' }, lbl));
    }
    // Break lines across gaps (node offline) wider than 3 buckets.
    const gap = Math.max(15_000, (span * 1000) / 240);
    for (const se of series) {
      let d = ''; let prevT = null;
      for (const p of points) {
        const v = p[se.key];
        if (v === null || v === undefined) { prevT = null; continue; }
        d += `${prevT === null || p.t - prevT > gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
        prevT = p.t;
      }
      svg.append(s('path', { d, fill: 'none', stroke: se.color, 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
    }
    const label = series.map((se) => {
      const last = points.at(-1)?.[se.key];
      return `${se.label} ${last === null || last === undefined ? 'no data' : fmt(last)}`;
    }).join(', ');
    svg.setAttribute('aria-label', `Latest: ${label}`);
    const cursor = s('line', { class: 'cursor', y1: PT, y2: H - PB, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
    svg.append(cursor);
    const tip = h('div', { class: 'tip', hidden: true });
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const t = t0 + (((e.clientX - r.left) / r.width) * W - PL) / (W - PL - PR) * span * 1000;
      let best = null;
      for (const p of points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      if (!best) return;
      cursor.setAttribute('x1', x(best.t)); cursor.setAttribute('x2', x(best.t)); cursor.setAttribute('visibility', 'visible');
      tip.replaceChildren(h('div', { class: 'muted' }, new Date(best.t).toLocaleString()),
        ...series.map((se) => h('div', {}, h('span', { style: `color:${se.color}` }, '● '), `${se.label} ${best[se.key] === null ? '—' : fmt(best[se.key])}`)));
      tip.hidden = false;
      const px = (x(best.t) / W) * r.width;
      tip.style.left = `${Math.min(Math.max(px + 10, 0), r.width - 170)}px`;
    });
    svg.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    container.append(svg, tip);
  }

  return {
    set(pts) { points = pts; tEnd = Date.now(); draw(); },
    push(p) {
      tEnd = Date.now();
      points.push(p);
      const cutoff = tEnd - span * 1000;
      while (points.length && points[0].t < cutoff) points.shift();
      draw();
    },
  };
}

// ---------- node detail ----------

function viewNode(main, id) {
  let node = state.nodes.get(id);
  let range = '1h';
  let charts = {};
  const facts = h('dl', { class: 'facts' });
  const head = h('div', { class: 'page-head' });
  const chartsEl = h('div', { class: 'charts' });
  const disksEl = h('div', { class: 'section' });
  const alertsEl = h('div', { class: 'section' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
  main.append(h('a', { class: 'crumb', href: '#/' }, '← Fleet'), head, facts, chartsEl, disksEl, alertsEl);

  if (!node) {
    head.append(h('h1', {}, 'Node not found'));
    return {};
  }

  const RANGES = [['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400], ['7d', 604800], ['30d', 2592000]];
  for (const [r] of RANGES) {
    seg.append(h('button', { type: 'button', 'aria-pressed': String(r === range), onclick: () => { range = r; load(); } }, r));
  }

  function renderHead() {
    const st = liveStatus(node);
    head.replaceChildren(h('h1', {}, node.name), h('span', { class: `status ${st}`, style: 'margin-left:0' }, st),
      h('span', { class: 'spacer' }), seg);
    const L = node.last || {};
    const fact = (k, v, title) => h('div', { class: 'fact', title: title || (typeof v === 'string' ? v : '') }, h('dt', {}, k), h('dd', {}, v ?? '—'));
    facts.replaceChildren(
      fact('Hostname', node.hostname), fact('OS', node.os), fact('Kernel', L.kernel), fact('IP', node.ip),
      fact('Uptime', fmtDuration(L.uptime)), fact('Processes', L.procs),
      fact('Memory', L.mem_total ? `${fmtBytes(L.mem_used)} / ${fmtBytes(L.mem_total)}` : '—'),
      fact('Last push', fmtAgo(node.last_seen), fmtTime(node.last_seen)), fact('Agent', node.agent_version));
    disksEl.replaceChildren(h('h2', {}, 'Volumes'),
      (L.disks || []).length
        ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Mount'), h('th', {}, 'Usage'), h('th', { class: 'num' }, 'Used'), h('th', { class: 'num' }, 'Total'))),
          h('tbody', {}, L.disks.map((d) => {
            const p = d.total ? (100 * d.used) / d.total : 0;
            return h('tr', {}, h('td', { class: 'mono' }, d.mount),
              h('td', { style: 'min-width:160px' }, h('div', { class: 'bar' }, h('span', { class: level(p), style: `width:${p}%` }))),
              h('td', { class: 'num' }, `${fmtBytes(d.used)} (${p.toFixed(1)}%)`), h('td', { class: 'num' }, fmtBytes(d.total)));
          }))))
        : h('p', { class: 'muted' }, 'No volume data yet.'));
  }

  function chartCard(title, legend, nowText) {
    const body = h('div', { class: 'chart' });
    const now = h('span', { class: 'now' }, nowText || '');
    const card = h('section', { class: 'chart-card', 'aria-label': title },
      h('div', { class: 'chart-head' }, h('h3', {}, title),
        h('span', { class: 'legend' }, legend.map(([l, c]) => h('span', {}, h('i', { style: `background:${c}` }), l))), now),
      body);
    chartsEl.append(card);
    return { body, now };
  }

  async function load() {
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.textContent === range));
    const data = await api(`/api/nodes/${id}/metrics?range=${range}`);
    const span = data.span;
    chartsEl.replaceChildren();
    const pctFmt = (v, axis) => (axis ? `${Math.round(v)}%` : fmtPct(v));
    const rateFmt = (v, axis) => (axis ? fmtBytes(v, 0) : fmtRate(v));
    const c1 = chartCard('CPU', [['CPU', 'var(--cpu)']]);
    const c2 = chartCard('Memory', [['RAM', 'var(--mem)'], ['Swap', 'var(--warn)']]);
    const c3 = chartCard('Network', [['In', 'var(--rx)'], ['Out', 'var(--tx)']]);
    const c4 = chartCard('Disk (fullest volume)', [['Disk', 'var(--disk)']]);
    charts = {
      cpu: [lineChart(c1.body, { series: [{ key: 'cpu', label: 'CPU', color: 'var(--cpu)' }], max: 100, fmt: pctFmt, span }), c1.now, (p) => fmtPct(p.cpu)],
      mem: [lineChart(c2.body, { series: [{ key: 'mem', label: 'RAM', color: 'var(--mem)' }, { key: 'swap', label: 'Swap', color: 'var(--warn)' }], max: 100, fmt: pctFmt, span }), c2.now, (p) => fmtPct(p.mem)],
      net: [lineChart(c3.body, { series: [{ key: 'rx', label: 'In', color: 'var(--rx)' }, { key: 'tx', label: 'Out', color: 'var(--tx)' }], fmt: rateFmt, span }), c3.now, (p) => `↓ ${fmtRate(p.rx)}  ↑ ${fmtRate(p.tx)}`],
      disk: [lineChart(c4.body, { series: [{ key: 'disk', label: 'Disk', color: 'var(--disk)' }], max: 100, fmt: pctFmt, span }), c4.now, (p) => fmtPct(p.disk)],
      live: data.bucket <= 5,
    };
    for (const [k, v] of Object.entries(charts)) {
      if (k === 'live') continue;
      v[0].set(data.points);
      const last = data.points.at(-1);
      if (last) v[1].textContent = v[2](last);
    }
  }

  async function loadAlerts() {
    const rows = await api(`/api/alerts?node=${id}`);
    alertsEl.replaceChildren(h('h2', {}, 'Alerts'), alertTable(rows.slice(0, 20), false));
  }

  renderHead();
  load().catch((e) => e instanceof AuthError || toast(e.message, true));
  loadAlerts().catch(() => {});

  return {
    onSample(n, t) {
      if (n.id !== id) return;
      node = n;
      renderHead();
      if (!charts.live) return;
      const L = n.last || {};
      const p = {
        t, cpu: L.cpu, load1: L.load1, mem: L.mem_pct, swap: L.swap_total ? L.swap_pct : null,
        disk: L.disk_pct, rx: L.net_rx, tx: L.net_tx,
      };
      for (const [k, v] of Object.entries(charts)) {
        if (k === 'live') continue;
        v[0].push(p);
        v[1].textContent = v[2](p);
      }
    },
    onTick() { node = state.nodes.get(id) || node; renderHead(); },
    onRefresh() {
      node = state.nodes.get(id);
      if (!node) { location.hash = '#/'; return; }
      renderHead(); loadAlerts().catch(() => {});
    },
  };
}

// ---------- alerts ----------

function alertTable(rows, withNode = true) {
  if (!rows.length) return h('p', { class: 'muted' }, 'No alerts. All quiet.');
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'State'), withNode ? h('th', {}, 'Node') : null, h('th', {}, 'Alert'),
      h('th', {}, 'Opened'), h('th', {}, 'Duration'))),
    h('tbody', {}, rows.map((a) => {
      const end = a.resolved_at ? new Date(a.resolved_at) : new Date();
      return h('tr', { class: a.resolved_at ? 'dim' : '' },
        h('td', {}, h('span', { class: `tag ${a.resolved_at ? 'resolved' : 'open'}` }, a.resolved_at ? 'Resolved' : 'Open')),
        withNode ? h('td', {}, h('a', { href: `#/node/${a.node_id}` }, a.node_name)) : null,
        h('td', {}, a.message),
        h('td', {}, fmtTime(a.opened_at)),
        h('td', {}, fmtDuration((end - new Date(a.opened_at)) / 1000)));
    }))));
}

function viewAlerts(main) {
  const body = h('div', {});
  main.append(h('div', { class: 'page-head' }, h('h1', {}, 'Alerts')), body);
  const load = () => api('/api/alerts').then((rows) => body.replaceChildren(alertTable(rows))).catch((e) => e instanceof AuthError || toast(e.message, true));
  load();
  return { onRefresh: load };
}

// ---------- dialogs ----------

function openDialog(title, content, actions) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-content').replaceChildren(...[content].flat());
  $('#dialog-actions').replaceChildren(...actions);
  if (!dlg.open) dlg.showModal();
  return dlg;
}
const closeDialog = () => $('#dialog').close();

function secretRow(value, label) {
  const code = h('code', { tabindex: 0, 'aria-label': label }, value);
  return h('div', { class: 'secret' }, code,
    h('button', {
      class: 'btn small', type: 'button',
      onclick: async (e) => {
        try { await navigator.clipboard.writeText(value); e.currentTarget.textContent = 'Copied'; } catch { toast('Copy failed: select the text manually', true); }
      },
    }, 'Copy'));
}

function confirmDialog(title, message, confirmLabel, onConfirm) {
  openDialog(title, h('p', {}, message), [
    h('button', { class: 'btn ghost', type: 'button', onclick: closeDialog }, 'Cancel'),
    h('button', {
      class: 'btn danger', type: 'button',
      onclick: async () => { try { await onConfirm(); closeDialog(); } catch (e) { if (!(e instanceof AuthError)) toast(e.message, true); } },
    }, confirmLabel),
  ]);
}

function showInstall(r, title) {
  openDialog(title, [
    h('p', {}, `Node "${r.name}" is ready. Run one command on that machine as root / Administrator. It installs the agent, schedules it every minute (12 pushes × 5 s) and does a test push.`),
    h('div', { class: 'callout' }, 'This token is shown once. It is stored only as a hash on the hub.'),
    h('div', {}, h('label', {}, 'Linux (cron)'), secretRow(r.install.linux, 'Linux install command')),
    h('div', {}, h('label', {}, 'Windows (Task Scheduler, elevated PowerShell)'), secretRow(r.install.windows, 'Windows install command')),
    h('div', {}, h('label', {}, 'Node token'), secretRow(r.token, 'Node token')),
    h('p', { class: 'muted small' }, `Hub URL in these commands: ${state.me.hub_url}. If nodes reach the hub by a different address (e.g. Tailscale name), set PUBLIC_URL in .env.`),
  ], [h('button', { class: 'btn primary', type: 'button', onclick: closeDialog }, 'Done')]);
}

function addNodeDialog() {
  const input = h('input', { type: 'text', id: 'node-name', required: true, maxlength: 63, placeholder: 'e.g. web-01', autocomplete: 'off' });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const submit = async () => {
    try {
      const r = await api('/api/nodes', { method: 'POST', body: { name: input.value } });
      showInstall(r, 'Install agent');
    } catch (e) { if (!(e instanceof AuthError)) err.textContent = e.message; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  openDialog('Add node', [h('div', {}, h('label', { for: 'node-name' }, 'Node name'), input, err)], [
    h('button', { class: 'btn ghost', type: 'button', onclick: closeDialog }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Create'),
  ]);
  input.focus();
}

// ---------- settings ----------

function viewSettings(main) {
  const nodesEl = h('section', { class: 'section' });
  const tokensEl = h('section', { class: 'section' });
  const rulesEl = h('section', { class: 'section' });
  const infoEl = h('section', { class: 'section' });
  main.append(h('div', { class: 'page-head' }, h('h1', {}, 'Settings')), nodesEl, tokensEl, rulesEl, infoEl);

  function renderNodes() {
    const nodes = [...state.nodes.values()].sort((a, b) => a.name.localeCompare(b.name));
    nodesEl.replaceChildren(
      h('div', { class: 'page-head', style: 'margin-bottom:12px' }, h('h2', {}, 'Nodes'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary small', type: 'button', onclick: () => addNodeDialog() }, '+ Add node')),
      nodes.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Status'), h('th', {}, 'Token'), h('th', {}, 'Last push'), h('th', {}, ''))),
        h('tbody', {}, nodes.map((n) => h('tr', {},
          h('td', {}, h('a', { href: `#/node/${n.id}` }, n.name)),
          h('td', {}, h('span', { class: `status ${liveStatus(n)}`, style: 'margin-left:0' }, liveStatus(n))),
          h('td', { class: 'mono' }, n.token_hint),
          h('td', {}, fmtAgo(n.last_seen)),
          h('td', { class: 'actions' },
            h('button', {
              class: 'btn small', type: 'button',
              onclick: () => confirmDialog('Rotate node token?', `The agent on "${n.name}" stops pushing until you reinstall it with the new command.`, 'Rotate',
                async () => { const r = await api(`/api/nodes/${n.id}/rotate`, { method: 'POST' }); setTimeout(() => showInstall(r, 'New install command'), 0); }),
            }, 'Rotate token'),
            h('button', {
              class: 'btn small danger', type: 'button',
              onclick: () => confirmDialog('Delete node?', `Deletes "${n.name}" and all its history and alerts. This cannot be undone.`, 'Delete',
                async () => { await api(`/api/nodes/${n.id}`, { method: 'DELETE' }); toast(`Deleted ${n.name}`); }),
            }, 'Delete'))))))) : h('p', { class: 'muted' }, 'No nodes yet.'));
  }

  async function renderTokens() {
    const rows = await api('/api/tokens');
    tokensEl.replaceChildren(
      h('div', { class: 'page-head', style: 'margin-bottom:12px' }, h('h2', {}, 'Access tokens'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary small', type: 'button', onclick: newTokenDialog }, '+ New token')),
      h('p', { class: 'muted small', style: 'margin-top:-6px' },
        `Tokens never expire. Revoke one to sign out its sessions right away. Every browser session lasts ${state.me.session_days} days, then the token must be entered again.`),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Label'), h('th', {}, 'Token'), h('th', {}, 'State'), h('th', {}, 'Created'), h('th', {}, 'Last sign-in'), h('th', { class: 'num' }, 'Sessions'), h('th', {}, ''))),
        h('tbody', {}, rows.map((t) => h('tr', { class: t.revoked_at ? 'dim' : '' },
          h('td', {}, t.label, t.label === state.me.token_label && !t.revoked_at ? h('span', { class: 'muted small' }, ' (this session)') : null),
          h('td', { class: 'mono' }, t.token_hint),
          h('td', {}, h('span', { class: `tag ${t.revoked_at ? 'revoked' : 'active'}` }, t.revoked_at ? 'Revoked' : 'Active')),
          h('td', {}, fmtTime(t.created_at)),
          h('td', {}, fmtTime(t.last_used_at)),
          h('td', { class: 'num' }, t.sessions),
          h('td', { class: 'actions' }, t.revoked_at ? null : h('button', {
            class: 'btn small danger', type: 'button',
            onclick: () => confirmDialog('Revoke token?', `"${t.label}" stops working and every browser signed in with it is signed out.`, 'Revoke',
              async () => {
                const r = await api(`/api/tokens/${t.id}`, { method: 'DELETE' });
                if (r.self) { showLogin('You revoked the token used by this session.'); return; }
                toast(`Revoked ${t.label}`); renderTokens();
              }),
          }, 'Revoke'))))))));
  }

  function newTokenDialog() {
    const input = h('input', { type: 'text', id: 'token-label', required: true, maxlength: 63, placeholder: 'e.g. phone, work laptop', autocomplete: 'off' });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const submit = async () => {
      try {
        const t = await api('/api/tokens', { method: 'POST', body: { label: input.value } });
        openDialog('Token created', [
          h('div', { class: 'callout' }, 'Copy it now. It is shown once and stored only as a hash.'),
          secretRow(t.token, 'New access token'),
          h('p', { class: 'muted small' }, `Never expires until revoked. Sessions opened with it last ${state.me.session_days} days.`),
        ], [h('button', { class: 'btn primary', type: 'button', onclick: closeDialog }, 'Done')]);
        renderTokens();
      } catch (e) { if (!(e instanceof AuthError)) err.textContent = e.message; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    openDialog('New access token', [h('div', {}, h('label', { for: 'token-label' }, 'Label'), input, err)], [
      h('button', { class: 'btn ghost', type: 'button', onclick: closeDialog }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Generate'),
    ]);
    input.focus();
  }

  async function renderRules() {
    const rules = await api('/api/rules');
    const NAMES = { cpu: 'CPU %', mem: 'Memory %', disk: 'Disk % (fullest volume)', swap: 'Swap %', offline: 'Offline (seconds without push)' };
    rulesEl.replaceChildren(h('h2', { style: 'margin-bottom:12px' }, 'Alert rules'),
      h('div', { class: 'table-wrap rules' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Enabled'), h('th', {}, 'Metric'), h('th', {}, 'Threshold'), h('th', {}, 'Sustained for (s)'), h('th', {}, ''))),
        h('tbody', {}, rules.map((r) => {
          const en = h('input', { type: 'checkbox', 'aria-label': `Enable ${NAMES[r.metric]}`, ...(r.enabled ? { checked: true } : {}) });
          const th = h('input', { type: 'number', min: r.metric === 'offline' ? 6 : 0, max: r.metric === 'offline' ? 86400 : 100, step: 1, value: r.threshold, 'aria-label': `${NAMES[r.metric]} threshold` });
          const fs = h('input', { type: 'number', min: 0, max: 86400, step: 5, value: r.for_sec, 'aria-label': `${NAMES[r.metric]} sustained seconds`, ...(r.metric === 'offline' ? { disabled: true } : {}) });
          return h('tr', {}, h('td', {}, en), h('td', {}, NAMES[r.metric] || r.metric),
            h('td', {}, h('span', { class: 'muted' }, r.metric === 'offline' ? '> ' : `${r.op} `), th), h('td', {}, fs),
            h('td', { class: 'actions' }, h('button', {
              class: 'btn small', type: 'button',
              onclick: async () => {
                try {
                  await api(`/api/rules/${r.id}`, { method: 'PUT', body: { threshold: Number(th.value), for_sec: Number(fs.value), enabled: en.checked } });
                  if (r.metric === 'offline') state.offlineAfter = en.checked ? Number(th.value) : 1e9;
                  toast('Rule saved');
                } catch (e) { if (!(e instanceof AuthError)) toast(e.message, true); }
              },
            }, 'Save')));
        })))));
  }

  function renderInfo() {
    const m = state.me;
    infoEl.replaceChildren(h('h2', { style: 'margin-bottom:12px' }, 'Hub'),
      h('dl', { class: 'facts' },
        ...[['Hub URL', m.hub_url], ['Storage', m.timescale ? 'Postgres + TimescaleDB' : 'Postgres'], ['Retention', `${m.retention_days} days`],
          ['Session length', `${m.session_days} days`], ['Session ends', fmtTime(m.expires_at)]]
          .map(([k, v]) => h('div', { class: 'fact', title: v }, h('dt', {}, k), h('dd', {}, v)))));
  }

  renderNodes();
  renderTokens().catch((e) => e instanceof AuthError || toast(e.message, true));
  renderRules().catch(() => {});
  renderInfo();
  return { onRefresh: renderNodes };
}

boot();
