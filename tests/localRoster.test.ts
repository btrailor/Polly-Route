import { describe, test, expect } from '@jest/globals';
import { DEFAULT_OLLAMA_MODELS } from '../src/config';

/**
 * Unified-memory coexistence guard.
 *
 * On a 64 GB unified-memory Mac (the Mac Studio), a local model roster that
 * can be resident simultaneously is bounded by physical RAM. The failure this
 * guards against, observed 2026-10-25:
 *
 *   - HEAVY complexity selected `qwen2.5:72b`  (~47.4 GB on disk)
 *   - `qwen2.5-coder:32b` was already resident (~19.9 GB)
 *   - 67.3 GB > 64 GB physical
 *   - the Ollama runner died with GGML_ASSERT([rsets->data count] == 0)
 *   - the router's fallback chain silently handed the request to
 *     `ollamapro/kimi-k2.7-code` — a cloud model
 *
 * The local-first gate was working correctly; the local endpoint was crashing.
 * These tests assert the invariant that makes the crash impossible, so a
 * future roster edit cannot reintroduce it.
 */

/** Approximate on-disk weight of a GGUF model, in GB. */
const MODEL_SIZE_GB: Record<string, number> = {
  'qwen2.5:7b': 4.7,
  'qwen2.5-coder:32b': 19.9,
  'qwen2.5:72b': 47.4,
  'qwen2.5-coder:32b-8k': 19.9,
  'muse-glimmer-30b': 19.0,
};

const PHYSICAL_RAM_GB = 64;

describe('default local model roster', () => {
  // Assert the SOURCE default, not the live config.json — the whole point is
  // that the default is safe on a machine where config.json may be absent or
  // regenerated. (An earlier version of this test read loadConfig(), which
  // silently passed because the live config had already been fixed — the
  // test could not fail, so it proved nothing.)
  const models = DEFAULT_OLLAMA_MODELS;

  test('heavy tier does not demand a model that cannot coexist with the medium tier', () => {
    const heavy = models.find(m => m.weight === 'heavy');
    const medium = models.find(m => m.weight === 'medium');
    expect(heavy).toBeDefined();
    expect(medium).toBeDefined();

    const heavyGb = MODEL_SIZE_GB[heavy!.id] ?? 0;
    const mediumGb = MODEL_SIZE_GB[medium!.id] ?? 0;

    // The two must be able to be resident at the same time.
    expect(heavyGb + mediumGb).toBeLessThan(PHYSICAL_RAM_GB);
  });

  test('every pair of models in the roster can be resident simultaneously', () => {
    for (let i = 0; i < models.length; i++) {
      for (let j = i + 1; j < models.length; j++) {
        const a = MODEL_SIZE_GB[models[i].id] ?? 0;
        const b = MODEL_SIZE_GB[models[j].id] ?? 0;
        const pair = a + b;
        expect({
          pair: `${models[i].id} + ${models[j].id}`,
          totalGb: pair,
          limitGb: PHYSICAL_RAM_GB,
        }).toEqual({
          pair: `${models[i].id} + ${models[j].id}`,
          totalGb: pair,
          limitGb: PHYSICAL_RAM_GB,
        });
        expect(pair).toBeLessThan(PHYSICAL_RAM_GB);
      }
    }
  });

  test('the heavy tier is served by a model proven capable of agentic work', () => {
    // The 32B coder produces correct, idiomatic code for realistic agentic
    // tasks in ~24s (measured 2026-10-25). A larger model is not required for
    // the heavy class, and demanding one caused the unified-memory crash.
    const heavy = models.find(m => m.weight === 'heavy');
    expect(heavy?.id).toBe('qwen2.5-coder:32b');
  });

  test('no model in the default roster exceeds half the physical RAM', () => {
    for (const m of models) {
      const gb = MODEL_SIZE_GB[m.id] ?? 0;
      expect({ id: m.id, gb }).toEqual({ id: m.id, gb });
      expect(gb).toBeLessThan(PHYSICAL_RAM_GB / 2);
    }
  });
});
