import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Config is read from a JSON file whose path is passed via CONFIG_PATH.
// Keeping it in a file avoids leaking the API key into the process list.
// ---------------------------------------------------------------------------
const cfg = JSON.parse(open(__ENV.CONFIG_PATH));

const tokensPrompt = new Counter('tokens_prompt');
const tokensCompletion = new Counter('tokens_completion');
const tokensTotal = new Counter('tokens_total');
const okRequests = new Counter('ok_requests');
const apiErrors = new Counter('api_errors');
const rateLimited = new Counter('rate_limit_429');
const requestStarts = new Counter('request_starts');

const rlRemainingReq = new Trend('rl_remaining_requests', true);
const rlRemainingTok = new Trend('rl_remaining_tokens', true);
const retryAfterMs = new Trend('retry_after_ms', true);

function buildScenarios() {
  const gracefulStop = '10s';
  const maxVUs = Math.max(1, cfg.maxVUs || 50);

  if (cfg.mode === 'arrival') {
    const pre = cfg.preAllocatedVUs > 0
      ? cfg.preAllocatedVUs
      : Math.max(2, Math.min(maxVUs, Math.ceil((cfg.targetRPM / 60) * (cfg.expectedLatencySec || 3))));
    return {
      main: {
        executor: 'constant-arrival-rate',
        exec: 'run',
        rate: cfg.targetRPM,
        timeUnit: '1m',
        duration: `${cfg.durationSec}s`,
        preAllocatedVUs: pre,
        maxVUs,
        gracefulStop,
        tags: { scenario: 'main' },
      },
    };
  }

  if (cfg.mode === 'vus') {
    return {
      main: {
        executor: 'constant-vus',
        exec: 'run',
        vus: cfg.vus,
        duration: `${cfg.durationSec}s`,
        gracefulStop,
        tags: { scenario: 'main' },
      },
    };
  }

  // ramp: linear rate ramp from startRPM to endRPM in `steps` stages
  const steps = Math.max(1, cfg.ramp.steps || 6);
  const stepSec = Math.max(1, cfg.ramp.stepSec || 10);
  const start = Math.max(1, cfg.ramp.startRPM);
  const end = Math.max(start + 1, cfg.ramp.endRPM);
  const stages = [];
  const seen = new Set();
  for (let i = 1; i <= steps; i++) {
    const target = Math.round(start + ((end - start) * i) / steps);
    if (seen.has(target)) continue;
    seen.add(target);
    stages.push({ duration: `${stepSec}s`, target });
  }
  return {
    main: {
      executor: 'ramping-arrival-rate',
      exec: 'run',
      startRate: start,
      timeUnit: '1m',
      stages,
      preAllocatedVUs: Math.max(2, Math.min(maxVUs, cfg.preAllocatedVUs || 10)),
      maxVUs,
      gracefulStop,
      tags: { scenario: 'main' },
    },
  };
}

export const options = {
  scenarios: buildScenarios(),
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  noConnectionReuse: !!cfg.noConnectionReuse,
  discardResponseBodies: false,
  thresholds: {},
};

const url = cfg.baseURL.replace(/\/+$/, '') + (cfg.endpoint || '/chat/completions');
const headers = Object.assign(
  { 'Content-Type': 'application/json', Accept: 'application/json' },
  cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  cfg.headers || {}
);
const timeout = `${cfg.timeoutMs || 60000}ms`;

// Each VU keeps a small budget of error-body logs so the operator can see
// *why* the provider rejected requests without flooding the log at high RPM.
let errorLogsLeft = 2;

function baseMessages() {
  const messages = [];
  if (cfg.systemPrompt) messages.push({ role: 'system', content: cfg.systemPrompt });
  messages.push({ role: 'user', content: cfg.prompt });
  return messages;
}

function readUsage(res) {
  try {
    const j = res.json();
    const u = j && j.usage;
    if (!u) return;
    const p = u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens;
    const c = u.completion_tokens != null ? u.completion_tokens : u.output_tokens;
    const t = u.total_tokens != null ? u.total_tokens : (p || 0) + (c || 0);
    if (p) tokensPrompt.add(p);
    if (c) tokensCompletion.add(c);
    if (t) tokensTotal.add(t);
  } catch (e) {
    // non-JSON response body, ignore
  }
}

function trackRateLimitHeaders(res) {
  const h = res.headers;
  const num = (v) => (v == null || v === '' ? null : Number(v));

  const remReq = num(h['X-Ratelimit-Remaining-Requests'] || h['X-RateLimit-Remaining-Requests']);
  const remTok = num(h['X-Ratelimit-Remaining-Tokens'] || h['X-RateLimit-Remaining-Tokens']);
  if (remReq != null && !isNaN(remReq)) rlRemainingReq.add(remReq);
  if (remTok != null && !isNaN(remTok)) rlRemainingTok.add(remTok);

  const ra = h['Retry-After'];
  if (ra != null && ra !== '') {
    const n = Number(ra);
    if (!isNaN(n)) retryAfterMs.add(n > 1000 ? n : n * 1000);
  }
}

export function run() {
  const messages = baseMessages();
  if (cfg.uniquePrompt) {
    messages[messages.length - 1].content += `\n\n[req ${Math.random().toString(36).slice(2)}]`;
  }

  const payload = {
    model: cfg.model,
    messages,
    max_tokens: cfg.maxTokens,
    stream: false,
  };
  if (cfg.temperature != null) payload.temperature = cfg.temperature;
  if (cfg.topP != null) payload.top_p = cfg.topP;
  if (cfg.extraBody && typeof cfg.extraBody === 'object') Object.assign(payload, cfg.extraBody);

  requestStarts.add(1);
  const res = http.post(url, JSON.stringify(payload), { headers, timeout, tags: { name: cfg.model } });

  if (res.status === 200) {
    okRequests.add(1);
    readUsage(res);
  } else {
    apiErrors.add(1, { status: String(res.status) });
    if (res.status === 429) rateLimited.add(1);
    if (errorLogsLeft > 0) {
      errorLogsLeft--;
      console.log(`[HTTP ${res.status}] ${String(res.body).slice(0, 300)}`);
    }
  }
  trackRateLimitHeaders(res);
}
