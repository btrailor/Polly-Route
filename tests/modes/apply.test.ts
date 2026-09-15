import { describe, it, expect } from '@jest/globals';
import { applyModeToRequest } from '../../src/modes/apply.js';
import { Mode } from '../../src/modes/schema.js';

function makeMode(overrides: Partial<Mode> = {}): Mode {
  return {
    name: 'Test',
    description: 'd',
    routing: { target: 'auto', costBias: 'balanced', localFirst: false },
    model: { primary: null, fallbacks: null },
    tools: { allow: null, deny: null, requireConfirmation: null },
    prompt: { systemSuffix: null, temperature: null },
    flags: { absolute: false, auditBeforeTool: false, disableWeb: false, disableSubagents: false, disableExec: false },
    ...overrides,
  };
}

function tool(name: string) {
  return { type: 'function' as const, function: { name } };
}

describe('applyModeToRequest', () => {
  it('overrides model primary when set', () => {
    const mode = makeMode({ model: { primary: 'ollama/qwen2.5:7b', fallbacks: null } });
    const out = applyModeToRequest(mode, { messages: [] });
    expect(out.model).toBe('ollama/qwen2.5:7b');
  });

  it('does not override model when primary is null', () => {
    const mode = makeMode();
    const out = applyModeToRequest(mode, { model: 'existing', messages: [] });
    expect(out.model).toBe('existing');
  });

  it('filters denied tools', () => {
    const mode = makeMode({ tools: { allow: null, deny: ['web_search'], requireConfirmation: null } });
    const out = applyModeToRequest(mode, {
      messages: [],
      tools: [tool('web_search'), tool('read')],
    });
    expect(out.tools).toHaveLength(1);
    expect(out.tools?.[0].function.name).toBe('read');
  });

  it('intersects allowed tools', () => {
    const mode = makeMode({ tools: { allow: ['read'], deny: null, requireConfirmation: null } });
    const out = applyModeToRequest(mode, {
      messages: [],
      tools: [tool('read'), tool('write'), tool('web_search')],
    });
    expect(out.tools).toHaveLength(1);
    expect(out.tools?.[0].function.name).toBe('read');
  });

  it('appends system suffix', () => {
    const mode = makeMode({ prompt: { systemSuffix: 'Be concise.', temperature: null } });
    const out = applyModeToRequest(mode, {
      messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }],
    });
    expect(out.messages[0].content).toContain('[Test] Be concise.');
    expect(out.messages[0].content).toContain('You are helpful.');
  });

  it('sets temperature', () => {
    const mode = makeMode({ prompt: { systemSuffix: null, temperature: 0.3 } });
    const out = applyModeToRequest(mode, { messages: [] });
    expect(out.temperature).toBe(0.3);
  });

  it('lockdown drops cloud primary', () => {
    const mode = makeMode({
      name: 'Lockdown',
      flags: { absolute: true, auditBeforeTool: false, disableWeb: true, disableSubagents: true, disableExec: false },
    });
    const out = applyModeToRequest(mode, {
      model: 'openrouter/some-model',
      messages: [],
      tools: [tool('web_search'), tool('read'), tool('exec')],
    });
    expect(out.model).toBeUndefined();
    const names = out.tools?.map(t => t.function.name).sort();
    expect(names).toEqual(['exec', 'read']);
  });
});
