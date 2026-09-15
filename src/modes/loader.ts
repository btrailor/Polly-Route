import fs from 'fs';
import path from 'path';
import { ModesConfig, ModeId, DEFAULT_MODE, validateModeId } from './schema.js';

const DEFAULT_CONFIG: ModesConfig = {
  version: 1,
  defaultMode: DEFAULT_MODE,
  modes: {},
};

export function modesConfigPath(): string {
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
