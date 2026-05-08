import { describe, test, expect } from '@jest/globals';
import { injectVaultContext, estimateChars } from '../src/injector';
import { RequestBody, Message } from '../src/types';

describe('injectVaultContext', () => {
  const base: RequestBody = {
    model: 'auto',
    messages: [
      { role: 'system',    content: 'You are the accountability coach.' },
      { role: 'user',      content: 'How am I doing this week?' },
    ],
    tools: [{ type: 'function', function: { name: 'memory_search', parameters: {} } }],
  };

  test('no chunks — returns same object reference (no copy)', () => {
    const result = injectVaultContext(base, []);
    expect(result).toBe(base);
  });

  test('with chunks — original system message unchanged', () => {
    const result = injectVaultContext(base, ['vault chunk one']);
    expect(result.messages[0]).toEqual(base.messages[0]);
  });

  test('with chunks — original user message unchanged', () => {
    const result = injectVaultContext(base, ['vault chunk one']);
    const userMsgs = result.messages.filter(m => m.role === 'user');
    expect(userMsgs[0]).toEqual(base.messages[1]);
  });

  test('with chunks — tools array unchanged', () => {
    const result = injectVaultContext(base, ['vault chunk one']);
    expect(result.tools).toEqual(base.tools);
  });

  test('with chunks — exactly one new message added', () => {
    const result = injectVaultContext(base, ['chunk one', 'chunk two']);
    expect(result.messages.length).toBe(base.messages.length + 1);
  });

  test('injected message is system role', () => {
    const result = injectVaultContext(base, ['chunk one']);
    const injected = result.messages.find(m =>
      m.role === 'system' && m !== base.messages[0]
    );
    expect(injected).toBeDefined();
    expect(injected?.role).toBe('system');
  });

  test('injected message contains vault content', () => {
    const result = injectVaultContext(base, ['important vault data']);
    const injected = result.messages.find(m =>
      m.role === 'system' && typeof m.content === 'string' && m.content.includes('important vault data')
    );
    expect(injected).toBeDefined();
  });

  test('injected message appears before user message', () => {
    const result = injectVaultContext(base, ['chunk']);
    const injectedIdx = result.messages.findIndex(m =>
      m.role === 'system' && m !== base.messages[0]
    );
    const userIdx = result.messages.findIndex(m => m.role === 'user');
    expect(injectedIdx).toBeGreaterThanOrEqual(0);
    expect(injectedIdx).toBeLessThan(userIdx);
  });

  test('multiple chunks — all included in injected message', () => {
    const result = injectVaultContext(base, ['chunk A', 'chunk B', 'chunk C']);
    const injected = result.messages.find(m =>
      m.role === 'system' && m !== base.messages[0]
    );
    const content = injected?.content as string;
    expect(content).toContain('chunk A');
    expect(content).toContain('chunk B');
    expect(content).toContain('chunk C');
  });
});

describe('estimateChars', () => {
  test('string content summed correctly', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'hello' },  // 5
      { role: 'user',   content: 'world!' }, // 6
    ];
    expect(estimateChars(msgs)).toBe(11);
  });

  test('empty messages array → 0', () => {
    expect(estimateChars([])).toBe(0);
  });

  test('array content parts summed', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] },
    ];
    expect(estimateChars(msgs)).toBe(11);
  });
});
