/**
 * OpenClaw modes.json schema types.
 *
 * All optional fields are nullable (T | null) so that a mode can explicitly
 * say "do not override this setting".
 */

export type ModeId =
  | 'default'
  | 'fast'
  | 'precise'
  | 'creative'
  | 'ops'
  | 'lockdown';

export type RoutingTarget = 'auto' | 'local' | 'local-first' | 'best';
export type CostBias = 'free' | 'cheap' | 'balanced' | 'quality';
export type Complexity = 'LIGHT' | 'MEDIUM' | 'HEAVY';

export interface ModeRouting {
  target: RoutingTarget;
  costBias: CostBias;
  localFirst: boolean;
  maxComplexity?: Complexity | null;
}

export interface ModeModel {
  primary: string | null;
  fallbacks: string[] | null;
}

export interface ModeTools {
  allow: string[] | null;
  deny: string[] | null;
  requireConfirmation: string[] | null;
}

export interface ModePrompt {
  systemSuffix: string | null;
  temperature: number | null;
}

export interface ModeFlags {
  absolute: boolean;
  auditBeforeTool: boolean;
  disableWeb: boolean;
  disableSubagents: boolean;
  disableExec: boolean;
}

export interface Mode {
  name: string;
  description: string;
  routing: ModeRouting;
  model: ModeModel;
  tools: ModeTools;
  prompt: ModePrompt;
  flags: ModeFlags;
}

export interface ModesConfig {
  $schema?: string;
  version: number;
  defaultMode: ModeId;
  modes: Record<string, Mode>;
}

export const KNOWN_MODE_IDS: ModeId[] = [
  'default',
  'fast',
  'precise',
  'creative',
  'ops',
  'lockdown',
];

export const DEFAULT_MODE: ModeId = 'default';

export function validateModeId(id: unknown): id is ModeId {
  return typeof id === 'string' && KNOWN_MODE_IDS.includes(id as ModeId);
}
