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
 * Resolution order:
 *   1. `OPENCLAW_MODES_PATH` — explicit override. Used by tests and CI.
 *   2. The repo's tracked `modes.json` — the canonical, version-controlled
 *      source of truth.
 *   3. `~/.openclaw/modes.json` — legacy per-machine location, still honored
 *      so an existing setup keeps working unchanged.
 *
 * The repo copy wins so that the mode definitions (including the local-first
 * `syntaxis` mode) are version-controlled and travel with the code. The
 * `__dirname` math resolves to the repo root from both `src/modes/` and
 * `dist/modes/`, so the same file is found whether running from source or
 * from the compiled build.
 */
export function modesConfigPath(): string {
  const override = process.env.OPENCLAW_MODES_PATH;
  if (override && override.trim()) return override.trim();

  const repoRoot = path.resolve(__dirname, '..', '..');
  const tracked = path.join(repoRoot, 'modes.json');
  if (fs.existsSync(tracked)) return tracked;

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
