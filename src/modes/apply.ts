/**
 * Apply a resolved mode to an OpenClaw request body.
 *
 * This is a pure function: it returns a new request body with mode-driven
 * overrides applied. It does not mutate the input.
 *
 * Override rules:
 * - model.primary is set only when the mode provides a non-null value.
 * - model.fallbacks are replaced (not merged) when provided.
 * - tools.allow is intersected with the existing tools list.
 * - tools.deny is added to the existing denied tools.
 * - tools.requireConfirmation is added.
 * - prompt.systemSuffix is appended to the existing system message or added
 *   as a new system message if absent.
 * - prompt.temperature is set only when provided.
 * - lockdown: removes cloud providers from fallbacks, disables web tools,
 *   and forces model primary to a local provider if not already set.
 */

import { Mode, ModeTools } from './schema.js';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface RequestBody {
  model?: string;
  messages: Array<{ role: string; content?: string | null }>;
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  temperature?: number;
  [key: string]: unknown;
}

export interface AgentToolPolicy {
  allow?: string[];
  deny?: string[];
  requireConfirmation?: string[];
}

function isCloudModel(model: string): boolean {
  return !model.startsWith('ollama/') && !model.startsWith('ollamapro/');
}

function intersectNames(allowed: string[], tools: ToolDefinition[]): ToolDefinition[] {
  const allowSet = new Set(allowed.map(s => s.toLowerCase()));
  return tools.filter(t => allowSet.has(t.function.name.toLowerCase()));
}

function filterDenied(denied: string[], tools: ToolDefinition[]): ToolDefinition[] {
  const denySet = new Set(denied.map(s => s.toLowerCase()));
  return tools.filter(t => !denySet.has(t.function.name.toLowerCase()));
}

export function applyModeToRequest(
  mode: Mode,
  body: RequestBody,
  agentPolicy: AgentToolPolicy = {},
): RequestBody {
  const result: RequestBody = { ...body };

  // --- Model overrides ---
  if (mode.model.primary) {
    result.model = mode.model.primary;
  }

  // --- Tool overrides ---
  const effectiveAllow = mode.tools.allow
    ? mode.tools.allow
    : agentPolicy.allow ?? null;
  const effectiveDeny = [
    ...(agentPolicy.deny || []),
    ...(mode.tools.deny || []),
  ];

  if (mode.flags.absolute || mode.flags.disableWeb) {
    effectiveDeny.push('web_search', 'web_fetch', 'browser');
  }

  if (mode.flags.disableSubagents) {
    effectiveDeny.push('sessions_spawn', 'sessions_send', 'subagents');
  }

  if (mode.flags.disableExec) {
    effectiveDeny.push('exec', 'process');
  }

  let tools = body.tools ? [...body.tools] : [];
  if (effectiveAllow) {
    tools = intersectNames(effectiveAllow, tools);
  }
  tools = filterDenied(effectiveDeny, tools);
  if (tools.length !== (body.tools?.length ?? 0)) {
    result.tools = tools;
  }

  // --- Prompt overrides ---
  if (mode.prompt.systemSuffix || mode.prompt.temperature !== null) {
    const messages = body.messages ? [...body.messages] : [];
    const sysIndex = messages.findIndex(m => m.role === 'system');
    if (mode.prompt.systemSuffix) {
      const suffix = mode.prompt.systemSuffix;
      if (sysIndex >= 0) {
        const existing = messages[sysIndex];
        messages[sysIndex] = {
          ...existing,
          content: `${existing.content ?? ''}\n\n[${mode.name}] ${suffix}`.trim(),
        };
      } else {
        messages.unshift({
          role: 'system',
          content: `[${mode.name}] ${suffix}`,
        });
      }
    }
    result.messages = messages;
  }

  if (mode.prompt.temperature !== null) {
    result.temperature = mode.prompt.temperature;
  }

  // --- Lockdown absolutes ---
  if (mode.flags.absolute) {
    if (result.model && isCloudModel(result.model)) {
      delete result.model;
    }
    // Strip any remaining cloud fallbacks if present in metadata.
    if (result.metadata && typeof result.metadata === 'object' && 'fallbacks' in result.metadata) {
      const md = result.metadata as Record<string, unknown>;
      const fallbacks = Array.isArray(md.fallbacks)
        ? (md.fallbacks as string[]).filter(m => !isCloudModel(m))
        : [];
      md.fallbacks = fallbacks;
    }
  }

  return result;
}
