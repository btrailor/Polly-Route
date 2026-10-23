import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Log-signal counters
// ---------------------------------------------------------------------------

const SIGNAL_NAMES = [
  'skip-no-credentials',
  'ollama-skip-size',
  'local-request-exceeds-all-endpoints',
  'confidence-escalation-unavailable',
] as const;

export type LogSignalName = typeof SIGNAL_NAMES[number];

export interface LogSignalCounters {
  count: number;
  last_ts: string | null;
}

export interface LogSignalsResult {
  available: boolean;
  log_mtime: string | null;
  signals: Record<LogSignalName, LogSignalCounters>;
  total: number;
  error?: string;
}

const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_LINES = 10000;

function resolveLogPath(): string {
  if (process.env.POLLY_ROUTER_LOG_PATH) return path.resolve(process.env.POLLY_ROUTER_LOG_PATH);
  return path.join(process.env.HOME || '.', '.openclaw', 'logs', 'polly-router.log');
}

function parseLogLine(line: string): { ts: string | null; signal: LogSignalName | null } {
  const match = line.match(/^\[([^\]]+)\]\s+(\S+)/);
  if (!match) return { ts: null, signal: null };
  const ts = match[1];
  const token = match[2];
  if (!SIGNAL_NAMES.includes(token as LogSignalName)) return { ts, signal: null };
  return { ts, signal: token as LogSignalName };
}

function tailLines(filePath: string, maxBytes: number, maxLines: number): string[] {
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.allocUnsafe(size - start);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const raw = buf.toString('utf-8');
  const all = raw.split(/\r?\n/);
  // Drop the first (likely partial) line unless we started at byte 0.
  const complete = start === 0 ? all : all.slice(1);
  return complete.slice(-maxLines);
}

/** Scan the tail of the router log for the four negative routing signals. */
export function scanLogSignals(): LogSignalsResult {
  const filePath = resolveLogPath();
  if (!fs.existsSync(filePath)) {
    return {
      available: false,
      log_mtime: null,
      signals: Object.fromEntries(SIGNAL_NAMES.map(s => [s, { count: 0, last_ts: null }])) as Record<LogSignalName, LogSignalCounters>,
      total: 0,
      error: 'log file not found',
    };
  }

  let mtime: Date;
  let lines: string[];
  try {
    mtime = fs.statSync(filePath).mtime;
    lines = tailLines(filePath, LOG_TAIL_BYTES, LOG_TAIL_LINES);
  } catch (e) {
    return {
      available: false,
      log_mtime: null,
      signals: Object.fromEntries(SIGNAL_NAMES.map(s => [s, { count: 0, last_ts: null }])) as Record<LogSignalName, LogSignalCounters>,
      total: 0,
      error: (e as Error).message,
    };
  }

  const signals = Object.fromEntries(
    SIGNAL_NAMES.map(s => [s, { count: 0, last_ts: null }]),
  ) as Record<LogSignalName, LogSignalCounters>;

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseLogLine(line);
    if (!parsed.signal || !parsed.ts) continue;
    const entry = signals[parsed.signal];
    entry.count += 1;
    entry.last_ts = parsed.ts;
  }

  const total = Object.values(signals).reduce((a, s) => a + s.count, 0);
  return {
    available: true,
    log_mtime: mtime.toISOString(),
    signals,
    total,
  };
}
