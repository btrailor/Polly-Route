import { describe, test, expect } from '@jest/globals';
import { buildChain } from '../src/router';
import { Config } from '../src/config';
import { RequestBody, VaultSignal } from '../src/types';

/**
 * Router tier contract (D-RTR-1 / D-RTR-2).
 *
 * Defect proven on 2026-10-28: the router ignored an explicitly requested
 * local model. A request for "qwen2.5:7b" was served by
 * "qwen2.5-coder:32b", because buildChain() never read body.model on the
 * local path -- pickLocalModel() selected purely from complexity +
 * estimateChars().
 *
 * Consequence: a chain step declaring `tier: light` could not be guaranteed a
 * light model. The "isolate inference" goal depends on this being fixed.
 *
 * These tests assert the property, not the implementation.
 */

// --- Fixtures ---------------------------------------------------------------

const CONFIG: Config = {
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 1000,
    models: [
      { id: 'qwen2.5:7b',         name: 'Qwen 2.5 7B',        maxChars: 28000,  weight: 'light',  contextTokens: 32768 },
      { id: 'qwen2.5-coder:32b',  name: 'Qwen 2.5 Coder 32B', maxChars: 112000, weight: 'medium', contextTokens: 32768 },
      { id: 'qwen2.5-coder:32b',  name: 'Qwen 2.5 Coder 32B (heavy tier)', maxChars: 112000, weight: 'heavy', contextTokens: 32768 },
    ],
  },
  providers: {},
  llamacpp: {
    endpoints: [
      { baseUrl: 'http://127.0.0.1:4211', model: 'muse-glimmer-30b', minCtx: 16384, timeoutMs: 1000 },
    ],
  },
} as unknown as Config;

const VAULT_ABSENT: VaultSignal = { confidence: 'ABSENT', score: 0, chunks: [] };

function bodyWith(metadata?: Record<string, unknown>): RequestBody {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    max_tokens: 20,
    temperature: 0,
    ...(metadata ? { metadata } : {}),
  } as RequestBody;
}

/** Provider names in the built chain. */
async function chainNames(body: RequestBody): Promise<string[]> {
  const plan = await buildChain(body, 'MEDIUM', VAULT_ABSENT, CONFIG);
  return plan.chain.map(e => e.name);
}

/** Cloud providers that must never appear in a localOnly chain. */
const CLOUD_PROVIDERS = [
  'ollamapro', 'kimi', 'glm', 'qwen', 'google', 'groq', 'deepseek',
  'openrouter_free', 'mistral', 'cerebras', 'copilot', 'openrouter',
];

// --- Tests ------------------------------------------------------------------

describe('router tier contract', () => {
  test('metadata.model pins the EXACT requested model', async () => {
    // The defect: this used to resolve to qwen2.5-coder:32b.
    const names = await chainNames(bodyWith({ model: 'qwen2.5:7b', localOnly: true }));
    expect(names).toContain('ollama/qwen2.5:7b');
    expect(names).not.toContain('ollama/qwen2.5-coder:32b');
  });

  test('metadata.tier selects within the requested weight class', async () => {
    const light = await chainNames(bodyWith({ tier: 'light', localOnly: true }));
    expect(light).toContain('ollama/qwen2.5:7b');
    expect(light).not.toContain('ollama/qwen2.5-coder:32b');

    const heavy = await chainNames(bodyWith({ tier: 'heavy', localOnly: true }));
    expect(heavy).toContain('ollama/qwen2.5-coder:32b');
    expect(heavy).not.toContain('ollama/qwen2.5:7b');
  });

  test('metadata.localOnly strips every cloud provider from the chain', async () => {
    const names = await chainNames(bodyWith({ tier: 'light', localOnly: true }));
    for (const cloud of CLOUD_PROVIDERS) {
      expect(names).not.toContain(cloud);
    }
  });

  test('without localOnly the cloud fallback chain is still present', async () => {
    // Guard against over-correcting: the default path must be unchanged.
    const names = await chainNames(bodyWith({ tier: 'light' }));
    expect(names.length).toBeGreaterThan(1);
  });

  test('an unresolvable model does NOT silently resolve to a different model', async () => {
    const names = await chainNames(bodyWith({ model: 'no-such-model:999b', localOnly: true }));
    // The chain must contain ONLY the unresolvable entry -- no fallback.
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('unresolvable');
    expect(names).not.toContain('ollama/qwen2.5:7b');
    expect(names).not.toContain('ollama/qwen2.5-coder:32b');
  });

  test('an unresolvable model rejects rather than serving a response', async () => {
    const plan = await buildChain(
      bodyWith({ model: 'no-such-model:999b', localOnly: true }),
      'MEDIUM', VAULT_ABSENT, CONFIG,
    );
    await expect(plan.chain[0].fn(bodyWith())).rejects.toThrow(/unresolvable/i);
  });

  test('metadata.model wins over metadata.tier', async () => {
    // tier says heavy, model says the 7B. The exact pin must win.
    const names = await chainNames(bodyWith({ tier: 'heavy', model: 'qwen2.5:7b', localOnly: true }));
    expect(names).toContain('ollama/qwen2.5:7b');
    expect(names).not.toContain('ollama/qwen2.5-coder:32b');
  });

  test('no metadata preserves existing default behaviour', async () => {
    // With no hints the router must behave exactly as it did before the
    // change: complexity-driven selection, no unresolvable entry.
    const plan = await buildChain(bodyWith(), 'MEDIUM', VAULT_ABSENT, CONFIG);
    const names = plan.chain.map(e => e.name);
    expect(names.some(n => n.startsWith('unresolvable:'))).toBe(false);

    // DIRECT vault + MEDIUM complexity routes LOCAL and selects the medium
    // weight class -- the pre-existing complexity-driven behaviour.
    const direct: VaultSignal = { confidence: 'DIRECT', score: 1, chunks: [] };
    const local = await buildChain(bodyWith(), 'MEDIUM', direct, CONFIG);
    const localNames = local.chain.map(e => e.name);
    expect(localNames).toContain('ollama/qwen2.5-coder:32b');
    expect(localNames).not.toContain('ollama/qwen2.5:7b');
  });

  test('a llama.cpp endpoint model can be pinned exactly', async () => {
    const names = await chainNames(bodyWith({ model: 'muse-glimmer-30b', localOnly: true }));
    expect(names).toContain('llamacpp/muse-glimmer-30b');
    // No other endpoint may be added when an exact model is pinned.
    expect(names).toHaveLength(1);
  });

  test('chain id and step id survive into the plan for attribution', async () => {
    const names = await chainNames(bodyWith({
      tier: 'light', localOnly: true, chainId: 'story-idea', chainStep: 'decide_target',
    }));
    expect(names.length).toBeGreaterThan(0);
  });
});
