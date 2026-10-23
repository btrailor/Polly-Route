import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { spawn, ChildProcess, execSync } from 'child_process';

/**
 * End-to-end integration tests for the frontier gate pipeline.
 *
 * A mock HTTP backend stands in for:
 *   - Ollama (/api/tags, /v1/chat/completions)
 *   - Cloud providers (/chat/completions)
 *   - Knowledge Skill vault probe (/search)
 *
 * The real polly-router server is spawned as a child process from the
 * compiled dist/server.js and pointed at a temp vault root + temp metrics
 * JSONL via environment variables.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function postJson(port: number, pathName: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getText(port: number, pathName: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathName }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

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

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForMetricEvent(filePath: string, event: string, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const parsed = JSON.parse(lines[i]);
          if (parsed.event === event) return parsed;
        }
      } catch {
        // File may be mid-write; retry.
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for event '${event}' in ${filePath}`);
}

async function waitForCaptureNote(vaultRoot: string, timeoutMs = 5000): Promise<{ name: string; content: string }> {
  const capturedDir = path.join(vaultRoot, '20-Active', 'captured');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(capturedDir)) {
      const files = fs.readdirSync(capturedDir).filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        const name = files[0];
        const content = fs.readFileSync(path.join(capturedDir, name), 'utf-8');
        if (content.includes('bloom: raw-ingest')) {
          return { name, content };
        }
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for capture note in ${capturedDir}`);
}

function openAiResponse(content: string): object {
  return {
    id: 'mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

// ─── Mock backend state ──────────────────────────────────────────────────────

interface VaultProbeResponse {
  confidence: 'DIRECT' | 'ADJACENT' | 'ABSENT';
  chunks: string[];
}

let mockVaultState: Record<string, VaultProbeResponse> = {};
let capturedRequests: { method: string; url: string; body: any }[] = [];

// Long enough to satisfy Knowledge Skill MIN_CONTEXT_CHARS (500)
function directChunks(): string[] {
  return [
    'The frontier gate is the vault-aware routing layer of the Polly framework. It combines a coverage signal from the personal knowledge vault with a complexity estimate of the incoming request to decide whether to route locally to Ollama or to a cloud provider. ' +
    'When the vault contains a direct answer and the request is light or medium, the gate prefers local models for low latency and privacy. ' +
    'When the vault is absent or the request is heavy, it routes to cloud providers and captures the response as a raw-ingest note for future coverage.',
    'Captured notes live in vault/20-Active/captured and are later bloomed into domain notes by the nightly bloom job.',
  ];
}

function adjacentChunks(): string[] {
  return ['Distributed systems require careful trade-offs between consistency, availability, and partition tolerance.'];
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('frontier gate integration', () => {
  let tmpDir: string;
  let vaultRoot: string;
  let metricsPath: string;
  let configPath: string;
  let skillIndexPath: string;
  let mockPort: number;
  let serverPort: number;
  let mockServer: http.Server;
  let serverProcess: ChildProcess;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-router-integration-'));
    vaultRoot = path.join(tmpDir, 'vault');
    fs.mkdirSync(path.join(vaultRoot, '20-Active', 'captured'), { recursive: true });
    metricsPath = path.join(tmpDir, 'polly-metrics.jsonl');

    // Dummy skill index so skillCoverage does not depend on the real workspace tree.
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
      knowledgeSkill: {
        baseUrl: `http://127.0.0.1:${mockPort}`,
        timeoutMs: 1000,
      },
      qmd: {
        baseUrl: `http://127.0.0.1:${mockPort}`,
        collection: 'vault',
        timeoutMs: 1000,
        minScore: 0.89,
      },
      skillCoverage: {
        indexPath: skillIndexPath,
        timeoutMs: 500,
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    // Start mock backend
    mockServer = http.createServer((req, res) => {
      let reqBody = '';
      req.on('data', c => reqBody += c);
      req.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(reqBody); } catch { parsed = {}; }
        capturedRequests.push({ method: req.method || 'GET', url: req.url || '/', body: parsed });

        // Knowledge Skill vault probe
        if (req.url?.startsWith('/search')) {
          const queryText = parsed.query ?? '';
          const match = Object.entries(mockVaultState).find(([q]) => queryText.toLowerCase().includes(q.toLowerCase()));
          if (match) {
            const [, { confidence, chunks }] = match;
            const score = confidence === 'DIRECT' ? 0.85 : 0.55;
            const results = chunks.map((text, i) => ({
              chunk_id: `chunk-${i}`,
              text,
              title: 'Mock note',
              section: 'mock',
              score: confidence === 'DIRECT' ? 0.85 : 0.55,
              retrieval_tier: confidence,
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results, query_time_ms: 1 }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results: [], query_time_ms: 1 }));
          return;
        }

        // Ollama tags availability
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'qwen2.5-coder:32b' }, { name: 'qwen2.5:72b' }] }));
          return;
        }

        // Chat completions (Ollama /v1, cloud providers)
        if (req.url?.endsWith('/chat/completions')) {
          const providerName = req.url?.split('/')[1] ?? 'provider';
          const content = `Mock response from ${providerName}`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(openAiResponse(content)));
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

    // Build server so we exercise the real compiled output.
    execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });

    // Start polly-router server as child process
    const serverScript = path.join(__dirname, '..', 'dist', 'server.js');
    serverProcess = spawn('node', [serverScript], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        POLLY_ROUTER_PORT: String(serverPort),
        POLLY_ROUTER_CONFIG: configPath,
        POLLY_VAULT_ROOT: vaultRoot,
        POLLY_METRICS_PATH: metricsPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout?.on('data', d => process.stdout.write(`[router] ${d}`));
    serverProcess.stderr?.on('data', d => process.stderr.write(`[router] ${d}`));

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
    mockVaultState = {};
    fs.writeFileSync(metricsPath, '', 'utf-8');
    clearCapturedNotes();
  });

  afterEach(() => {
    // no-op; cleanup in afterAll
  });

  function readMetrics() {
    const raw = fs.readFileSync(metricsPath, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map(l => JSON.parse(l));
  }

  function capturedNotes() {
    const capturedDir = path.join(vaultRoot, '20-Active', 'captured');
    if (!fs.existsSync(capturedDir)) return [];
    return fs.readdirSync(capturedDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f, content: fs.readFileSync(path.join(capturedDir, f), 'utf-8') }));
  }

  function clearCapturedNotes() {
    const capturedDir = path.join(vaultRoot, '20-Active', 'captured');
    if (!fs.existsSync(capturedDir)) return;
    for (const f of fs.readdirSync(capturedDir)) {
      fs.rmSync(path.join(capturedDir, f), { force: true });
    }
  }

  // ─── Scenario 1: ABSENT + MEDIUM → cloud + capture ─────────────────────────

  const MEDIUM_QUERY = 'Please explain in plain language how the frontier gate routing pipeline decides whether to send a request to a local Ollama model or to a cloud provider, and what information it uses from the knowledge vault.';
  const HEAVY_QUERY = 'Design a distributed system from scratch with security audit and threat model';

  test('scenario 1: ABSENT vault + MEDIUM complexity routes to cloud and captures a note', async () => {
    mockVaultState = {};

    const res = await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: MEDIUM_QUERY }],
    });

    expect(res.status).toBe(200);
    expect(res.headers['x-polly-vault']).toBe('ABSENT');
    expect(res.headers['x-polly-complexity']).toBe('MEDIUM');
    expect(res.headers['x-polly-provider']).toMatch(/^(groq|cerebras|google|mistral|openrouter|deepseek|ollamapro|openrouter_free)$/);

    const note = await waitForCaptureNote(vaultRoot);
    expect(note.content).toContain('bloom: raw-ingest');
    expect(note.content).toContain('vault_gap: knowledge_gap');
    expect(note.content).toContain(MEDIUM_QUERY);

    await waitForMetricEvent(metricsPath, 'capture');
    const metrics = readMetrics();
    const routing = metrics.filter((m: any) => m.event === 'routing_decision');
    expect(routing.length).toBe(1);
    expect(routing[0].vault).toBe('ABSENT');
    expect(routing[0].target).toBe('CLOUD');
    expect(routing[0].complexity).toBe('MEDIUM');

    const captures = metrics.filter((m: any) => m.event === 'capture');
    expect(captures.length).toBe(1);
    expect(captures[0].vault_gap).toBe('knowledge_gap');
    expect(captures[0].captured).toBe(true);
  }, 20000);

  // ─── Scenario 2: same request again → DIRECT → local ───────────────────────

  test('scenario 2: repeated request finds captured note and routes locally', async () => {
    mockVaultState = {
      'frontier gate routing pipeline': {
        confidence: 'DIRECT',
        chunks: directChunks(),
      },
    };

    const res = await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: MEDIUM_QUERY }],
    });

    expect(res.status).toBe(200);
    expect(res.headers['x-polly-vault']).toBe('DIRECT');
    expect(res.headers['x-polly-complexity']).toBe('MEDIUM');
    expect(res.headers['x-polly-provider']).toMatch(/^ollama\//);

    // No new capture because it routed locally
    expect(capturedNotes().length).toBe(0);

    await waitForFile(metricsPath);
    const metrics = readMetrics();
    const routing = metrics.filter((m: any) => m.event === 'routing_decision');
    expect(routing.length).toBe(1);
    expect(routing[0].vault).toBe('DIRECT');
    expect(routing[0].target).toBe('LOCAL');
    expect(metrics.filter((m: any) => m.event === 'capture').length).toBe(0);
  }, 20000);

  // ─── Scenario 3: ABSENT + LIGHT → local (no capture) ───────────────────────

  test('scenario 3: ABSENT vault + LIGHT complexity routes locally without capture', async () => {
    mockVaultState = {};

    const res = await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    expect(res.headers['x-polly-vault']).toBe('ABSENT');
    expect(res.headers['x-polly-complexity']).toBe('LIGHT');
    expect(res.headers['x-polly-provider']).toMatch(/^ollama\//);

    expect(capturedNotes().length).toBe(0);

    await waitForFile(metricsPath);
    const metrics = readMetrics();
    const routing = metrics.filter((m: any) => m.event === 'routing_decision');
    expect(routing.length).toBe(1);
    expect(routing[0].vault).toBe('ABSENT');
    expect(routing[0].target).toBe('LOCAL');
    expect(routing[0].complexity).toBe('LIGHT');
    expect(metrics.filter((m: any) => m.event === 'capture').length).toBe(0);
  }, 20000);

  // ─── Scenario 4: ADJACENT + HEAVY → cloud ────────────────────────────────────

  test('scenario 4: ADJACENT vault + HEAVY complexity routes to cloud', async () => {
    mockVaultState = {
      'distributed system': {
        confidence: 'ADJACENT',
        chunks: adjacentChunks(),
      },
    };

    const res = await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: HEAVY_QUERY }],
    });

    expect(res.status).toBe(200);
    expect(res.headers['x-polly-vault']).toBe('ADJACENT');
    expect(res.headers['x-polly-complexity']).toBe('HEAVY');
    expect(res.headers['x-polly-provider']).toMatch(/^(groq|cerebras|google|mistral|openrouter|deepseek|ollamapro|openrouter_free)$/);

    // Capability gap because vault had related content but request required cloud
    const note = await waitForCaptureNote(vaultRoot);
    expect(note.content).toContain('vault_gap: capability_gap');

    await waitForMetricEvent(metricsPath, 'capture');
    const metrics = readMetrics();
    const routing = metrics.filter((m: any) => m.event === 'routing_decision');
    expect(routing.length).toBe(1);
    expect(routing[0].vault).toBe('ADJACENT');
    expect(routing[0].target).toBe('CLOUD');
    expect(routing[0].complexity).toBe('HEAVY');

    const captures = metrics.filter((m: any) => m.event === 'capture');
    expect(captures.length).toBe(1);
    expect(captures[0].vault_gap).toBe('capability_gap');
  }, 20000);

  // ─── Scenario 5: metrics across all scenarios ──────────────────────────────

  test('scenario 5: metrics.jsonl aggregates correct routing and capture events', async () => {
    mockVaultState = {};
    fs.writeFileSync(metricsPath, '', 'utf-8');
    clearCapturedNotes();

    // 1) ABSENT MEDIUM → cloud + capture
    await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: MEDIUM_QUERY }],
    });
    await waitForFile(metricsPath);

    // 2) repeated → DIRECT → local (simulate captured note now in vault)
    mockVaultState = {
      'frontier gate routing pipeline': {
        confidence: 'DIRECT',
        chunks: directChunks(),
      },
    };
    await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: MEDIUM_QUERY }],
    });

    // 3) ABSENT LIGHT → local
    mockVaultState = {};
    await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // 4) ADJACENT HEAVY → cloud
    mockVaultState = {
      'distributed system': {
        confidence: 'ADJACENT',
        chunks: adjacentChunks(),
      },
    };
    await postJson(serverPort, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: HEAVY_QUERY }],
    });

    // Give capture async writes a moment to finish.
    await new Promise(r => setTimeout(r, 300));

    const metrics = readMetrics();

    const routing = metrics.filter((m: any) => m.event === 'routing_decision');
    expect(routing).toHaveLength(4);
    expect(routing.map((m: any) => [m.vault, m.complexity, m.target])).toEqual([
      ['ABSENT', 'MEDIUM', 'CLOUD'],
      ['DIRECT', 'MEDIUM', 'LOCAL'],
      ['ABSENT', 'LIGHT', 'LOCAL'],
      ['ADJACENT', 'HEAVY', 'CLOUD'],
    ]);

    const captures = metrics.filter((m: any) => m.event === 'capture');
    expect(captures).toHaveLength(2);
    expect(captures.map((m: any) => m.vault_gap).sort()).toEqual(['capability_gap', 'knowledge_gap']);

    const status = await getText(serverPort, '/status');
    expect(status.status).toBe(200);
    const snapshot = JSON.parse(status.body).metrics;
    expect(snapshot.total_requests).toBe(4);
    expect(snapshot.cloud_requests).toBe(2);
    expect(snapshot.local_completed).toBe(2);
    expect(snapshot.captured_notes).toBe(2);
  }, 30000);
});
