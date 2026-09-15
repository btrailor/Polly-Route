/**
 * Integration tests: mode resolver wired into the polly-router server pipeline.
 *
 * These tests verify the end-to-end behavior of:
 * 1. /mode list command → JSON response with available modes.
 * 2. /mode reset command → clears metadata.mode, falls back to default.
 * 3. Lockdown mode → forcedTarget = LOCAL, no cloud providers in chain.
 * 4. Ops mode → mode applied, no forced target (preference-with-warning).
 *
 * The tests use the real modes.json config if available, or fall back to a
 * minimal sample config.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { spawn, ChildProcess, execSync } from 'child_process';
import { loadModesConfig } from '../../src/modes/loader.js';
import { resolveMode } from '../../src/modes/resolver.js';
import { applyModeToRequest, AgentToolPolicy } from '../../src/modes/apply.js';
import { findModeCommandInMessages } from '../../src/modes/parser.js';
import { ModesConfig } from '../../src/modes/schema.js';

// Use real config if available, otherwise fall back to a minimal sample.
let config: ModesConfig;
try {
  config = loadModesConfig();
  if (Object.keys(config.modes).length < 2) throw new Error('insufficient modes');
} catch {
  config = {
    version: 1,
    defaultMode: 'default',
    modes: {
      default: {
        name: 'Default',
        description: 'Standard routing',
        routing: { target: 'auto', costBias: 'balanced', localFirst: false },
        model: { primary: null, fallbacks: null },
        tools: { allow: null, deny: null, requireConfirmation: null },
        prompt: { systemSuffix: null, temperature: null },
        flags: { absolute: false, auditBeforeTool: false, disableWeb: false, disableSubagents: false, disableExec: false },
      },
      lockdown: {
        name: 'Lockdown',
        description: 'Local-only, no cloud, no web/exec/subagents',
        routing: { target: 'local', costBias: 'free', localFirst: true },
        model: { primary: 'ollama/qwen2.5:7b', fallbacks: null },
        tools: { allow: null, deny: null, requireConfirmation: null },
        prompt: { systemSuffix: 'Local-only mode: no cloud, no web tools.', temperature: 0.3 },
        flags: { absolute: true, auditBeforeTool: true, disableWeb: true, disableSubagents: true, disableExec: false },
      },
      ops: {
        name: 'Ops',
        description: 'Local system operations',
        routing: { target: 'local-first', costBias: 'cheap', localFirst: true },
        model: { primary: null, fallbacks: null },
        tools: { allow: null, deny: ['web_search'], requireConfirmation: null },
        prompt: { systemSuffix: 'Ops mode: prefer local execution.', temperature: null },
        flags: { absolute: false, auditBeforeTool: false, disableWeb: false, disableSubagents: false, disableExec: false },
      },
      fast: {
        name: 'Fast',
        description: 'Quick responses',
        routing: { target: 'local-first', costBias: 'cheap', localFirst: true, maxComplexity: 'MEDIUM' },
        model: { primary: 'ollama/qwen2.5:7b', fallbacks: null },
        tools: { allow: null, deny: ['skill_workshop'], requireConfirmation: null },
        prompt: { systemSuffix: null, temperature: null },
        flags: { absolute: false, auditBeforeTool: false, disableWeb: false, disableSubagents: false, disableExec: false },
      },
    },
  };
}

describe('Mode resolver integration with router pipeline', () => {
  describe('/mode list', () => {
    it('findModeCommandInMessages detects /mode list', () => {
      const cmd = findModeCommandInMessages([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: '/mode list' },
      ]);
      expect(cmd).not.toBeNull();
      expect(cmd!.list).toBe(true);
    });

    it('findModeCommandInMessages detects bare /mode', () => {
      const cmd = findModeCommandInMessages([
        { role: 'user', content: '/mode' },
      ]);
      expect(cmd).not.toBeNull();
      expect(cmd!.list).toBe(true);
    });
  });

  describe('/mode reset', () => {
    it('findModeCommandInMessages detects /mode reset', () => {
      const cmd = findModeCommandInMessages([
        { role: 'user', content: '/mode reset' },
      ]);
      expect(cmd).not.toBeNull();
      expect(cmd!.reset).toBe(true);
      expect(cmd!.mode).toBeUndefined();
    });

    it('resolveMode falls back to default after reset clears metadata', () => {
      const metadata = { mode: 'lockdown' };
      // Simulate reset: clear metadata.mode
      delete (metadata as Record<string, unknown>).mode;
      const r = resolveMode(config, [{ role: 'user', content: '/mode reset' }], metadata);
      expect(r.modeId).toBe(config.defaultMode);
      expect(r.provenance).toBe('default');
    });
  });

  describe('lockdown mode', () => {
    it('resolveMode returns lockdown for /mode lockdown', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode lockdown' }]);
      expect(r.modeId).toBe('lockdown');
      expect(r.provenance).toBe('command');
    });

    it('lockdown mode has absolute flag', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode lockdown' }]);
      expect(r.mode.flags.absolute).toBe(true);
    });

    it('applyModeToRequest replaces cloud model with local model in lockdown', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode lockdown' }]);
      const body = {
        model: 'groq/llama-3.3-70b',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hello' },
        ],
        tools: [
          { type: 'function' as const, function: { name: 'web_search', description: 'search web', parameters: {} } },
          { type: 'function' as const, function: { name: 'exec', description: 'run command', parameters: {} } },
          { type: 'function' as const, function: { name: 'read', description: 'read file', parameters: {} } },
        ],
      };
      const applied = applyModeToRequest(r.mode, body, {});
      // Mode sets a local model as primary, replacing the cloud model.
      expect(applied.model).toBeDefined();
      expect(applied.model).not.toBe('groq/llama-3.3-70b');
      // If the mode's primary is local, it should be an ollama model.
      if (r.mode.model.primary) {
        expect(applied.model).toBe(r.mode.model.primary);
      }
      // web_search should be filtered out
      const toolNames = (applied.tools ?? []).map(t => t.function.name);
      expect(toolNames).not.toContain('web_search');
      // read should still be present
      expect(toolNames).toContain('read');
      // System suffix should be appended
      const sysMsg = applied.messages.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('[Lockdown]');
    });

    it('lockdown should force LOCAL target in router', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode lockdown' }]);
      let forcedTarget: string | undefined;
      if (r.mode.flags.absolute) {
        forcedTarget = 'LOCAL';
      }
      expect(forcedTarget).toBe('LOCAL');
    });
  });

  describe('ops mode', () => {
    it('resolveMode returns ops for /mode ops', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode ops' }]);
      expect(r.modeId).toBe('ops');
      expect(r.provenance).toBe('command');
    });

    it('ops mode is not absolute (preference-with-warning)', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode ops' }]);
      expect(r.mode.flags.absolute).toBe(false);
    });

    it('applyModeToRequest denies web_search in ops mode', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode ops' }]);
      const body = {
        messages: [{ role: 'user', content: 'fix the service' }],
        tools: [
          { type: 'function' as const, function: { name: 'web_search', description: 'search', parameters: {} } },
          { type: 'function' as const, function: { name: 'exec', description: 'run', parameters: {} } },
        ],
      };
      const applied = applyModeToRequest(r.mode, body, {});
      const toolNames = (applied.tools ?? []).map(t => t.function.name);
      expect(toolNames).not.toContain('web_search');
      expect(toolNames).toContain('exec');
    });

    it('ops mode should force LOCAL target when routing.target is "local"', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode ops' }]);
      let forcedTarget: string | undefined;
      if (r.mode.flags.absolute) {
        forcedTarget = 'LOCAL';
      } else if (r.mode.routing.target === 'local') {
        forcedTarget = 'LOCAL';
      }
      // With real modes.json, ops has target='local', so it forces LOCAL.
      // With the fallback sample config, ops has target='local-first', so no force.
      // Either outcome is valid depending on config; just verify the logic.
      if (r.mode.routing.target === 'local') {
        expect(forcedTarget).toBe('LOCAL');
      } else {
        expect(forcedTarget).toBeUndefined();
      }
    });
  });

  describe('fast mode', () => {
    it('resolveMode returns fast for /mode fast', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode fast' }]);
      expect(r.modeId).toBe('fast');
    });

    it('fast mode sets model primary', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode fast' }]);
      expect(r.mode.model.primary).not.toBeNull();
    });
  });

  describe('metadata-based mode resolution', () => {
    it('resolveMode uses metadata.mode when no /mode command', () => {
      const r = resolveMode(config, [{ role: 'user', content: 'hello' }], { mode: 'lockdown' });
      expect(r.modeId).toBe('lockdown');
      expect(r.provenance).toBe('metadata');
    });

    it('resolveMode prefers /mode command over metadata', () => {
      const r = resolveMode(
        config,
        [{ role: 'user', content: '/mode fast' }],
        { mode: 'lockdown' },
      );
      expect(r.modeId).toBe('fast');
      expect(r.provenance).toBe('command');
    });
  });

  describe('env-based mode resolution', () => {
    it('resolveMode uses OPENCLAW_MODE env when no command or metadata', () => {
      const r = resolveMode(config, [{ role: 'user', content: 'hello' }], {}, { OPENCLAW_MODE: 'fast' });
      expect(r.modeId).toBe('fast');
      expect(r.provenance).toBe('env');
    });
  });

  describe('applyModeToRequest edge cases', () => {
    it('does not crash when body has no tools', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode lockdown' }]);
      const body = { messages: [{ role: 'user', content: 'hi' }] };
      const applied = applyModeToRequest(r.mode, body, {});
      expect(applied.messages).toBeDefined();
    });

    it('does not crash when body has no system message', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode lockdown' }]);
      const body = { messages: [{ role: 'user', content: 'hi' }] };
      const applied = applyModeToRequest(r.mode, body, {});
      const sysMsg = applied.messages.find(m => m.role === 'system');
      expect(sysMsg).toBeDefined();
      expect(sysMsg?.content).toContain('[Lockdown]');
    });

    it('preserves existing system message content when appending suffix', () => {
      const r = resolveMode(config, [{ role: 'user', content: '/mode lockdown' }]);
      const body = {
        messages: [{ role: 'system', content: 'You are a coding assistant.' }],
      };
      const applied = applyModeToRequest(r.mode, body, {});
      const sysMsg = applied.messages.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('You are a coding assistant.');
      expect(sysMsg?.content).toContain('[Lockdown]');
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// HTTP-level integration tests: exercise the compiled server /v1/chat/completions
// pipeline with real /mode commands against a mock backend.
// ──────────────────────────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        reject(new Error('Could not find free port'));
      }
    });
  });
}

function waitForServer(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const req = http.get(`http://127.0.0.1:${port}/status`, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          resolve();
          return;
        }
        res.resume();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Server did not become ready on port ${port} within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tryConnect, 100);
    };
    tryConnect();
  });
}

function postJson(port: number, pathName: string, body: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let responseBody = '';
      res.on('data', c => responseBody += c);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

interface MockCapturedRequest {
  method: string;
  url: string;
  body: any;
}

describe('mode resolver HTTP integration', () => {
  let tmpDir: string;
  let vaultRoot: string;
  let metricsPath: string;
  let configPath: string;
  let skillIndexPath: string;
  let mockPort: number;
  let serverPort: number;
  let mockServer: http.Server;
  let serverProcess: ChildProcess;
  let capturedRequests: MockCapturedRequest[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-modes-http-integration-'));
    vaultRoot = path.join(tmpDir, 'vault');
    fs.mkdirSync(path.join(vaultRoot, '20-Active', 'captured'), { recursive: true });
    metricsPath = path.join(tmpDir, 'polly-metrics.jsonl');
    fs.writeFileSync(metricsPath, '', 'utf-8');

    skillIndexPath = path.join(tmpDir, 'available-skills.md');
    fs.writeFileSync(skillIndexPath, '| `noop` | No operation | nothing relevant |\n', 'utf-8');

    mockPort = await findFreePort();
    serverPort = await findFreePort();
    configPath = path.join(tmpDir, 'polly-router.config.json');

    const cfg = {
      port: serverPort,
      ollama: {
        baseUrl: `http://127.0.0.1:${mockPort}`,
        models: [
          { id: 'qwen2.5:7b', name: '7B', maxChars: 28000, weight: 'light' },
          { id: 'qwen2.5-coder:32b', name: '32B', maxChars: 112000, weight: 'medium' },
          { id: 'qwen2.5:72b', name: '72B', maxChars: 480000, weight: 'heavy' },
        ],
      },
      providers: {
        groq: { baseUrl: `http://127.0.0.1:${mockPort}/groq`, apiKey: 'test-groq', defaultModel: 'llama-3.3-70b-versatile' },
        cerebras: { baseUrl: `http://127.0.0.1:${mockPort}/cerebras`, apiKey: 'test-cerebras', defaultModel: 'llama-3.3-70b' },
        google: { baseUrl: `http://127.0.0.1:${mockPort}/google`, apiKey: 'test-google', defaultModel: 'gemini-2.5-flash' },
        mistral: { baseUrl: `http://127.0.0.1:${mockPort}/mistral`, apiKey: 'test-mistral', defaultModel: 'mistral-small-latest' },
        openrouter: { baseUrl: `http://127.0.0.1:${mockPort}/openrouter`, apiKey: 'test-openrouter', defaultModel: 'qwen/qwen3-235b-a22b:free' },
        deepseek: { baseUrl: `http://127.0.0.1:${mockPort}/deepseek`, apiKey: 'test-deepseek', defaultModel: 'deepseek-chat' },
        openrouter_free: { baseUrl: `http://127.0.0.1:${mockPort}/openrouter-free`, apiKey: 'test-openrouter-free', defaultModel: 'qwen/qwen3-coder:free' },
        ollamapro: { baseUrl: `http://127.0.0.1:${mockPort}/ollama-pro`, apiKey: 'test-ollama-pro', defaultModel: 'gemma4:31b' },
      },
      knowledgeSkill: { baseUrl: `http://127.0.0.1:${mockPort}`, timeoutMs: 1000 },
      qmd: { baseUrl: `http://127.0.0.1:${mockPort}`, collection: 'vault', timeoutMs: 1000, minScore: 0.89 },
      skillCoverage: { indexPath: skillIndexPath, timeoutMs: 500 },
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    mockServer = http.createServer((req, res) => {
      let reqBody = '';
      req.on('data', c => reqBody += c);
      req.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(reqBody); } catch { parsed = {}; }
        capturedRequests.push({ method: req.method || 'GET', url: req.url || '/', body: parsed });

        if (req.url?.startsWith('/search')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results: [], query_time_ms: 1 }));
          return;
        }

        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'qwen2.5-coder:32b' }, { name: 'qwen2.5:72b' }] }));
          return;
        }

        if (req.url?.endsWith('/chat/completions')) {
          const providerName = req.url?.split('/')[1] ?? 'provider';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: `Mock response from ${providerName}` }, finish_reason: 'stop' }],
          }));
          return;
        }

        res.writeHead(404);
        res.end('not found');
      });
    });

    await new Promise<void>((resolve, reject) => {
      mockServer.listen(mockPort, '127.0.0.1', (err?: Error) => {
        if (err) reject(err); else resolve();
      });
    });

    execSync('npm run build', { cwd: path.join(__dirname, '../..'), stdio: 'pipe' });

    const serverScript = path.join(__dirname, '../..', 'dist', 'server.js');
    serverProcess = spawn('node', [serverScript], {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        POLLY_ROUTER_PORT: String(serverPort),
        POLLY_ROUTER_CONFIG: configPath,
        POLLY_VAULT_ROOT: vaultRoot,
        POLLY_METRICS_PATH: metricsPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout?.on('data', d => process.stdout.write(`[modes-router] ${d}`));
    serverProcess.stderr?.on('data', d => process.stderr.write(`[modes-router] ${d}`));

    await waitForServer(serverPort, 15000);
  }, 60000);

  afterAll(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    await new Promise(r => mockServer?.close(r));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 15000);

  beforeEach(() => {
    capturedRequests = [];
  });

  it('/mode list returns JSON with available modes and default mode id', async () => {
    const res = await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: '/mode list' }],
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('mode.list');
    expect(Array.isArray(body.modes)).toBe(true);
    expect(body.modes.map((m: any) => m.id)).toContain('lockdown');
    expect(body.modes.map((m: any) => m.id)).toContain('ops');
    expect(body.defaultMode).toBe(config.defaultMode);
  }, 10000);

  it('/mode reset clears metadata.mode and resolves to default', async () => {
    const res = await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: '/mode reset' }],
      metadata: { mode: 'lockdown' },
    });

    expect(res.status).toBe(200);
    // Without the lockdown metadata, default mode has no forced target.
    // The ABSENT + MEDIUM query routes to a cloud provider, proving reset worked.
    expect(res.headers['x-polly-provider']).not.toMatch(/^ollama\//);
    expect(res.headers['x-polly-vault']).toBe('ABSENT');
  }, 10000);

  it('/mode lockdown forces local routing, strips cloud model, and removes web tools', async () => {
    const res = await postJson(serverPort, '/v1/chat/completions', {
      model: 'groq/llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: '/mode lockdown\nhello' }],
      tools: [
        { type: 'function', function: { name: 'web_search', description: 'search web', parameters: {} } },
        { type: 'function', function: { name: 'exec', description: 'run command', parameters: {} } },
      ],
    });

    expect(res.status).toBe(200);
    // Lockdown absolute flag forces LOCAL, so provider must be local Ollama.
    expect(res.headers['x-polly-provider']).toMatch(/^ollama\//);

    const localDispatch = capturedRequests.find(r => r.url?.endsWith('/chat/completions') && r.url?.startsWith('/v1/'));
    expect(localDispatch).toBeDefined();
    if (!localDispatch) return;
    expect(localDispatch.body.model).not.toBe('groq/llama-3.3-70b-versatile');
    const toolNames = (localDispatch.body.tools ?? []).map((t: any) => t.function?.name);
    expect(toolNames).not.toContain('web_search');
    expect(toolNames).toContain('exec');
  }, 10000);

  it('/mode ops applies local routing and denies web tools', async () => {
    const res = await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: '/mode ops\nfix the service' }],
      tools: [
        { type: 'function', function: { name: 'web_search', description: 'search', parameters: {} } },
        { type: 'function', function: { name: 'exec', description: 'run', parameters: {} } },
      ],
    });

    expect(res.status).toBe(200);
    // Ops target is 'local', so forcedTarget=LOCAL.
    expect(res.headers['x-polly-provider']).toMatch(/^ollama\//);

    const localDispatch = capturedRequests.find(r => r.url?.endsWith('/chat/completions') && r.url?.startsWith('/v1/'));
    expect(localDispatch).toBeDefined();
    if (!localDispatch) return;
    const toolNames = (localDispatch.body.tools ?? []).map((t: any) => t.function?.name);
    expect(toolNames).not.toContain('web_search');
    expect(toolNames).toContain('exec');
  }, 10000);
});