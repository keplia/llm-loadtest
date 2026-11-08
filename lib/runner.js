import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MetricsAggregator, analyzeLimit, normalizeSummary } from './metrics.js';
import { JsonlTailer } from './tail.js';

function makeId() {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function isSafeRunId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id) && !id.includes('..');
}

export function sanitizeConfig(cfg) {
  const out = { ...cfg };
  const hadKey = !!out.apiKey;
  delete out.apiKey;
  out.hasApiKey = hadKey;
  return out;
}

function expectedDurationSec(cfg) {
  if (cfg.mode === 'ramp') {
    return (cfg.ramp?.steps || 6) * (cfg.ramp?.stepSec || 10) + 60;
  }
  return Number(cfg.durationSec || 60) + 60;
}

function downsample(series, maxPoints = 600) {
  if (!series || series.length <= maxPoints) return series || [];
  const step = series.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    const chunk = series.slice(start, end);
    const avg = (key) => {
      const vals = chunk.map((d) => d[key]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sum = (key) => chunk.reduce((a, b) => a + (b[key] || 0), 0);
    const starts = sum('starts');
    out.push({
      t: chunk[0].t,
      reqs: Math.round(sum('reqs') / chunk.length),
      starts: Math.round(starts / chunk.length),
      fail: Math.round(sum('fail') / chunk.length),
      rpm: Math.round((starts / chunk.length) * 60),
      avg: avg('avg'),
      p50: avg('p50'),
      p95: avg('p95'),
      ttfb: avg('ttfb'),
      tokens: Math.round(sum('tokens') / chunk.length),
      statuses: chunk.reduce((acc, c) => {
        for (const [k, v] of Object.entries(c.statuses || {})) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {}),
    });
  }
  return out;
}

export class Run extends EventEmitter {
  constructor(opts, { runsDir, scriptPath, k6Bin }) {
    super();
    this.id = makeId();
    this.cfg = opts.config;
    this.advertisedRPM = opts.advertisedRPM ?? null;
    this.runsDir = runsDir;
    this.scriptPath = scriptPath;
    this.k6Bin = k6Bin;

    this.dir = path.join(runsDir, this.id);
    this.metricsPath = path.join(this.dir, 'metrics.ndjson');
    this.summaryPath = path.join(this.dir, 'summary.json');
    this.configPath = path.join(this.dir, 'config.secret.json');
    this.logPath = path.join(this.dir, 'k6.log');

    this.status = 'starting';
    this.createdAt = Date.now();
    this.startedAt = null;
    this.endedAt = null;
    this.errorMessage = null;
    this.stopRequested = false;

    this.agg = new MetricsAggregator();
    this.tailer = null;
    this.child = null;
    this.snapshotTimer = null;
    this.watchdog = null;
    this.result = null;
  }

  publicMeta() {
    return {
      id: this.id,
      status: this.status,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      error: this.errorMessage,
      advertisedRPM: this.advertisedRPM,
      config: sanitizeConfig(this.cfg),
    };
  }

  snapshot() {
    const snap = this.agg.snapshot(Date.now());
    return {
      ...this.publicMeta(),
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      target: this.targetDescriptor(),
      metrics: snap,
      limit: analyzeLimit(snap.series),
    };
  }

  targetDescriptor() {
    const c = this.cfg;
    if (c.mode === 'arrival') return { mode: 'arrival', rpm: c.targetRPM, durationSec: c.durationSec };
    if (c.mode === 'vus') return { mode: 'vus', vus: c.vus, durationSec: c.durationSec };
    return { mode: 'ramp', startRPM: c.ramp?.startRPM, endRPM: c.ramp?.endRPM, steps: c.ramp?.steps, stepSec: c.ramp?.stepSec };
  }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });

    this.tailer = new JsonlTailer(this.metricsPath, (line) => this.agg.ingest(line));
    this.tailer.start();

    const args = [
      'run',
      '--no-thresholds',
      '--summary-mode', 'full',
      '--quiet',
      '--log-format', 'raw',
      '--summary-export', this.summaryPath,
      '--out', `json=${this.metricsPath}`,
    ];
    if (this.cfg.rpsCap > 0) args.push('--rps', String(this.cfg.rpsCap));
    args.push(this.scriptPath);

    const logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.logStream = logStream;

    try {
      this.child = spawn(this.k6Bin, args, {
        env: {
          ...process.env,
          CONFIG_PATH: this.configPath,
          K6_NO_USAGE_REPORT: 'true',
          K6_WEB_DASHBOARD: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.failStart(err);
      return;
    }

    this.child.stdout.on('data', (d) => logStream.write(d));
    this.child.stderr.on('data', (d) => logStream.write(d));
    this.child.on('error', (err) => this.failStart(err));
    this.child.on('exit', (code, signal) => this.finish(code, signal));

    this.status = 'running';
    this.startedAt = Date.now();
    this.writeMeta();

    this.snapshotTimer = setInterval(() => {
      try {
        this.emit('snapshot', this.snapshot());
      } catch (err) {
        this.errorMessage = String(err?.message || err);
      }
    }, 1000);
    if (this.snapshotTimer.unref) this.snapshotTimer.unref();

    const watchdogMs = (expectedDurationSec(this.cfg) + 180) * 1000;
    this.watchdog = setTimeout(() => {
      this.errorMessage = 'Watchdog: test melewati batas waktu, dihentikan paksa.';
      this.stop();
    }, watchdogMs);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  failStart(err) {
    this.status = 'failed';
    this.errorMessage = `Gagal menjalankan k6: ${err?.message || err}`;
    this.endedAt = Date.now();
    this.writeMeta();
    this.cleanupTimers();
    try {
      fs.writeFileSync(path.join(this.dir, 'result.json'), JSON.stringify({ error: this.errorMessage }, null, 2));
    } catch {
      /* ignore */
    }
    this.emit('done', { ...this.publicMeta(), error: this.errorMessage });
  }

  stop() {
    if (this.status !== 'running') return false;
    this.stopRequested = true;
    this.status = 'stopping';
    this.writeMeta();
    try {
      this.child.kill('SIGINT');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (this.child && this.child.exitCode == null) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 10000).unref?.();
    return true;
  }

  cleanupTimers() {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.snapshotTimer = null;
    this.watchdog = null;
  }

  finish(code, signal) {
    if (this.status === 'done' || this.status === 'failed' || this.status === 'stopped') return;
    this.cleanupTimers();
    this.endedAt = Date.now();

    // Give k6 a moment to flush the NDJSON + summary file, then finalize.
    setTimeout(() => {
      if (this.tailer) this.tailer.stop();
      this.finalize(code, signal);
    }, 400);
  }

  finalize(code, signal) {
    let summaryRaw = null;
    try {
      summaryRaw = JSON.parse(fs.readFileSync(this.summaryPath, 'utf8'));
    } catch {
      summaryRaw = null;
    }

    this.status = this.stopRequested ? 'stopped' : code === 0 ? 'done' : 'failed';
    if (this.status === 'failed' && !this.errorMessage) {
      this.errorMessage = `k6 keluar dengan kode ${code}${signal ? ` (${signal})` : ''}`;
    }

    const snap = this.agg.snapshot(Date.now());
    const k6 = normalizeSummary(summaryRaw);
    const elapsedSec = this.startedAt ? (this.endedAt - this.startedAt) / 1000 : 0;
    const fullSeries = this.agg.series(4 * 3600, this.endedAt || Date.now());
    const limit = analyzeLimit(fullSeries);

    // k6 keeps the test alive during gracefulStop while in-flight requests
    // drain. Using the scheduled duration avoids deflating the achieved RPM.
    const scheduleSec = this.cfg.mode === 'ramp'
      ? (this.cfg.ramp.steps * this.cfg.ramp.stepSec)
      : this.cfg.durationSec;
    const denomSec = elapsedSec > 0 ? Math.min(elapsedSec, scheduleSec) : scheduleSec;
    const count = snap.sent || k6?.httpReqs?.count || snap.total;
    const achievedRPM = denomSec > 0 ? (count / denomSec) * 60 : null;

    // k6 logs a few sample error bodies; surface the last one to the UI.
    let lastError = null;
    try {
      const log = fs.readFileSync(this.logPath, 'utf8');
      const matches = [...log.matchAll(/\[HTTP (\d+)\] (.+)/g)];
      if (matches.length) {
        const m = matches[matches.length - 1];
        const body = m[2].replace(/"\s+source=\w+\s*$/, '').trim();
        lastError = { status: Number(m[1]), body: body.slice(0, 600) };
      }
    } catch {
      /* no log */
    }

    this.result = {
      id: this.id,
      status: this.status,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedSec,
      scheduleSec,
      advertisedRPM: this.advertisedRPM,
      target: this.targetDescriptor(),
      config: sanitizeConfig(this.cfg),
      achievedRPM,
      limit,
      k6,
      metrics: snap,
      series: downsample(fullSeries, 600),
      lastError,
      error: this.errorMessage,
    };

    try {
      fs.writeFileSync(path.join(this.dir, 'result.json'), JSON.stringify(this.result, null, 2));
    } catch {
      /* ignore */
    }
    this.writeMeta();
    if (this.logStream) {
      try {
        this.logStream.end();
      } catch {
        /* ignore */
      }
    }
    this.emit('done', this.result);
  }

  writeMeta() {
    try {
      fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(this.publicMeta(), null, 2));
    } catch {
      /* ignore */
    }
  }
}

export class RunManager {
  constructor({ rootDir, k6Bin }) {
    this.rootDir = rootDir;
    this.runsDir = path.join(rootDir, 'runs');
    this.scriptPath = path.join(rootDir, 'k6', 'llm.js');
    this.k6Bin = k6Bin;
    this.runs = new Map();
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.markInterrupted();
  }

  // Runs that were still active when the server stopped can never be resumed.
  markInterrupted() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.runsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = path.join(this.runsDir, e.name, 'meta.json');
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (['running', 'starting', 'stopping'].includes(meta.status)) {
          meta.status = 'failed';
          meta.error = 'Server berhenti saat tes berjalan.';
          meta.endedAt = meta.endedAt || Date.now();
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        }
      } catch {
        /* skip */
      }
    }
  }

  create(options) {
    const run = new Run(options, {
      runsDir: this.runsDir,
      scriptPath: this.scriptPath,
      k6Bin: this.k6Bin,
    });
    this.runs.set(run.id, run);
    run.start();
    return run;
  }

  get(id) {
    return this.runs.get(id) || null;
  }

  list() {
    const out = [];
    let entries = [];
    try {
      entries = fs.readdirSync(this.runsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(this.runsDir, e.name);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        const resultPath = path.join(dir, 'result.json');
        if (fs.existsSync(resultPath)) {
          try {
            const r = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
            meta.achievedRPM = r.achievedRPM ?? null;
            meta.limit = r.limit ?? null;
            meta.successRate = r.metrics?.successRate ?? null;
            meta.total = r.metrics?.total ?? null;
          } catch {
            /* ignore */
          }
        }
        out.push(meta);
      } catch {
        /* skip incomplete dirs */
      }
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  loadResult(id) {
    if (!isSafeRunId(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.runsDir, id, 'result.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  remove(id) {
    if (!isSafeRunId(id)) return false;
    const run = this.runs.get(id);
    if (run && (run.status === 'running' || run.status === 'starting')) run.stop();
    this.runs.delete(id);
    const dir = path.join(this.runsDir, id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
