import { Message, Complexity, ContentPart } from './types.js';

const HEAVY_PATTERNS = [
  /architect/i, /refactor/i, /design system/i, /debug.*complex/i,
  /multi.?file/i, /implement.*from scratch/i, /optimize.*algorithm/i,
  /security audit/i, /threat model/i, /distributed/i,
];

const LIGHT_PATTERNS = [
  /^(hi|hello|hey|thanks|ok|yes|no|sure)\b/i,
  /what (is|are|does|time|day)/i,
  /translate/i, /define /i, /spell /i,
  /remind me/i, /heartbeat/i, /status check/i,
];

function messageText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as ContentPart[]).map(c => c.text ?? '').join(' ');
  }
  return '';
}

export function classifyComplexity(messages: Message[]): Complexity {
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last) return 'MEDIUM';
  const text = messageText(last).toLowerCase();
  const toks = text.split(/\s+/).length;
  if (LIGHT_PATTERNS.some(p => p.test(text)) && toks < 30) return 'LIGHT';
  if (HEAVY_PATTERNS.some(p => p.test(text)) || toks > 800) return 'HEAVY';
  return 'MEDIUM';
}

export function getLastUserMessage(messages: Message[]): string {
  const last = [...messages].reverse().find(m => m.role === 'user');
  return last ? messageText(last) : '';
}
