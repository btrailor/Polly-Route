import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { captureCloudResponse } from '../src/capture';
import { RequestBody, VaultSignal } from '../src/types';

const TEST_BODY: RequestBody = {
  model: 'auto',
  messages: [{ role: 'user', content: 'What is the capture pipeline?' }],
};

const makeVault = (confidence: VaultSignal['confidence'], score = 0.9): VaultSignal => ({
  confidence,
  score,
  chunks: confidence === 'ABSENT' ? [] : ['vault chunk'],
});

jest.mock('../src/vaultWriter', () => ({
  writeCapture: jest.fn(async (note: { filename: string; content: string }) => `/vault/20-Active/captured/${note.filename}`),
}));

import { writeCapture } from '../src/vaultWriter';

const mockedWriteCapture = writeCapture as jest.MockedFunction<typeof writeCapture>;

let tmpDir: string;
let metricsPath: string;
let originalMetricsPath: string | undefined;

describe('captureCloudResponse', () => {
  beforeEach(() => {
    mockedWriteCapture.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-capture-'));
    metricsPath = path.join(tmpDir, 'polly-metrics.jsonl');
    originalMetricsPath = process.env.POLLY_METRICS_PATH;
    process.env.POLLY_METRICS_PATH = metricsPath;
  });

  afterEach(() => {
    if (originalMetricsPath === undefined) delete process.env.POLLY_METRICS_PATH;
    else process.env.POLLY_METRICS_PATH = originalMetricsPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('skips capture for non-cloud targets', async () => {
    await captureCloudResponse({
      body: TEST_BODY,
      provider: 'ollama/qwen2.5:7b',
      vaultSignal: makeVault('DIRECT'),
      complexity: 'LIGHT',
      target: 'LOCAL',
      rawResponseText: '{"choices":[{"message":{"content":"hello"}}]}',
    });
    expect(mockedWriteCapture).not.toHaveBeenCalled();
  });

  test('writes a note with correct frontmatter for knowledge gap', async () => {
    await captureCloudResponse({
      body: TEST_BODY,
      provider: 'groq',
      vaultSignal: makeVault('ABSENT'),
      complexity: 'MEDIUM',
      target: 'CLOUD',
      rawResponseText: '{"choices":[{"message":{"content":"The capture pipeline buffers responses."}}]}',
    });

    expect(mockedWriteCapture).toHaveBeenCalledTimes(1);
    const note = mockedWriteCapture.mock.calls[0][0];
    expect(note.filename).toMatch(/^\d{4}-\d{2}-\d{2}-what-is-the-capture-pipeline\.md$/);
    expect(note.content).toContain('bloom: raw-ingest');
    expect(note.content).toContain('source: polly-router');
    expect(note.content).toContain('provider: groq');
    expect(note.content).toContain('vault_gap: knowledge_gap');
    expect(note.content).toContain('complexity: MEDIUM');
    expect(note.content).toContain('captured_at:');
    expect(note.content).toContain('## Query');
    expect(note.content).toContain('What is the capture pipeline?');
    expect(note.content).toContain('## Answer Summary');
    expect(note.content).toContain('The capture pipeline buffers responses.');
  });

  test('classifies capability gap when vault had content', async () => {
    await captureCloudResponse({
      body: TEST_BODY,
      provider: 'cerebras',
      vaultSignal: makeVault('ADJACENT'),
      complexity: 'HEAVY',
      target: 'CLOUD',
      rawResponseText: '{"choices":[{"message":{"content":"complex answer"}}]}',
    });

    const note = mockedWriteCapture.mock.calls[0][0];
    expect(note.content).toContain('vault_gap: capability_gap');
  });

  test('extracts answer summary from SSE stream', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      'data: [DONE]',
    ].join('\n');

    await captureCloudResponse({
      body: TEST_BODY,
      provider: 'google',
      vaultSignal: makeVault('ABSENT'),
      complexity: 'MEDIUM',
      target: 'CLOUD',
      rawResponseText: sse,
    });

    const note = mockedWriteCapture.mock.calls[0][0];
    expect(note.content).toContain('Hello world');
  });
});
