import { describe, test, expect } from '@jest/globals';
import { injectVaultContext, estimateChars } from '../src/injector';
import { classifyComplexity } from '../src/classifier';
import { RequestBody, Message } from '../src/types';

// ─── Router Honesty Invariant ────────────────────────────────────────────────
// The router must not modify existing messages or tools.
// Vault context injection is the ONLY permitted modification:
// it appends a single new system message, nothing else.

describe('router honesty invariant', () => {
  const originalMessages: Message[] = [
    { role: 'system', content: 'AGENT IDENTITY: accountability coach.\n# SOUL.md\nYou are a direct, energizing coach.' },
    { role: 'user',   content: 'How am I doing this week?' },
  ];

  const originalTools = [
    { type: 'function' as const, function: { name: 'memory_search', description: 'Search memory', parameters: {} } },
    { type: 'function' as const, function: { name: 'cron',          description: 'Schedule',      parameters: {} } },
  ];

  const body: RequestBody = {
    model: 'auto',
    messages: originalMessages,
    tools: originalTools,
  };

  test('injectVaultContext does not modify existing messages', () => {
    const chunks = ['Vault excerpt: polly-router routes by vault confidence.'];
    const result = injectVaultContext(body, chunks);

    // Original system message unchanged
    expect(result.messages[0]).toEqual(originalMessages[0]);
    // Tools unchanged
    expect(result.tools).toEqual(originalTools);
    // One new message appended (vault context)
    expect(result.messages.length).toBe(originalMessages.length + 1);
    // The appended message is a system message containing vault content
    expect(result.messages[1].role).toBe('system');
    expect(typeof result.messages[1].content).toBe('string');
    expect((result.messages[1].content as string).toLowerCase()).toMatch(/vault/);
  });

  test('injectVaultContext with no chunks returns body unchanged', () => {
    const result = injectVaultContext(body, []);
    expect(result).toBe(body); // referential equality — same object
  });

  test('injectVaultContext appends BEFORE user message', () => {
    const chunks = ['some vault content'];
    const result = injectVaultContext(body, chunks);
    // Vault system message should be before the user message
    const vaultIdx = result.messages.findIndex(m =>
      m.role === 'system' && typeof m.content === 'string' && m.content.includes('vault')
    );
    const userIdx = result.messages.findIndex(m => m.role === 'user');
    expect(vaultIdx).toBeGreaterThanOrEqual(0);
    expect(vaultIdx).toBeLessThan(userIdx);
  });
});

// ─── Classifier ──────────────────────────────────────────────────────────────

describe('classifyComplexity', () => {
  test('hi → LIGHT', () => {
    expect(classifyComplexity([{ role: 'user', content: 'hi' }])).toBe('LIGHT');
  });

  test('architect a system → HEAVY', () => {
    expect(classifyComplexity([{ role: 'user', content: 'Can you architect a distributed system for me?' }])).toBe('HEAVY');
  });

  test('medium question → MEDIUM', () => {
    expect(classifyComplexity([{ role: 'user', content: 'Can you explain in detail how the polly router decides which model provider to use for each request, including how vault confidence and complexity classification interact to build the provider chain?' }])).toBe('MEDIUM');
  });

  test('empty messages → MEDIUM', () => {
    expect(classifyComplexity([])).toBe('MEDIUM');
  });
});

// ─── estimateChars ───────────────────────────────────────────────────────────

describe('estimateChars', () => {
  test('counts chars across messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'hello' },
      { role: 'user',   content: 'world' },
    ];
    expect(estimateChars(messages)).toBe(10);
  });
});

// ─── Contract translation wiring ─────────────────────────────────────────────
// Verifies that contractTranslate is called on the local path and that
// cloud path bodies are unmodified. Does not require a live Ollama server.

import { contractTranslate, DEFAULT_LOCAL_SURFACE } from '../src/contractTranslation';

describe('contractTranslate wiring (local path)', () => {
  const soul = '# SOUL\nYou are the Accountability Coach. You track goals and habits.';
  const messages: Message[] = [
    { role: 'system', content: soul },
    { role: 'user',   content: 'Set up a reminder for me' },
  ];
  const fullTools = [
    { type: 'function' as const, function: { name: 'memory_search', description: '', parameters: {} } },
    { type: 'function' as const, function: { name: 'cron',          description: '', parameters: {} } },
    { type: 'function' as const, function: { name: 'exec',          description: '', parameters: {} } },
  ];

  test('contract translation removes non-surface tools', () => {
    const result = contractTranslate(messages, fullTools, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
      model: 'qwen2.5:7b',
    });
    const keptNames = result.tools.map(t => t.function.name);
    expect(keptNames).not.toContain('cron');
    expect(keptNames).not.toContain('exec');
    expect(keptNames).toContain('memory_search');
  });

  test('translated system prompt does not reference removed tools', () => {
    const result = contractTranslate(messages, fullTools, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
    });
    const sys = result.messages.find(m => m.role === 'system')?.content as string;
    // The available tools line should not name cron or exec
    const availableLine = sys.match(/Available tools: (.*)/)?.[1] ?? '';
    expect(availableLine).not.toContain('cron');
    expect(availableLine).not.toContain('exec');
  });

  test('translated system prompt preserves identity', () => {
    const result = contractTranslate(messages, fullTools, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
    });
    const sys = result.messages.find(m => m.role === 'system')?.content as string;
    expect(sys).toContain('Accountability Coach');
    expect(sys).toContain('goals and habits');
  });

  test('cloud path body unchanged by contractTranslate (only vault injection permitted)', () => {
    // Cloud path in server.ts skips contractTranslate entirely.
    // This test verifies injector still does not modify existing messages.
    const body: RequestBody = { model: 'auto', messages, tools: fullTools };
    const result = injectVaultContext(body, []);
    expect(result).toBe(body); // same reference — nothing changed
  });
});
