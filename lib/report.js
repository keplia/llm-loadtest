import fs from 'node:fs';
import path from 'node:path';

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('id-ID', { maximumFractionDigits: digits });
}

function pct(n) {
  if (n == null) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function chartSvg(series, key, color, unitLabel) {
  const pts = (series || []).filter((d) => d[key] != null);
  if (pts.length < 2) return '<p class="muted">Data tidak cukup untuk grafik.</p>';
  const W = 1000;
  const H = 240;
  const pad = { l: 56, r: 16, t: 12, b: 28 };
  const maxY = Math.max(...pts.map((d) => d[key]), 1);
  const minT = pts[0].t;
  const maxT = pts[pts.length - 1].t || minT + 1;
  const x = (t) => pad.l + ((t - minT) / Math.max(maxT - minT, 1)) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - (v / maxY) * (H - pad.t - pad.b);
  const poly = pts.map((d) => `${x(d.t).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  const area = `${pad.l},${H - pad.b} ${poly} ${x(pts[pts.length - 1].t).toFixed(1)},${H - pad.b}`;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const gy = y(maxY * f);
      return `<line x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${W - pad.r}" y2="${gy.toFixed(1)}" stroke="#2a3342" stroke-width="1"/>
      <text x="${pad.l - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" fill="#7d8a9c" font-size="11">${fmt(maxY * f, 0)}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unitLabel)}">
    <defs><linearGradient id="g-${key}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <polygon points="${area}" fill="url(#g-${key})"/>
    <polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2"/>
    <text x="${W - pad.r}" y="${H - 8}" text-anchor="end" fill="#7d8a9c" font-size="11">${esc(unitLabel)}</text>
  </svg>`;
}

function kpi(label, value, sub = '') {
  return `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${
    sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''
  }</div>`;
}

export function renderReport(result) {
  const r = result;
  const cfg = r.config || {};
  const m = r.metrics || {};
  const k6 = r.k6 || {};
  const lat = k6.duration || m.latency || {};
  const ttfb = k6.waiting || m.ttfb || {};
  const statuses = m.statusCounts || {};
  const series = r.series || [];

  const statusRows = Object.entries(statuses)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([code, count]) => `<tr><td><span class="tag ${code === '200' ? 'ok' : code === '429' ? 'warn' : 'bad'}">${esc(code)}</span></td><td>${fmt(count)}</td><td>${pct(count / (m.total || 1))}</td></tr>`)
    .join('');

  const verdict =
    r.limit && r.limit.limitRPM != null
      ? `Rate limit mulai terlihat di sekitar <b>${fmt(r.limit.limitRPM)} RPM</b>; rate stabil tertinggi ± <b>${fmt(r.limit.sustainableRPM)} RPM</b>.`
      : r.advertisedRPM
        ? `Tidak ada penolakan 429 yang signifikan. RPM tercapai <b>${fmt(r.achievedRPM)}</b> dari kuota yang diumumkan <b>${fmt(r.advertisedRPM)}</b>.`
        : `RPM tercapai <b>${fmt(r.achievedRPM)}</b> tanpa penolakan 429 yang signifikan.`;

  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Laporan ${esc(r.id)} · LLM Load Test</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1120px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:22px;margin:0 0 4px}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin:32px 0 12px}
  .muted{color:#8b949e}
  .badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid}
  .badge.done{color:#3fb950;border-color:#238636;background:#12261a}
  .badge.failed{color:#f85149;border-color:#8b2c2c;background:#2a1414}
  .badge.stopped{color:#d29922;border-color:#7a5800;background:#2a2312}
  .verdict{margin-top:14px;padding:14px 16px;border:1px solid #30363d;border-left:4px solid #58a6ff;border-radius:8px;background:#111826}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .kpi{padding:14px 16px;border:1px solid #21262d;border-radius:10px;background:#11161d}
  .kpi-label{font-size:12px;color:#8b949e}
  .kpi-value{font-size:24px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums}
  .kpi-sub{font-size:11px;color:#6e7681;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #21262d}
  th{font-size:12px;color:#8b949e;font-weight:600}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  svg{width:100%;height:auto;background:#0f141b;border:1px solid #21262d;border-radius:10px}
  .tag{padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
  .tag.ok{background:#12261a;color:#3fb950}.tag.warn{background:#2a2312;color:#d29922}.tag.bad{background:#2a1414;color:#f85149}
  code{background:#161b22;border:1px solid #21262d;padding:1px 6px;border-radius:5px;font-size:12px}
  .foot{margin-top:40px;color:#6e7681;font-size:12px}
  @media(max-width:760px){.grid2{grid-template-columns:1fr}}
</style></head>
<body><div class="wrap">
  <div class="muted">LLM Load Test · laporan k6</div>
  <h1>${esc(cfg.model || 'model')} <span class="badge ${esc(r.status)}">${esc(r.status)}</span></h1>
  <div class="muted">${esc(r.id)} · ${esc(new Date(r.startedAt || r.createdAt).toLocaleString('id-ID'))} · durasi ${fmt(r.elapsedSec, 1)}s</div>
  <div class="verdict">${verdict}</div>

  <h2>Ringkasan</h2>
  <div class="kpis">
    ${kpi('RPM tercapai (avg)', fmt(r.achievedRPM), `target ${esc(JSON.stringify(r.target))}`)}
    ${kpi('RPM kuota diumumkan', fmt(r.advertisedRPM), 'dari /v1/models')}
    ${kpi('RPM stabil tertinggi', fmt(r.limit?.sustainableRPM), 'error ≤ 2% dalam 5s')}
    ${kpi('Titik 429 pertama', fmt(r.limit?.limitRPM), 'error > 5%')}
    ${kpi('Total request', fmt(k6.httpReqs?.count ?? m.total))}
    ${kpi('Success rate', pct(m.successRate))}
    ${kpi('p95 latency', lat['p(95)'] != null ? `${fmt(lat['p(95)'])} ms` : '—')}
    ${kpi('p95 TTFB', ttfb['p(95)'] != null ? `${fmt(ttfb['p(95)'])} ms` : '—')}
    ${kpi('Token / detik', fmt(m.tokens?.perSec, 1))}
    ${kpi('Dropped iterations', fmt(k6.dropped ?? m.dropped), 'iterasi gagal dijadwalkan')}
  </div>

  <h2>Request rate (RPM per detik)</h2>
  ${chartSvg(series, 'rpm', '#58a6ff', 'RPM (rata-rata per detik)')}

  <div class="grid2">
    <div>
      <h2>Latency</h2>
      <table><thead><tr><th>Metrik</th><th>Avg</th><th>p50</th><th>p95</th><th>p99</th><th>Max</th></tr></thead><tbody>
        <tr><td>Request</td><td>${fmt(lat.avg)}</td><td>${fmt(lat.med)}</td><td>${fmt(lat['p(95)'])}</td><td>${fmt(lat['p(99)'])}</td><td>${fmt(lat.max)}</td></tr>
        <tr><td>TTFB</td><td>${fmt(ttfb.avg)}</td><td>${fmt(ttfb.med)}</td><td>${fmt(ttfb['p(95)'])}</td><td>${fmt(ttfb['p(99)'])}</td><td>${fmt(ttfb.max)}</td></tr>
      </tbody></table>
      <div class="muted" style="font-size:12px;margin-top:6px">satuan milidetik</div>
    </div>
    <div>
      <h2>Status code</h2>
      <table><thead><tr><th>Status</th><th>Jumlah</th><th>Porsi</th></tr></thead><tbody>${statusRows || '<tr><td colspan="3">—</td></tr>'}</tbody></table>
    </div>
  </div>

  <h2>Konfigurasi</h2>
  <table><tbody>
    <tr><th>Provider</th><td><code>${esc(cfg.baseURL)}${esc(cfg.endpoint || '')}</code></td></tr>
    <tr><th>Model</th><td><code>${esc(cfg.model)}</code></td></tr>
    <tr><th>Mode</th><td>${esc(cfg.mode)}</td></tr>
    <tr><th>Target</th><td>${esc(JSON.stringify(r.target))}</td></tr>
    <tr><th>Max tokens</th><td>${esc(cfg.maxTokens)}</td></tr>
    <tr><th>Prompt</th><td>${esc(cfg.prompt)}</td></tr>
    <tr><th>API key</th><td>${cfg.hasApiKey ? 'disembunyikan' : '—'}</td></tr>
    ${r.lastError ? `<tr><th>Error terakhir</th><td><code>HTTP ${esc(r.lastError.status)}</code> ${esc(r.lastError.body)}</td></tr>` : ''}
  </tbody></table>

  <div class="foot">Dibuat ${esc(new Date().toLocaleString('id-ID'))} · k6 · LLM Load Test</div>
</div></body></html>`;
}
