import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { loadModesConfig, getMode, listModes, modesConfigPath } from '../../src/modes/loader.js';
import { validateModeId } from '../../src/modes/schema.js';

describe('loadModesConfig', () => {
  it('loads the tracked modes.json with every known mode', () => {
    const config = loadModesConfig();
    expect(config.version).toBe(1);
    expect(config.defaultMode).toBe('default');
    // Containment rather than an exact list, so adding a mode does not break
    // this test — but every mode in the file must be a known mode id.
    for (const id of Object.keys(config.modes)) {
      expect(validateModeId(id)).toBe(true);
    }
    for (const id of ['default', 'fast', 'precise', 'creative', 'ops', 'syntaxis', 'lockdown']) {
      expect(config.modes[id]).toBeDefined();
    }
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
    // Resolution order: OPENCLAW_MODES_PATH override, then the repo's tracked
    // modes.json, then the legacy ~/.openclaw/modes.json.
    const override = process.env.OPENCLAW_MODES_PATH;
    if (override && override.trim()) {
      expect(modesConfigPath()).toBe(override.trim());
      return;
    }
    const repoRoot = path.resolve(__dirname, '..', '..');
    const tracked = path.join(repoRoot, 'modes.json');
    if (fs.existsSync(tracked)) {
      expect(modesConfigPath()).toBe(tracked);
    } else {
      expect(modesConfigPath()).toMatch(/\.openclaw[/\\]modes\.json$/);
    }
  });

  it('prefers the tracked repo modes.json over the legacy per-machine path', () => {
    // The mode definitions are version-controlled so they travel with the code.
    // The legacy ~/.openclaw/modes.json is only a fallback.
    delete process.env.OPENCLAW_MODES_PATH;
    const repoRoot = path.resolve(__dirname, '..', '..');
    const tracked = path.join(repoRoot, 'modes.json');
    expect(fs.existsSync(tracked)).toBe(true);
    expect(modesConfigPath()).toBe(tracked);
  });
});
