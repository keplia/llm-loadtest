// Aggregates k6's NDJSON metric stream into live snapshots and a final result.

const RESERVOIR = 200000; // max latency samples kept for overall percentiles

export function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

function toMs(ts) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? Date.now() : t;
}

class Reservoir {
  constructor(cap = RESERVOIR) {
    this.cap = cap;
    this.values = [];
    this.seen = 0;
  }
  add(v) {
    this.seen++;
    if (this.values.length < this.cap) {
      this.values.push(v);
    } else {
      const i = Math.floor(Math.random() * this.seen);
      if (i < this.cap) this.values[i] = v;
    }
  }
  stats() {
    const s = this.values.slice().sort((a, b) => a - b);
    return {
      count: this.seen,
      avg: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
      min: s.length ? s[0] : null,
      max: s.length ? s[s.length - 1] : null,
      p50: percentile(s, 50),
      p90: percentile(s, 90),
      p95: percentile(s, 95),
      p99: percentile(s, 99),
    };
  }
}

export class MetricsAggregator {
  constructor() {
    this.reset();
  }

  reset() {
    this.total = 0;
    this.sent = 0;
    this.fail = 0;
    this.statusCounts = Object.create(null);
    this.buckets = new Map(); // secondEpoch -> bucket
    this.completionTimes = [];
    this.startTimes = [];
    this.latency = new Reservoir();
    this.ttfb = new Reservoir();
    this.tokens = { prompt: 0, completion: 0, total: 0 };
    this.dropped = 0;
    this.bytesReceived = 0;
    this.bytesSent = 0;
    this.vus = 0;
    this.vusMax = 0;
    this.rateLimit = {
      remainingRequests: null,
      remainingTokens: null,
      retryAfterMs: null,
    };
    this.startedAt = null;
    this.lastEventAt = null;
  }

  bucketAt(ms) {
    const sec = Math.floor(ms / 1000) * 1000;
    let b = this.buckets.get(sec);
    if (!b) {
      b = { t: sec, reqs: 0, starts: 0, fail: 0, latency: [], ttfb: [], tokens: 0, statuses: Object.create(null) };
      this.buckets.set(sec, b);
    }
    return b;
  }

  // Parse one NDJSON line from k6 and fold it into the aggregates.
  ingest(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || msg.type !== 'Point' || !msg.data) return;

    const { metric } = msg;
    const data = msg.data;
    const value = Number(data.value);
    const at = toMs(data.time);
    if (this.startedAt == null || at < this.startedAt) this.startedAt = at;
    if (this.lastEventAt == null || at > this.lastEventAt) this.lastEventAt = at;

    switch (metric) {
      case 'request_starts': {
        this.sent += value;
        this.bucketAt(at).starts += value;
        this.startTimes.push(at);
        break;
      }
      case 'http_reqs': {
        this.total++;        const status = data.tags && data.tags.status != null ? String(data.tags.status) : '0';
        this.statusCounts[status] = (this.statusCounts[status] || 0) + 1;
        const b = this.bucketAt(at);
        b.reqs++;
        b.statuses[status] = (b.statuses[status] || 0) + 1;
        this.completionTimes.push(at);
        break;
      }
      case 'http_req_failed': {
        if (value === 1) {
          this.fail++;
          this.bucketAt(at).fail++;
        }
        break;
      }
      case 'http_req_duration': {
        this.latency.add(value);
        const b = this.bucketAt(at);
        if (b.latency.length < 20000) b.latency.push(value);
        break;
      }
      case 'http_req_waiting': {
        this.ttfb.add(value);
        const b = this.bucketAt(at);
        if (b.ttfb.length < 20000) b.ttfb.push(value);
        break;
      }
      case 'tokens_prompt':
        this.tokens.prompt += value;
        this.bucketAt(at).tokens += value;
        break;
      case 'tokens_completion':
        this.tokens.completion += value;
        this.bucketAt(at).tokens += value;
        break;
      case 'tokens_total':
        this.tokens.total += value;
        break;
      case 'dropped_iterations':
        this.dropped += value;
        break;
      case 'data_received':
        this.bytesReceived += value;
        break;
      case 'data_sent':
        this.bytesSent += value;
        break;
      case 'vus':
        this.vus = value;
        break;
      case 'vus_max':
        this.vusMax = value;
        break;
      case 'rl_remaining_requests':
        this.rateLimit.remainingRequests = value;
        break;
      case 'rl_remaining_tokens':
        this.rateLimit.remainingTokens = value;
        break;
      case 'retry_after_ms':
        this.rateLimit.retryAfterMs = value;
        break;
      default:
        break;
    }
  }

  cleanup(nowMs = Date.now()) {
    const cutoff = nowMs - 30 * 60 * 1000;
    for (const [sec] of this.buckets) {
      if (sec < cutoff) this.buckets.delete(sec);
    }
    while (this.completionTimes.length && this.completionTimes[0] < nowMs - 61000) {
      this.completionTimes.shift();
    }
    while (this.startTimes.length && this.startTimes[0] < nowMs - 61000) {
      this.startTimes.shift();
    }
  }

  series(limitSec = 180, nowMs = Date.now()) {
    const cutoff = Math.floor((nowMs - limitSec * 1000) / 1000) * 1000;
    const kept = [];
    for (const b of this.buckets.values()) {
      if (b.t >= cutoff) kept.push(b);
    }
    if (!kept.length) return [];
    kept.sort((a, b) => a.t - b.t);
    const bySec = new Map(kept.map((b) => [b.t, b]));
    const out = [];
    // Fill gaps with zero buckets so the time axis represents every second.
    for (let t = kept[0].t; t <= kept[kept.length - 1].t; t += 1000) {
      const b = bySec.get(t) || { t, reqs: 0, starts: 0, fail: 0, latency: [], ttfb: [], tokens: 0, statuses: {} };
      const lat = b.latency.slice().sort((a, b2) => a - b2);
      const ttfb = b.ttfb.slice().sort((a, b2) => a - b2);
      out.push({
        t,
        reqs: b.reqs,
        starts: b.starts,
        fail: b.fail,
        rpm: b.starts * 60,
        avg: lat.length ? lat.reduce((a, c) => a + c, 0) / lat.length : null,
        p50: percentile(lat, 50),
        p95: percentile(lat, 95),
        ttfb: percentile(ttfb, 50),
        tokens: b.tokens,
        statuses: b.statuses,
      });
    }
    return out;
  }

  snapshot(nowMs = Date.now()) {
    this.cleanup(nowMs);
    const elapsedMs = this.startedAt ? nowMs - this.startedAt : 0;
    const elapsedSec = Math.max(elapsedMs / 1000, 0.001);
    const lat = this.latency.stats();
    const ttfb = this.ttfb.stats();
    const windowStarts = this.startTimes.length; // already pruned to last 60s
    let recentStarts = 0;
    for (let i = this.startTimes.length - 1; i >= 0; i--) {
      if (this.startTimes[i] >= nowMs - 10000) recentStarts++;
      else break;
    }
    const recentWindowSec = Math.min(10, Math.max(elapsedSec, 0.001));
    return {
      startedAt: this.startedAt,
      elapsedMs,
      total: this.total,
      sent: this.sent,
      ok: Math.max(0, this.total - this.fail),
      fail: this.fail,
      successRate: this.total ? (this.total - this.fail) / this.total : null,
      statusCounts: { ...this.statusCounts },
      rpmWindow: windowStarts,
      rpmRecent: (recentStarts / recentWindowSec) * 60,
      rpmAvg: elapsedMs > 0 ? (this.sent / elapsedSec) * 60 : 0,
      latency: lat,
      ttfb,
      tokens: { ...this.tokens, perSec: this.tokens.total / elapsedSec },
      dropped: this.dropped,
      vus: this.vus,
      vusMax: this.vusMax,
      rateLimit: { ...this.rateLimit },
      bytes: { received: this.bytesReceived, sent: this.bytesSent },
      series: this.series(180, nowMs),
    };
  }
}

// Estimate the sustainable request rate from per-second buckets and the point
// where the provider started rejecting requests (429 / errors).
export function analyzeLimit(series) {
  if (!series || series.length < 3) return { sustainableRPM: null, limitRPM: null };
  // Adaptive smoothing window: short tests use most of their buckets, long
  // tests are smoothed over 10s so occasional latency jitter doesn't look
  // like a rate-limit ceiling.
  const window = Math.max(2, Math.min(10, series.length - 1));

  const windows = [];
  for (let i = 0; i + window <= series.length; i++) {
    let reqs = 0;
    let starts = 0;
    let fail = 0;
    let limited = 0;
    let span = 0;
    for (let j = i; j < i + window; j++) {
      const b = series[j];
      reqs += b.reqs;
      starts += b.starts || 0;
      fail += b.fail;
      limited += b.statuses['429'] || 0;
    }
    const first = series[i].t;
    const last = series[i + window - 1].t;
    span = Math.max((last - first) / 1000 + 1, 1);
    if (starts === 0 && reqs === 0) continue;
    windows.push({
      t: first,
      rpm: (starts / span) * 60,
      errorRate: reqs ? fail / reqs : 0,
      limitedRate: reqs ? limited / reqs : 0,
    });
  }

  let sustainable = null;
  for (const w of windows) {
    if (w.errorRate <= 0.02 && (sustainable == null || w.rpm > sustainable.rpm)) sustainable = w;
  }
  let limit = null;
  for (const w of windows) {
    if (w.limitedRate > 0.05 || w.errorRate > 0.1) {
      limit = w;
      break;
    }
  }
  return {
    sustainableRPM: sustainable ? Math.round(sustainable.rpm) : null,
    sustainableErrorRate: sustainable ? sustainable.errorRate : null,
    limitRPM: limit ? Math.round(limit.rpm) : null,
    limitErrorRate: limit ? limit.errorRate : null,
  };
}

// Convert k6's --summary-export JSON into the shape the UI expects.
export function normalizeSummary(summary) {
  if (!summary || !summary.metrics) return null;
  const m = summary.metrics;
  const pick = (name, keys) => {
    const obj = m[name];
    if (!obj) return null;
    const out = {};
    for (const k of keys) if (obj[k] != null) out[k] = obj[k];
    return out;
  };
  return {
    httpReqs: m.http_reqs ? { count: m.http_reqs.count, rate: m.http_reqs.rate } : null,
    failed: m.http_req_failed ? { rate: m.http_req_failed.rate, passes: m.http_req_failed.passes, fails: m.http_req_failed.fails } : null,
    duration: pick('http_req_duration', ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)']),
    waiting: pick('http_req_waiting', ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)']),
    dropped: m.dropped_iterations ? m.dropped_iterations.count : 0,
    tokensTotal: m.tokens_total ? m.tokens_total.count : 0,
    tokensPrompt: m.tokens_prompt ? m.tokens_prompt.count : 0,
    tokensCompletion: m.tokens_completion ? m.tokens_completion.count : 0,
    dataReceived: m.data_received ? m.data_received.count : 0,
    dataSent: m.data_sent ? m.data_sent.count : 0,
  };
}
