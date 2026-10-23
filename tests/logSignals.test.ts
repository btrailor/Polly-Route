import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanLogSignals, LogSignalName } from '../src/logSignals';

describe('scanLogSignals', () => {
  let tmpDir: string;
  let logPath: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-logsignals-'));
    logPath = path.join(tmpDir, 'polly-router.log');
    originalPath = process.env.POLLY_ROUTER_LOG_PATH;
    process.env.POLLY_ROUTER_LOG_PATH = logPath;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.POLLY_ROUTER_LOG_PATH;
    else process.env.POLLY_ROUTER_LOG_PATH = originalPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeLines(lines: string[]) {
    fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');
  }

  test('returns zeros with available:false when log file is missing', () => {
    fs.rmSync(logPath, { force: true });
    const result = scanLogSignals();
    expect(result.available).toBe(false);
    expect(result.total).toBe(0);
    expect(result.log_mtime).toBeNull();
    const signals = Object.values(result.signals);
    expect(signals.every(s => s.count === 0 && s.last_ts === null)).toBe(true);
  });

  test('counts the four negative signals and reports last timestamp', () => {
    const lines = [
      '[2026-10-22T10:00:00.000Z] routing {"target":"LOCAL"}',
      '[2026-10-22T11:00:00.000Z] skip-no-credentials {"provider":"kimi"}',
      '[2026-10-22T12:00:00.000Z] skip-no-credentials {"provider":"glm"}',
      '[2026-10-22T13:00:00.000Z] ollama-skip-size {"provider":"ollama/qwen2.5:7b"}',
      '[2026-10-22T14:00:00.000Z] local-request-exceeds-all-endpoints {"requestChars":99999}',
      '[2026-10-22T15:00:00.000Z] confidence-escalation-unavailable {"provider":"ollama/qwen2.5:7b"}',
      '[2026-10-22T16:00:00.000Z] complete {"provider":"groq"}',
    ];
    writeLines(lines);

    const result = scanLogSignals();
    expect(result.available).toBe(true);
    expect(result.total).toBe(5);
    expect(result.log_mtime).not.toBeNull();

    expect(result.signals['skip-no-credentials'].count).toBe(2);
    expect(result.signals['skip-no-credentials'].last_ts).toBe('2026-10-22T12:00:00.000Z');
    expect(result.signals['ollama-skip-size'].count).toBe(1);
    expect(result.signals['ollama-skip-size'].last_ts).toBe('2026-10-22T13:00:00.000Z');
    expect(result.signals['local-request-exceeds-all-endpoints'].count).toBe(1);
    expect(result.signals['confidence-escalation-unavailable'].count).toBe(1);
  });

  test('reads only the tail of a large log', () => {
    const head: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      head.push(`[2026-10-21T10:00:00.000Z] skip-no-credentials {"provider":"head-${i}"} ${'x'.repeat(2400)}`);
    }
    const tail: string[] = [
      '[2026-10-23T10:00:00.000Z] ollama-skip-size {"provider":"ollama/qwen2.5:7b"}',
      '[2026-10-23T10:01:00.000Z] confidence-escalation-unavailable {"provider":"ollama/qwen2.5:7b"}',
    ];
    writeLines([...head, ...tail]);

    const result = scanLogSignals();
    const fileSize = fs.statSync(logPath).size;
    // The production tail byte budget is 2 MB. With a ~7 MB file, the scan
    // must not read the whole file: it should see only the lines that fall in
    // the last 2 MB window (~850 head lines) plus the 2 tail lines.
    expect(fileSize).toBeGreaterThan(5 * 1024 * 1024);
    expect(result.signals['skip-no-credentials'].count).toBeGreaterThan(800);
    expect(result.signals['skip-no-credentials'].count).toBeLessThan(1000);
    expect(result.signals['ollama-skip-size'].count).toBe(1);
    expect(result.signals['confidence-escalation-unavailable'].count).toBe(1);
    expect(result.total).toBe(result.signals['skip-no-credentials'].count + 2);
  });

  test('does not double-count non-signal lines', () => {
    writeLines([
      '[2026-10-23T10:00:00.000Z] skip-no-credentials {"provider":"kimi"}',
      '[2026-10-23T10:00:01.000Z] something-else-happened',
      '[2026-10-23T10:00:02.000Z] skip-no-credentials-not-really',
    ]);
    const result = scanLogSignals();
    expect(result.signals['skip-no-credentials'].count).toBe(1);
    expect(result.total).toBe(1);
  });
});
