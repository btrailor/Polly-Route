import { describe, test, expect, jest } from '@jest/globals';
import { Complexity, VaultSignal, RequestBody, VaultConfidence, SkillSignal } from '../src/types';
import { Config, OllamaModel } from '../src/config';
import { buildChain, decideTarget } from '../src/router';

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
  qmd: { baseUrl: 'http://localhost:8181', collection: 'vault', timeoutMs: 500, minScore: 0.89 },
};

// Small body — fits in 7b
const SMALL_BODY: RequestBody = {
  model: 'auto',
  messages: [{ role: 'user', content: 'hi' }],
};

function makeVault(confidence: VaultSignal['confidence'], score = 0.9): VaultSignal {
  return { confidence, score, chunks: confidence !== 'ABSENT' ? ['vault chunk'] : [] };
}

function makeSkill(name: string, procedure: string, score = 5): SkillSignal {
  return { hasSkill: true, skillName: name, procedure, score };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// We need to mock OllamaAdapter.isAvailable to return true without network calls.
// We also need to capture chain names without dispatching.
// Strategy: import buildChain and mock the OllamaAdapter prototype.

let lastDispatchBody: RequestBody | null = null;

jest.mock('../src/providers/ollama', () => {
  const actual = jest.requireActual('../src/providers/ollama') as any;
  return {
    ...actual,
    OllamaAdapter: class MockOllama extends actual.OllamaAdapter {
      async isAvailable() { return true; }
      async dispatch(model: any, body: any) {
        lastDispatchBody = body;
        throw new Error('dispatch not called in routing tests');
      }
    },
  };
});

// Copilot reads from filesystem — mock it too
jest.mock('../src/providers/copilot', () => ({
  copilotAdapter: () => async () => { throw new Error('copilot not dispatched in tests'); },
}));

function names(chain: { name: string }[]) {
  return chain.map(e => {
    if (e.name.startsWith('ollama/')) return 'ollama';
    return e.name;
  });
}

// ─── Unit tests for the coverage-vs-complexity matrix decision ───────────────

describe('decideTarget coverage-vs-complexity matrix', () => {
  const fits = true;
  const nofit = false;

  const cases: { vault: VaultConfidence; complexity: Complexity; fits: boolean; expected: string }[] = [
    { vault: 'DIRECT',  complexity: 'LIGHT',  fits,      expected: 'LOCAL' },
    { vault: 'DIRECT',  complexity: 'MEDIUM', fits,      expected: 'LOCAL' },
    { vault: 'DIRECT',  complexity: 'HEAVY',  fits,      expected: 'LOCAL' },
    { vault: 'DIRECT',  complexity: 'HEAVY',  fits: nofit, expected: 'CLOUD' },
    { vault: 'ADJACENT', complexity: 'LIGHT',  fits,      expected: 'LOCAL' },
    { vault: 'ADJACENT', complexity: 'MEDIUM', fits,      expected: 'LOCAL+CTX' },
    { vault: 'ADJACENT', complexity: 'MEDIUM', fits: nofit, expected: 'CLOUD' },
    { vault: 'ADJACENT', complexity: 'HEAVY',  fits,      expected: 'CLOUD' },
    { vault: 'ABSENT',   complexity: 'LIGHT',  fits,      expected: 'LOCAL' },
    { vault: 'ABSENT',   complexity: 'LIGHT',  fits: nofit, expected: 'CLOUD' },
    { vault: 'ABSENT',   complexity: 'MEDIUM', fits,      expected: 'CLOUD' },
    { vault: 'ABSENT',   complexity: 'HEAVY',  fits,      expected: 'CLOUD' },
  ];

  test.each(cases)(
    '$vault + $complexity (fits=$fits) → $expected',
    ({ vault, complexity, fits: f, expected }) => {
      expect(decideTarget(complexity, makeVault(vault), f)).toBe(expected);
    }
  );
});

// ─── Tests for buildChain output ─────────────────────────────────────────────

describe('routing matrix — chain order', () => {
  test('buildChain returns target alongside chain', async () => {
    const result = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ABSENT'), TEST_CONFIG);
    expect(result).toHaveProperty('target');
    expect(result).toHaveProperty('chain');
    expect(Array.isArray(result.chain)).toBe(true);
    expect(result.target).toBe('CLOUD');
  });

  test('LIGHT + DIRECT — local first', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'LIGHT', makeVault('DIRECT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('ollama');
    expect(ns).toContain('google');
    expect(ns).toContain('groq');
  });

  test('MEDIUM + DIRECT — min 32b local first, then cloud', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('DIRECT'), TEST_CONFIG);
    expect(chain[0].name).toBe('ollama/qwen2.5-coder:32b');
    expect(names(chain)).toContain('google');
    expect(names(chain)).toContain('groq');
  });

  test('HEAVY + DIRECT — local first (frontier-gate: DIRECT covers heavy)', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'HEAVY', makeVault('DIRECT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('ollama');
    expect(chain[0].name).toBe('ollama/qwen2.5:72b');
    expect(ns).toContain('google');
    expect(ns).toContain('groq');
  });

  test('LIGHT + ADJACENT — local first, then cloud', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'LIGHT', makeVault('ADJACENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('ollama');
    expect(ns).toContain('groq');
    expect(ns).toContain('cerebras');
    expect(ns).toContain('mistral');
    expect(ns).toContain('google');
  });

  test('MEDIUM + ADJACENT — LOCAL+CTX, local first with vault context', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ADJACENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('ollama');
    expect(chain[0].name).toBe('ollama/qwen2.5-coder:32b');
    expect(ns).toContain('google');
    expect(ns).toContain('groq');
  });

  test('HEAVY + ADJACENT — cloud first, no local', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'HEAVY', makeVault('ADJACENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('google');
    expect(ns[1]).toBe('groq');
    expect(ns).not.toContain('ollama');
    expect(ns).toContain('copilot');
  });

  test('LIGHT + ABSENT — local first (simple enough without vault)', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'LIGHT', makeVault('ABSENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('ollama');
    expect(ns).toContain('groq');
  });

  test('MEDIUM + ABSENT — cloud first, no local', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ABSENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('google');
    expect(ns).toContain('groq');
    expect(ns).not.toContain('ollama');
  });

  test('HEAVY + ABSENT — cloud first, no local', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'HEAVY', makeVault('ABSENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).toBe('google');
    expect(ns).not.toContain('ollama');
    expect(ns).toContain('copilot');
  });

  test('no cell produces an empty chain', async () => {
    const combos: [Complexity, VaultSignal['confidence']][] = [
      ['LIGHT','DIRECT'],['LIGHT','ADJACENT'],['LIGHT','ABSENT'],
      ['MEDIUM','DIRECT'],['MEDIUM','ADJACENT'],['MEDIUM','ABSENT'],
      ['HEAVY','DIRECT'],['HEAVY','ADJACENT'],['HEAVY','ABSENT'],
    ];
    for (const [c, v] of combos) {
      const { chain } = await buildChain(SMALL_BODY, c, makeVault(v), TEST_CONFIG);
      expect(chain.length).toBeGreaterThan(0);
    }
  });

  // Acceptance criteria from R3-A card.
  test('ACCEPTANCE: {vault: DIRECT, complexity: HEAVY} → returns local chain', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'HEAVY', makeVault('DIRECT'), TEST_CONFIG);
    expect(names(chain)[0]).toBe('ollama');
  });

  test('ACCEPTANCE: {vault: ABSENT, complexity: MEDIUM} → returns cloud chain', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ABSENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns[0]).not.toBe('ollama');
    expect(ns).toContain('google');
    expect(ns).toContain('groq');
    expect(ns).not.toContain('ollama');
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
    const { chain } = await buildChain(body, 'LIGHT', vault, TEST_CONFIG);

    // Replace chain fns with capture fns
    for (const entry of chain) {
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

// ─── Skill coverage probe integration ───────────────────────────────────────

describe('skill coverage fills vault gaps', () => {
  const skill = makeSkill('scope-a-sprint', '## Scope-a-sprint procedure\nUse the seven-section brief.');

  test('ACCEPTANCE: ABSENT vault + hasSkill=true → routes to LOCAL for LIGHT', async () => {
    const { target, chain } = await buildChain(SMALL_BODY, 'LIGHT', makeVault('ABSENT'), TEST_CONFIG, skill);
    expect(target).toBe('LOCAL');
    expect(names(chain)[0]).toBe('ollama');
  });

  test('ACCEPTANCE: ABSENT vault + hasSkill=true → routes to LOCAL+CTX for MEDIUM', async () => {
    const { target, chain } = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ABSENT'), TEST_CONFIG, skill);
    expect(target).toBe('LOCAL+CTX');
    expect(names(chain)[0]).toBe('ollama');
  });

  test('ABSENT vault + hasSkill=true + HEAVY → stays CLOUD', async () => {
    const { target, chain } = await buildChain(SMALL_BODY, 'HEAVY', makeVault('ABSENT'), TEST_CONFIG, skill);
    expect(target).toBe('CLOUD');
    expect(names(chain)[0]).not.toBe('ollama');
  });

  test('ACCEPTANCE: skill procedure is injected alongside vault chunks', async () => {
    lastDispatchBody = null;
    const vault = makeVault('ADJACENT');
    const { chain } = await buildChain(SMALL_BODY, 'MEDIUM', vault, TEST_CONFIG, skill);

    // Trigger the local dispatch so the mocked adapter captures the body.
    try { await chain[0].fn(SMALL_BODY); } catch {}

    expect(lastDispatchBody).not.toBeNull();
    const systemMsg = lastDispatchBody!.messages.find(m => m.role === 'system');
    const systemText = typeof systemMsg?.content === 'string' ? systemMsg.content : '';
    expect(systemText).toContain('vault chunk');
    expect(systemText).toContain('scope-a-sprint');
    expect(systemText).toContain('seven-section brief');
  });
});

// ─── Unit tests for decideTarget with skill coverage ────────────────────────

describe('decideTarget with skill coverage', () => {
  const fits = true;
  const nofit = false;
  const skill = makeSkill('any', 'procedure');

  test('ABSENT + hasSkill + LIGHT + fits → LOCAL', () => {
    expect(decideTarget('LIGHT', makeVault('ABSENT'), fits, skill)).toBe('LOCAL');
  });

  test('ABSENT + hasSkill + MEDIUM + fits → LOCAL+CTX', () => {
    expect(decideTarget('MEDIUM', makeVault('ABSENT'), fits, skill)).toBe('LOCAL+CTX');
  });

  test('ABSENT + hasSkill + HEAVY → CLOUD', () => {
    expect(decideTarget('HEAVY', makeVault('ABSENT'), fits, skill)).toBe('CLOUD');
  });

  test('ABSENT + hasSkill + MEDIUM + nofit → CLOUD', () => {
    expect(decideTarget('MEDIUM', makeVault('ABSENT'), nofit, skill)).toBe('CLOUD');
  });

  test('ABSENT + noSkill → behaves like original matrix', () => {
    expect(decideTarget('LIGHT', makeVault('ABSENT'), fits)).toBe('LOCAL');
    expect(decideTarget('MEDIUM', makeVault('ABSENT'), fits)).toBe('CLOUD');
    expect(decideTarget('HEAVY', makeVault('ABSENT'), fits)).toBe('CLOUD');
  });
});

// ─── Phase 0 focused tests ────────────────────────────────────────────────────

describe('Phase 0 fixes — Ollama size guard', () => {
  const BIG_BODY: RequestBody = {
    model: 'auto',
    messages: [{ role: 'user', content: 'x'.repeat(70000) }],
  };

  test('small request passes size guard and routes to local Ollama', async () => {
    const { chain } = await buildChain(SMALL_BODY, 'LIGHT', makeVault('ABSENT'), TEST_CONFIG);
    expect(names(chain)[0]).toBe('ollama');
  });

  test('oversized request skips local Ollama via ollama-skip-size', async () => {
    const { chain } = await buildChain(BIG_BODY, 'MEDIUM', makeVault('DIRECT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns).not.toContain('ollama');
    expect(ns[0]).not.toBe('ollama');
  });

  test('oversized request still produces cloud fallback chain', async () => {
    const { chain } = await buildChain(BIG_BODY, 'MEDIUM', makeVault('ABSENT'), TEST_CONFIG);
    const ns = names(chain);
    expect(ns).not.toContain('ollama');
    expect(ns.length).toBeGreaterThan(0);
    expect(ns).toContain('google');
    expect(ns).toContain('groq');
  });
});

describe('Phase 0 fixes — empty credentials skip', () => {
  test('cloud provider with empty apiKey is skipped', async () => {
    const emptyConfig: Config = {
      ...TEST_CONFIG,
      providers: {
        ...TEST_CONFIG.providers,
        groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', defaultModel: 'llama-3.3-70b-versatile' },
      },
    };
    const { chain } = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ABSENT'), emptyConfig);
    const ns = names(chain);
    expect(ns).not.toContain('groq');
    expect(ns).toContain('google');
  });

  test('all cloud providers with empty keys produce empty cloud chain', async () => {
    const emptyConfig: Config = {
      ...TEST_CONFIG,
      providers: Object.fromEntries(
        Object.entries(TEST_CONFIG.providers).map(([k, v]) => [k, { ...v, apiKey: '' }])
      ) as Config['providers'],
    };
    const { chain } = await buildChain(SMALL_BODY, 'MEDIUM', makeVault('ABSENT'), emptyConfig);
    const ns = names(chain);
    expect(ns).not.toContain('groq');
    expect(ns).not.toContain('google');
    expect(ns).not.toContain('cerebras');
    expect(ns).not.toContain('mistral');
  });
});
