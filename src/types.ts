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

export interface RoutingDecision {
  complexity: Complexity;
  vault: VaultConfidence;
  vaultScore: number;
  chain: string[];
}

export interface RequestLogEntry {
  ts: string;
  provider: string;
  complexity: Complexity;
  vault: VaultConfidence;
  ms: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}
