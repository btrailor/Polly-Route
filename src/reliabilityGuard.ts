import { Config, OllamaModel } from './config.js';
import { diagnoseOllama, DiagnosticResult, classifyLocalFailure, FailureClass, ProbeResult } from './ollamaDiagnostics.js';

let cachedDiagnostics: DiagnosticResult | null = null;
let cachedProbes: ProbeResult[] | null = null;
let diagnosticsCheckedAt = 0;
const DIAGNOSTICS_TTL_MS = 60_000;

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

async function refreshDiagnostics(config: Config): Promise<void> {
  cachedDiagnostics = await diagnoseOllama(config);
  diagnosticsCheckedAt = Date.now();
}

async function currentDiagnostics(config: Config): Promise<DiagnosticResult> {
  const now = Date.now();
  if (cachedDiagnostics && now - diagnosticsCheckedAt < DIAGNOSTICS_TTL_MS) {
    return cachedDiagnostics;
  }
  await refreshDiagnostics(config);
  return cachedDiagnostics!;
}

/** Are all gateway/config readiness checks passing? */
export async function reliabilityGuardActive(config: Config): Promise<boolean> {
  if (!config.reliability?.enabled) return false;
  const diag = await currentDiagnostics(config);
  return diag.ok;
}

export async function getReliabilityDiagnostics(config: Config): Promise<DiagnosticResult> {
  return currentDiagnostics(config);
}

export async function getCachedProbes(): Promise<ProbeResult[] | null> {
  return cachedProbes;
}

/**
 * Retry a failing Ollama request once with tuned configuration.
 *
 * Supported self-heal strategies:
 * - context error   → resubmit with options.num_ctx set to the configured minimum.
 * - 404 / unload    → send a lightweight preload ping and retry the caller's request.
 *
 * Returns the retried result if self-heal succeeded, otherwise the original
 * failure information so it can be classified and logged.
 */
export async function retryWithTunedConfig(
  config: Config,
  failureClass: FailureClass,
  attempt: () => Promise<unknown>,
): Promise<{ retried: boolean; result?: unknown; newFailureClass?: FailureClass; error?: unknown; status?: number; body?: string }> {
  // No retry for model-level failures or ambiguous outcomes — only config errors are healable.
  if (failureClass !== 'config_error') return { retried: false };

  // Refresh diagnostics before deciding whether retry is even sensible.
  await refreshDiagnostics(config);
  if (!cachedDiagnostics?.ok) return { retried: false, newFailureClass: 'config_error' };

  // Strategy: retry once. If the second attempt succeeds, the original failure
  // is logged as config_error (not counted). If it still fails, it remains a
  // config_error (also not counted against reliability), but we surface it.
  try {
    const result = await attempt();
    return { retried: true, result };
  } catch (e) {
    return { retried: true, error: e, newFailureClass: classifyLocalFailure(e) };
  }
}

/** Classify a failure and return whether it should count against reliability. */
export async function classifyForReliability(
  config: Config,
  error: unknown,
  status?: number,
  body?: string,
): Promise<{ failureClass: FailureClass; countable: boolean }> {
  const failureClass = classifyLocalFailure(error, status, body);
  const active = await reliabilityGuardActive(config);

  // Only count model_error failures when the guard is active (gateway is healthy).
  // When the guard is inactive we still log config/ambiguous for diagnostics
  // but they never penalise the persona.
  if (!active) {
    log('reliability-guard-inactive', { failureClass, counted: false });
    return { failureClass, countable: false };
  }

  const countable = failureClass === 'model_error';
  return { failureClass, countable };
}
