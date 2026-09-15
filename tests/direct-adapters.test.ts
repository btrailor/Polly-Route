import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import http from 'http';
import { RequestBody } from '../src/types.js';
import { ProviderConfig } from '../src/config.js';

// Mock dispatchOpenAI to capture arguments without making real HTTP calls
const mockDispatch = jest.fn() as jest.MockedFunction<any>;

jest.mock('../src/providers/base.js', () => ({
  dispatchOpenAI: (...args: any[]) => mockDispatch(...args as any[]),
  ProviderError: class ProviderError extends Error {
    constructor(public provider: string, public status: number, message: string) {
      super(message);
    }
  },
}));

// Import after mock is set up
import { kimiAdapter } from '../src/providers/kimi.js';
import { glmAdapter } from '../src/providers/glm.js';
import { qwenAdapter } from '../src/providers/qwen.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const BASE_BODY: RequestBody = {
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello, world!' }],
  stream: false,
};

const KIMI_CFG: ProviderConfig = {
  baseUrl: 'https://api.moonshot.cn/v1',
  apiKey: 'test-kimi-key',
  defaultModel: 'moonshot-v1-auto',
  dailyRequestLimit: 300,
  maxRequestChars: 128000,
  timeoutMs: 60000,
};

const GLM_CFG: ProviderConfig = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'test-glm-key',
  defaultModel: 'glm-4-flash',
  dailyRequestLimit: 300,
  maxRequestChars: 128000,
  timeoutMs: 60000,
};

const QWEN_CFG: ProviderConfig = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: 'test-qwen-key',
  defaultModel: 'qwen-plus',
  dailyRequestLimit: 300,
  maxRequestChars: 128000,
  timeoutMs: 60000,
};

// Fake IncomingMessage for the mock return value — we only need an object
// that satisfies the return type; no real socket is needed since the
// mock never actually streams data.
function fakeResponse(): http.IncomingMessage {
  const res = { statusCode: 200 } as unknown as http.IncomingMessage;
  return res;
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue(fakeResponse());
});

// ─── Kimi adapter tests ───────────────────────────────────────────────────────

describe('kimiAdapter', () => {
  test('dispatches to Moonshot API with correct baseUrl and apiKey', async () => {
    const adapter = kimiAdapter(KIMI_CFG);
    await adapter(BASE_BODY);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [url, key, model, body, opts] = mockDispatch.mock.calls[0];
    expect(url).toBe('https://api.moonshot.cn/v1');
    expect(key).toBe('test-kimi-key');
    expect(model).toBe('moonshot-v1-auto');
    expect(opts.timeoutMs).toBe(60000);
  });

  test('uses body.model when provided instead of defaultModel', async () => {
    const adapter = kimiAdapter(KIMI_CFG);
    const body: RequestBody = { ...BASE_BODY, model: 'moonshot-v1-8k' };
    await adapter(body);

    const [, , model] = mockDispatch.mock.calls[0];
    expect(model).toBe('moonshot-v1-8k');
  });

  test('remaps max_completion_tokens to max_tokens', async () => {
    const adapter = kimiAdapter(KIMI_CFG);
    const body: RequestBody = {
      ...BASE_BODY,
      max_completion_tokens: 4096,
    } as any;
    await adapter(body);

    const [, , , dispatchedBody] = mockDispatch.mock.calls[0];
    expect(dispatchedBody.max_completion_tokens).toBeUndefined();
    expect(dispatchedBody.max_tokens).toBe(4096);
  });

  test('passes through body without max_completion_tokens unchanged', async () => {
    const adapter = kimiAdapter(KIMI_CFG);
    await adapter(BASE_BODY);

    const [, , , dispatchedBody] = mockDispatch.mock.calls[0];
    expect(dispatchedBody.max_tokens).toBeUndefined();
    expect(dispatchedBody.messages).toEqual(BASE_BODY.messages);
  });

  test('uses default timeout of 60000ms when not configured', async () => {
    const cfg: ProviderConfig = { ...KIMI_CFG, timeoutMs: undefined };
    const adapter = kimiAdapter(cfg);
    await adapter(BASE_BODY);

    const [, , , , opts] = mockDispatch.mock.calls[0];
    expect(opts.timeoutMs).toBe(60000);
  });

  test('handles empty apiKey gracefully', async () => {
    const cfg: ProviderConfig = { ...KIMI_CFG, apiKey: undefined };
    const adapter = kimiAdapter(cfg);
    await adapter(BASE_BODY);

    const [, key] = mockDispatch.mock.calls[0];
    expect(key).toBe('');
  });
});

// ─── GLM adapter tests ─────────────────────────────────────────────────────────

describe('glmAdapter', () => {
  test('dispatches to Zhipu API with correct baseUrl and apiKey', async () => {
    const adapter = glmAdapter(GLM_CFG);
    await adapter(BASE_BODY);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [url, key, model, body, opts] = mockDispatch.mock.calls[0];
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(key).toBe('test-glm-key');
    expect(model).toBe('glm-4-flash');
    expect(opts.timeoutMs).toBe(60000);
  });

  test('uses body.model when provided instead of defaultModel', async () => {
    const adapter = glmAdapter(GLM_CFG);
    const body: RequestBody = { ...BASE_BODY, model: 'glm-4-plus' };
    await adapter(body);

    const [, , model] = mockDispatch.mock.calls[0];
    expect(model).toBe('glm-4-plus');
  });

  test('remaps max_completion_tokens to max_tokens', async () => {
    const adapter = glmAdapter(GLM_CFG);
    const body: RequestBody = {
      ...BASE_BODY,
      max_completion_tokens: 8192,
    } as any;
    await adapter(body);

    const [, , , dispatchedBody] = mockDispatch.mock.calls[0];
    expect(dispatchedBody.max_completion_tokens).toBeUndefined();
    expect(dispatchedBody.max_tokens).toBe(8192);
  });

  test('passes through body without max_completion_tokens unchanged', async () => {
    const adapter = glmAdapter(GLM_CFG);
    await adapter(BASE_BODY);

    const [, , , dispatchedBody] = mockDispatch.mock.calls[0];
    expect(dispatchedBody.max_tokens).toBeUndefined();
    expect(dispatchedBody.messages).toEqual(BASE_BODY.messages);
  });

  test('uses default timeout of 60000ms when not configured', async () => {
    const cfg: ProviderConfig = { ...GLM_CFG, timeoutMs: undefined };
    const adapter = glmAdapter(cfg);
    await adapter(BASE_BODY);

    const [, , , , opts] = mockDispatch.mock.calls[0];
    expect(opts.timeoutMs).toBe(60000);
  });

  test('handles empty apiKey gracefully', async () => {
    const cfg: ProviderConfig = { ...GLM_CFG, apiKey: undefined };
    const adapter = glmAdapter(cfg);
    await adapter(BASE_BODY);

    const [, key] = mockDispatch.mock.calls[0];
    expect(key).toBe('');
  });
});

// ─── Qwen adapter tests ─────────────────────────────────────────────────────────

describe('qwenAdapter', () => {
  test('dispatches to DashScope API with correct baseUrl and apiKey', async () => {
    const adapter = qwenAdapter(QWEN_CFG);
    await adapter(BASE_BODY);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [url, key, model, body, opts] = mockDispatch.mock.calls[0];
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(key).toBe('test-qwen-key');
    expect(model).toBe('qwen-plus');
    expect(opts.timeoutMs).toBe(60000);
  });

  test('uses body.model when provided instead of defaultModel', async () => {
    const adapter = qwenAdapter(QWEN_CFG);
    const body: RequestBody = { ...BASE_BODY, model: 'qwen-max' };
    await adapter(body);

    const [, , model] = mockDispatch.mock.calls[0];
    expect(model).toBe('qwen-max');
  });

  test('remaps max_completion_tokens to max_tokens', async () => {
    const adapter = qwenAdapter(QWEN_CFG);
    const body: RequestBody = {
      ...BASE_BODY,
      max_completion_tokens: 2048,
    } as any;
    await adapter(body);

    const [, , , dispatchedBody] = mockDispatch.mock.calls[0];
    expect(dispatchedBody.max_completion_tokens).toBeUndefined();
    expect(dispatchedBody.max_tokens).toBe(2048);
  });

  test('passes through body without max_completion_tokens unchanged', async () => {
    const adapter = qwenAdapter(QWEN_CFG);
    await adapter(BASE_BODY);

    const [, , , dispatchedBody] = mockDispatch.mock.calls[0];
    expect(dispatchedBody.max_tokens).toBeUndefined();
    expect(dispatchedBody.messages).toEqual(BASE_BODY.messages);
  });

  test('uses default timeout of 60000ms when not configured', async () => {
    const cfg: ProviderConfig = { ...QWEN_CFG, timeoutMs: undefined };
    const adapter = qwenAdapter(cfg);
    await adapter(BASE_BODY);

    const [, , , , opts] = mockDispatch.mock.calls[0];
    expect(opts.timeoutMs).toBe(60000);
  });

  test('handles empty apiKey gracefully', async () => {
    const cfg: ProviderConfig = { ...QWEN_CFG, apiKey: undefined };
    const adapter = qwenAdapter(cfg);
    await adapter(BASE_BODY);

    const [, key] = mockDispatch.mock.calls[0];
    expect(key).toBe('');
  });
});

// ─── Routing preference tests (direct API vs OpenRouter/Ollama Pro) ────────────

describe('routing chain prefers direct adapters over intermediaries', () => {
  test('all three direct adapters can be instantiated from config', () => {
    const kimi = kimiAdapter(KIMI_CFG);
    const glm  = glmAdapter(GLM_CFG);
    const qwen = qwenAdapter(QWEN_CFG);

    expect(typeof kimi).toBe('function');
    expect(typeof glm).toBe('function');
    expect(typeof qwen).toBe('function');
  });

  test('direct adapters use correct base URLs (not OpenRouter)', async () => {
    await kimiAdapter(KIMI_CFG)(BASE_BODY);
    expect(mockDispatch.mock.calls[0][0]).not.toContain('openrouter.ai');

    mockDispatch.mockClear();
    mockDispatch.mockResolvedValue(fakeResponse());

    await glmAdapter(GLM_CFG)(BASE_BODY);
    expect(mockDispatch.mock.calls[0][0]).not.toContain('openrouter.ai');

    mockDispatch.mockClear();
    mockDispatch.mockResolvedValue(fakeResponse());

    await qwenAdapter(QWEN_CFG)(BASE_BODY);
    expect(mockDispatch.mock.calls[0][0]).not.toContain('openrouter.ai');
  });
});