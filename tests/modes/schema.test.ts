import { describe, it, expect } from '@jest/globals';
import { KNOWN_MODE_IDS, validateModeId, DEFAULT_MODE } from '../../src/modes/schema.js';

describe('mode schema', () => {
  it('has six defined modes', () => {
    expect(KNOWN_MODE_IDS).toHaveLength(6);
    expect(KNOWN_MODE_IDS).toContain('default');
    expect(KNOWN_MODE_IDS).toContain('fast');
    expect(KNOWN_MODE_IDS).toContain('precise');
    expect(KNOWN_MODE_IDS).toContain('creative');
    expect(KNOWN_MODE_IDS).toContain('ops');
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
});
