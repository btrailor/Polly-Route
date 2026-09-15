import { RequestBody } from '../types.js';
import { dispatchOpenAI } from './base.js';
import { ProviderConfig } from '../config.js';
import http from 'http';

/**
 * Direct API adapter for Kimi (Moonshot AI).
 * Endpoint: https://api.moonshot.cn/v1
 * OpenAI-compatible chat completions API.
 *
 * Advantages over OpenRouter intermediary:
 * - Full rate limits (no intermediary throttling)
 * - Lower latency (direct connection)
 * - Access to Moonshot-specific features (long context, file search)
 *
 * Fallback: If this adapter fails (429/5xx/timeout), the router
 * falls through to OpenRouter/Ollama Pro which also expose Kimi models.
 */
export function kimiAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> => {
    const model = (body.model && body.model !== 'auto') ? body.model : (cfg.defaultModel ?? 'moonshot-v1-auto');
    // Kimi supports max_tokens (not max_completion_tokens); strip the latter
    const { max_completion_tokens, ...rest } = body as any;
    const kimiBody: RequestBody = max_completion_tokens
      ? { ...rest, max_tokens: max_completion_tokens }
      : rest;
    return dispatchOpenAI(
      cfg.baseUrl,
      cfg.apiKey ?? '',
      model,
      kimiBody,
      { timeoutMs: cfg.timeoutMs ?? 60000 },
    );
  };
}