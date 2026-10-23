import http from 'http';
import { RequestBody } from '../types.js';
import { LlamacppEndpoint } from '../llamacppDiagnostics.js';
import { dispatchOpenAI } from './base.js';
import { DEFAULT_CHARS_PER_TOKEN, CONTEXT_HEADROOM_TOKENS, maxCharsForContext } from '../config.js';

/**
 * llama-server (llama.cpp) provider adapter.
 *
 * llama-server exposes an OpenAI-compatible /v1/chat/completions endpoint.
 * Unlike Ollama, it guarantees the context size via -c at launch, and the
 * /props endpoint reports the actual n_ctx.
 *
 * This adapter lets the router dispatch to llama-server instances directly,
 * using the same contract-translation and tool-rewriting pipeline that
 * handles Ollama responses.
 */
export class LlamacppAdapter {
  constructor(private endpoint: LlamacppEndpoint, private defaults?: { charsPerToken?: number; headroomTokens?: number }) {}

  get modelId(): string {
    return this.endpoint.model;
  }

  get baseUrl(): string {
    return this.endpoint.baseUrl;
  }

  /** Provider name for logging and chain identification. */
  get name(): string {
    return `llamacpp/${this.endpoint.model}`;
  }

  /** Safe character budget for this endpoint, using the shared chars/token estimate. */
  maxChars(): number {
    return maxCharsForContext(
      this.endpoint.minCtx,
      this.endpoint.charsPerToken ?? this.defaults?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
      this.endpoint.headroomTokens ?? this.defaults?.headroomTokens ?? CONTEXT_HEADROOM_TOKENS,
    );
  }

  async dispatch(body: RequestBody): Promise<http.IncomingMessage> {
    // Always request non-streaming so server.ts can buffer,
    // rewrite text-format tool calls, and re-emit as SSE if needed.
    const nonStreamBody = { ...body, stream: false };
    return dispatchOpenAI(
      `${this.endpoint.baseUrl}/v1`,
      'llamacpp', // no API key needed for local llama-server
      this.endpoint.model,
      nonStreamBody,
      { timeoutMs: this.endpoint.timeoutMs ?? 120_000 }
    );
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${this.endpoint.baseUrl}/props`, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
  }
}