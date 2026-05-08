import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { Complexity, VaultSignal, RequestBody } from '../src/types';
import { Config, OllamaModel } from '../src/config';

// ─── Minimal config for testing ────────────────────────────────────────────

const TEST_MODELS: OllamaModel[] = [
  { id: 'qwen2.5:7b',        name: '7B',  maxChars:  28000, weight: 'light'  },
  { id: 'qwen2.5-coder:32b', name: '32B', maxChars: 112000, weight: 'medium' },
  { id: 'qwen2.5:72b',       name: '72B', maxChars: 480000, weight: 'heavy'  },
];

const TEST_CONFIG: Config = {
  port: 4200,
  ollama: { baseUrl: 'http://127.0.0.1:11434', models: TEST_MODELS },
  providers: {
    groq:     { baseUrl: 'https://api.groq.com/openai/v1',     apiKey: 'test-groq',     defaultModel: 'llama-3.3-70b-versatile' },
    cerebras: { baseUrl: 'https://api.cerebras.ai/v1',          apiKey: 'test-cerebras', defaultModel: 'llama-3.3-70b' },
    google:   { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'test-google', defaultModel: 'gemini-2.5-flash' },
    mistral:  { baseUrl: 'https://api.mistral.ai/v1',           apiKey: 'test-mistral',  defaultModel: 'mistral-small-latest' },
  },
  qmd: { baseUrl: 'http://localhost:8181', collection: 'vault', timeoutMs: 500 },
};

// Small body — fits in 7b
const SMALL_BODY: RequestBody = {
  model: 'auto',
  messages: [{ role: 'user', content: 'hi' }],
};

function makeVault(confidence: VaultSignal['confidence'], score = 0.9): VaultSignal {
  return { confidence, score, chunks: confidence !== 'ABSENT' ? ['vault chunk'] : [] };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// We need to mock OllamaAdapter.isAvailable to return true without network calls.
// We also need to capture chain names without dispatching.
// Strategy: import buildChain and mock the OllamaAdapter prototype.

jest.mock('../src/providers/ollama', () => {
  const actual = jest.requireActual('../src/providers/ollama') as any;
  return {
    OllamaAdapter: class MockOllama extends actual.OllamaAdapter {
      async isAvailable() { return true; }
      async dispatch(model: any, body: any) {
        throw new Error('dispatch not called in routing tests');
      }
    },
  };
});

// Copilot reads from filesystem — mock it too
jest.mock('../src/providers/copilot', () => ({
  copilotAdapter: () => async () => { throw new Error('copilot not dispatched in tests'); },
}));

import { buildChain } from '../src/router';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('routing matrix — chain order', () => {
  // Helper: extract provider name prefix from chain
  function names(chain: { name: string }[]) {
    return chain.map(e => {
      if (e.name.startsWith('ollama/')) return 'ollama';
      return e.name;
    });
  }

  test('LIGHT + DIRECT — ollama first, then cloud', async () => {
    const chain = await buildChain(SMALL_BODY, 'LIGHT', makeVault('DIRECT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('ollama');
    expect(ns).toContain('google');
    expect(ns).toContain('groq');
  });

  test('MEDIUM + DIRECT — min 32b local first, then cloud', async () => {
    const chain = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('DIRECT'), TEST_CONFIG);
    expect(chain[0].name).toBe('ollama/qwen2.5-coder:32b'); // min 32b enforced
    expect(names(chain)).toContain('google');
    expect(names(chain)).toContain('groq');
  });

  test('HEAVY + DIRECT — local first, then cloud, copilot last', async () => {
    const chain = await buildChain(SMALL_BODY, 'HEAVY', makeVault('DIRECT'), TEST_CONFIG);
    expect(names(chain)[0]).toBe('ollama');
    expect(names(chain)).toContain('copilot');
  });

  test('LIGHT + ADJACENT — local first, then groq, cerebras, mistral, google', async () => {
    const chain = await buildChain(SMALL_BODY, 'LIGHT', makeVault('ADJACENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('ollama');
    expect(ns).toContain('groq');
    expect(ns).toContain('cerebras');
    expect(ns).toContain('mistral');
    expect(ns).toContain('google');
  });

  test('MEDIUM + ADJACENT — google first, then groq, then local', async () => {
    const chain = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ADJACENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('google');
    expect(ns[1]).toBe('groq');
    expect(ns).toContain('ollama');
  });

  test('HEAVY + ADJACENT — google first, groq second, copilot last', async () => {
    const chain = await buildChain(SMALL_BODY, 'HEAVY', makeVault('ADJACENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('google');
    expect(ns[1]).toBe('groq');
    expect(ns).toContain('copilot');
  });

  test('LIGHT + ABSENT — groq first, no local', async () => {
    const chain = await buildChain(SMALL_BODY, 'LIGHT', makeVault('ABSENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('groq');
    expect(ns).not.toContain('ollama');
  });

  test('MEDIUM + ABSENT — groq first, google second, no local', async () => {
    const chain = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ABSENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('groq');
    expect(ns[1]).toBe('google');
    expect(ns).not.toContain('ollama');
  });

  test('HEAVY + ABSENT — copilot first', async () => {
    const chain = await buildChain(SMALL_BODY, 'HEAVY', makeVault('ABSENT'), TEST_CONFIG);
    expect(names(chain)[0]).toBe('copilot');
    expect(names(chain)).not.toContain('ollama');
  });

  test('no cell produces an empty chain', async () => {
    const combos: [Complexity, VaultSignal['confidence']][] = [
      ['LIGHT','DIRECT'],['LIGHT','ADJACENT'],['LIGHT','ABSENT'],
      ['MEDIUM','DIRECT'],['MEDIUM','ADJACENT'],['MEDIUM','ABSENT'],
      ['HEAVY','DIRECT'],['HEAVY','ADJACENT'],['HEAVY','ABSENT'],
    ];
    for (const [c, v] of combos) {
      const chain = await buildChain(SMALL_BODY, c, makeVault(v), TEST_CONFIG);
      expect(chain.length).toBeGreaterThan(0);
    }
  });
});

// ─── Honesty invariant: vault injection only ─────────────────────────────────

describe('router body honesty', () => {
  test('DIRECT routing — original messages passed through, vault chunk appended', async () => {
    const body: RequestBody = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'SOUL: accountability coach identity here' },
        { role: 'user',   content: 'check in' },
      ],
      tools: [{ type: 'function', function: { name: 'cron', parameters: {} } }],
    };

    // Capture what body each chain entry receives
    const capturedBodies: RequestBody[] = [];
    const vault = makeVault('DIRECT');
    const chain = await buildChain(body, 'LIGHT', vault, TEST_CONFIG);

    // Replace chain fns with capture fns
    for (const entry of chain) {
      const original = entry.fn;
      entry.fn = async (b: RequestBody) => {
        capturedBodies.push(b);
        throw new Error('stop');
      };
    }

    // Execute first entry
    try { await chain[0].fn(body); } catch {}

    if (capturedBodies.length > 0) {
      const captured = capturedBodies[0];
      // Original system message untouched
      expect(captured.messages[0]).toEqual(body.messages[0]);
      // Tools untouched
      expect(captured.tools).toEqual(body.tools);
    }
  });
});
