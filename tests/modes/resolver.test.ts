import { describe, it, expect } from '@jest/globals';
import { resolveMode } from '../../src/modes/resolver.js';
import { loadModesConfig } from '../../src/modes/loader.js';
import { ModesConfig, ModeId } from '../../src/modes/schema.js';

const sampleConfig: ModesConfig = {
  version: 1,
  defaultMode: 'default',
  modes: {
    default: {
      name: 'Default',
      description: 'd',
      routing: { target: 'auto', costBias: 'balanced', localFirst: false },
      model: { primary: null, fallbacks: null },
      tools: { allow: null, deny: null, requireConfirmation: null },
      prompt: { systemSuffix: null, temperature: null },
      flags: { absolute: false, auditBeforeTool: false, disableWeb: false, disableSubagents: false, disableExec: false },
    },
    fast: {
      name: 'Fast',
      description: 'd',
      routing: { target: 'local-first', costBias: 'cheap', localFirst: true, maxComplexity: 'MEDIUM' },
      model: { primary: 'ollama/qwen2.5:7b', fallbacks: null },
      tools: { allow: null, deny: ['skill_workshop'], requireConfirmation: null },
      prompt: { systemSuffix: null, temperature: null },
      flags: { absolute: false, auditBeforeTool: false, disableWeb: false, disableSubagents: false, disableExec: false },
    },
  },
};

describe('resolveMode', () => {
  it('prefers /mode command', () => {
    const r = resolveMode(sampleConfig, [{ role: 'user', content: '/mode fast' }]);
    expect(r.modeId).toBe('fast');
    expect(r.provenance).toBe('command');
  });

  it('falls back to metadata', () => {
    const r = resolveMode(sampleConfig, [{ role: 'user', content: 'hello' }], { mode: 'fast' });
    expect(r.modeId).toBe('fast');
    expect(r.provenance).toBe('metadata');
  });

  it('falls back to env var', () => {
    const r = resolveMode(sampleConfig, [{ role: 'user', content: 'hello' }], {}, { OPENCLAW_MODE: 'fast' });
    expect(r.modeId).toBe('fast');
    expect(r.provenance).toBe('env');
  });

  it('falls back to config default', () => {
    const r = resolveMode(sampleConfig, [{ role: 'user', content: 'hello' }]);
    expect(r.modeId).toBe('default');
    expect(r.provenance).toBe('default');
  });

  it('uses classifier suggestion when enabled', () => {
    const config = loadModesConfig();
    const r = resolveMode(config, [{ role: 'user', content: 'lockdown please' }], {}, {}, true);
    expect(r.modeId).toBe('lockdown');
    expect(r.provenance).toBe('suggested');
  });

  it('loads real modes.json successfully', () => {
    const config = loadModesConfig();
    expect(Object.keys(config.modes).length).toBeGreaterThanOrEqual(6);
    const r = resolveMode(config, [{ role: 'user', content: '/mode lockdown' }]);
    expect(r.modeId).toBe('lockdown');
    expect(r.mode.flags.absolute).toBe(true);
  });
});
