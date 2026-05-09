/**
 * contractTranslation.ts — Contract translation for local model routing.
 *
 * When polly-router routes a request to a local model, the tool surface must
 * be reduced and the system prompt rewritten to match. This module performs
 * that translation as a pure function: no I/O, no external calls, deterministic.
 *
 * Invariants (must all hold — see design.md for full specification):
 *   I1 — Tool schema coherence: schema names ↔ prompt references are identical sets
 *   I2 — No phantom tool references: prompt never names a tool whose schema is absent
 *   I3 — Identity preserved: agent name, role, behavioral instructions survive translation
 *   I4 — Cloud path: input = output except vault context append (enforced in server.ts)
 *   I5 — Token budget respected: translated request fits model window
 *   I6 — Local surface is a strict subset of original tools
 *   I7 — Deterministic: same inputs always produce same output
 */

import { Message, Tool } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractTranslationOptions {
  /** Tools to preserve in the local surface. Must be a subset of request tools. */
  localSurface: string[];
  /** Maximum token budget for the translated request (messages + tools). */
  maxTokens: number;
  /** Model name, used for logging/debugging only. */
  model?: string;
}

export interface TranslationResult {
  messages: Message[];
  tools: Tool[];
  /** Tokens estimated in the translated request. */
  estimatedTokens: number;
  /** Tools removed during translation. */
  removedTools: string[];
  /** Whether context compression was applied. */
  compressed: boolean;
}

// ---------------------------------------------------------------------------
// Default local tool surface
// ---------------------------------------------------------------------------

/**
 * Default tools preserved when routing to any local model.
 * See design.md "Local Tool Surface" for selection criteria.
 *
 * Excluded by default (with reasons):
 *   - message: denied by 57/59 cloud agents; per-agent opt-in
 *   - cron: blocks gateway event loop
 *   - edit: risky with hallucinated oldText on small models
 *   - exec: system-level, dangerous with hallucinated args
 *   - web_search / web_fetch / browser: group:web, not locally meaningful
 *   - image_generate / video_generate / tts / music_generate: group:ui
 *   - sessions_*: group:sessions, orchestration
 *   - gateway / nodes: admin/device tools, explicitly denied by all agents
 *
 * Included QMD tools (qmd__query, qmd__get, qmd__multi_get, qmd__status):
 *   These are vault search tools registered via QMD MCP server.
 *   Vault-primary agents (cartographer, archivist) depend on these.
 *   Local routing is triggered by vault relevance — stripping vault search
 *   tools on the local path would be self-defeating.
 */
export const DEFAULT_LOCAL_SURFACE: string[] = [
  'memory_search',
  'memory_get',
  'update_plan',
  'read',
  'write',
  // QMD vault search tools (registered via MCP server 'qmd')
  // These are the primary tools for vault-primary agents (cartographer, archivist)
  // and must survive contract translation when routing local.
  'qmd__query',
  'qmd__get',
  'qmd__multi_get',
  'qmd__status',
];

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token estimator: 1 token ≈ 4 chars for English prose.
 * JSON schemas are denser; this deliberately over-estimates for safety.
 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

// ---------------------------------------------------------------------------
// Tool schema reduction (I1, I2, I6)
// ---------------------------------------------------------------------------

/**
 * Filter the request's tool list to only those in the local surface.
 * Preserves schema integrity — no partial schemas.
 */
export function reduceTools(
  tools: Tool[],
  localSurface: string[],
): { kept: Tool[]; removed: string[] } {
  const surfaceSet = new Set(localSurface);
  const kept: Tool[] = [];
  const removed: string[] = [];

  for (const tool of tools) {
    const name = tool.function?.name;
    if (name && surfaceSet.has(name)) {
      kept.push(tool);
    } else if (name) {
      removed.push(name);
    }
  }

  return { kept, removed };
}

// ---------------------------------------------------------------------------
// System prompt rewrite (I1, I2, I3)
// ---------------------------------------------------------------------------

const TOOLS_SECTION_MARKER = '<!-- polly:local-tools -->';

/**
 * Rewrite the system prompt to:
 *   1. Preserve the identity block (I3)
 *   2. Replace the tools-available section with exactly the local surface (I1, I2)
 *
 * The rewrite appends a tools declaration section at the end of the system prompt.
 * If a prior polly-injected tools section exists (marked by TOOLS_SECTION_MARKER),
 * it is replaced. Otherwise the section is appended.
 */
export function rewriteSystemPrompt(
  systemContent: string,
  keptTools: Tool[],
  removedTools: string[],
): string {
  // Remove any previous polly tools section
  const markerIndex = systemContent.indexOf(TOOLS_SECTION_MARKER);
  const base = markerIndex >= 0
    ? systemContent.slice(0, markerIndex).trimEnd()
    : systemContent.trimEnd();

  if (keptTools.length === 0) {
    return base + `\n\n${TOOLS_SECTION_MARKER}\nYou have no tools available in this context.`;
  }

  const toolNames = keptTools.map(t => `\`${t.function.name}\``).join(', ');
  const removedNote = removedTools.length > 0
    ? `The following tools are NOT available in this context and must not be called: ${removedTools.map(n => `\`${n}\``).join(', ')}. Any instructions above referencing these tools do not apply here.`
    : '';
  const toolsSection = [
    TOOLS_SECTION_MARKER,
    `You have access to the following tools ONLY. You may not call any other tool.`,
    ``,
    `Available tools: ${toolNames}`,
    ...(removedNote ? ['', removedNote] : []),
  ].join('\n');

  return base + '\n\n' + toolsSection;
}

// ---------------------------------------------------------------------------
// Context compression (I5)
// ---------------------------------------------------------------------------

/**
 * Compress conversation history to fit within the token budget.
 *
 * Priority order (what survives when budget is tight):
 *   1. System prompt (never compressed)
 *   2. Current user message (never compressed)
 *   3. Most recent 2 assistant+user turn pairs
 *   4. Tool results for the current turn
 *   5. Older conversation history (dropped first)
 *
 * Returns the compressed message list.
 */
export function compressHistory(
  messages: Message[],
  toolTokens: number,
  maxTokens: number,
): { messages: Message[]; compressed: boolean } {
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  const systemTokens = estimateTokens(systemMessages);
  let budget = maxTokens - systemTokens - toolTokens;

  if (budget <= 0) {
    // System prompt alone exceeds budget — can't help, return as-is
    return { messages, compressed: false };
  }

  // Always keep the last user message
  const lastUserIdx = [...nonSystem].reverse().findIndex(m => m.role === 'user');
  if (lastUserIdx === -1) {
    return { messages, compressed: false };
  }
  const lastUserMessage = nonSystem[nonSystem.length - 1 - lastUserIdx];
  const lastUserTokens = estimateTokens(lastUserMessage);
  budget -= lastUserTokens;

  if (budget <= 0) {
    return { messages: [...systemMessages, lastUserMessage], compressed: true };
  }

  // Fill remaining budget with most recent turns (excluding last user message)
  const history = nonSystem.filter(m => m !== lastUserMessage);
  const kept: Message[] = [];
  let compressed = false;

  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateTokens(history[i]);
    if (budget - t >= 0) {
      kept.unshift(history[i]);
      budget -= t;
    } else {
      compressed = true;
      break;
    }
  }

  return {
    messages: [...systemMessages, ...kept, lastUserMessage],
    compressed,
  };
}

// ---------------------------------------------------------------------------
// Main entry point (I7 — pure, deterministic)
// ---------------------------------------------------------------------------

/**
 * Translate a request body for local model dispatch.
 *
 * Pure function: no I/O, no randomness, no external calls.
 * Same inputs always produce the same output (I7).
 *
 * @param messages - Original message list from the request
 * @param tools    - Original tool list from the request
 * @param options  - Local surface, token budget, and model hint
 * @returns        - Translated messages, tools, and translation metadata
 */
export function contractTranslate(
  messages: Message[],
  tools: Tool[],
  options: ContractTranslationOptions,
): TranslationResult {
  const { localSurface, maxTokens } = options;

  // I6 — local surface must be a subset of the original tools
  const originalNames = new Set(tools.map(t => t.function?.name).filter(Boolean));
  const effectiveSurface = localSurface.filter(name => originalNames.has(name));

  // Step 1: Reduce tool schemas
  const { kept: keptTools, removed: removedTools } = reduceTools(tools, effectiveSurface);

  // Step 2: Rewrite system prompt (I1, I2, I3)
  const rewrittenMessages = messages.map(m => {
    if (m.role === 'system') {
      return {
        ...m,
        content: rewriteSystemPrompt(m.content as string, keptTools, removedTools),
      };
    }
    return m;
  });

  // Step 3: Compress context to fit token budget (I5)
  const toolTokens = estimateTokens(keptTools);
  const { messages: compressedMessages, compressed } = compressHistory(
    rewrittenMessages,
    toolTokens,
    maxTokens,
  );

  const estimatedTokens = estimateTokens(compressedMessages) + toolTokens;

  return {
    messages: compressedMessages,
    tools: keptTools,
    estimatedTokens,
    removedTools,
    compressed,
  };
}
