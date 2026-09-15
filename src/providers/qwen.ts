import { RequestBody } from '../types.js';
import { dispatchOpenAI } from './base.js';
import { ProviderConfig } from '../config.js';
import http from 'http';

/**
 * Direct API adapter for Qwen (Alibaba DashScope).
 * Endpoint: https://dashscope.aliyuncs.com/compatible-mode/v1
 * OpenAI-compatible chat completions API.
 *
 * Advantages over OpenRouter/Ollama Pro intermediary:
 * - Full rate limits (no intermediary throttling)
 * - Lower latency (direct connection)
 * - Access to DashScope-specific features (long context, multimodal)
 *
 * Fallback: If this adapter fails (429/5xx/timeout), the router
 * falls through to OpenRouter/Ollama Pro which also expose Qwen models.
 */
export function qwenAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> => {
    const model = (body.model && body.model !== 'auto') ? body.model : (cfg.defaultModel ?? 'qwen-plus');
    // DashScope supports max_tokens; strip max_completion_tokens if present
    const { max_completion_tokens, ...rest } = body as any;
    const qwenBody: RequestBody = max_completion_tokens
      ? { ...rest, max_tokens: max_completion_tokens }
      : rest;
    return dispatchOpenAI(
      cfg.baseUrl,
      cfg.apiKey ?? '',
      model,
      qwenBody,
      { timeoutMs: cfg.timeoutMs ?? 60000 },
    );
  };
}