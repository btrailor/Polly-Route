/**
 * REGRESSION: contract translation must actually reach the local model.
 *
 * Defect (found 2026-10-29): the server computed a contract-translated body
 * for local dispatch, then passed it to `entry.fn(dispatchBody)` — but every
 * chain entry dispatched its OWN captured body and ignored that argument.
 * The translation was computed and silently thrown away.
 *
 * Compounding it: the server translated its OWN body, which lacks the
 * injected vault chunks / skill procedure / conductor context that the
 * router's captured body carries.
 *
 * Measured impact: a request with 40 tools sent 2,237 tokens of tool
 * definitions to the local model, where translation would have reduced 40
 * tools to the ~9 in DEFAULT_LOCAL_SURFACE.
 *
 * These tests assert the translation is present in the body that the
 * adapter actually receives.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { DEFAULT_LOCAL_SURFACE } from '../src/contractTranslation.js';

const TEST_MODELS = [
  { id: 'qwen2.5:7b',        name: '7B',  maxChars: 28000,  weight: 'light',  contextTokens: 32768 },
  { id: 'qwen2.5-coder:32b', name: '32B', maxChars: 112000, weight: 'medium', contextTokens: 32768 },
  { id: 'qwen2.5:72b',       name: '72B', maxChars: 480000, weight: 'heavy',  contextTokens: 32768 },
] as any;

type AnyFn = (...args: any[]) => any;

function makeTool(name: string) {
  return {
    type: 'function',
    function: {
      name,
      description: `Tool ${name}`,
      parameters: { type: 'object', properties: {} },
    },
  };
}

describe('contract translation reaches the local model', () => {
  test('the tool surface sent to the local model is REDUCED, not the full set', async () => {
    const { buildChain } = await import('../src/router.js');

    let dispatched: any = null;

    // A request with far more tools than the local surface allows.
    const manyTools = [
      ...DEFAULT_LOCAL_SURFACE.map((t) => makeTool(t)),
      ...Array.from({ length: 31 }, (_, i) => makeTool(`extra_tool_${i}`)),
    ];

    const body: any = {
      model: 'test',
      messages: [
        { role: 'system', content: 'You are a helpful agent.' },
        { role: 'user', content: 'hello' },
      ],
      tools: manyTools,
    };

    const config: any = {
      port: 4200,
      ollama: { baseUrl: 'http://127.0.0.1:11434', models: TEST_MODELS },
      providers: {},
      qmd: { baseUrl: 'http://localhost:8181', collection: 'vault', timeoutMs: 500, minScore: 0.89 },
    };

    // Mock the ollama adapter so we capture what it receives.
    const ollamaMod = await import('../src/providers/ollama.js');
    const spy = jest.spyOn(ollamaMod.OllamaAdapter.prototype, 'dispatch').mockImplementation(
      ((...args: any[]) => {
        dispatched = args[1];
        const { EventEmitter } = require('events');
        const em: any = new EventEmitter();
        em.statusCode = 200;
        return Promise.resolve(em);
      }) as AnyFn,
    );

    try {
      const { chain } = await buildChain(body, 'LIGHT', { confidence: 'ABSENT', score: 0, chunks: [] } as any, config, { hasSkill: false } as any);
      expect(chain.length).toBeGreaterThan(0);

      const ollamaEntry = chain.find((e: any) => e.name.startsWith('ollama/'));
      expect(ollamaEntry).toBeDefined();

      await ollamaEntry!.fn(body);

      expect(dispatched).not.toBeNull();
      const sentToolNames = (dispatched.tools ?? []).map((t: any) => t.function.name);

      // The whole point: the model receives a REDUCED tool set.
      expect(sentToolNames.length).toBeLessThan(manyTools.length);
      expect(sentToolNames.length).toBeLessThanOrEqual(DEFAULT_LOCAL_SURFACE.length + 1); // +1 for exec
      expect(sentToolNames).not.toContain('extra_tool_0');
    } finally {
      spy.mockRestore();
    }
  });

  test('the system prompt sent to the local model states the reduced surface', async () => {
    const { buildChain } = await import('../src/router.js');

    let dispatched: any = null;

    const manyTools = [
      ...DEFAULT_LOCAL_SURFACE.map((t) => makeTool(t)),
      makeTool('secret_tool'),
    ];

    const body: any = {
      model: 'test',
      messages: [
        { role: 'system', content: 'You are a helpful agent.' },
        { role: 'user', content: 'hello' },
      ],
      tools: manyTools,
    };

    const config: any = {
      port: 4200,
      ollama: { baseUrl: 'http://127.0.0.1:11434', models: TEST_MODELS },
      providers: {},
      qmd: { baseUrl: 'http://localhost:8181', collection: 'vault', timeoutMs: 500, minScore: 0.89 },
    };

    const ollamaMod = await import('../src/providers/ollama.js');
    const spy = jest.spyOn(ollamaMod.OllamaAdapter.prototype, 'dispatch').mockImplementation(
      ((...args: any[]) => {
        dispatched = args[1];
        const { EventEmitter } = require('events');
        const em: any = new EventEmitter();
        em.statusCode = 200;
        return Promise.resolve(em);
      }) as AnyFn,
    );

    try {
      const { chain } = await buildChain(body, 'LIGHT', { confidence: 'ABSENT', score: 0, chunks: [] } as any, config, { hasSkill: false } as any);
      const ollamaEntry = chain.find((e: any) => e.name.startsWith('ollama/'));
      await ollamaEntry!.fn(body);

      const systemMsg = dispatched.messages.find((m: any) => m.role === 'system');
      const systemText = typeof systemMsg?.content === 'string' ? systemMsg.content : '';

      // The rewrite must be visible to the model.
      expect(systemText).toContain('You have access to the following tools ONLY');
      // The removed tool must NOT be offered as available. It is deliberately
      // named in the "NOT available" note so the model stops calling it.
      const availableLine = systemText.split('Available tools:')[1]?.split('\n')[0] ?? '';
      expect(availableLine).not.toContain('secret_tool');
      expect(systemText).toContain('NOT available in this context');
    } finally {
      spy.mockRestore();
    }
  });

  test('the injected context survives translation (router body, not server body)', async () => {
    const { buildChain } = await import('../src/router.js');

    let dispatched: any = null;

    const body: any = {
      model: 'test',
      messages: [
        { role: 'system', content: 'VAULT CHUNK MARKER: scope-a-sprint' },
        { role: 'user', content: 'hello' },
      ],
      tools: [makeTool('read'), makeTool('exec')],
    };

    const config: any = {
      port: 4200,
      ollama: { baseUrl: 'http://127.0.0.1:11434', models: TEST_MODELS },
      providers: {},
      qmd: { baseUrl: 'http://localhost:8181', collection: 'vault', timeoutMs: 500, minScore: 0.89 },
    };

    const ollamaMod = await import('../src/providers/ollama.js');
    const spy = jest.spyOn(ollamaMod.OllamaAdapter.prototype, 'dispatch').mockImplementation(
      ((...args: any[]) => {
        dispatched = args[1];
        const { EventEmitter } = require('events');
        const em: any = new EventEmitter();
        em.statusCode = 200;
        return Promise.resolve(em);
      }) as AnyFn,
    );

    try {
      const { chain } = await buildChain(body, 'LIGHT', { confidence: 'ABSENT', score: 0, chunks: [] } as any, config, { hasSkill: false } as any);
      const ollamaEntry = chain.find((e: any) => e.name.startsWith('ollama/'));
      await ollamaEntry!.fn(body);

      const systemMsg = dispatched.messages.find((m: any) => m.role === 'system');
      const systemText = typeof systemMsg?.content === 'string' ? systemMsg.content : '';

      // The context marker must still be there after the system rewrite.
      expect(systemText).toContain('scope-a-sprint');
    } finally {
      spy.mockRestore();
    }
  });
});
