const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const LS_KEY = 'llt.settings.v1';

const state = {
  mode: 'arrival',
  models: [],
  currentModel: null,
  runId: null,
  es: null,
  esErrors: 0,
  running: false,
  targetTouched: false,
};

/* ------------------------------------------------------------------ utils */
const fmt = (n, d = 0) =>
  n == null || !isFinite(n)
    ? '—'
    : Number(n).toLocaleString('id-ID', { maximumFractionDigits: d });

const pct = (x) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`);

function compact(n) {
  if (n == null || !isFinite(n)) return '—';
  const units = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [v, s] of units) if (n >= v) return `${(n / v).toFixed(1)}${s}`;
  return fmt(n);
}

function fmtDur(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}j ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtSec(s) {
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${Math.round(s)}s`;
}

const clock = (ts) =>
  ts ? new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

function targetLabel(target) {
  if (!target) return '';
  if (target.mode === 'arrival') return `target ${fmt(target.rpm)} RPM · ${target.durationSec}s`;
  if (target.mode === 'vus') return `${fmt(target.vus)} virtual user · ${target.durationSec}s`;
  if (target.mode === 'ramp') return `ramp ${fmt(target.startRPM)} → ${fmt(target.endRPM)} RPM · ${target.steps}×${target.stepSec}s`;
  return '';
}

function targetRPMOf(obj) {
  const t = obj?.target;
  if (!t) return null;
  if (t.mode === 'arrival' && t.rpm != null) return t.rpm;
  return null;
}

/* ------------------------------------------------------------------- init */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  restoreSettings();
  await checkHealth();
  await loadHistory();
}

function bindEvents() {
  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => setMode(tab.dataset.mode))
  );
  ['targetRPM', 'vus', 'rampStart', 'rampEnd', 'rampSteps', 'rampStepSec', 'durationSec', 'durationSecVus'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { if (id === 'targetRPM') state.targetTouched = true; });
  });

  $('#loadModels').addEventListener('click', loadModels);
  $('#runForm').addEventListener('submit', startRun);
  $('#stopBtn').addEventListener('click', stopRun);
  $('#toggleKey').addEventListener('click', () => {
    const input = $('#apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('#model').addEventListener('change', () => selectModel($('#model').value));
  $('#remember').addEventListener('change', saveSettings);
  $('#refreshHistory').addEventListener('click', loadHistory);
}

function setMode(mode) {
  state.mode = mode;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $$('[data-mode-panel]').forEach((p) => {
    p.hidden = p.dataset.modePanel !== mode;
  });
}

/* --------------------------------------------------------------- provider */
async function checkHealth() {
  const el = $('#health');
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.ok) {
      el.className = 'health ok';
      el.innerHTML = `<span class="dot"></span><span>k6 ${data.k6.split(' ')[1] || ''} siap · Node ${data.node}</span>`;
    } else {
      el.className = 'health bad';
      el.innerHTML = '<span class="dot"></span><span>k6 tidak ditemukan</span>';
      setFormError('k6 tidak terdeteksi di server. Install k6 atau set K6_BIN.');
    }
  } catch {
    el.className = 'health bad';
    el.innerHTML = '<span class="dot"></span><span>server tidak merespons</span>';
  }
}

async function loadModels() {
  const baseURL = $('#baseURL').value.trim();
  const apiKey = $('#apiKey').value;
  if (!baseURL) {
    setFormError('Base URL wajib diisi.');
    return;
  }
  setFormError('');
  const status = $('#modelsStatus');
  status.className = 'hint';
  status.textContent = 'Memuat daftar model…';
  const btn = $('#loadModels');
  btn.disabled = true;
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL, apiKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal memuat model');
    state.models = data.models || [];
    const select = $('#model');
    const previous = select.value;
    select.innerHTML = '';
    if (!state.models.length) {
      select.innerHTML = '<option value="">— tidak ada model —</option>';
      status.className = 'hint error';
      status.textContent = 'Provider tidak mengembalikan model.';
      return;
    }
    for (const m of state.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.rpm ? `${m.id} · ${fmt(m.rpm)} RPM` : m.id;
      select.appendChild(opt);
    }
    const preferred =
      (state.pendingModel && state.models.find((m) => m.id === state.pendingModel)) ||
      state.models.find((m) => m.id === previous) ||
      state.models.find((m) => m.ready && m.rpm) ||
      state.models[0];
    state.pendingModel = null;
    select.value = preferred.id;
    state.targetTouched = false;
    selectModel(preferred.id, true);
    status.className = 'hint ok';
    status.textContent = `${state.models.length} model dimuat dari ${data.meta?.url || '/models'}`;
    saveSettings();
  } catch (err) {
    status.className = 'hint error';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function selectModel(id, silent = false) {
  const model = state.models.find((m) => m.id === id) || null;
  state.currentModel = model;
  const meta = $('#modelMeta');
  meta.innerHTML = '';
  if (!model) return;
  const chip = (cls, html) => {
    const s = document.createElement('span');
    s.className = `chip ${cls}`;
    s.innerHTML = html;
    meta.appendChild(s);
  };
  if (model.rpm) chip('accent', `RPM kuota <b>${fmt(model.rpm)}</b>`);
  if (model.tpm) chip('', `Token/menit <b>${compact(model.tpm)}</b>`);
  if (model.context) chip('', `Konteks <b>${compact(model.context)}</b>`);
  chip(model.ready ? 'ok' : 'warn', model.ready ? 'ready' : 'tidak ready');
  if (model.ownedBy) chip('', `owner <b>${model.ownedBy}</b>`);

  if (model.rpm && !state.targetTouched) {
    $('#targetRPM').value = model.rpm;
  }
  if (!silent) saveSettings();
}

/* ------------------------------------------------------------------ form */
function setFormError(msg) {
  const el = $('#formError');
  el.className = msg ? 'hint error' : 'hint';
  el.textContent = msg || '';
}

function collectConfig() {
  const baseURL = $('#baseURL').value.trim();
  const apiKey = $('#apiKey').value;
  const model = $('#model').value;
  if (!baseURL) return fail('Base URL wajib diisi.');
  if (!model) return fail('Model belum dipilih. Klik “Muat model” dulu.');
  const headersRaw = $('#headers').value.trim();
  let headers = {};
  if (headersRaw) {
    try {
      headers = JSON.parse(headersRaw);
    } catch {
      return fail('Header tambahan bukan JSON yang valid.');
    }
  }
  const mode = state.mode;
  const durationSec = Number(
    mode === 'vus' ? $('#durationSecVus').value : $('#durationSec').value
  );
  return {
    baseURL,
    apiKey,
    model,
    mode,
    durationSec,
    targetRPM: Number($('#targetRPM').value),
    vus: Number($('#vus').value),
    ramp: {
      startRPM: Number($('#rampStart').value),
      endRPM: Number($('#rampEnd').value),
      steps: Number($('#rampSteps').value),
      stepSec: Number($('#rampStepSec').value),
    },
    prompt: $('#prompt').value,
    maxTokens: Number($('#maxTokens').value),
    temperature: $('#temperature').value === '' ? null : Number($('#temperature').value),
    endpoint: $('#endpoint').value.trim() || '/chat/completions',
    timeoutMs: Number($('#timeoutMs').value),
    preAllocatedVUs: Number($('#preAllocatedVUs').value),
    maxVUs: Number($('#maxVUs').value),
    rpsCap: Number($('#rpsCap').value),
    uniquePrompt: $('#uniquePrompt').checked,
    noConnectionReuse: $('#noConnectionReuse').checked,
    headers,
    advertisedRPM: state.currentModel?.rpm ?? null,
  };
}

function fail(msg) {
  setFormError(msg);
  return null;
}

async function startRun(e) {
  e.preventDefault();
  if (state.running) return;
  setFormError('');
  const cfg = collectConfig();
  if (!cfg) return;

  const startBtn = $('#startBtn');
  startBtn.disabled = true;
  startBtn.textContent = 'Memulai…';
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal memulai tes');
    saveSettings();
    resetResults();
    state.runId = data.run.id;
    setRunning(true);
    showRunHeader(data.run);
    connect(data.run.id);
  } catch (err) {
    setFormError(err.message);
    setRunning(false);
  } finally {
    startBtn.disabled = state.running;
    startBtn.textContent = 'Mulai tes';
  }
}

async function stopRun() {
  if (!state.runId) return;
  const btn = $('#stopBtn');
  btn.disabled = true;
  btn.textContent = 'Menghentikan…';
  try {
    await fetch(`/api/runs/${encodeURIComponent(state.runId)}/stop`, { method: 'POST' });
  } catch {
    /* ignore */
  }
}

function setRunning(running) {
  state.running = running;
  $('#startBtn').disabled = running;
  $('#stopBtn').hidden = !running;
  if (running) {
    $('#stopBtn').disabled = false;
    $('#stopBtn').textContent = 'Stop';
  }
}

/* ------------------------------------------------------------------- sse */
function connect(id) {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  state.esErrors = 0;
  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  state.es = es;

  es.addEventListener('snapshot', (ev) => {
    try {
      renderSnapshot(JSON.parse(ev.data));
    } catch (err) {
      console.error(err);
    }
  });

  es.addEventListener('done', (ev) => {
    try {
      const result = JSON.parse(ev.data);
      es.close();
      state.es = null;
      setRunning(false);
      renderDone(result);
      loadHistory();
    } catch (err) {
      console.error(err);
    }
  });

  es.onerror = () => {
    state.esErrors++;
    if (state.esErrors >= 4 && state.es) {
      es.close();
      state.es = null;
      setRunning(false);
      setFormError('Koneksi live terputus. Muat ulang halaman untuk melihat hasil.');
    }
  };
}

/* --------------------------------------------------------------- rendering */
function showRunHeader(obj) {
  $('#emptyState').hidden = true;
  $('#liveView').hidden = false;
  const cfg = obj.config || {};
  $('#runModel').textContent = cfg.model || '—';
  $('#runId').textContent = obj.id || '';
  const pill = $('#statusPill');
  pill.className = `status-pill ${obj.status || 'running'}`;
  pill.textContent = obj.status || 'running';
  const target = obj.target || (cfg.mode ? {
    mode: cfg.mode,
    rpm: cfg.targetRPM,
    vus: cfg.vus,
    durationSec: cfg.durationSec,
    startRPM: cfg.ramp?.startRPM,
    endRPM: cfg.ramp?.endRPM,
    steps: cfg.ramp?.steps,
    stepSec: cfg.ramp?.stepSec,
  } : null);
  $('#runTarget').textContent = targetLabel(target);
  $('#targetNote').textContent = targetLabel(target);
}

function resetResults() {
  $('#kpis').innerHTML = '';
  $('#summaryCard').hidden = true;
  $('#limitCard').hidden = true;
  $('#summaryBody').innerHTML = '';
  $('#limitBody').innerHTML = '';
  $('#elapsed').textContent = '0s';
  for (const id of ['chartRpm', 'chartLatency', 'chartStatus']) {
    const canvas = document.getElementById(id);
    if (!canvas) continue;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function renderSnapshot(snap) {
  if (!snap || !snap.id) return;
  if (state.runId !== snap.id) state.runId = snap.id;
  const pill = $('#statusPill');
  pill.className = `status-pill ${snap.status}`;
  pill.textContent = snap.status;
  $('#runModel').textContent = snap.config?.model || '—';
  $('#runId').textContent = snap.id;
  $('#elapsed').textContent = fmtDur(snap.elapsedMs);
  $('#runTarget').textContent = targetLabel(snap.target);
  $('#targetNote').textContent = targetLabel(snap.target);
  $('#liveView').hidden = false;
  $('#emptyState').hidden = true;

  if (snap.status === 'running' || snap.status === 'starting') setRunning(true);

  renderKpis(snap.metrics, snap);
  drawAllCharts(snap.metrics.series, targetRPMOf(snap));
  renderLimit(snap, { live: true });
}

function renderDone(result) {
  state.running = false;
  showRunHeader(result);
  const pill = $('#statusPill');
  pill.className = `status-pill ${result.status}`;
  pill.textContent = result.status;
  $('#elapsed').textContent = fmtDur((result.elapsedSec || 0) * 1000);

  renderKpis(result.metrics, result, true);
  drawAllCharts(result.series || [], targetRPMOf(result));
  renderLimit(result, { live: false });
  renderSummary(result);
  $('#summaryCard').hidden = false;
  $('#reportLink').href = `/api/runs/${encodeURIComponent(result.id)}/report`;
  if (result.error) setFormError(result.error);
}

function renderKpis(m, ctx, final = false) {
  if (!m) return;
  const st = m.statusCounts || {};
  const errCount = Number(st['429'] || 0);
  const targetRPM = targetRPMOf(ctx);
  const successCls = m.successRate == null ? '' : m.successRate < 0.95 ? 'bad' : m.successRate < 0.99 ? 'warn' : 'good';
  const rpmMain = final ? ctx.achievedRPM ?? m.rpmAvg : m.rpmRecent;
  const rpmLabel = final ? 'RPM tercapai (avg)' : 'RPM saat ini';
  const rpmSub = final
    ? `${targetRPM ? `target ${fmt(targetRPM)} RPM` : `${fmt(m.total)} request`}`
    : `rata-rata ${fmt(m.rpmAvg)}${targetRPM ? ` · target ${fmt(targetRPM)}` : ''}`;
  const lat = final ? (ctx.k6?.duration || m.latency) : m.latency;
  const ttfb = final ? (ctx.k6?.waiting || m.ttfb) : m.ttfb;
  const p95 = (x) => x?.['p(95)'] ?? x?.p95;
  const p50 = (x) => x?.med ?? x?.p50;

  const items = [
    kpi(rpmLabel, fmt(rpmMain), rpmSub, 'hero'),
    kpi('Total request', fmt(final ? ctx.k6?.httpReqs?.count ?? m.total : m.total), `${fmt(m.ok)} ok · ${fmt(m.fail)} gagal`),
    kpi('Success rate', pct(m.successRate), successCls === 'good' ? 'sehat' : successCls === 'warn' ? 'ada error' : 'banyak error', successCls),
    kpi('429 rate limited', fmt(errCount),
      m.rateLimit?.retryAfterMs != null ? `retry-after ~${fmt(m.rateLimit.retryAfterMs)} ms` : `${pct(errCount / (m.total || 1))} dari request`,
      errCount ? 'warn' : ''),
    kpi('Latency p95', p95(lat) != null ? `${fmt(p95(lat))}<span class="unit">ms</span>` : '—', `p50 ${fmt(p50(lat))} ms`),
    kpi('TTFB p95', p95(ttfb) != null ? `${fmt(p95(ttfb))}<span class="unit">ms</span>` : '—', `p50 ${fmt(p50(ttfb))} ms`),
    kpi('Token / detik', fmt(m.tokens?.perSec, 1), `total ${compact(m.tokens?.total)}`),
    kpi('Dropped', fmt(final ? ctx.k6?.dropped ?? m.dropped : m.dropped), `${fmt(m.vus || 0)}/${fmt(m.vusMax || 0)} VU aktif`),
  ];
  $('#kpis').innerHTML = items.join('');
}

function kpi(label, value, sub, cls = '') {
  return `<div class="kpi ${cls}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub || '&nbsp;'}</div>
  </div>`;
}

function renderLimit(result, { live }) {
  const limit = result.limit || {};
  const m = result.metrics || {};
  const st = m.statusCounts || {};
  const err429 = Number(st['429'] || 0);
  const card = $('#limitCard');
  const body = $('#limitBody');
  if (!limit.advertisedRPM && !limit.limitRPM && !limit.sustainableRPM && !err429 && !result.advertisedRPM) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const advertised = result.advertisedRPM ?? limit.advertisedRPM ?? null;
  const box = (label, value, sub) =>
    `<div class="limit-box"><div class="label">${label}</div><div class="value">${value}</div><div class="kpi-sub">${sub || '&nbsp;'}</div></div>`;

  let note;
  if (limit.limitRPM != null) {
    note = `Provider mulai menolak (429 / error) di sekitar <b>${fmt(limit.limitRPM)} RPM</b>. Rate stabil tertinggi yang masih sehat ± <b>${fmt(limit.sustainableRPM)} RPM</b> (error ≤ 2% dalam jendela 5 detik).`;
  } else if (err429 > 0) {
    note = `Ada <b>${fmt(err429)}</b> respons 429. Rate stabil tertinggi ± <b>${fmt(limit.sustainableRPM)} RPM</b>.`;
  } else {
    note = live
      ? 'Belum ada penolakan 429. Uji lebih lama atau naikkan RPM untuk menemukan batasnya.'
      : `Tidak ada 429 yang signifikan. Tes mencapai <b>${fmt(result.achievedRPM)} RPM</b>${advertised ? ` dari kuota <b>${fmt(advertised)} RPM</b>` : ''}.`;
  }

  body.innerHTML = `
    <div class="limit-grid">
      ${box('Kuota diumumkan', advertised ? `${fmt(advertised)} <span class="unit">RPM</span>` : '—', 'dari /v1/models')}
      ${box('RPM stabil tertinggi', limit.sustainableRPM != null ? `${fmt(limit.sustainableRPM)} <span class="unit">RPM</span>` : '—', 'error ≤ 2% / 5s')}
      ${box('Titik 429 pertama', limit.limitRPM != null ? `${fmt(limit.limitRPM)} <span class="unit">RPM</span>` : '—', 'error > 5%')}
      ${box('429 diterima', `${fmt(err429)}`, `${pct(err429 / (m.total || 1))} dari request`)}
    </div>
    <p class="note">${note}</p>`;
}

function renderSummary(result) {
  const k6 = result.k6 || {};
  const m = result.metrics || {};
  const lat = k6.duration || m.latency || {};
  const ttfb = k6.waiting || m.ttfb || {};
  const st = m.statusCounts || {};
  const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;

  const statusChips = Object.entries(st)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([code, count]) => {
      const cls = code === '200' || (Number(code) >= 200 && Number(code) < 300) ? 's2' : code === '429' ? 's4' : Number(code) >= 500 || code === '0' ? 's5' : 's4';
      return `<span class="status-tag ${cls}">${code}</span> ${fmt(count)}`;
    })
    .join(' &nbsp; ');

  $('#summaryBody').innerHTML = `
    <table class="summary-table"><tbody>
      ${row('RPM tercapai (avg)', `<b>${fmt(result.achievedRPM)}</b>`)}
      ${row('RPM kuota diumumkan', fmt(result.advertisedRPM))}
      ${row('Total request', fmt(k6.httpReqs?.count ?? m.total))}
      ${row('Request terkirim', fmt(m.sent))}
      ${row('Success rate', pct(m.successRate))}
      ${row('Latency avg / p50 / p95 / p99', `${fmt(lat.avg)} / ${fmt(lat.med ?? lat.p50)} / ${fmt(lat['p(95)'] ?? lat.p95)} / ${fmt(lat['p(99)'] ?? lat.p99)} ms`)}
      ${row('TTFB avg / p95', `${fmt(ttfb.avg)} / ${fmt(ttfb['p(95)'] ?? ttfb.p95)} ms`)}
      ${row('Token prompt / completion / total', `${compact(k6.tokensPrompt ?? m.tokens?.prompt)} / ${compact(k6.tokensCompletion ?? m.tokens?.completion)} / ${compact(k6.tokensTotal ?? m.tokens?.total)}`)}
      ${row('Token per detik', fmt(m.tokens?.perSec, 1))}
      ${row('Dropped iterations', fmt(k6.dropped ?? m.dropped))}
      ${row('Durasi', `${fmt(result.elapsedSec, 1)} s`)}
      ${row('Status code', statusChips || '—')}
      ${result.lastError ? row('Error terakhir', `<code>HTTP ${result.lastError.status}</code> ${escapeHtml(errorMessage(result.lastError))}`) : ''}
    </tbody></table>
    ${result.error ? `<p class="note" style="color:#ff8b84">${result.error}</p>` : ''}`;
}

/* ----------------------------------------------------------------- charts */
function prepareCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const h = rect.height || 170;
  if (rect.width < 20) return null;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, h);
  return { ctx, w: rect.width, h };
}

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const f = v / 10 ** exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

function drawAxes(ctx, w, h, pad, max) {
  ctx.font = '10px ui-sans-serif,system-ui,sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ((h - pad.t - pad.b) * i) / 4;
    ctx.strokeStyle = '#1b2431';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = '#66738a';
    ctx.textAlign = 'right';
    ctx.fillText(fmt(max * (1 - i / 4), max <= 10 ? 1 : 0), pad.l - 7, y);
  }
}

function drawXLabels(ctx, w, h, pad, points) {
  if (points.length < 2) return;
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const span = Math.max((maxT - minT) / 1000, 1);
  ctx.fillStyle = '#66738a';
  ctx.font = '10px ui-sans-serif,system-ui,sans-serif';
  ctx.textBaseline = 'alphabetic';
  const labels = [0, 0.5, 1].map((f) => ({ f, t: minT + (maxT - minT) * f }));
  for (const l of labels) {
    const x = pad.l + (w - pad.l - pad.r) * l.f;
    ctx.textAlign = l.f === 0 ? 'left' : l.f === 1 ? 'right' : 'center';
    ctx.fillText(`+${fmtSec(span * l.f)}`, x, h - 5);
  }
}

function drawLineChart(canvas, points, lines, opts = {}) {
  const c = prepareCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  const pad = { l: 42, r: 12, t: 22, b: 20 };

  if (!points || points.length === 0) {
    ctx.fillStyle = '#66738a';
    ctx.font = '12px ui-sans-serif,system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Menunggu data…', w / 2, (h + pad.t) / 2);
    return;
  }

  let maxVal = 0;
  for (const line of lines) {
    for (const p of points) {
      const v = p[line.key];
      if (v != null && isFinite(v)) maxVal = Math.max(maxVal, v);
    }
  }
  if (opts.target) maxVal = Math.max(maxVal, opts.target);
  const max = niceMax(maxVal || 1);
  drawAxes(ctx, w, h, pad, max);

  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const span = Math.max(maxT - minT, 1);
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const xOf = (t) => pad.l + ((t - minT) / span) * plotW;
  const yOf = (v) => pad.t + plotH - (v / max) * plotH;

  if (opts.target) {
    const ty = yOf(Math.min(opts.target, max));
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(227,160,8,0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, ty);
    ctx.lineTo(w - pad.r, ty);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(227,160,8,0.9)';
    ctx.font = '10px ui-sans-serif,system-ui,sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`target ${fmt(opts.target)}`, w - pad.r - 2, ty - 2);
  }

  for (const line of lines) {
    const pts = points.filter((p) => p[line.key] != null && isFinite(p[line.key]));
    if (!pts.length) continue;
    if (line.fill) {
      const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
      grad.addColorStop(0, line.color + '55');
      grad.addColorStop(1, line.color + '00');
      ctx.beginPath();
      ctx.moveTo(xOf(pts[0].t), h - pad.b);
      for (const p of pts) ctx.lineTo(xOf(p.t), yOf(p[line.key]));
      ctx.lineTo(xOf(pts[pts.length - 1].t), h - pad.b);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(p.t);
      const y = yOf(p[line.key]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  drawXLabels(ctx, w, h, pad, points);

  // legend
  let lx = pad.l;
  ctx.textBaseline = 'middle';
  ctx.font = '10px ui-sans-serif,system-ui,sans-serif';
  for (const line of lines) {
    ctx.fillStyle = line.color;
    ctx.fillRect(lx, 6, 9, 3);
    ctx.fillStyle = '#8b98ab';
    ctx.textAlign = 'left';
    ctx.fillText(line.label, lx + 13, 8);
    lx += 13 + ctx.measureText(line.label).width + 14;
  }
}

function drawBarChart(canvas, points) {
  const c = prepareCanvas(canvas);
  if (!c) return;
  const { ctx, w, h } = c;
  const pad = { l: 42, r: 12, t: 22, b: 20 };

  if (!points || points.length === 0) {
    ctx.fillStyle = '#66738a';
    ctx.font = '12px ui-sans-serif,system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Menunggu data…', w / 2, (h + pad.t) / 2);
    return;
  }

  let max = 1;
  for (const p of points) max = Math.max(max, p.reqs || 0);
  const niceM = niceMax(max);
  drawAxes(ctx, w, h, pad, niceM);

  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const bw = Math.max(1, Math.min(10, plotW / points.length - 1));
  const gap = plotW / points.length;

  points.forEach((p, i) => {
    const x = pad.l + i * gap + (gap - bw) / 2;
    const reqs = p.reqs || 0;
    const fail = p.fail || 0;
    const r429 = (p.statuses && p.statuses['429']) || 0;
    const ok = Math.max(0, reqs - fail);
    const other = Math.max(0, fail - r429);
    let y = pad.t + plotH;

    const seg = (value, color) => {
      if (value <= 0) return;
      const height = (value / niceM) * plotH;
      y -= height;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, bw, height);
    };
    seg(ok, '#3fb950');
    seg(r429, '#e3a008');
    seg(other, '#f85149');
  });

  drawXLabels(ctx, w, h, pad, points);

  const legend = [
    ['ok', '#3fb950'],
    ['429', '#e3a008'],
    ['error lain', '#f85149'],
  ];
  let lx = pad.l;
  ctx.textBaseline = 'middle';
  ctx.font = '10px ui-sans-serif,system-ui,sans-serif';
  for (const [label, color] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, 6, 9, 3);
    ctx.fillStyle = '#8b98ab';
    ctx.textAlign = 'left';
    ctx.fillText(label, lx + 13, 8);
    lx += 13 + ctx.measureText(label).width + 14;
  }
}

function movingAverage(points, key, win = 5) {
  return points.map((p, i) => {
    const start = Math.max(0, i - win + 1);
    let sum = 0;
    let n = 0;
    for (let j = start; j <= i; j++) {
      const v = points[j][key];
      if (v != null && isFinite(v)) {
        sum += v;
        n++;
      }
    }
    return { ...p, [key]: n ? sum / n : null };
  });
}

function drawAllCharts(series, target) {
  const pts = series || [];
  const rpmSeries = movingAverage(pts, 'rpm', 5);
  drawLineChart(
    $('#chartRpm'),
    rpmSeries,
    [{ key: 'rpm', color: '#5b9dff', label: 'RPM (rata-rata 5s)', fill: true }],
    { target: target || null }
  );
  drawLineChart($('#chartLatency'), pts, [
    { key: 'p50', color: '#3fb950', label: 'p50' },
    { key: 'p95', color: '#e3a008', label: 'p95' },
  ]);
  drawBarChart($('#chartStatus'), pts);
}

/* ---------------------------------------------------------------- history */
async function loadHistory() {
  const el = $('#historyList');
  try {
    const res = await fetch('/api/runs');
    const data = await res.json();
    const runs = data.runs || [];
    if (!runs.length) {
      el.innerHTML = '<div class="muted small">Belum ada riwayat.</div>';
      return;
    }
    el.innerHTML = '';
    for (const run of runs.slice(0, 40)) {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.dataset.id = run.id;
      const cfg = run.config || {};
      const target = targetLabel(
        cfg.mode === 'arrival'
          ? { mode: 'arrival', rpm: cfg.targetRPM, durationSec: cfg.durationSec }
          : cfg.mode === 'vus'
            ? { mode: 'vus', vus: cfg.vus, durationSec: cfg.durationSec }
            : { mode: 'ramp', startRPM: cfg.ramp?.startRPM, endRPM: cfg.ramp?.endRPM, steps: cfg.ramp?.steps, stepSec: cfg.ramp?.stepSec }
      );
      item.innerHTML = `
        <span class="dot ${run.status}"></span>
        <div class="history-main">
          <div class="history-model">${escapeHtml(cfg.model || '—')}</div>
          <div class="history-sub">${clock(run.createdAt)} · ${escapeHtml(target)}</div>
        </div>
        <div class="history-metric ${run.successRate != null && run.successRate < 0.5 ? 'bad' : ''}">${historyMetric(run)}</div>
        <button class="history-del" title="Hapus">✕</button>`;
      item.addEventListener('click', () => openRun(run.id));
      item.querySelector('.history-del').addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteRun(run.id);
      });
      el.appendChild(item);
    }
  } catch {
    el.innerHTML = '<div class="muted small">Gagal memuat riwayat.</div>';
  }
}

function historyMetric(run) {
  if (run.status === 'running' || run.status === 'starting') return 'berjalan';
  if (run.successRate != null && run.successRate < 0.5) return `${pct(run.successRate)} ok`;
  if (run.achievedRPM != null) return `${fmt(run.achievedRPM)} RPM`;
  return escapeHtml(run.status);
}

async function openRun(id) {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.runId = id;
    if (data.live) {
      resetResults();
      showRunHeader(data.run);
      setRunning(true);
      connect(id);
    } else if (data.result) {
      setRunning(false);
      renderDone(data.result);
    } else {
      setRunning(false);
      showRunHeader(data.run || { id, config: {} });
    }
  } catch (err) {
    setFormError(err.message);
  }
}

async function deleteRun(id) {
  try {
    await fetch(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (state.runId === id) {
      state.runId = null;
      if (state.es) {
        state.es.close();
        state.es = null;
      }
      setRunning(false);
      $('#liveView').hidden = true;
      $('#emptyState').hidden = false;
      resetResults();
    }
    loadHistory();
  } catch {
    /* ignore */
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorMessage(lastError) {
  if (!lastError) return '';
  try {
    const j = JSON.parse(lastError.body);
    return j?.error?.message || j?.message || lastError.body;
  } catch {
    return lastError.body;
  }
}

/* --------------------------------------------------------------- settings */
function saveSettings() {
  try {
    const remember = $('#remember').checked;
    const data = {
      baseURL: $('#baseURL').value.trim(),
      model: $('#model').value,
      mode: state.mode,
      remember,
      apiKey: remember ? $('#apiKey').value : '',
    };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function restoreSettings() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    data = {};
  }
  if (data.baseURL) $('#baseURL').value = data.baseURL;
  if (data.apiKey) {
    $('#apiKey').value = data.apiKey;
    $('#remember').checked = true;
  }
  if (data.mode) setMode(data.mode);
  if (data.model) {
    // Model is restored once the model list is loaded.
    state.pendingModel = data.model;
  }
}
