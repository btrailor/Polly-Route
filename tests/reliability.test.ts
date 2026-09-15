import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ReliabilityEntry,
  recordReliability,
  recordLocalSuccess,
  gcReliability,
  reliabilityWindow,
  adjustTargetByReliability,
  getReliabilityPath,
} from '../src/reliability';
import { Config } from '../src/config';

describe('persona reliability logger and policy adjuster', () => {
  let tmpDir: string;
  let reliabilityPath: string;
  let originalPath: string | undefined;

  const baseConfig: Config = {
    port: 4200,
    ollama: { baseUrl: 'http://127.0.0.1:11434', models: [] },
    providers: {},
    qmd: { baseUrl: 'http://localhost:8181', collection: 'vault', timeoutMs: 500, minScore: 0.89 },
    reliability: {
      enabled: true,
      windowDays: 7,
      minAttempts: 3,
      minSuccessRate: 0.6,
      gcDays: 30,
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-reliability-'));
    reliabilityPath = path.join(tmpDir, 'persona-reliability.jsonl');
    originalPath = process.env.POLLY_RELIABILITY_PATH;
    process.env.POLLY_RELIABILITY_PATH = reliabilityPath;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.POLLY_RELIABILITY_PATH;
    else process.env.POLLY_RELIABILITY_PATH = originalPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function readEntries(): ReliabilityEntry[] {
    if (!fs.existsSync(reliabilityPath)) return [];
    return fs.readFileSync(reliabilityPath, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => JSON.parse(l));
  }

  test('getReliabilityPath honours POLLY_RELIABILITY_PATH', () => {
    expect(getReliabilityPath()).toBe(reliabilityPath);
  });

  test('recordReliability appends entries to JSONL', () => {
    recordReliability({
      ts: new Date().toISOString(),
      persona: 'default',
      task_type: 'coding',
      provider: 'ollama/qwen2.5-coder:32b',
      success: false,
      failure_class: 'model_error',
    }, baseConfig);

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].persona).toBe('default');
    expect(entries[0].failure_class).toBe('model_error');
  });

  test('recordLocalSuccess writes a success entry', () => {
    recordLocalSuccess({
      ts: new Date().toISOString(),
      persona: 'default',
      task_type: 'coding',
      provider: 'ollama/qwen2.5-coder:32b',
    }, baseConfig);

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].success).toBe(true);
    expect(entries[0].failure_class).toBe('success');
  });

  test('gcReliability removes entries older than gcDays', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    fs.writeFileSync(
      reliabilityPath,
      JSON.stringify({ ts: old, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' }) + '\n' +
      JSON.stringify({ ts: recent, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: true, failure_class: 'success' }) + '\n',
      'utf-8',
    );

    gcReliability(baseConfig);
    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].success).toBe(true);
  });

  test('gcReliability drops malformed lines', () => {
    fs.writeFileSync(
      reliabilityPath,
      'this is not json\n' +
      JSON.stringify({ ts: new Date().toISOString(), persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: true, failure_class: 'success' }) + '\n',
      'utf-8',
    );
    gcReliability(baseConfig);
    expect(readEntries()).toHaveLength(1);
  });

  test('reliabilityWindow ignores entries outside the window', () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    fs.writeFileSync(
      reliabilityPath,
      JSON.stringify({ ts: old, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' }) + '\n' +
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' }) + '\n',
      'utf-8',
    );

    const w = reliabilityWindow('default', 'coding', baseConfig);
    expect(w.attempts).toBe(1);
    expect(w.success_rate).toBe(0);
  });

  test('reliabilityWindow counts successes and model_error failures', () => {
    const now = new Date().toISOString();
    fs.writeFileSync(
      reliabilityPath,
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: true, failure_class: 'success' }) + '\n' +
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: true, failure_class: 'success' }) + '\n' +
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' }) + '\n' +
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'config_error' }) + '\n',
      'utf-8',
    );

    const w = reliabilityWindow('default', 'coding', baseConfig);
    expect(w.attempts).toBe(3); // 2 successes + 1 model_error
    expect(w.successes).toBe(2);
    expect(w.success_rate).toBeCloseTo(2 / 3);
    expect(w.cloud_bias).toBe(false); // 66% >= 60%
  });

  test('reliabilityWindow does not count config_error or ambiguous failures', () => {
    const now = new Date().toISOString();
    fs.writeFileSync(
      reliabilityPath,
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'config_error' }) + '\n' +
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'ambiguous' }) + '\n' +
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: true, failure_class: 'success' }) + '\n',
      'utf-8',
    );

    const w = reliabilityWindow('default', 'coding', baseConfig);
    expect(w.attempts).toBe(1);
    expect(w.successes).toBe(1);
    expect(w.success_rate).toBe(1);
    expect(w.cloud_bias).toBe(false);
  });

  test('cloud_bias activates only after minAttempts with success rate below threshold', () => {
    const now = new Date().toISOString();
    const lines = [
      { ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' },
      { ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: true, failure_class: 'success' },
      { ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' },
    ];
    fs.writeFileSync(
      reliabilityPath,
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
      'utf-8',
    );

    const w = reliabilityWindow('default', 'coding', baseConfig);
    expect(w.attempts).toBe(3);
    expect(w.success_rate).toBeCloseTo(1 / 3);
    expect(w.cloud_bias).toBe(true);
  });

  test('adjustTargetByReliability biases LOCAL toward LOCAL+CTX', () => {
    const now = new Date().toISOString();
    const lines = Array.from({ length: 3 }).map(() =>
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' })
    );
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    expect(adjustTargetByReliability('LOCAL', 'default', 'coding', baseConfig, true)).toBe('LOCAL+CTX');
  });

  test('adjustTargetByReliability biases LOCAL+CTX toward CLOUD', () => {
    const now = new Date().toISOString();
    const lines = Array.from({ length: 3 }).map(() =>
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' })
    );
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    expect(adjustTargetByReliability('LOCAL+CTX', 'default', 'coding', baseConfig, true)).toBe('CLOUD');
  });

  test('adjustTargetByReliability never upgrades CLOUD', () => {
    const now = new Date().toISOString();
    const lines = Array.from({ length: 3 }).map(() =>
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' })
    );
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    expect(adjustTargetByReliability('CLOUD', 'default', 'coding', baseConfig, true)).toBe('CLOUD');
  });

  test('adjustTargetByReliability is no-op when disabled', () => {
    const disabled: Config = { ...baseConfig, reliability: { ...baseConfig.reliability!, enabled: false } };
    const now = new Date().toISOString();
    const lines = Array.from({ length: 3 }).map(() =>
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' })
    );
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    expect(adjustTargetByReliability('LOCAL', 'default', 'coding', disabled, true)).toBe('LOCAL');
  });

  test('adjustTargetByReliability is no-op when guard is inactive', () => {
    const now = new Date().toISOString();
    const lines = Array.from({ length: 3 }).map(() =>
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' })
    );
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    expect(adjustTargetByReliability('LOCAL', 'default', 'coding', baseConfig, false)).toBe('LOCAL');
  });

  test('adjustTargetByReliability defaults active to false to avoid accidental bias', () => {
    const now = new Date().toISOString();
    const lines = Array.from({ length: 3 }).map(() =>
      JSON.stringify({ ts: now, persona: 'default', task_type: 'coding', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' })
    );
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    expect(adjustTargetByReliability('LOCAL', 'default', 'coding', baseConfig)).toBe('LOCAL');
  });
});
