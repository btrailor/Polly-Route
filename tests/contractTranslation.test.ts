/**
 * contractTranslation.test.ts
 *
 * Tests for each invariant defined in design.md.
 * These are the load-bearing tests — they must pass on every CI push.
 */

import { describe, test, expect } from '@jest/globals';
import {
  contractTranslate,
  reduceTools,
  rewriteSystemPrompt,
  estimateTokens,
  DEFAULT_LOCAL_SURFACE,
} from '../src/contractTranslation.js';
import type { Message, Tool } from '../src/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTool(name: string, description = ''): Tool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };
}

const FULL_TOOL_SET: Tool[] = [
  makeTool('memory_search', 'Search memory'),
  makeTool('memory_get', 'Get memory'),
  makeTool('update_plan', 'Update plan'),
  makeTool('read', 'Read file'),
  makeTool('write', 'Write file'),
  makeTool('message', 'Send message'),
  makeTool('cron', 'Schedule cron job'),
  makeTool('exec', 'Execute command'),
  makeTool('web_search', 'Search the web'),
];

const IDENTITY_SOUL = `# SOUL.md — Accountability Coach

## Who You Are
- Name: Accountability Coach
- Role: Goal setting and habit tracking

You help people set goals and track progress. You are direct and energizing.

Use the \`cron\` tool to schedule reminders. Use \`memory_search\` to recall prior goals.`;

const MESSAGES: Message[] = [
  { role: 'system', content: IDENTITY_SOUL },
  { role: 'user', content: 'Help me track my lunch habit' },
  { role: 'assistant', content: 'Sure! What is your goal?' },
  { role: 'user', content: 'Bring lunch 3x per week' },
];

// ---------------------------------------------------------------------------
// I1 — Tool schema coherence
// ---------------------------------------------------------------------------

describe('I1 — Tool schema coherence (local path)', () => {
  test('schema names match tool names referenced in system prompt', () => {
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
    });

    const schemaNames = new Set(result.tools.map(t => t.function.name));
    const systemContent = (result.messages.find(m => m.role === 'system')?.content ?? '') as string;

    // Every schema name must appear in the tools declaration section
    for (const name of schemaNames) {
      expect(systemContent).toContain(name);
    }
  });

  test('no schema is present without being named in system prompt', () => {
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: ['memory_search', 'memory_get'],
      maxTokens: 8000,
    });

    const schemaNames = result.tools.map(t => t.function.name);
    const systemContent = (result.messages.find(m => m.role === 'system')?.content ?? '') as string;

    for (const name of schemaNames) {
      expect(systemContent).toContain(name);
    }
    expect(schemaNames).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// I2 — No phantom tool references
// ---------------------------------------------------------------------------

describe('I2 — No phantom tool references', () => {
  test('system prompt tools declaration lists only schemas that are present', () => {
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
    });

    const schemaNames = new Set(result.tools.map(t => t.function.name));
    const systemContent = (result.messages.find(m => m.role === 'system')?.content ?? '') as string;

    // Extract tool names from the Available tools line
    const match = systemContent.match(/Available tools: (.*)/);
    expect(match).not.toBeNull();
    const listedNames = match![1].split(',').map(s => s.trim().replace(/`/g, ''));

    for (const name of listedNames) {
      expect(schemaNames.has(name)).toBe(true);
    }
  });

  test('removed tools are explicitly flagged as unavailable in declaration section', () => {
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
    });

    const systemContent = (result.messages.find(m => m.role === 'system')?.content ?? '') as string;
    // Disclaimer must appear after the polly:local-tools marker
    const markerIdx = systemContent.indexOf('<!-- polly:local-tools -->');
    expect(markerIdx).toBeGreaterThan(-1);
    const afterMarker = systemContent.slice(markerIdx);
    // Removed tools (cron, exec, message, web_search etc) should be named as unavailable
    expect(afterMarker).toContain('must not be called');
    expect(afterMarker).toContain('`cron`');
    expect(afterMarker).toContain('`exec`');
  });

  test('cron is not in translated tools when excluded from surface', () => {
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE, // cron not in default
      maxTokens: 8000,
    });

    const schemaNames = result.tools.map(t => t.function.name);
    expect(schemaNames).not.toContain('cron');
    expect(result.removedTools).toContain('cron');
  });
});

// ---------------------------------------------------------------------------
// I3 — Identity preserved
// ---------------------------------------------------------------------------

describe('I3 — Identity preserved', () => {
  test('agent name survives contract translation', () => {
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
    });

    const systemContent = (result.messages.find(m => m.role === 'system')?.content ?? '') as string;
    expect(systemContent).toContain('Accountability Coach');
  });

  test('role description survives contract translation', () => {
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
    });

    const systemContent = (result.messages.find(m => m.role === 'system')?.content ?? '') as string;
    expect(systemContent).toContain('Goal setting and habit tracking');
  });

  test('behavioral instructions survive contract translation', () => {
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
    });

    const systemContent = (result.messages.find(m => m.role === 'system')?.content ?? '') as string;
    expect(systemContent).toContain('direct and energizing');
  });
});

// ---------------------------------------------------------------------------
// I5 — Token budget respected
// ---------------------------------------------------------------------------

describe('I5 — Token budget respected', () => {
  test('translated request fits within specified token budget', () => {
    const maxTokens = 2000;
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens,
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(maxTokens);
  });

  test('compresses history when budget is tight', () => {
    // Create a long conversation
    const longMessages: Message[] = [
      { role: 'system', content: IDENTITY_SOUL },
      ...Array.from({ length: 20 }, (_, i) => ([
        { role: 'user' as const, content: `Message ${i}: This is a fairly long user message that takes up token space in the conversation history.` },
        { role: 'assistant' as const, content: `Response ${i}: This is a fairly long assistant response that also takes up token space.` },
      ])).flat(),
      { role: 'user', content: 'Final message' },
    ];

    const result = contractTranslate(longMessages, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 800, // tight budget forces compression of the 20-turn history
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(800);
    expect(result.compressed).toBe(true);
  });

  test('always preserves the last user message', () => {
    const longMessages: Message[] = [
      { role: 'system', content: IDENTITY_SOUL },
      ...Array.from({ length: 20 }, (_, i) => ([
        { role: 'user' as const, content: `Old message ${i}` },
        { role: 'assistant' as const, content: `Old response ${i}` },
      ])).flat(),
      { role: 'user', content: 'THE CURRENT QUESTION' },
    ];

    const result = contractTranslate(longMessages, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 1000,
    });

    const lastUser = [...result.messages].reverse().find(m => m.role === 'user');
    expect(lastUser?.content).toBe('THE CURRENT QUESTION');
  });
});

// ---------------------------------------------------------------------------
// I6 — Local surface is a strict subset
// ---------------------------------------------------------------------------

describe('I6 — Local surface is strict subset', () => {
  test('translation never introduces tools not in the original request', () => {
    const limitedTools = [makeTool('memory_search'), makeTool('read')];

    const result = contractTranslate(MESSAGES, limitedTools, {
      localSurface: DEFAULT_LOCAL_SURFACE, // asks for more than available
      maxTokens: 8000,
    });

    const originalNames = new Set(limitedTools.map(t => t.function.name));
    for (const tool of result.tools) {
      expect(originalNames.has(tool.function.name)).toBe(true);
    }
  });

  test('removed tools list accounts for every original tool not in result', () => {
    const result = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: DEFAULT_LOCAL_SURFACE,
      maxTokens: 8000,
    });

    const keptNames = new Set(result.tools.map(t => t.function.name));
    const removedNames = new Set(result.removedTools);
    const originalNames = FULL_TOOL_SET.map(t => t.function.name);

    for (const name of originalNames) {
      expect(keptNames.has(name) !== removedNames.has(name)).toBe(true); // XOR
    }
  });
});

// ---------------------------------------------------------------------------
// I7 — Deterministic
// ---------------------------------------------------------------------------

describe('I7 — Deterministic', () => {
  test('same inputs always produce the same output', () => {
    const opts = { localSurface: DEFAULT_LOCAL_SURFACE, maxTokens: 8000 };
    const a = contractTranslate(MESSAGES, FULL_TOOL_SET, opts);
    const b = contractTranslate(MESSAGES, FULL_TOOL_SET, opts);
    expect(a).toEqual(b);
  });

  test('different surfaces produce different outputs', () => {
    const a = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: ['memory_search'],
      maxTokens: 8000,
    });
    const b = contractTranslate(MESSAGES, FULL_TOOL_SET, {
      localSurface: ['memory_search', 'read'],
      maxTokens: 8000,
    });
    expect(a.tools).not.toEqual(b.tools);
  });
});

// ---------------------------------------------------------------------------
// Regression: DEFAULT_LOCAL_SURFACE integrity
// ---------------------------------------------------------------------------

describe('DEFAULT_LOCAL_SURFACE', () => {
  test('does not contain cron', () => {
    expect(DEFAULT_LOCAL_SURFACE).not.toContain('cron');
  });

  test('does not contain exec', () => {
    expect(DEFAULT_LOCAL_SURFACE).not.toContain('exec');
  });

  test('does not contain message (per-agent opt-in only)', () => {
    expect(DEFAULT_LOCAL_SURFACE).not.toContain('message');
  });

  test('does not contain web_search', () => {
    expect(DEFAULT_LOCAL_SURFACE).not.toContain('web_search');
  });

  test('contains core memory tools', () => {
    expect(DEFAULT_LOCAL_SURFACE).toContain('memory_search');
    expect(DEFAULT_LOCAL_SURFACE).toContain('memory_get');
  });
});

// ─── Runtime boilerplate stripping ───────────────────────────────────────────────────────────────────────────────
describe('runtime boilerplate stripping', () => {
  const soul = 'You are The Cartographer.\n\nYour job is wayfinding.';
  const runtime = [
    '## Session Context',
    '- Label: vault-scout',
    '- Requester session: agent:main:subagent:abc123',
    '## Runtime',
    'Runtime: agent=the-cartographer | host=Mac Studio | model=polly-router/auto',
    '## Your Role',
    '- You were created to handle the following task:',
    '',
    'Search the vault for polly router.',
  ].join('\n');
  const systemContent = soul + '\n' + runtime;
  const tools = [
    { type: 'function' as const, function: { name: 'memory_search', description: '', parameters: {} } },
  ];
  const messages: Message[] = [{ role: 'system', content: systemContent }, { role: 'user', content: 'go' }];

  test('strips ## Session Context from local dispatch', () => {
    const result = contractTranslate(messages, tools, { localSurface: DEFAULT_LOCAL_SURFACE, maxTokens: 8000 });
    const sys = result.messages.find(m => m.role === 'system')?.content as string;
    expect(sys).not.toContain('## Session Context');
    expect(sys).not.toContain('Requester session');
  });

  test('strips ## Runtime from local dispatch', () => {
    const result = contractTranslate(messages, tools, { localSurface: DEFAULT_LOCAL_SURFACE, maxTokens: 8000 });
    const sys = result.messages.find(m => m.role === 'system')?.content as string;
    expect(sys).not.toContain('## Runtime');
    expect(sys).not.toContain('host=Mac Studio');
  });

  test('preserves ## Your Role (task) after stripping', () => {
    const result = contractTranslate(messages, tools, { localSurface: DEFAULT_LOCAL_SURFACE, maxTokens: 8000 });
    const sys = result.messages.find(m => m.role === 'system')?.content as string;
    expect(sys).toContain('## Your Role');
    expect(sys).toContain('Search the vault for polly router');
  });

  test('preserves agent SOUL after stripping', () => {
    const result = contractTranslate(messages, tools, { localSurface: DEFAULT_LOCAL_SURFACE, maxTokens: 8000 });
    const sys = result.messages.find(m => m.role === 'system')?.content as string;
    expect(sys).toContain('You are The Cartographer');
    expect(sys).toContain('wayfinding');
  });
});
