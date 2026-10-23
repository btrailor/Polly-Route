import http from 'http';
import { RequestBody } from '../types.js';
import { Config, OllamaModel, DEFAULT_CHARS_PER_TOKEN, CONTEXT_HEADROOM_TOKENS, maxCharsForContext } from '../config.js';
import { dispatchOpenAI } from './base.js';

/**
 * Default num_ctx to pass to Ollama for each model.
 *
 * Ollama's OpenAI-compatible endpoint defaults to num_ctx=16384 regardless of
 * the model's actual context_length. Without this override, the router's
 * local budget decisions (which assume the model's full context) don't match
 * what Ollama actually uses, causing requests that should fit to hang or 400.
 *
 * Values reflect the model's supported context_length from its Modelfile/
 * model_info, NOT the Ollama default.
 */
const MODEL_NUM_CTX: Record<string, number> = {
  'qwen2.5:7b':         32768,
  'qwen2.5-coder:32b':  32768,
  'qwen2.5:72b':        32768,
};

/** Fallback dispatch timeout when no config value is present. */
const DEFAULT_OLLAMA_TIMEOUT_MS = 120_000;

export class OllamaAdapter {
  constructor(
    private models: OllamaModel[],
    private baseUrl: string,
    private config?: Config['ollama'],
  ) {}

  private charsPerTokenFor(model: OllamaModel): number {
    return model.charsPerToken
      ?? this.config?.charsPerToken
      ?? DEFAULT_CHARS_PER_TOKEN;
  }

  private headroomTokensFor(model: OllamaModel): number {
    return model.headroomTokens
      ?? this.config?.headroomTokens
      ?? CONTEXT_HEADROOM_TOKENS;
  }

  /** Safe character budget for a model, using the shared chars/token estimate. */
  maxCharsFor(modelId: string): number {
    const model = this.models.find(m => m.id === modelId);
    const numCtx = model?.contextTokens ?? MODEL_NUM_CTX[modelId] ?? 16384;
    const charsPerToken = model ? this.charsPerTokenFor(model) : DEFAULT_CHARS_PER_TOKEN;
    const headroomTokens = model ? this.headroomTokensFor(model) : CONTEXT_HEADROOM_TOKENS;
    return maxCharsForContext(numCtx, charsPerToken, headroomTokens);
  }

  /** True if the request characters fit in this model with headroom. */
  fits(model: OllamaModel, requestChars: number): boolean {
    return requestChars <= this.maxCharsFor(model.id);
  }

  /**
   * Select the smallest model whose real budget fits the request, respecting
   * the minimum complexity weight. Falls back to smaller models when the
   * preferred weight-class model does not fit, so a 60k request that exceeds
   * the 32B budget still lands on a fitting model rather than cloud.
   */
  pickModel(requestChars: number, minWeight?: OllamaModel['weight']): OllamaModel | null {
    const order: OllamaModel['weight'][] = ['light', 'medium', 'heavy'];
    const minIdx = minWeight ? order.indexOf(minWeight) : 0;
    // Consider models in weight order, but only from minWeight upward.
    const candidates = this.models.filter(m => order.indexOf(m.weight) >= minIdx);
    // Prefer the smallest candidate that fits; if none fit, try smaller models.
    for (const model of candidates) {
      if (this.fits(model, requestChars)) return model;
    }
    // Fallback to any smaller model that genuinely fits.
    const smaller = this.models.filter(m => order.indexOf(m.weight) < minIdx);
    for (const model of smaller) {
      if (this.fits(model, requestChars)) return model;
    }
    return null;
  }

  private timeoutMsFor(model: OllamaModel): number {
    return this.config?.modelTimeouts?.[model.id]
      ?? this.config?.timeoutMs
      ?? DEFAULT_OLLAMA_TIMEOUT_MS;
  }

  async dispatch(model: OllamaModel, body: RequestBody): Promise<http.IncomingMessage> {
    // Always request non-streaming from Ollama so server.ts can buffer,
    // rewrite text-format tool calls, and re-emit as SSE if the client wants it.
    const numCtx = model.contextTokens ?? MODEL_NUM_CTX[model.id] ?? 16384;
    const nonStreamBody = {
      ...body,
      stream: false,
      // Ollama's OpenAI-compatible endpoint accepts an `options` field
      // alongside the standard OpenAI parameters. Setting num_ctx here
      // makes Ollama use the model's full context window instead of its
      // 16384 default.
      options: { ...(body as any).options, num_ctx: numCtx },
    };
    return dispatchOpenAI(
      `${this.baseUrl}/v1`,
      'ollama',
      model.id,
      nonStreamBody,
      { timeoutMs: this.timeoutMsFor(model) }
    );
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${this.baseUrl}/api/tags`, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
  }
}
