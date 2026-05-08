import { RequestBody, Message } from './types.js';

/**
 * The ONLY modification the router makes to the request body.
 * Appends a single system message containing vault chunks before the first user turn.
 * Existing messages are never modified.
 */
export function injectVaultContext(body: RequestBody, chunks: string[]): RequestBody {
  if (!chunks.length) return body;

  const vaultCtx = chunks
    .map((c, i) => `[Vault excerpt ${i + 1}]\n${c}`)
    .join('\n\n');

  const systemMsg: Message = {
    role: 'system',
    content: `Relevant context from the user's personal knowledge vault:\n\n${vaultCtx}\n\nUse this context where relevant.`,
  };

  const messages = body.messages ?? [];
  const firstNonSystem = messages.findIndex(m => m.role !== 'system');
  const insertAt = firstNonSystem === -1 ? messages.length : firstNonSystem;

  return {
    ...body,
    messages: [
      ...messages.slice(0, insertAt),
      systemMsg,
      ...messages.slice(insertAt),
    ],
  };
}

export function estimateChars(messages: Message[]): number {
  return messages.reduce((n, m) => {
    const c = m.content ?? '';
    const text = typeof c === 'string' ? c : (c as any[]).map((x: any) => x.text ?? '').join('');
    return n + text.length;
  }, 0);
}
