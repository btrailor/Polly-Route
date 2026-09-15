import { describe, it, expect } from '@jest/globals';
import { classifyModeContext, classifyModeFromMessages } from '../../src/modes/classifier.js';

describe('classifyModeContext', () => {
  it('suggests lockdown for no-network language', () => {
    const r = classifyModeContext('Please handle this in lockdown; do not send anything to the cloud.');
    expect(r?.mode).toBe('lockdown');
    expect(r?.confidence).toBe(1);
  });

  it('suggests ops for local system tasks', () => {
    const r = classifyModeContext('Run this script on my Mac and fix the launchd plist.');
    expect(r?.mode).toBe('ops');
    expect(r?.confidence).toBeGreaterThan(0.5);
  });

  it('suggests fast for quick responses', () => {
    const r = classifyModeContext('Quick one-liner: what is 2+2?');
    expect(r?.mode).toBe('fast');
  });

  it('suggests precise for verification requests', () => {
    const r = classifyModeContext('Cite sources and verify the exact steps.');
    expect(r?.mode).toBe('precise');
  });

  it('suggests creative for generative requests', () => {
    const r = classifyModeContext('Brainstorm ten blog titles for a coffee brand.');
    expect(r?.mode).toBe('creative');
  });

  it('returns null for neutral text', () => {
    expect(classifyModeContext('hello')).toBeNull();
  });
});

describe('classifyModeFromMessages', () => {
  it('combines user messages for classification', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'lockdown please' },
    ];
    const r = classifyModeFromMessages(messages);
    expect(r?.mode).toBe('lockdown');
  });
});
