import { describe, it, expect } from '@jest/globals';
import { loadModesConfig, getMode, listModes, modesConfigPath } from '../../src/modes/loader.js';
import { validateModeId } from '../../src/modes/schema.js';

describe('loadModesConfig', () => {
  it('loads ~/.openclaw/modes.json with seven modes', () => {
    const config = loadModesConfig();
    expect(config.version).toBe(1);
    expect(config.defaultMode).toBe('default');
    expect(Object.keys(config.modes).sort()).toEqual(['creative', 'default', 'fast', 'lockdown', 'ops', 'precise', 'syntaxis']);
  });

  it('exposes every known mode', () => {
    const config = loadModesConfig();
    const ids = listModes(config);
    for (const id of ids) {
      expect(validateModeId(id)).toBe(true);
      expect(getMode(config, id as any)).toBeDefined();
    }
  });

  it('reports a valid config path', () => {
    // The path may be overridden via OPENCLAW_MODES_PATH (tests and CI point
    // it at tests/fixtures/modes.json). When it is not overridden, it must be
    // the conventional ~/.openclaw/modes.json.
    const override = process.env.OPENCLAW_MODES_PATH;
    if (override && override.trim()) {
      expect(modesConfigPath()).toBe(override.trim());
    } else {
      expect(modesConfigPath()).toMatch(/\.openclaw[/\\]modes\.json$/);
    }
  });
});
