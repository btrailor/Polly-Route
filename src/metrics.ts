import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricsEvent =
  | RoutingDecisionEvent
  | CaptureEvent
  | BloomEvent;

export interface RoutingDecisionEvent {
  ts: string; // ISO 8601
  event: 'routing_decision';
  complexity: 'LIGHT' | 'MEDIUM' | 'HEAVY';
  vault: 'DIRECT' | 'ADJACENT' | 'ABSENT';
  target: 'LOCAL' | 'LOCAL+CTX' | 'CLOUD';
  provider: string;
  /** Whether the chosen provider returned a successful response for this decision. */
  outcome: 'success' | 'fallback' | 'error';
  /** Whether a skill covered the request when vault knowledge was absent. */
  skill?: boolean;
  /** Name of the matching skill, if any. */
  skillName?: string;
  /** Whether a conductor domain matched the request. */
  conductor?: boolean;
  /** Domain id that matched, if any. */
  conductorDomain?: string;
  /** Wall-clock latency of the dispatch, in milliseconds. */
  ms?: number;
  /** Estimated cost of the dispatch in USD. */
  costUsd?: number;
  /** Input tokens reported by the provider, when available. */
  inputTokens?: number;
  /** Output tokens reported by the provider, when available. */
  outputTokens?: number;
}

export interface CaptureEvent {
  ts: string;
  event: 'capture';
  provider: string;
  vault_gap: 'knowledge_gap' | 'capability_gap';
  complexity: 'LIGHT' | 'MEDIUM' | 'HEAVY';
  /** Whether the capture was actually written to the vault. */
  captured: boolean;
}

export interface BloomEvent {
  ts: string;
  event: 'bloom';
  /** Number of raw-ingest notes promoted in this bloom run. */
  notes_processed: number;
}

/** Per-provider usage rollup, used to answer "which providers are actually serving traffic". */
export interface ProviderBreakdown {
  provider: string;
  /** Total routing decisions attributed to this provider. */
  requests: number;
  /** Decisions that returned a successful response. */
  successes: number;
  /** Decisions that ended in an error. */
  errors: number;
  /** True when the provider is a local backend (ollama/ or llamacpp/). */
  local: boolean;
  /** Summed estimated cost in USD. */
  costUsd: number;
  /** Mean latency in milliseconds, when timing was recorded. */
  avgMs: number | null;
  /** Summed input tokens, when the provider reported usage. */
  inputTokens: number;
  /** Summed output tokens, when the provider reported usage. */
  outputTokens: number;
}

export interface MetricSnapshot {
  window_days: number;
  total_requests: number;
  cloud_requests: number;
  cloud_dependency_ratio: number | null;
  local_dispatched: number;
  local_completed: number;
  local_first_success_rate: number | null;
  vault_direct: number;
  vault_adjacent: number;
  vault_absent: number;
  knowledge_coverage_score: number | null;
  coverage_gap_rate: number | null;
  captured_notes: number;
  capture_rate: number | null;
  bloom_lag: number;
  /** Per-provider usage rollup for the whole window. */
  providers: ProviderBreakdown[];
  /** Total estimated USD spend across all providers in the window. */
  total_cost_usd: number;
}

export interface DailyBucket {
  date: string; // YYYY-MM-DD
  total_requests: number;
  cloud_requests: number;
  cloud_dependency_ratio: number | null;
  local_dispatched: number;
  local_completed: number;
  local_first_success_rate: number | null;
  vault_direct: number;
  vault_adjacent: number;
  vault_absent: number;
  knowledge_coverage_score: number | null;
  coverage_gap_rate: number | null;
  captured_notes: number;
  capture_rate: number | null;
  captures_attempted: number;
  bloom_lag: number;
  bloom_processed: number;
  /** Per-provider usage rollup for this day. */
  providers: ProviderBreakdown[];
  /** Total estimated USD spend for this day. */
  total_cost_usd: number;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function resolveMetricsPath(): string {
  if (process.env.POLLY_METRICS_PATH) return path.resolve(process.env.POLLY_METRICS_PATH);
  // Works for both src/ (ts-node) and dist/ (compiled) because each is two
  // levels below the workspace root.
  const workspaceSibling = path.resolve(__dirname, '..', '..', 'system', 'polly-metrics.jsonl');
  if (fs.existsSync(path.dirname(workspaceSibling))) return workspaceSibling;
  return path.join(process.env.HOME || '.', '.openclaw', 'workspace', 'system', 'polly-metrics.jsonl');
}

export function getMetricsPath(): string {
  return resolveMetricsPath();
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isoDate(ts: string | Date): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return d.toISOString().slice(0, 10);
}

function withinWindow(ts: string | Date, cutoff: Date): boolean {
  return (typeof ts === 'string' ? new Date(ts) : ts) >= cutoff;
}

// ---------------------------------------------------------------------------
// Writing events
// ---------------------------------------------------------------------------

/** Append a metrics event to the rolling JSONL log. */
export function recordMetrics(event: MetricsEvent): void {
  try {
    const filePath = getMetricsPath();
    ensureDir(filePath);
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(filePath, line, 'utf-8');
  } catch (e) {
    // Metrics recording must never break request handling.
    console.error('[metrics] failed to record event:', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// In-memory cache for window events
// ---------------------------------------------------------------------------

interface MetricsCache {
  path: string;
  mtimeMs: number;
  size: number;
  events: MetricsEvent[];
}

let metricsCache: MetricsCache | null = null;

/** Test-only hook to inspect the current cache state. */
export function metricsCacheState(): { path: string | null; mtimeMs: number | null; size: number | null; hit: boolean } {
  return {
    path: metricsCache?.path ?? null,
    mtimeMs: metricsCache?.mtimeMs ?? null,
    size: metricsCache?.size ?? null,
    hit: false,
  };
}

// ---------------------------------------------------------------------------
// Reading / aggregating
// ---------------------------------------------------------------------------

interface Aggregate {
  totalRequests: number;
  cloudRequests: number;
  localDispatched: number;
  localCompleted: number;
  vaultDirect: number;
  vaultAdjacent: number;
  vaultAbsent: number;
  capturedNotes: number;
  capturesAttempted: number;
  bloomProcessed: number;
  /** Per-provider rollup accumulator. */
  providerStats: Map<string, ProviderAccumulator>;
  totalCostUsd: number;
}

/** Mutable per-provider counters used while folding events into an Aggregate. */
interface ProviderAccumulator {
  requests: number;
  successes: number;
  errors: number;
  costUsd: number;
  msTotal: number;
  msCount: number;
  inputTokens: number;
  outputTokens: number;
}

function emptyAggregate(): Aggregate {
  return {
    totalRequests: 0,
    cloudRequests: 0,
    localDispatched: 0,
    localCompleted: 0,
    vaultDirect: 0,
    vaultAdjacent: 0,
    vaultAbsent: 0,
    capturedNotes: 0,
    capturesAttempted: 0,
    bloomProcessed: 0,
    providerStats: new Map(),
    totalCostUsd: 0,
  };
}

function isLocalProvider(provider: string): boolean {
  return provider.startsWith('ollama/') || provider.startsWith('llamacpp/');
}

function isCloudProvider(provider: string): boolean {
  return !isLocalProvider(provider);
}

/** Fold one routing decision into the per-provider rollup. */
function aggregateProvider(acc: Aggregate, ev: RoutingDecisionEvent): void {
  const provider = ev.provider || 'none';
  let stat = acc.providerStats.get(provider);
  if (!stat) {
    stat = { requests: 0, successes: 0, errors: 0, costUsd: 0, msTotal: 0, msCount: 0, inputTokens: 0, outputTokens: 0 };
    acc.providerStats.set(provider, stat);
  }
  stat.requests += 1;
  if (ev.outcome === 'success') stat.successes += 1;
  if (ev.outcome === 'error') stat.errors += 1;
  if (typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd)) {
    stat.costUsd += ev.costUsd;
    acc.totalCostUsd += ev.costUsd;
  }
  if (typeof ev.ms === 'number' && Number.isFinite(ev.ms)) {
    stat.msTotal += ev.ms;
    stat.msCount += 1;
  }
  if (typeof ev.inputTokens === 'number' && Number.isFinite(ev.inputTokens)) stat.inputTokens += ev.inputTokens;
  if (typeof ev.outputTokens === 'number' && Number.isFinite(ev.outputTokens)) stat.outputTokens += ev.outputTokens;
}

/** Render the per-provider rollup as a stable, sorted list (busiest first). */
function providerBreakdown(acc: Aggregate): ProviderBreakdown[] {
  return [...acc.providerStats.entries()]
    .map(([provider, stat]) => ({
      provider,
      requests: stat.requests,
      successes: stat.successes,
      errors: stat.errors,
      local: isLocalProvider(provider),
      costUsd: stat.costUsd,
      avgMs: stat.msCount > 0 ? stat.msTotal / stat.msCount : null,
      inputTokens: stat.inputTokens,
      outputTokens: stat.outputTokens,
    }))
    .sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider));
}

function aggregateEvent(acc: Aggregate, ev: MetricsEvent): void {
  switch (ev.event) {
    case 'routing_decision': {
      acc.totalRequests += 1;
      if (isCloudProvider(ev.provider)) acc.cloudRequests += 1;
      aggregateProvider(acc, ev);
      if (ev.target === 'LOCAL' || ev.target === 'LOCAL+CTX') {
        acc.localDispatched += 1;
        // Count as a local completion only when the local provider actually
        // returned the successful response. Both local backends count:
        // `ollama/<model>` and `llamacpp/<model>`. Restricting this to
        // `ollama/` alone silently discarded every successful llama.cpp
        // completion, understating local_first_success_rate and inflating
        // the apparent cloud dependency.
        if (ev.outcome === 'success' && isLocalProvider(ev.provider)) {
          acc.localCompleted += 1;
        }
      }
      if (ev.vault === 'DIRECT') acc.vaultDirect += 1;
      else if (ev.vault === 'ADJACENT') acc.vaultAdjacent += 1;
      else if (ev.vault === 'ABSENT') acc.vaultAbsent += 1;
      break;
    }
    case 'capture': {
      acc.capturesAttempted += 1;
      if (ev.captured) acc.capturedNotes += 1;
      break;
    }
    case 'bloom': {
      acc.bloomProcessed += ev.notes_processed;
      break;
    }
  }
}

function readWindowEvents(cutoff: Date): MetricsEvent[] {
  const filePath = getMetricsPath();
  if (!fs.existsSync(filePath)) {
    metricsCache = null;
    return [];
  }

  const stat = fs.statSync(filePath);
  if (
    metricsCache &&
    metricsCache.path === filePath &&
    metricsCache.mtimeMs === stat.mtimeMs &&
    metricsCache.size === stat.size
  ) {
    // The file has not changed since our last parse; reuse cached events.
    // Filter again by cutoff in case the rolling window advanced.
    return metricsCache.events.filter(ev => withinWindow(ev.ts, cutoff));
  }

  const events: MetricsEvent[] = [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MetricsEvent;
      if (!parsed.ts || !withinWindow(parsed.ts, cutoff)) continue;
      events.push(parsed);
    } catch {
      // Ignore malformed lines; the log is append-only and should recover.
    }
  }

  metricsCache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, events };
  return events;
}

function computeSnapshot(acc: Aggregate): MetricSnapshot {
  return {
    window_days: WINDOW_DAYS,
    total_requests: acc.totalRequests,
    cloud_requests: acc.cloudRequests,
    cloud_dependency_ratio: ratio(acc.cloudRequests, acc.totalRequests),
    local_dispatched: acc.localDispatched,
    local_completed: acc.localCompleted,
    local_first_success_rate: ratio(acc.localCompleted, acc.localDispatched),
    vault_direct: acc.vaultDirect,
    vault_adjacent: acc.vaultAdjacent,
    vault_absent: acc.vaultAbsent,
    knowledge_coverage_score: ratio(acc.vaultDirect + acc.vaultAdjacent, acc.totalRequests),
    coverage_gap_rate: ratio(acc.vaultAbsent, acc.totalRequests),
    captured_notes: acc.capturedNotes,
    capture_rate: ratio(acc.capturedNotes, acc.cloudRequests),
    bloom_lag: Math.max(0, acc.capturedNotes - acc.bloomProcessed),
    providers: providerBreakdown(acc),
    total_cost_usd: acc.totalCostUsd,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

/** Return a rolling 7-day snapshot of all tracked metrics. */
export function metricsSnapshot(): MetricSnapshot {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * MS_PER_DAY);
  const events = readWindowEvents(cutoff);
  const acc = emptyAggregate();
  for (const ev of events) aggregateEvent(acc, ev);
  return computeSnapshot(acc);
}

/** Shape returned by the /metrics endpoint. */
export interface MetricsTimeSeries {
  generated_at: string;
  window_days: number;
  /** Per-day buckets, oldest first. */
  days: DailyBucket[];
  /** Window-wide totals. */
  summary: MetricSnapshot;
  /** Window-wide per-provider rollup, busiest first. */
  providers: ProviderBreakdown[];
  /** Window-wide estimated spend in USD. */
  total_cost_usd: number;
}

/** Return per-day time-series for the last 7 days. */
export function metricsTimeSeries(): MetricsTimeSeries {
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY);
  const events = readWindowEvents(cutoff);

  // Initialise 7 daily buckets ending today.
  const buckets = new Map<string, Aggregate>();
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const d = new Date(now.getTime() - i * MS_PER_DAY);
    buckets.set(isoDate(d), emptyAggregate());
  }

  for (const ev of events) {
    const date = isoDate(ev.ts);
    const acc = buckets.get(date);
    if (!acc) continue; // outside the 7 explicit buckets
    aggregateEvent(acc, ev);
  }

  const days: DailyBucket[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * MS_PER_DAY);
    const date = isoDate(d);
    const acc = buckets.get(date)!;
    days.push({
      date,
      total_requests: acc.totalRequests,
      cloud_requests: acc.cloudRequests,
      cloud_dependency_ratio: ratio(acc.cloudRequests, acc.totalRequests),
      local_dispatched: acc.localDispatched,
      local_completed: acc.localCompleted,
      local_first_success_rate: ratio(acc.localCompleted, acc.localDispatched),
      vault_direct: acc.vaultDirect,
      vault_adjacent: acc.vaultAdjacent,
      vault_absent: acc.vaultAbsent,
      knowledge_coverage_score: ratio(acc.vaultDirect + acc.vaultAdjacent, acc.totalRequests),
      coverage_gap_rate: ratio(acc.vaultAbsent, acc.totalRequests),
      captured_notes: acc.capturedNotes,
      capture_rate: ratio(acc.capturedNotes, acc.cloudRequests),
      captures_attempted: acc.capturesAttempted,
      bloom_lag: Math.max(0, acc.capturedNotes - acc.bloomProcessed),
      bloom_processed: acc.bloomProcessed,
      providers: providerBreakdown(acc),
      total_cost_usd: acc.totalCostUsd,
    });
  }

  const all = aggregateAll(events);

  return {
    generated_at: now.toISOString(),
    window_days: WINDOW_DAYS,
    days,
    // Window-wide rollup so a dashboard can read totals and the per-provider
    // breakdown without having to sum the daily buckets itself.
    summary: computeSnapshot(all),
    providers: providerBreakdown(all),
    total_cost_usd: all.totalCostUsd,
  };
}

/** Fold a flat list of events into one Aggregate. */
function aggregateAll(events: MetricsEvent[]): Aggregate {
  const acc = emptyAggregate();
  for (const ev of events) aggregateEvent(acc, ev);
  return acc;
}

// ---------------------------------------------------------------------------
// Convenience helpers for callers
// ---------------------------------------------------------------------------

export function recordRoutingDecision(
  complexity: RoutingDecisionEvent['complexity'],
  vault: RoutingDecisionEvent['vault'],
  target: RoutingDecisionEvent['target'],
  provider: string,
  outcome: RoutingDecisionEvent['outcome'],
  skill?: boolean,
  skillName?: string,
  conductor?: boolean,
  conductorDomain?: string,
  telemetry?: RoutingDecisionTelemetry,
): void {
  recordMetrics({
    ts: new Date().toISOString(),
    event: 'routing_decision',
    complexity,
    vault,
    target,
    provider,
    outcome,
    skill,
    skillName,
    conductor,
    conductorDomain,
    ...(telemetry ?? {}),
  });
}

/** Optional per-dispatch telemetry recorded alongside a routing decision. */
export interface RoutingDecisionTelemetry {
  ms?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function recordCapture(
  provider: string,
  vault_gap: CaptureEvent['vault_gap'],
  complexity: CaptureEvent['complexity'],
  captured: boolean,
): void {
  recordMetrics({
    ts: new Date().toISOString(),
    event: 'capture',
    provider,
    vault_gap,
    complexity,
    captured,
  });
}

export function recordBloom(notesProcessed: number): void {
  recordMetrics({
    ts: new Date().toISOString(),
    event: 'bloom',
    notes_processed: notesProcessed,
  });
}
