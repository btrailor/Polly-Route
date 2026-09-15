import { RequestBody } from '../types.js';
import { dispatchOpenAI } from './base.js';
import { ProviderConfig } from '../config.js';
import http from 'http';

/**
 * Direct API adapter for GLM (Zhipu AI / BigModel).
 * Endpoint: https://open.bigmodel.cn/api/paas/v4
 * OpenAI-compatible chat completions API.
 *
 * Advantages over OpenRouter/Ollama Pro intermediary:
 * - Full rate limits (no intermediary throttling)
 * - Lower latency (direct connection)
 * - Access to Zhipu-specific features (web search, code interpreter)
 *
 * Fallback: If this adapter fails (429/5xx/timeout), the router
 * falls through to OpenRouter/Ollama Pro which also expose GLM models.
 */
export function glmAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> => {
    const model = (body.model && body.model !== 'auto') ? body.model : (cfg.defaultModel ?? 'glm-4-flash');
    // GLM supports max_tokens; strip max_completion_tokens if present
    const { max_completion_tokens, ...rest } = body as any;
    const glmBody: RequestBody = max_completion_tokens
      ? { ...rest, max_tokens: max_completion_tokens }
      : rest;
    return dispatchOpenAI(
      cfg.baseUrl,
      cfg.apiKey ?? '',
      model,
      glmBody,
      { timeoutMs: cfg.timeoutMs ?? 60000 },
    );
  };
}