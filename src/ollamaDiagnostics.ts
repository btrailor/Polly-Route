import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Config, OllamaModel } from './config.js';
import { probeAllLlamacpp } from './llamacppDiagnostics.js';

const MIN_CONTEXT_BY_WEIGHT = {
  light: 4096,
  medium: 8192,
  heavy: 32768,
};

export interface DiagnosticResult {
  ok: boolean;
  reachable: boolean;
  modelsPresent: boolean;
  contextAdequate: boolean;
  proxyOk: boolean;
  details: string[];
}

export interface OllamaShow {
  parameters?: string;
  [key: string]: unknown;
}

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

/** Check if proxy environment variables could interfere with Ollama localhost calls. */
function proxyOk(baseUrl: string): { ok: boolean; detail: string } {
  const u = new URL(baseUrl);
  const isLocalhost = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (!isLocalhost) return { ok: true, detail: 'non-localhost baseUrl, proxy check skipped' };

  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(s => s.trim().toLowerCase());

  const localhostNoProxy = noProxy.some(h => h === 'localhost' || h === '127.0.0.1');
  if ((httpProxy || httpsProxy) && !localhostNoProxy) {
    return { ok: false, detail: `proxy env set without NO_PROXY for localhost/127.0.0.1` };
  }
  return { ok: true, detail: 'proxy env does not interfere with localhost' };
}

/** Simple GET probe with timeout. */
function httpGetJson(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

function extractParam(params: string | undefined, key: string): number | undefined {
  if (!params) return undefined;
  const re = new RegExp(`${key}\\s+(\\d+)`, 'i');
  const m = params.match(re);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Run a one-time (or periodic) diagnostic of the local Ollama gateway.
 * Returns an object that the reliability guard uses to decide whether
 * reliability feedback may be active.
 */
export async function diagnoseOllama(config: Config): Promise<DiagnosticResult> {
  const details: string[] = [];
  const baseUrl = config.ollama.baseUrl;

  // A. Proxy sanity
  const proxy = proxyOk(baseUrl);
  details.push(proxy.detail);
  if (!proxy.ok) {
    return { ok: false, reachable: false, modelsPresent: false, contextAdequate: false, proxyOk: false, details };
  }

  // B. Reachability
  const tagsUrl = `${baseUrl}/api/tags`;
  const tagsRes = await httpGetJson(tagsUrl, 1500);
  const reachable = tagsRes.status === 200;
  details.push(`ollama /api/tags status=${tagsRes.status}`);
  if (!reachable) {
    return { ok: false, reachable: false, modelsPresent: false, contextAdequate: false, proxyOk: true, details };
  }

  let availableModels: string[] = [];
  try {
    const parsed = JSON.parse(tagsRes.body);
    availableModels = (parsed.models ?? []).map((m: any) => m.name ?? m.model ?? '').filter(Boolean);
  } catch {
    details.push('failed to parse /api/tags response');
  }

  // C. Configured models exist
  const configuredIds = config.ollama.models.map(m => m.id);
  const modelsPresent = configuredIds.every(id => availableModels.some(name => name === id || name.startsWith(`${id}:`)));
  details.push(`configured models: ${configuredIds.join(', ')}; available: ${availableModels.join(', ')}`);

  if (!modelsPresent) {
    return { ok: false, reachable: true, modelsPresent: false, contextAdequate: false, proxyOk: true, details };
  }

  // D. Effective context length for each model
  let contextAdequate = true;
  for (const model of config.ollama.models) {
    const showUrl = `${baseUrl}/api/show`;
    const showBody = JSON.stringify({ name: model.id });
    const showRes = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = http.request(showUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(showBody) },
        timeout: 1500,
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
      req.write(showBody);
      req.end();
    });

    let effectiveNumCtx: number | undefined;
    if (showRes.status === 200) {
      try {
        const parsed = JSON.parse(showRes.body) as OllamaShow;
        effectiveNumCtx = extractParam(parsed.parameters, 'num_ctx');
      } catch { /* fall through */ }
    }

    const minCtx = MIN_CONTEXT_BY_WEIGHT[model.weight];
    const adequate = effectiveNumCtx !== undefined && effectiveNumCtx >= minCtx;
    details.push(`model ${model.id} effective num_ctx=${effectiveNumCtx ?? 'unknown'} min=${minCtx} adequate=${adequate}`);
    if (!adequate) contextAdequate = false;
  }

  // E. llama.cpp endpoints (Pivot 3/4): guaranteed n_ctx via GET /props.
  // If every configured llama-server endpoint reports adequate context, the
  // local lane is trustworthy even when Ollama's num_ctx probe is inconclusive.
  if (config.llamacpp?.endpoints?.length) {
    const { allAdequate, results } = await probeAllLlamacpp(config.llamacpp.endpoints);
    for (const r of results) details.push(r.detail);
    if (allAdequate && !contextAdequate) {
      details.push('context adequacy satisfied by llama.cpp guaranteed-n_ctx endpoints (ollama probe inconclusive)');
      contextAdequate = true;
    } else if (!allAdequate) {
      details.push('llama.cpp endpoint(s) configured but not all adequate — see details above');
    }
  }

  const ok = contextAdequate;
  log('ollama-diagnostics', { ok, reachable, modelsPresent, contextAdequate, proxyOk: true, detailCount: details.length });
  return { ok, reachable: true, modelsPresent: true, contextAdequate, proxyOk: true, details };
}

export type FailureClass = 'config_error' | 'model_error' | 'ambiguous';

export interface ProbeResult {
  model: string;
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
  latencyMs: number;
}

/**
 * Run a synthetic end-to-end probe against a local model.
 *
 * Sends a tiny chat completion and checks that the model returns a coherent
 * HTTP 200 within the timeout. This is the final readiness gate before the
 * persona reliability feedback loop is allowed to count local failures.
 *
 * Probes are lightweight (one short completion per model) and run only at
 * startup or when diagnostics are refreshed.
 */
export async function probeLocalCapability(baseUrl: string, modelId: string, timeoutMs = 30000): Promise<ProbeResult> {
  const startedAt = Date.now();
  const url = new URL(`${baseUrl}/v1/chat/completions`);
  const payload = Buffer.from(JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
    max_tokens: 10,
    temperature: 0,
    stream: false,
  }));

  return new Promise((resolve) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const ok = res.statusCode === 200 && body.toLowerCase().includes('ok');
        resolve({
          model: modelId,
          ok,
          status: res.statusCode ?? 0,
          body: body.slice(0, 200),
          latencyMs: Date.now() - startedAt,
        });
      });
    });

    req.on('error', (e) => resolve({ model: modelId, ok: false, error: e.message, latencyMs: Date.now() - startedAt }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ model: modelId, ok: false, error: `timeout after ${timeoutMs}ms`, latencyMs: Date.now() - startedAt });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Run capability probes for every configured local model and return a map.
 */
export async function probeAllLocalCapabilities(
  config: Config,
  timeoutMs = 30000,
): Promise<{ probes: ProbeResult[]; allOk: boolean }> {
  const probes = await Promise.all(
    config.ollama.models.map(m => probeLocalCapability(config.ollama.baseUrl, m.id, timeoutMs))
  );
  const allOk = probes.every(p => p.ok);
  log('local-capability-probes', { count: probes.length, allOk, models: probes.map(p => ({ model: p.model, ok: p.ok, latencyMs: p.latencyMs })) });
  return { probes, allOk };
}

/**
 * Classify a local (Ollama-side) failure so the reliability logger knows
 * whether to count it against the persona's track record.
 */
export function classifyLocalFailure(error: unknown, status?: number, body?: string): FailureClass {
  const msg = String(error?.toString() ?? '').toLowerCase();
  const bodyStr = (body ?? '').toLowerCase();

  if (!status && (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('timeout'))) {
    return 'config_error';
  }
  if (status === 404) return 'config_error';
  if (status === 502 || status === 504) return 'config_error';
  if (status === 503) return 'config_error';
  if (status === 400 && (bodyStr.includes('context') || bodyStr.includes('too many tokens') || bodyStr.includes('length'))) {
    return 'config_error';
  }
  if (status && status >= 500 && status < 600) return 'config_error';

  if (status && status >= 200 && status < 300) {
    if (bodyStr.includes('tool_calls') || bodyStr.includes('json parse')) return 'model_error';
    if (bodyStr.includes('i cannot') || bodyStr.includes('i\'m sorry') || bodyStr.includes('refuse')) return 'ambiguous';
    return 'ambiguous';
  }

  return 'model_error';
}
