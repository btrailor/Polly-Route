import http from 'http';
import { URL } from 'url';

/**
 * llama.cpp endpoint diagnostics (Pivot 3/4 early wiring, 2026-07-18).
 *
 * Unlike Ollama, llama-server guarantees its context size: `-c 32768` at launch
 * is exactly what GET /props reports. This replaces the "effective num_ctx=unknown
 * adequate=false" guesswork that kept the reliability guard from ever trusting
 * local models.
 */

export interface LlamacppEndpoint {
  baseUrl: string;   // e.g. http://127.0.0.1:4210
  model: string;     // alias served, e.g. qwen2.5-coder:32b
  minCtx: number;    // minimum acceptable n_ctx for this endpoint's role
  timeoutMs?: number; // optional per-endpoint dispatch timeout override
  charsPerToken?: number; // optional per-endpoint chars-per-token ratio
  headroomTokens?: number; // optional per-endpoint output headroom
}

export interface LlamacppProbeResult {
  endpoint: LlamacppEndpoint;
  reachable: boolean;
  nCtx: number | null;
  adequate: boolean;
  detail: string;
}

function httpGetJson(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

export async function probeLlamacppEndpoint(
  ep: LlamacppEndpoint,
  timeoutMs = 2000,
): Promise<LlamacppProbeResult> {
  const url = new URL('/props', ep.baseUrl).toString();
  const res = await httpGetJson(url, timeoutMs);
  if (res.status !== 200) {
    return { endpoint: ep, reachable: false, nCtx: null, adequate: false,
      detail: `llamacpp ${ep.model} @ ${ep.baseUrl} unreachable (status ${res.status})` };
  }
  try {
    const props = JSON.parse(res.body);
    const nCtx: number | null =
      props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? null;
    if (nCtx === null) {
      return { endpoint: ep, reachable: true, nCtx: null, adequate: false,
        detail: `llamacpp ${ep.model}: /props reachable but n_ctx missing` };
    }
    const adequate = nCtx >= ep.minCtx;
    return { endpoint: ep, reachable: true, nCtx, adequate,
      detail: `llamacpp ${ep.model}: n_ctx=${nCtx} guaranteed, min=${ep.minCtx}, adequate=${adequate}` };
  } catch {
    return { endpoint: ep, reachable: true, nCtx: null, adequate: false,
      detail: `llamacpp ${ep.model}: /props returned unparseable body` };
  }
}

export async function probeAllLlamacpp(
  endpoints: LlamacppEndpoint[] | undefined,
  timeoutMs = 2000,
): Promise<{ anyConfigured: boolean; allAdequate: boolean; results: LlamacppProbeResult[] }> {
  if (!endpoints || endpoints.length === 0) {
    return { anyConfigured: false, allAdequate: false, results: [] };
  }
  const results = await Promise.all(endpoints.map((ep) => probeLlamacppEndpoint(ep, timeoutMs)));
  return { anyConfigured: true, allAdequate: results.every((r) => r.adequate), results };
}
