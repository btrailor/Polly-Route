/**
 * Resolve the active mode for a session / request.
 *
 * Resolution order:
 *   1. `/mode` command in the most recent user message.
 *   2. `body.metadata.mode`.
 *   3. `OPENCLAW_MODE` environment variable.
 *   4. `modes.defaultMode` from config.
 *
 * Returns the resolved mode id, the mode definition, and provenance so the
 * caller can log / surface why this mode was chosen.
 */

import { ModesConfig, ModeId, Mode, DEFAULT_MODE, validateModeId } from './schema.js';
import { findModeCommandInMessages } from './parser.js';
import { classifyModeFromMessages } from './classifier.js';

export interface ResolutionResult {
  modeId: ModeId;
  mode: Mode;
  provenance: 'command' | 'metadata' | 'env' | 'default' | 'suggested';
  suggestionConfidence?: number;
}

export interface RequestMetadata {
  mode?: string;
  [key: string]: unknown;
}

export function resolveMode(
  config: ModesConfig,
  messages: Array<{ role: string; content?: string | null }> = [],
  metadata?: RequestMetadata,
  env: Record<string, string | undefined> = process.env,
  allowSuggestion = false,
): ResolutionResult {
  // 1. Explicit /mode command
  const cmd = findModeCommandInMessages(messages);
  if (cmd?.mode) {
    const mode = config.modes[cmd.mode];
    if (mode) {
      return { modeId: cmd.mode, mode, provenance: 'command' };
    }
    // Unknown command mode id falls through to default so we never run undefined.
  }

  // 2. Request metadata
  if (metadata?.mode) {
    const id = metadata.mode as ModeId;
    const mode = config.modes[id];
    if (mode) {
      return { modeId: id, mode, provenance: 'metadata' };
    }
  }

  // 3. Environment variable
  const envMode = env.OPENCLAW_MODE as ModeId | undefined;
  if (envMode && config.modes[envMode]) {
    return { modeId: envMode, mode: config.modes[envMode], provenance: 'env' };
  }

  // 4. Optional classifier suggestion
  if (allowSuggestion) {
    const suggestion = classifyModeFromMessages(messages);
    if (suggestion && config.modes[suggestion.mode] && suggestion.mode !== DEFAULT_MODE) {
      return {
        modeId: suggestion.mode,
        mode: config.modes[suggestion.mode],
        provenance: 'suggested',
        suggestionConfidence: suggestion.confidence,
      };
    }
  }

  // 5. Config default
  const defaultId = config.defaultMode || DEFAULT_MODE;
  const defaultMode = config.modes[defaultId] || config.modes[DEFAULT_MODE];
  if (!defaultMode) {
    throw new Error(`[mode-resolver] No mode definition found for default "${defaultId}" and no fallback default mode exists.`);
  }
  return { modeId: defaultId, mode: defaultMode, provenance: 'default' };
}
