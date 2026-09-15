import { describe, it, expect } from '@jest/globals';
import { parseModeCommand, findModeCommandInMessages } from '../../src/modes/parser.js';

describe('parseModeCommand', () => {
  it('parses /mode <name>', () => {
    expect(parseModeCommand('/mode fast')).toEqual({ mode: 'fast', list: false, reset: false });
    expect(parseModeCommand('/mode lockdown')).toEqual({ mode: 'lockdown', list: false, reset: false });
  });

  it('treats bare /mode and /mode list as list', () => {
    expect(parseModeCommand('/mode')).toEqual({ list: true, reset: false });
    expect(parseModeCommand('/mode list')).toEqual({ list: true, reset: false });
  });

  it('treats reset/clear/default as reset', () => {
    expect(parseModeCommand('/mode reset')).toEqual({ list: false, reset: true });
    expect(parseModeCommand('/mode clear')).toEqual({ list: false, reset: true });
    expect(parseModeCommand('/mode default')).toEqual({ list: false, reset: true });
  });

  it('ignores non-command text', () => {
    expect(parseModeCommand('please use /mode fast')).toBeNull();
    expect(parseModeCommand('hello')).toBeNull();
  });
});

describe('findModeCommandInMessages', () => {
  it('finds the last user /mode command', () => {
    const messages = [
      { role: 'user', content: '/mode precise' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '/mode fast' },
    ];
    expect(findModeCommandInMessages(messages)).toEqual({ mode: 'fast', list: false, reset: false });
  });

  it('returns null when no command present', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(findModeCommandInMessages(messages)).toBeNull();
  });
});
