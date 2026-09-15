import fs from 'fs';
import path from 'path';
import { Config } from './config.js';

export interface ReliabilityEntry {
  ts: string; // ISO 8601
  persona: string;
  task_type: string;
  provider: string;
  success: boolean;
  failure_class: 'config_error' | 'model_error' | 'ambiguous' | 'success';
}

export interface ReliabilityWindow {
  persona: string;
  task_type: string;
  window_days: number;
  attempts: number;
  successes: number;
  failures: number;
  success_rate: number;
  cloud_bias: boolean;
}

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_GC_DAYS = 30;
const DEFAULT_MIN_ATTEMPTS = 3;
const DEFAULT_MIN_SUCCESS_RATE = 0.6;

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

function resolveReliabilityPath(config?: Config): string {
  if (process.env.POLLY_RELIABILITY_PATH) return path.resolve(process.env.POLLY_RELIABILITY_PATH);
  const workspaceSibling = path.resolve(__dirname, '..', '..', 'system', 'persona-reliability.jsonl');
  if (fs.existsSync(path.dirname(workspaceSibling))) return workspaceSibling;
  return path.join(process.env.HOME || '.', '.openclaw', 'workspace', 'system', 'persona-reliability.jsonl');
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function withinWindow(ts: string, cutoff: Date): boolean {
  return new Date(ts) >= cutoff;
}

export function getReliabilityPath(config?: Config): string {
  return resolveReliabilityPath(config);
}

function reliabilityConfig(config?: Config) {
  const rc = config?.reliability;
  return {
    enabled: rc?.enabled ?? false,
    windowDays: rc?.windowDays ?? DEFAULT_WINDOW_DAYS,
    gcDays: rc?.gcDays ?? DEFAULT_GC_DAYS,
    minAttempts: rc?.minAttempts ?? DEFAULT_MIN_ATTEMPTS,
    minSuccessRate: rc?.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE,
  };
}

/** Append a reliability event. Config errors are still recorded for diagnostics. */
export function recordReliability(entry: ReliabilityEntry, config?: Config): void {
  try {
    const filePath = getReliabilityPath(config);
    ensureDir(filePath);
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(filePath, line, 'utf-8');
  } catch (e) {
    log('[reliability] failed to record entry', { error: (e as Error).message });
  }
}

/** Record a successful local completion so the success rate denominator is real. */
export function recordLocalSuccess(
  partial: Omit<ReliabilityEntry, 'success' | 'failure_class'>,
  config?: Config,
): void {
  recordReliability(
    { ...partial, success: true, failure_class: 'success' },
    config,
  );
}

/** Remove entries older than gcDays. */
export function gcReliability(config?: Config): void {
  try {
    const filePath = getReliabilityPath(config);
    if (!fs.existsSync(filePath)) return;
    const rc = reliabilityConfig(config);
    const cutoff = new Date(Date.now() - rc.gcDays * 24 * 60 * 60 * 1000);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const kept: string[] = [];
    let removed = 0;
    let malformed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ReliabilityEntry;
        if (withinWindow(parsed.ts, cutoff)) kept.push(line);
        else removed++;
      } catch {
        malformed++;
        // drop unparseable lines
      }
    }
    fs.writeFileSync(filePath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8');
    log('reliability-gc', { removed, malformed, kept: kept.length });
  } catch (e) {
    log('[reliability] gc failed', { error: (e as Error).message });
  }
}

function readWindowEntries(cutoff: Date, config?: Config): ReliabilityEntry[] {
  const filePath = getReliabilityPath(config);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const entries: ReliabilityEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ReliabilityEntry;
      // Count only countable outcomes: successful local completions and genuine
      // model-level failures. Gateway/config errors and ambiguous failures are
      // logged for diagnostics but do not move the success-rate needle.
      const countable =
        parsed.failure_class === 'success' || parsed.failure_class === 'model_error';
      if (withinWindow(parsed.ts, cutoff) && countable) {
        entries.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return entries;
}

/**
 * Compute per-(persona, task_type) reliability over the configured window.
 * Only counts entries whose failure_class is `model_error`.
 */
export function reliabilityWindow(
  persona: string,
  taskType: string,
  config?: Config,
): ReliabilityWindow {
  const rc = reliabilityConfig(config);
  const cutoff = new Date(Date.now() - rc.windowDays * 24 * 60 * 60 * 1000);
  const entries = readWindowEntries(cutoff, config).filter(
    e => e.persona === persona && e.task_type === taskType
  );

  const attempts = entries.length;
  const successes = entries.filter(e => e.success).length;
  const failures = attempts - successes;
  const successRate = attempts === 0 ? 1 : successes / attempts;
  const cloudBias = attempts >= rc.minAttempts && successRate < rc.minSuccessRate;

  return {
    persona,
    task_type: taskType,
    window_days: rc.windowDays,
    attempts,
    successes,
    failures,
    success_rate: successRate,
    cloud_bias: cloudBias,
  };
}

/**
 * Apply a soft reliability bias to a frontier-gate target.
 * Only downgrades LOCAL / LOCAL+CTX toward CLOUD; never upgrades.
 *
 * The guard `active` flag reflects the R3-F.1 readiness checklist: the bias is
 * applied only when the feedback loop is both enabled *and* the gateway/config
 * diagnostics show a healthy local stack, so misconfiguration failures do not
 * pigeonhole a persona to the cloud.
 */
export function adjustTargetByReliability(
  target: 'LOCAL' | 'LOCAL+CTX' | 'CLOUD',
  persona: string,
  taskType: string,
  config?: Config,
  active = false,
): 'LOCAL' | 'LOCAL+CTX' | 'CLOUD' {
  const rc = reliabilityConfig(config);
  if (!rc.enabled || !active) return target;
  const window = reliabilityWindow(persona, taskType, config);
  if (!window.cloud_bias) return target;
  if (target === 'LOCAL') return 'LOCAL+CTX';
  if (target === 'LOCAL+CTX') return 'CLOUD';
  return target;
}
