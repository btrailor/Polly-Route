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
  };
}

function isCloudProvider(provider: string): boolean {
  return !provider.startsWith('ollama/') && !provider.startsWith('llamacpp/');
}

function aggregateEvent(acc: Aggregate, ev: MetricsEvent): void {
  switch (ev.event) {
    case 'routing_decision': {
      acc.totalRequests += 1;
      if (isCloudProvider(ev.provider)) acc.cloudRequests += 1;
      if (ev.target === 'LOCAL' || ev.target === 'LOCAL+CTX') {
        acc.localDispatched += 1;
        // Count as a local completion only when the local provider actually
        // returned the successful response.
        if (ev.outcome === 'success' && ev.provider.startsWith('ollama/')) {
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
  if (!fs.existsSync(filePath)) return [];

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

/** Return per-day time-series for the last 7 days. */
export function metricsTimeSeries(): { generated_at: string; window_days: number; days: DailyBucket[] } {
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
    });
  }

  return {
    generated_at: now.toISOString(),
    window_days: WINDOW_DAYS,
    days,
  };
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
  });
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
