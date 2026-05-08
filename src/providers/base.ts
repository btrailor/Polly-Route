import http from 'http';
import https from 'https';
import { RequestBody } from '../types.js';

export interface StreamOptions {
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

export class ProviderError extends Error {
  constructor(public provider: string, public status: number, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export async function dispatchOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  body: RequestBody,
  opts: StreamOptions = {}
): Promise<http.IncomingMessage> {
  const payload = Buffer.from(JSON.stringify({ ...body, model }));
  const url = new URL(`${baseUrl}/chat/completions`);
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'polly-route/0.6',
        ...opts.extraHeaders,
      },
    }, resolve);

    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 30000, () => {
      req.destroy(new Error(`timeout after ${opts.timeoutMs ?? 30000}ms`));
    });
    req.write(payload);
    req.end();
  });
}
