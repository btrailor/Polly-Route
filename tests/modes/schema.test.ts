import { describe, it, expect } from '@jest/globals';
import { KNOWN_MODE_IDS, validateModeId, DEFAULT_MODE } from '../../src/modes/schema.js';
import { loadModesConfig } from '../../src/modes/loader.js';

describe('mode schema', () => {
  it('has seven defined modes', () => {
    expect(KNOWN_MODE_IDS).toHaveLength(7);
    expect(KNOWN_MODE_IDS).toContain('default');
    expect(KNOWN_MODE_IDS).toContain('fast');
    expect(KNOWN_MODE_IDS).toContain('precise');
    expect(KNOWN_MODE_IDS).toContain('creative');
    expect(KNOWN_MODE_IDS).toContain('ops');
    expect(KNOWN_MODE_IDS).toContain('syntaxis');
    expect(KNOWN_MODE_IDS).toContain('lockdown');
  });

  it('validates known mode ids', () => {
    expect(validateModeId('fast')).toBe(true);
    expect(validateModeId('lockdown')).toBe(true);
    expect(validateModeId('nope')).toBe(false);
    expect(validateModeId('')).toBe(false);
    expect(validateModeId(null)).toBe(false);
  });

  it('default mode is default', () => {
    expect(DEFAULT_MODE).toBe('default');
  });

  it('syntaxis mode is local-absolute and still permits subagents', () => {
    // The 'syntaxis' mode exists so Syntaxis pipeline work (conductor domain
    // packs, the scripts they orchestrate) runs entirely on local models while
    // still allowing delegation.
    //
    // 'absolute: true' is the property that matters: in router.ts, forceLocal
    // removes the whole cloud fallback chain, so a local failure can never be
    // absorbed by a cloud provider. 'disableSubagents: false' is what makes it
    // usable for the pipeline work, which is fanned out across subagents.
    const config = loadModesConfig();
    const syntaxis = config.modes.syntaxis;
    expect(syntaxis).toBeDefined();
    expect(syntaxis.routing.target).toBe('local');
    expect(syntaxis.routing.localFirst).toBe(true);
    expect(syntaxis.flags.absolute).toBe(true);
    expect(syntaxis.flags.disableSubagents).toBe(false);

    // No cloud model may appear in the mode's primary or fallbacks.
    const models = [syntaxis.model.primary, ...(syntaxis.model.fallbacks ?? [])];
    for (const m of models) {
      expect(m ?? '').not.toMatch(/ollamapro|openrouter|google|groq|cerebras|deepseek|mistral|kimi|glm|qwen\//i);
    }
  });

  it('ops mode no longer lists a cloud model as a fallback', () => {
    // ops mode previously offered 'ollamapro/kimi-k2.7-code' as a fallback,
    // which contradicted its own "no cloud leakage" description.
    const config = loadModesConfig();
    const ops = config.modes.ops;
    const models = [ops.model.primary, ...(ops.model.fallbacks ?? [])];
    for (const m of models) {
      expect(m ?? '').not.toMatch(/ollamapro|openrouter|google|groq|cerebras|deepseek|mistral/i);
    }
  });
});
