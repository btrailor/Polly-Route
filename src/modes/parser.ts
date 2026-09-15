/**
 * Parse `/mode` commands from user text.
 *
 * Supported forms:
 *   /mode fast
 *   /mode precise
 *   /mode reset           → returns undefined (caller should clear mode)
 *   /mode list            → special token, caller should list modes
 *   /mode                 → same as /mode list
 */

import { ModeId, validateModeId } from './schema.js';

export interface ParsedModeCommand {
  mode?: ModeId;
  list: boolean;
  reset: boolean;
}

const MODE_COMMAND_RE = /^\/mode(?:\s+([\w-]+))?\s*$/im;

export function parseModeCommand(text: string): ParsedModeCommand | null {
  const match = text.match(MODE_COMMAND_RE);
  if (!match) return null;

  const arg = (match[1] || '').toLowerCase().trim();
  if (!arg || arg === 'list') {
    return { list: true, reset: false };
  }
  if (arg === 'reset' || arg === 'clear' || arg === 'default') {
    return { list: false, reset: true };
  }
  if (validateModeId(arg)) {
    return { mode: arg as ModeId, list: false, reset: false };
  }
  // Unknown mode argument: treat as a request for the list so the user sees valid options.
  return { list: true, reset: false };
}

export function findModeCommandInMessages(
  messages: Array<{ role: string; content?: string | null }>,
): ParsedModeCommand | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !m.content || typeof m.content !== 'string') continue;
    const parsed = parseModeCommand(m.content);
    if (parsed) return parsed;
  }
  return null;
}
