import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { RunManager } from './lib/runner.js';
import { renderReport } from './lib/report.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const K6_BIN = process.env.K6_BIN || 'k6';
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const AUTH_ENABLED = Boolean(AUTH_USER && AUTH_PASS);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

let k6Version = null;
try {
  k6Version = execFileSync(K6_BIN, ['version'], { encoding: 'utf8' }).trim();
} catch {
  k6Version = null;
}

const manager = new RunManager({ rootDir: ROOT, k6Bin: K6_BIN });

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Optional HTTP Basic Auth. Enabled only when AUTH_USER and AUTH_PASS are set.
function authorize(req, res) {
  if (!AUTH_ENABLED) return true;
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : '';
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    if (safeEqual(user, AUTH_USER) && safeEqual(pass, AUTH_PASS)) return true;
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="LLM Load Test", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end('Login diperlukan');
  return false;
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Body bukan JSON yang valid'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function normalizeBaseURL(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('Base URL tidak valid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Base URL harus http:// atau https://');
  }
  return u.toString().replace(/\/+$/, '');
}

function normalizeModels(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const models = [];
  for (const item of data) {
    if (typeof item === 'string') {
      models.push({ id: item, name: item, rpm: null, tpm: null, context: null, ready: true });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const id = item.id || item.name || item.model;
    if (!id) continue;

    let rpm = null;
    let tpm = null;
    if (Array.isArray(item.capacity)) {
      for (const c of item.capacity) {
        if (!c) continue;
        if (c.unit === 'request' && c.per === 'minute') rpm = Number(c.value) || rpm;
        if ((c.unit === 'token' || c.unit === 'tokens') && c.per === 'minute') tpm = Number(c.value) || tpm;
      }
    }
    let context = null;
    if (Array.isArray(item.input_modalities)) {
      for (const mod of item.input_modalities) {
        const ctx = mod?.supported_inputs?.max_context_length?.value;
        if (ctx && (!context || ctx > context)) context = Number(ctx);
        if (Array.isArray(mod.capacity)) {
          for (const c of mod.capacity) {
            if (c && (c.unit === 'token' || c.unit === 'tokens') && c.per === 'minute' && c.type === 'prompt') {
              tpm = tpm == null ? Number(c.value) : tpm;
            }
          }
        }
      }
    }
    models.push({
      id: String(id),
      name: String(item.name || id),
      rpm,
      tpm,
      context,
      ready: item.is_ready !== false,
      ownedBy: item.owned_by || null,
      status: item.status || null,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function buildRunConfig(body) {
  const baseURL = normalizeBaseURL(body.baseURL);
  if (!body.model) throw new Error('Model wajib dipilih');
  const mode = ['arrival', 'vus', 'ramp'].includes(body.mode) ? body.mode : 'arrival';

  let headers = {};
  if (body.headers) {
    if (typeof body.headers === 'string' && body.headers.trim()) {
      try {
        headers = JSON.parse(body.headers);
      } catch {
        throw new Error('Header tambahan harus JSON yang valid');
      }
    } else if (typeof body.headers === 'object') {
      headers = body.headers;
    }
  }

  const cfg = {
    baseURL,
    apiKey: String(body.apiKey || ''),
    endpoint: body.endpoint || '/chat/completions',
    model: String(body.model),
    prompt: String(body.prompt || 'Reply with the single word: ok'),
    systemPrompt: body.systemPrompt ? String(body.systemPrompt) : null,
    maxTokens: clampInt(body.maxTokens, 1, 200000, 16),
    temperature: body.temperature === '' || body.temperature == null ? null : Number(body.temperature),
    topP: body.topP === '' || body.topP == null ? null : Number(body.topP),
    uniquePrompt: !!body.uniquePrompt,
    noConnectionReuse: !!body.noConnectionReuse,
    timeoutMs: clampInt(body.timeoutMs, 1000, 600000, 60000),
    headers,
    mode,
    durationSec: clampInt(body.durationSec, 5, 7200, 60),
    targetRPM: clampInt(body.targetRPM, 1, 1000000, 60),
    vus: clampInt(body.vus, 1, 5000, 10),
    preAllocatedVUs: clampInt(body.preAllocatedVUs, 0, 5000, 0),
    maxVUs: clampInt(body.maxVUs, 1, 10000, 200),
    expectedLatencySec: Number(body.expectedLatencySec) > 0 ? Number(body.expectedLatencySec) : 3,
    rpsCap: clampInt(body.rpsCap, 0, 1000000, 0),
    ramp: {
      startRPM: clampInt(body.ramp?.startRPM, 1, 100000, 10),
      endRPM: clampInt(body.ramp?.endRPM, 1, 1000000, 500),
      steps: clampInt(body.ramp?.steps, 1, 60, 6),
      stepSec: clampInt(body.ramp?.stepSec, 1, 600, 10),
    },
  };
  if (cfg.temperature != null && (Number.isNaN(cfg.temperature) || cfg.temperature < 0 || cfg.temperature > 2)) {
    cfg.temperature = null;
  }
  if (cfg.mode === 'ramp' && cfg.ramp.endRPM <= cfg.ramp.startRPM) {
    throw new Error('RPM akhir ramp harus lebih besar dari RPM awal');
  }
  return cfg;
}

function sseWrite(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function handleEvents(req, res, id) {
  const run = manager.get(id);
  const result = run ? null : manager.loadResult(id);

  if (!run && !result) {
    json(res, 404, { error: 'Run tidak ditemukan' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  if (!run || run.status === 'done' || run.status === 'failed' || run.status === 'stopped') {
    const data = result || run?.result;
    if (data) sseWrite(res, 'done', data);
    else sseWrite(res, 'snapshot', run ? run.snapshot() : manager.list().find((r) => r.id === id));
    res.end();
    return;
  }

  let closed = false;
  const onSnapshot = (snap) => sseWrite(res, 'snapshot', snap);
  const onDone = (payload) => {
    sseWrite(res, 'done', payload);
    cleanup();
    res.end();
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    run.off('snapshot', onSnapshot);
    run.off('done', onDone);
    req.off('close', cleanup);
  }

  run.on('snapshot', onSnapshot);
  run.on('done', onDone);
  req.on('close', cleanup);

  // Prime the client immediately.
  onSnapshot(run.snapshot());
}

function isSafeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id) && !id.includes('..');
}

const server = http.createServer(async (req, res) => {
  if (!authorize(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  try {
    if (pathname === '/api/health') {
      return json(res, 200, { ok: !!k6Version, k6: k6Version, node: process.version });
    }

    if (pathname === '/api/models' && method === 'POST') {
      const body = await readBody(req);
      let baseURL;
      try {
        baseURL = normalizeBaseURL(body.baseURL);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const headers = { Accept: 'application/json' };
      if (body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;
      if (body.headers && typeof body.headers === 'object') Object.assign(headers, body.headers);

      let upstream;
      try {
        upstream = await fetch(`${baseURL}/models`, {
          headers,
          signal: AbortSignal.timeout(20000),
        });
      } catch (err) {
        return json(res, 502, { error: `Gagal menghubungi provider: ${err.message}` });
      }
      const text = await upstream.text();
      if (!upstream.ok) {
        return json(res, 502, {
          error: `Provider mengembalikan HTTP ${upstream.status}`,
          detail: text.slice(0, 800),
        });
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return json(res, 502, { error: 'Respons /models bukan JSON', detail: text.slice(0, 400) });
      }
      const models = normalizeModels(payload);
      return json(res, 200, {
        models,
        meta: {
          url: `${baseURL}/models`,
          count: models.length,
          rateLimit: {
            limitRequests: upstream.headers.get('x-ratelimit-limit-requests'),
            remainingRequests: upstream.headers.get('x-ratelimit-remaining-requests'),
            limitTokens: upstream.headers.get('x-ratelimit-limit-tokens'),
            remainingTokens: upstream.headers.get('x-ratelimit-remaining-tokens'),
          },
        },
      });
    }

    if (pathname === '/api/runs' && method === 'GET') {
      return json(res, 200, { runs: manager.list() });
    }

    if (pathname === '/api/runs' && method === 'POST') {
      const body = await readBody(req);
      let cfg;
      try {
        cfg = buildRunConfig(body);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      if (!k6Version) {
        return json(res, 500, { error: 'k6 tidak ditemukan. Install k6 atau set K6_BIN.' });
      }
      const run = manager.create({ config: cfg, advertisedRPM: body.advertisedRPM ?? null });
      return json(res, 201, { run: run.publicMeta() });
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)(?:\/([a-z]+))?$/);
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const action = runMatch[2];
      if (!isSafeId(id)) return json(res, 400, { error: 'ID run tidak valid' });

      if (action === 'events' && method === 'GET') {
        return handleEvents(req, res, id);
      }
      if (action === 'stop' && method === 'POST') {
        const run = manager.get(id);
        if (!run) return json(res, 404, { error: 'Run tidak ditemukan' });
        return json(res, 200, { stopped: run.stop() });
      }
      if (action === 'report' && method === 'GET') {
        const result = manager.get(id)?.result || manager.loadResult(id);
        if (!result) return json(res, 404, { error: 'Hasil run belum tersedia' });
        const html = renderReport(result);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      if (action === 'result' && method === 'GET') {
        const result = manager.get(id)?.result || manager.loadResult(id);
        if (!result) return json(res, 404, { error: 'Hasil run belum tersedia' });
        return json(res, 200, result);
      }
      if (action === 'log' && method === 'GET') {
        const file = path.join(ROOT, 'runs', id, 'k6.log');
        return fs.readFile(file, 'utf8', (err, data) => {
          if (err) return json(res, 404, { error: 'Log tidak ditemukan' });
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(data);
        });
      }
      if (action == null && method === 'GET') {
        const run = manager.get(id);
        const result = run?.result || manager.loadResult(id);
        const meta = run ? run.publicMeta() : manager.list().find((r) => r.id === id);
        if (!meta && !result) return json(res, 404, { error: 'Run tidak ditemukan' });
        return json(res, 200, { run: meta || result, result, live: run ? run.status === 'running' : false });
      }
      if (action == null && method === 'DELETE') {
        return json(res, 200, { removed: manager.remove(id) });
      }
    }

    if (method === 'GET') return serveStatic(req, res, pathname);

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) return json(res, 500, { error: err.message || String(err) });
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  LLM Load Test siap`);
  console.log(`  → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  k6: ${k6Version || 'TIDAK DITEMUKAN'}\n`);
});
