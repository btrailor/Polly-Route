import fs from 'fs';
import path from 'path';

export interface OllamaModel {
  id: string;
  name: string;
  maxChars: number;
  weight: 'light' | 'medium' | 'heavy';
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  dailyRequestLimit?: number;  // max requests per 24h rolling window (free tier enforcement)
  maxRequestChars?: number;    // skip provider if request exceeds this size
}

export interface Config {
  port: number;
  ollama: {
    baseUrl: string;
    models: OllamaModel[];
  };
  providers: {
    groq?: ProviderConfig;
    cerebras?: ProviderConfig;
    google?: ProviderConfig;
    mistral?: ProviderConfig;
    openrouter?: ProviderConfig;
    ollamapro?: ProviderConfig;
  };
  qmd: {
    baseUrl: string;
    collection: string;
    timeoutMs: number;
    minScore: number;
  };
}

const DEFAULT_OLLAMA_MODELS: OllamaModel[] = [
  { id: 'qwen2.5:7b',        name: 'Qwen 2.5 7B',         maxChars:  28000, weight: 'light'  },
  { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B',  maxChars: 112000, weight: 'medium' },
  { id: 'qwen2.5:72b',       name: 'Qwen 2.5 72B',        maxChars: 480000, weight: 'heavy'  },
];

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
    },
    providers: raw.providers ?? {},
    qmd: {
      baseUrl: raw.qmd?.baseUrl ?? 'http://localhost:8181',
      collection: raw.qmd?.collection ?? 'vault',
      timeoutMs: raw.qmd?.timeoutMs ?? 500,
      minScore: raw.qmd?.minScore ?? 0.89,
    },
  };
}
