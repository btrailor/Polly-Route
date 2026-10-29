import fs from 'fs';
import path from 'path';
import { ModesConfig, ModeId, DEFAULT_MODE, validateModeId } from './schema.js';

const DEFAULT_CONFIG: ModesConfig = {
  version: 1,
  defaultMode: DEFAULT_MODE,
  modes: {},
};

/**
 * Resolve the path to the modes config.
 *
 * `OPENCLAW_MODES_PATH` overrides the default location. This exists so tests
 * (and CI) can run against a tracked fixture instead of depending on a
 * developer's ~/.openclaw/modes.json — the modes test suite otherwise fails
 * on any machine (or CI runner) where that file is absent.
 */
export function modesConfigPath(): string {
  const override = process.env.OPENCLAW_MODES_PATH;
  if (override && override.trim()) return override.trim();
  return path.join(process.env.HOME || '.', '.openclaw', 'modes.json');
}

export function loadModesConfig(): ModesConfig {
  const configPath = modesConfigPath();
  let raw: Partial<ModesConfig> = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.warn('[mode-resolver] modes.json not found, using empty defaults:', (e as Error).message);
    return DEFAULT_CONFIG;
  }

  const defaultMode: ModeId = validateModeId(raw.defaultMode) ? raw.defaultMode : DEFAULT_MODE;
  const modes: Record<string, import('./schema.js').Mode> = {};

  if (raw.modes && typeof raw.modes === 'object') {
    for (const [id, mode] of Object.entries(raw.modes)) {
      modes[id] = mode;
    }
  }

  return {
    $schema: raw.$schema,
    version: Number(raw.version) || 1,
    defaultMode,
    modes,
  };
}


export function getMode(config: ModesConfig, id: ModeId): import('./schema.js').Mode | undefined {
  return config.modes[id];
}

export function listModes(config: ModesConfig): string[] {
  return Object.keys(config.modes);
}
