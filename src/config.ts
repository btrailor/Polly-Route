import fs from 'fs';
import path from 'path';

export interface OllamaModel {
  id: string;
  name: string;
  maxChars: number;
  weight: 'light' | 'medium' | 'heavy';
  /** Model context window in tokens, used for the real budget calculation. */
  contextTokens?: number;
  /** Per-model chars-per-token override. */
  charsPerToken?: number;
  /** Per-model output headroom override (tokens). */
  headroomTokens?: number;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  dailyRequestLimit?: number;  // max requests per 24h rolling window (free tier enforcement)
  maxRequestChars?: number;    // skip provider if request exceeds this size
  timeoutMs?: number;           // optional per-provider timeout override
}

/** Estimate of characters consumed per token when checking context fit. */
export const DEFAULT_CHARS_PER_TOKEN = 2.0;

/** Output token headroom: reserve this fraction of the context window for generation. */
export const CONTEXT_HEADROOM_TOKENS = 4096;

/** Compute the safe character budget for a local model or endpoint.
 *  Uses the configured charsPerToken (default 2.0) and reserves headroom for the response.
 */
export function maxCharsForContext(
  contextTokens: number,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
  headroomTokens: number = CONTEXT_HEADROOM_TOKENS,
): number {
  const usableTokens = Math.max(0, contextTokens - headroomTokens);
  return Math.floor(usableTokens * charsPerToken);
}

export interface SkillCoverageConfig {
  /** Path to the skill index markdown file. */
  indexPath: string;
  /** Maximum time to spend probing the skill index (ms). */
  timeoutMs: number;
}

export interface ConductorConfig {
  /** Path to the conductor domains directory. */
  domainsDir: string;
  /** Maximum time to spend probing domain manifests (ms). */
  timeoutMs: number;
  /** Minimum match score to trigger conductor routing (0–1). */
  minScore: number;
}

export interface ReliabilityConfig {
  /** Master switch for the persona reliability feedback loop. */
  enabled: boolean;
  /** Number of days to look back when computing local success rate. */
  windowDays?: number;
  /** Success rate below which local routing is biased toward cloud. */
  minSuccessRate?: number;
  /** Minimum model_error attempts before cloud bias can activate. */
  minAttempts?: number;
  /** Days after which old reliability records are garbage collected. */
  gcDays?: number;
}

export interface ConfidenceConfig {
  /** Master switch for structural confidence scoring. */
  enabled: boolean;
  /** Score below which the router should escalate to the next provider. */
  escalationThreshold?: number;
  /** Known imports / modules that are valid in the target codebase. */
  knownImports?: string[];
  /** Known API call signatures (e.g. function names) that are valid. */
  knownApiCalls?: string[];
  /** Known type names that are valid in the target codebase. */
  knownTypes?: string[];
}

export interface Config {
  port: number;
  ollama: {
    baseUrl: string;
    models: OllamaModel[];
    timeoutMs?: number;
    modelTimeouts?: Record<string, number>;
    probeTimeoutMs?: number;
    /** Global chars-per-token override for all Ollama models. */
    charsPerToken?: number;
    /** Global output headroom override for all Ollama models. */
    headroomTokens?: number;
  };
  providers: {
    groq?: ProviderConfig;
    cerebras?: ProviderConfig;
    deepseek?: ProviderConfig;
    openrouter_free?: ProviderConfig;
    google?: ProviderConfig;
    mistral?: ProviderConfig;
    openrouter?: ProviderConfig;
    ollamapro?: ProviderConfig;
    // Direct API adapters (bypass OpenRouter/Ollama Pro intermediary)
    kimi?: ProviderConfig;
    glm?: ProviderConfig;
    qwen?: ProviderConfig;
  };
  qmd: {
    baseUrl: string;
    collection: string;
    timeoutMs: number;
    minScore: number;
    /**
     * Whether the QMD fallback probe is enabled. Defaults to true for
     * backward compatibility. Set false when no QMD daemon is deployed —
     * the probe then fails every time, adding latency and noise without
     * recovering any request.
     */
    enabled?: boolean;
  };
  knowledgeSkill?: {
    baseUrl: string;
    timeoutMs: number;
  };
  skillCoverage?: SkillCoverageConfig;
  conductor?: ConductorConfig;
  reliability?: ReliabilityConfig;
  confidence?: ConfidenceConfig;
  llamacpp?: {
    /** Global defaults applied to every endpoint. */
    charsPerToken?: number;
    headroomTokens?: number;
    endpoints: {
      baseUrl: string;
      model: string;
      minCtx: number;
      timeoutMs?: number;
      charsPerToken?: number;
      headroomTokens?: number;
    }[];
  };
}

const DEFAULT_OLLAMA_MODELS: OllamaModel[] = [
  { id: 'qwen2.5:7b',        name: 'Qwen 2.5 7B',         maxChars:  28000, weight: 'light',  contextTokens: 32768 },
  { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B',  maxChars: 112000, weight: 'medium', contextTokens: 32768 },
  { id: 'qwen2.5:72b',       name: 'Qwen 2.5 72B',        maxChars: 112000, weight: 'heavy',  contextTokens: 32768 },
];

// Provider ids that share a single secret file. The map key is the provider id
// used in Config['providers']; the value is the secret filename base (without
// `_api_key` suffix). For example, `openrouter_free` resolves to `openrouter_api_key`.
const PROVIDER_SECRET_ALIASES: Record<string, string> = {
  openrouter_free: 'openrouter',
};

// Map provider ids to the env var that holds their API key fallback.
// Secrets live in ~/.openclaw/secrets/<provider>_api_key and are injected
// into the environment by the OpenClaw service or launchd.
const PROVIDER_ENV_KEYS: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter_free: 'OPENROUTER_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  ollamapro: 'OLLAMAPRO_API_KEY',
  // Direct API keys (bypass OpenRouter/Ollama Pro intermediary)
  kimi: 'KIMI_API_KEY',
  glm: 'GLM_API_KEY',
  qwen: 'QWEN_API_KEY',
};

// Resolve a provider API key from, in order:
// 1. The config JSON value
// 2. A matching environment variable
// 3. A secret file under ~/.openclaw/secrets/
const SECRETS_DIR = path.join(process.env.HOME || '.', '.openclaw', 'secrets');

function readSecretFile(secretName: string): string | undefined {
  const filePath = path.join(SECRETS_DIR, secretName);
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

function resolveProviderApiKeys(providers: Config['providers']): Config['providers'] {
  const resolved: Config['providers'] = {};
  for (const [id, cfg] of Object.entries(providers ?? {})) {
    if (!cfg) continue;
    const envKey = PROVIDER_ENV_KEYS[id];
    const secretBase = PROVIDER_SECRET_ALIASES[id] ?? id;
    const secretName = `${secretBase}_api_key`;
    const apiKey =
      cfg.apiKey?.trim()
      || (envKey ? process.env[envKey]?.trim() : undefined)
      || readSecretFile(secretName);
    resolved[id as keyof Config['providers']] = { ...cfg, apiKey };
  }
  return resolved;
}

/** True when a provider block exists in config and a non-empty API key resolved. */
export function providerIsConfigured(cfg?: ProviderConfig): boolean {
  return !!(cfg && cfg.apiKey && cfg.apiKey.length > 0);
}

export function loadConfig(): Config {
  const configPath = process.env.POLLY_ROUTER_CONFIG
    || path.join(__dirname, '..', 'polly-router.config.json');

  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.warn('[polly-route] Config not found, using defaults:', (e as Error).message);
  }

  return {
    port: Number(process.env.POLLY_ROUTER_PORT) || 4200,
    ollama: {
      baseUrl: raw.ollama?.baseUrl ?? 'http://127.0.0.1:11434',
      models: raw.ollama?.models ?? DEFAULT_OLLAMA_MODELS,
      timeoutMs: raw.ollama?.timeoutMs,
      modelTimeouts: raw.ollama?.modelTimeouts,
      probeTimeoutMs: raw.ollama?.probeTimeoutMs,
      charsPerToken: raw.ollama?.charsPerToken,
    },
    providers: resolveProviderApiKeys(raw.providers ?? {}),
    qmd: {
      baseUrl: raw.qmd?.baseUrl ?? 'http://localhost:8181',
      collection: raw.qmd?.collection ?? 'vault',
      timeoutMs: raw.qmd?.timeoutMs ?? 500,
      minScore: raw.qmd?.minScore ?? 0.89,
      enabled: raw.qmd?.enabled ?? true,
    },
    knowledgeSkill: raw.knowledgeSkill ?? {
      baseUrl: 'http://localhost:4201',
      timeoutMs: 2000,
    },
    skillCoverage: raw.skillCoverage ?? {
      indexPath: path.join(process.env.HOME || '.', '.openclaw', 'workspace', 'skills', 'available-skills', 'SKILL.md'),
      timeoutMs: 1000,
    },
    conductor: (() => {
      const cfg = raw.conductor;
      if (!cfg) return {
        domainsDir: path.join(process.env.HOME || '.', '.openclaw', 'workspace', 'projects', 'syntaxis', 'conductor', 'domains'),
        timeoutMs: 2000,
        minScore: 0.35,
      };
      // Expand ~ in domainsDir if present
      let domainsDir = cfg.domainsDir;
      if (domainsDir.startsWith('~/')) {
        domainsDir = path.join(process.env.HOME || '.', domainsDir.slice(2));
      }
      return { ...cfg, domainsDir };
    })(),
    reliability: raw.reliability,
    confidence: raw.confidence,
    llamacpp: (() => {
      if (!raw.llamacpp) return undefined;
      return {
        endpoints: raw.llamacpp.endpoints ?? [],
      };
    })(),
  };
}
