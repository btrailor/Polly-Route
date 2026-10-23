import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  recordMetrics,
  recordRoutingDecision,
  recordCapture,
  recordBloom,
  metricsSnapshot,
  metricsTimeSeries,
  metricsCacheState,
} from '../src/metrics';

describe('metrics JSONL log and computations', () => {
  let tmpDir: string;
  let metricsPath: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-metrics-'));
    metricsPath = path.join(tmpDir, 'polly-metrics.jsonl');
    originalPath = process.env.POLLY_METRICS_PATH;
    process.env.POLLY_METRICS_PATH = metricsPath;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.POLLY_METRICS_PATH;
    else process.env.POLLY_METRICS_PATH = originalPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('appends events to JSONL and reads them back', () => {
    recordRoutingDecision('LIGHT', 'DIRECT', 'LOCAL', 'ollama/qwen2.5:7b', 'success');
    recordCapture('groq', 'knowledge_gap', 'MEDIUM', true);
    recordBloom(3);

    const lines = fs.readFileSync(metricsPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed[0].event).toBe('routing_decision');
    expect(parsed[1].event).toBe('capture');
    expect(parsed[2].event).toBe('bloom');
  });

  test('snapshot computes all tracked metrics', () => {
    recordRoutingDecision('LIGHT', 'DIRECT', 'LOCAL', 'ollama/qwen2.5:7b', 'success');
    recordRoutingDecision('MEDIUM', 'ABSENT', 'CLOUD', 'groq', 'success');
    recordRoutingDecision('HEAVY', 'ADJACENT', 'CLOUD', 'cerebras', 'success');
    recordRoutingDecision('LIGHT', 'DIRECT', 'LOCAL', 'ollama/qwen2.5:7b', 'success');
    // local dispatched but fallback to cloud
    recordRoutingDecision('MEDIUM', 'ADJACENT', 'LOCAL+CTX', 'groq', 'success');
    recordCapture('groq', 'knowledge_gap', 'MEDIUM', true);
    recordCapture('cerebras', 'capability_gap', 'HEAVY', true);
    recordCapture('groq', 'knowledge_gap', 'MEDIUM', false);
    recordBloom(1);

    const snap = metricsSnapshot();
    expect(snap.total_requests).toBe(5);
    expect(snap.cloud_requests).toBe(3); // groq, cerebras, fallback groq
    expect(snap.cloud_dependency_ratio).toBeCloseTo(3 / 5);
    expect(snap.local_dispatched).toBe(3);
    expect(snap.local_completed).toBe(2); // only ollama successes
    expect(snap.local_first_success_rate).toBeCloseTo(2 / 3);
    expect(snap.vault_direct).toBe(2);
    expect(snap.vault_adjacent).toBe(2);
    expect(snap.vault_absent).toBe(1);
    expect(snap.knowledge_coverage_score).toBeCloseTo(4 / 5);
    expect(snap.coverage_gap_rate).toBeCloseTo(1 / 5);
    expect(snap.captured_notes).toBe(2);
    expect(snap.capture_rate).toBeCloseTo(2 / 3);
    expect(snap.bloom_lag).toBe(1); // 2 captured - 1 bloomed
  });

  test('counts successful llama.cpp completions as local completions', () => {
    // Regression: local_completed only matched providers prefixed `ollama/`,
    // so every successful `llamacpp/<model>` completion was discarded. That
    // understated local_first_success_rate and inflated apparent cloud
    // dependency even though the local backend had done the work.
    recordRoutingDecision('MEDIUM', 'DIRECT', 'LOCAL', 'llamacpp/muse-glimmer-30b', 'success');
    recordRoutingDecision('MEDIUM', 'DIRECT', 'LOCAL', 'llamacpp/muse-glimmer-30b', 'success');
    recordRoutingDecision('MEDIUM', 'DIRECT', 'LOCAL', 'ollama/qwen2.5:7b', 'success');
    // A local dispatch that fell through to cloud is dispatched but not completed.
    recordRoutingDecision('HEAVY', 'ADJACENT', 'LOCAL+CTX', 'ollamapro', 'success');

    const snap = metricsSnapshot();
    expect(snap.local_dispatched).toBe(4);
    expect(snap.local_completed).toBe(3); // 2 llamacpp + 1 ollama
    expect(snap.cloud_requests).toBe(1); // only the ollamapro fallback
    expect(snap.local_first_success_rate).toBeCloseTo(3 / 4);
  });

  test('does not count a failed local attempt as a local completion', () => {
    recordRoutingDecision('LIGHT', 'DIRECT', 'LOCAL', 'ollama/qwen2.5:7b', 'error');
    recordRoutingDecision('LIGHT', 'DIRECT', 'LOCAL', 'llamacpp/muse-glimmer-30b', 'error');

    const snap = metricsSnapshot();
    expect(snap.local_dispatched).toBe(2);
    expect(snap.local_completed).toBe(0);
    expect(snap.local_first_success_rate).toBe(0);
  });

  test('time-series returns one bucket per day for the last 7 days', () => {
    recordRoutingDecision('LIGHT', 'DIRECT', 'LOCAL', 'ollama/qwen2.5:7b', 'success');
    recordCapture('groq', 'knowledge_gap', 'MEDIUM', true);

    const ts = metricsTimeSeries();
    expect(ts.window_days).toBe(7);
    expect(ts.days).toHaveLength(7);
    const today = new Date().toISOString().slice(0, 10);
    expect(ts.days[6].date).toBe(today);
    expect(ts.days[6].total_requests).toBe(1);
    expect(ts.days[6].captured_notes).toBe(1);
  });

  test('ignores events outside the rolling 7-day window', () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    fs.writeFileSync(
      metricsPath,
      JSON.stringify({ ts: old, event: 'routing_decision', complexity: 'LIGHT', vault: 'DIRECT', target: 'LOCAL', provider: 'ollama/qwen2.5:7b', outcome: 'success' }) + '\n' +
      JSON.stringify({ ts: recent, event: 'routing_decision', complexity: 'LIGHT', vault: 'DIRECT', target: 'LOCAL', provider: 'ollama/qwen2.5:7b', outcome: 'success' }) + '\n',
      'utf-8',
    );

    const snap = metricsSnapshot();
    expect(snap.total_requests).toBe(1);
  });

  test('caches events and reuses them when the file has not changed', () => {
    recordRoutingDecision('LIGHT', 'DIRECT', 'LOCAL', 'ollama/qwen2.5:7b', 'success');

    const first = metricsSnapshot();
    const cacheAfterFirst = metricsCacheState();
    expect(first.total_requests).toBe(1);
    expect(cacheAfterFirst.mtimeMs).not.toBeNull();

    const second = metricsSnapshot();
    const cacheAfterSecond = metricsCacheState();
    expect(second.total_requests).toBe(1);
    expect(cacheAfterSecond.mtimeMs).toBe(cacheAfterFirst.mtimeMs);
    expect(cacheAfterSecond.size).toBe(cacheAfterFirst.size);
  });

  test('invalidates cache when the metrics file is appended', () => {
    recordRoutingDecision('LIGHT', 'DIRECT', 'LOCAL', 'ollama/qwen2.5:7b', 'success');
    metricsSnapshot();
    const before = metricsCacheState();

    // Small sleep so the mtime is guaranteed to differ on platforms with 1s resolution.
    const then = Date.now();
    while (Date.now() - then < 1100) { /* busy wait */ }

    recordRoutingDecision('MEDIUM', 'ABSENT', 'CLOUD', 'groq', 'success');
    const snap = metricsSnapshot();
    const after = metricsCacheState();

    expect(snap.total_requests).toBe(2);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
  });
});
