import type http from 'http';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ContentPart {
  type: 'text';
  text: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface RequestBody {
  model: string;
  messages: Message[];
  tools?: Tool[];
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export type Complexity = 'LIGHT' | 'MEDIUM' | 'HEAVY';
export type VaultConfidence = 'DIRECT' | 'ADJACENT' | 'ABSENT';

export interface VaultSignal {
  confidence: VaultConfidence;
  score: number;
  chunks: string[];
}

export interface SkillSignal {
  hasSkill: boolean;
  skillName?: string;
  procedure?: string;
  score?: number;
}

export interface ConductorAction {
  id: string;
  description: string;
  execute: string;
  params: Record<string, { type: string; required?: boolean; description?: string; default?: unknown }>;
  gates: string[];
}

export interface ConductorSignal {
  /** True when a conductor domain matches the user's request. */
  matched: boolean;
  /** Domain id (e.g. "loom"). */
  domainId?: string;
  /** Domain description from manifest. */
  domainDescription?: string;
  /** System prompt extra from manifest. */
  systemPrompt?: string;
  /** All actions from the matched domain manifest. */
  actions?: ConductorAction[];
  /** Best-matching action id (e.g. "generate_scene"). */
  matchedActionId?: string;
  /** Match score (0–1). */
  score?: number;
  /** Pre-built context block to inject into the request. */
  contextBlock?: string;
}

export type RoutingTarget = 'LOCAL' | 'LOCAL+CTX' | 'CLOUD';

export interface ChainEntry {
  name: string;
  fn: (body: RequestBody) => Promise<http.IncomingMessage>;
}

export interface RoutingPlan {
  target: RoutingTarget;
  chain: ChainEntry[];
  /** Whether confidence scoring is enabled for this routing plan. */
  confidenceEnabled?: boolean;
}

// ─── Confidence scoring: structural signal for router escalation ────────────

/**
 * Structural confidence signal produced by inspecting model output.
 *
 * The router uses this to decide whether a local model's response is
 * trustworthy enough to return, or whether it should be escalated to
 * a larger model in the fallback chain.
 */
export interface ConfidenceSignal {
  /** Overall confidence score in [0, 1]. */
  score: number;
  /** Human-readable label for the score tier. */
  tier: 'high' | 'medium' | 'low';
  /** Individual checks that contributed to the score. */
  checks: ConfidenceCheck[];
  /** True when the score is below the escalation threshold. */
  shouldEscalate: boolean;
}

export interface ConfidenceCheck {
  name: string;
  passed: boolean;
  /** Weight of this check in the final score (0–1). */
  weight: number;
  /** Short human-readable detail. */
  detail?: string;
}

/**
 * Configuration for the confidence scorer.
 */
export interface ConfidenceConfig {
  /** Master switch. When false, scoring is skipped and high confidence is returned. */
  enabled: boolean;
  /** Score below which the router should escalate to the next provider. */
  escalationThreshold: number;
  /** Known imports / modules that are valid in the target codebase. */
  knownImports?: string[];
  /** Known API call signatures (e.g. function names) that are valid. */
  knownApiCalls?: string[];
  /** Known type names that are valid in the target codebase. */
  knownTypes?: string[];
}

export interface RoutingDecision {
  complexity: Complexity;
  vault: VaultConfidence;
  vaultScore: number;
  skill?: SkillSignal;
  target: RoutingTarget;
  chain: string[];
}

export interface RequestLogEntry {
  ts: string;
  provider: string;
  complexity: Complexity;
  vault: VaultConfidence;
  skill?: boolean;
  skillName?: string;
  conductor?: boolean;
  conductorDomain?: string;
  ms: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}
