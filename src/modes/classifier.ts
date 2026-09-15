/**
 * Context classifier: suggest a mode from the user's request text.
 *
 * This is a lightweight rule-based classifier used when no explicit `/mode`
 * command is present. It returns a suggested mode and a confidence score.
 * Suggestions are advisory; the caller may ignore them unless configured to
 * auto-switch.
 */

import { ModeId } from './schema.js';

export interface ModeSuggestion {
  mode: ModeId;
  confidence: number; // 0..1
  reason: string;
}

const RULES: Array<{
  mode: ModeId;
  confidence: number;
  patterns: RegExp[];
  reason: string;
}> = [
  {
    mode: 'lockdown',
    confidence: 1.0,
    patterns: [
      /\blockdown\b/i,
      /\bno\s+(?:cloud|network|web)\b/i,
      /\bair[-\s]?gap(?:ped)?\b/i,
      /\bsecrets?\s+safe\b/i,
      /\bdon'?t?\s+(?:send|transmit|upload)\b/i,
      /\blockdown\s+please\b/i,
    ],
    reason: 'User explicitly requested lockdown / no-network handling.',
  },
  {
    mode: 'ops',
    confidence: 0.9,
    patterns: [
      /\brun\s+(?:this|the|a)\s+(?:script|command|shell)\b/i,
      /\bedit\s+(?:config|crontab|systemd|nginx|plist|env)\b/i,
      /\bfix\s+(?:service|daemon|launchd|homebrew)\b/i,
      /\bdeploy\s+(?:to\s+)?local\b/i,
      /\bon\s+(?:mac|macos|this\s+machine)\b/i,
    ],
    reason: 'Request involves local system operations or config edits.',
  },
  {
    mode: 'fast',
    confidence: 0.7,
    patterns: [
      /\bquick\b/i,
      /\bshort\s+(?:answer|reply)\b/i,
      /\bone[-\s]?liner\b/i,
      /\btldr\b/i,
      /\bgive\s+me\s+the\s+(?:fast|quick)\b/i,
    ],
    reason: 'User asked for a quick or short response.',
  },
  {
    mode: 'precise',
    confidence: 0.75,
    patterns: [
      /\bverify\b/i,
      /\bcite\s+(?:source|sources)\b/i,
      /\bresearch\s+(?:and\s+)?confirm\b/i,
      /\bexactly\s+(?:right|correct)\b/i,
      /\bstep[-\s]?by[-\s]?step\b/i,
    ],
    reason: 'Request asks for verification, citations, or exact reasoning.',
  },
  {
    mode: 'creative',
    confidence: 0.75,
    patterns: [
      /\bbrainstorm\b/i,
      /\bwrite\s+(?:a\s+)?(poem|story|script|draft|blog|copy)\b/i,
      /\bgenerate\s+(?:ideas|options|variations)\b/i,
      /\bdesign\s+(?:a\s+)?(logo|brand|image|concept)\b/i,
      /\bmake\s+it\s+(?:creative|poetic|vivid|weird)\b/i,
    ],
    reason: 'Request is generative or exploratory.',
  },
];

export function classifyModeContext(text: string): ModeSuggestion | null {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();

  let best: ModeSuggestion | null = null;
  for (const rule of RULES) {
    if (rule.patterns.some(p => p.test(lower))) {
      if (!best || rule.confidence > best.confidence) {
        best = { mode: rule.mode, confidence: rule.confidence, reason: rule.reason };
      }
    }
  }
  return best;
}

export function classifyModeFromMessages(
  messages: Array<{ role: string; content?: string | null }>,
): ModeSuggestion | null {
  const userTexts = messages
    .filter(m => m.role === 'user' && typeof m.content === 'string')
    .map(m => m.content as string);
  if (userTexts.length === 0) return null;
  const combined = userTexts.join('\n');
  return classifyModeContext(combined);
}
