import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RequestBody } from '../src/types';
import { Config, OllamaModel } from '../src/config';

let reliabilityPath: string;
let tmpDir: string;
let originalReliabilityPath: string | undefined;

jest.mock('../src/reliabilityGuard', () => ({
  reliabilityGuardActive: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../src/providers/ollama', () => {
  const actual = jest.requireActual('../src/providers/ollama') as any;
  return {
    ...actual,
    OllamaAdapter: class MockOllama extends actual.OllamaAdapter {
      async isAvailable() { return true; }
      async dispatch() { throw new Error('not dispatched in routing tests'); }
    },
  };
});

jest.mock('../src/providers/copilot', () => ({
  copilotAdapter: () => async () => { throw new Error('copilot not dispatched in tests'); },
}));

// Import after mocks are declared.
import { buildChain } from '../src/router';

const TEST_MODELS: OllamaModel[] = [
  { id: 'qwen2.5:7b', name: '7B', maxChars: 28000, weight: 'light' },
  { id: 'qwen2.5-coder:32b', name: '32B', maxChars: 112000, weight: 'medium' },
  { id: 'qwen2.5:72b', name: '72B', maxChars: 480000, weight: 'heavy' },
];

const TEST_CONFIG: Config = {
  port: 4200,
  ollama: { baseUrl: 'http://127.0.0.1:11434', models: TEST_MODELS },
  providers: {
    groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'test-groq', defaultModel: 'llama-3.3-70b-versatile' },
    cerebras: { baseUrl: 'https://api.cerebras.ai/v1', apiKey: 'test-cerebras', defaultModel: 'llama-3.3-70b' },
    google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'test-google', defaultModel: 'gemini-2.5-flash' },
    mistral: { baseUrl: 'https://api.mistral.ai/v1', apiKey: 'test-mistral', defaultModel: 'mistral-small-latest' },
  },
  qmd: { baseUrl: 'http://localhost:8181', collection: 'vault', timeoutMs: 500, minScore: 0.89 },
  reliability: {
    enabled: true,
    windowDays: 7,
    minAttempts: 3,
    minSuccessRate: 0.6,
    gcDays: 30,
  },
};

const SMALL_BODY: RequestBody = {
  model: 'auto',
  messages: [{ role: 'user', content: 'hi' }],
};

function makeVault(confidence: 'DIRECT' | 'ADJACENT' | 'ABSENT', score = 0.9) {
  return { confidence, score, chunks: confidence !== 'ABSENT' ? ['vault chunk'] : [] };
}

describe('router reliability bias integration', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-router-reliability-'));
    reliabilityPath = path.join(tmpDir, 'persona-reliability.jsonl');
    originalReliabilityPath = process.env.POLLY_RELIABILITY_PATH;
    process.env.POLLY_RELIABILITY_PATH = reliabilityPath;
  });

  afterEach(() => {
    if (originalReliabilityPath === undefined) delete process.env.POLLY_RELIABILITY_PATH;
    else process.env.POLLY_RELIABILITY_PATH = originalReliabilityPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('LOCAL target is biased to LOCAL+CTX when local success rate is below threshold', async () => {
    const now = new Date().toISOString();
    const lines = Array.from({ length: 3 }).map(() =>
      JSON.stringify({ ts: now, persona: 'default', task_type: 'general', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' })
    );
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    const { target } = await buildChain(SMALL_BODY, 'LIGHT', makeVault('DIRECT'), TEST_CONFIG, { hasSkill: false }, 'default', 'general');
    expect(target).toBe('LOCAL+CTX');
  });

  test('LOCAL+CTX target is biased to CLOUD when local success rate is below threshold', async () => {
    const now = new Date().toISOString();
    const lines = Array.from({ length: 3 }).map(() =>
      JSON.stringify({ ts: now, persona: 'default', task_type: 'general', provider: 'ollama/qwen2.5-coder:32b', success: false, failure_class: 'model_error' })
    );
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    const { target } = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ADJACENT'), TEST_CONFIG, { hasSkill: false }, 'default', 'general');
    expect(target).toBe('CLOUD');
  });

  test('target stays LOCAL when local track record is healthy', async () => {
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({ ts: now, persona: 'default', task_type: 'general', provider: 'ollama/qwen2.5:7b', success: true, failure_class: 'success' }),
      JSON.stringify({ ts: now, persona: 'default', task_type: 'general', provider: 'ollama/qwen2.5:7b', success: true, failure_class: 'success' }),
      JSON.stringify({ ts: now, persona: 'default', task_type: 'general', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' }),
    ];
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    const { target } = await buildChain(SMALL_BODY, 'LIGHT', makeVault('DIRECT'), TEST_CONFIG, { hasSkill: false }, 'default', 'general');
    expect(target).toBe('LOCAL');
  });

  test('CLOUD target remains CLOUD even with poor local track record', async () => {
    const now = new Date().toISOString();
    const lines = Array.from({ length: 3 }).map(() =>
      JSON.stringify({ ts: now, persona: 'default', task_type: 'general', provider: 'ollama/qwen2.5:7b', success: false, failure_class: 'model_error' })
    );
    fs.writeFileSync(reliabilityPath, lines.join('\n') + '\n', 'utf-8');

    const { target } = await buildChain(SMALL_BODY, 'HEAVY', makeVault('ABSENT'), TEST_CONFIG, { hasSkill: false }, 'default', 'general');
    expect(target).toBe('CLOUD');
  });
});
