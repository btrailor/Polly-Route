import { RequestBody } from '../types.js';
import { dispatchOpenAI } from './base.js';
import { ProviderConfig } from '../config.js';
import http from 'http';

export function groqAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> => {
    // Groq rejects max_completion_tokens > 32768; cap or remap to max_tokens
    const { max_completion_tokens, ...rest } = body as any;
    const groqBody: RequestBody = max_completion_tokens
      ? { ...rest, max_tokens: Math.min(max_completion_tokens, 32768) }
      : rest;
    return dispatchOpenAI(cfg.baseUrl, cfg.apiKey ?? '', cfg.defaultModel ?? 'llama-3.3-70b-versatile', groqBody, { timeoutMs: 20000 });
  };
}

export function cerebrasAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> =>
    dispatchOpenAI(cfg.baseUrl, cfg.apiKey ?? '', cfg.defaultModel ?? 'llama-3.3-70b', body, { timeoutMs: 20000 });
}

export function googleAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> =>
    dispatchOpenAI(cfg.baseUrl, cfg.apiKey ?? '', cfg.defaultModel ?? 'gemini-2.5-flash', body, { timeoutMs: 30000 });
}

export function mistralAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> => {
    // Mistral rejects max_completion_tokens — remap to max_tokens
    const { max_completion_tokens, ...rest } = body as any;
    const mistralBody: RequestBody = max_completion_tokens
      ? { ...rest, max_tokens: max_completion_tokens }
      : rest;
    return dispatchOpenAI(cfg.baseUrl, cfg.apiKey ?? '', cfg.defaultModel ?? 'mistral-small-latest', mistralBody, { timeoutMs: 25000 });
  };
}

export function openrouterAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> =>
    dispatchOpenAI(cfg.baseUrl, cfg.apiKey ?? '', cfg.defaultModel ?? 'qwen/qwen3-235b-a22b:free', body, {
      timeoutMs: 30000,
      extraHeaders: { 'HTTP-Referer': 'https://polly-route' },
    });
}

export function deepseekAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> =>
    dispatchOpenAI(cfg.baseUrl, cfg.apiKey ?? '', cfg.defaultModel ?? 'deepseek-chat', body, { timeoutMs: 60000 });
}

export function openrouterFreeAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> =>
    dispatchOpenAI(cfg.baseUrl, cfg.apiKey ?? '', cfg.defaultModel ?? 'qwen/qwen3-coder:free', body, {
      timeoutMs: 60000,
      extraHeaders: { 'HTTP-Referer': 'https://polly-route' },
    });
}

export function ollamaProAdapter(cfg: ProviderConfig) {
  return (body: RequestBody): Promise<http.IncomingMessage> =>
    dispatchOpenAI(cfg.baseUrl, cfg.apiKey ?? '', cfg.defaultModel ?? 'gemma4:31b', body, { timeoutMs: cfg.timeoutMs ?? 60000 });
}
