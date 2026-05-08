import http from 'http';
import { loadConfig } from './config.js';
import { classifyComplexity, getLastUserMessage } from './classifier.js';
import { probeVault } from './vault.js';
import { buildChain } from './router.js';
import { estimateCost } from './cost.js';
import { record, recent, stats } from './log.js';
import { RequestBody } from './types.js';

const config = loadConfig();

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function handleCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: RequestBody;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON' } });
  }

  const complexity  = classifyComplexity(body.messages ?? []);
  const userMsg     = getLastUserMessage(body.messages ?? []);
  const vaultSignal = await probeVault(body.messages ?? [], config);

  log('dispatch', { complexity, vault: vaultSignal.confidence, vaultScore: vaultSignal.score.toFixed(2) });

  const chain = await buildChain(body, complexity, vaultSignal, config);
  const startMs = Date.now();

  for (const entry of chain) {
    try {
      const upstream = await entry.fn(body);

      if (upstream.statusCode && upstream.statusCode >= 400) {
        const errBody = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          upstream.on('data', c => chunks.push(c));
          upstream.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
        log('dispatch error — trying next', { provider: entry.name, status: upstream.statusCode, body: errBody.slice(0, 200) });
        continue;
      }

      log('streaming', { provider: entry.name });

      // Stream response back to client
      const headers: Record<string, string> = {
        'Content-Type': upstream.headers['content-type'] ?? 'application/json',
        'X-Polly-Provider': entry.name,
        'X-Polly-Vault': vaultSignal.confidence,
        'X-Polly-Complexity': complexity,
      };
      if (upstream.headers['transfer-encoding']) headers['transfer-encoding'] = upstream.headers['transfer-encoding'] as string;

      res.writeHead(upstream.statusCode ?? 200, headers);

      let rawBody = '';
      upstream.on('data', (chunk: Buffer) => {
        res.write(chunk);
        rawBody += chunk.toString();
      });

      upstream.on('end', () => {
        res.end();
        const ms = Date.now() - startMs;

        let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
        try {
          const parsed = JSON.parse(rawBody);
          usage = parsed.usage;
        } catch {}

        const cost = estimateCost(entry.name, usage);
        log('complete', { provider: entry.name, complexity, vault: vaultSignal.confidence, ms, costUsd: cost?.total?.toFixed(6) ?? '0' });

        record({
          ts: new Date().toISOString(),
          provider: entry.name,
          complexity,
          vault: vaultSignal.confidence,
          ms,
          costUsd: cost?.total ?? 0,
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
        });
      });

      upstream.on('error', (e: Error) => {
        log('stream error', { provider: entry.name, error: e.message });
        if (!res.writableEnded) res.end();
      });

      return;

    } catch (e: unknown) {
      log('dispatch error — trying next', { provider: entry.name, error: (e as Error).message });
    }
  }

  sendJson(res, 502, { error: { message: 'All providers failed' } });
}

function handleModels(_req: http.IncomingMessage, res: http.ServerResponse) {
  sendJson(res, 200, {
    object: 'list',
    data: [{ id: 'auto', object: 'model', created: 1700000000, owned_by: 'polly-route' }],
  });
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
  sendJson(res, 200, { status: 'ok', uptime: process.uptime(), ...stats() });
}

function handleLog(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200);
  sendJson(res, 200, { ...stats(), entries: recent(limit) });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url ?? '/';
  if (req.method === 'POST' && url === '/v1/chat/completions') return handleCompletions(req, res);
  if (req.method === 'GET'  && url === '/v1/models')           return handleModels(req, res);
  if (req.method === 'GET'  && (url === '/status' || url === '/health')) return handleStatus(req, res);
  if (req.method === 'GET'  && url.startsWith('/log'))         return handleLog(req, res);
  sendJson(res, 404, { error: { message: 'Not found' } });
});

server.listen(config.port, '127.0.0.1', () => {
  log(`polly-route v0.6 listening on http://127.0.0.1:${config.port}`);
  log('providers', { available: Object.keys(config.providers).filter(k => !!(config.providers as any)[k]) });
  log('ollama', { models: config.ollama.models.map(m => m.id) });
  log('qmd', { url: config.qmd.baseUrl });
});

server.on('error', (e: Error & { code?: string }) => {
  if (e.code === 'EADDRINUSE') console.error(`[polly-route] Port ${config.port} in use`);
  else console.error('[polly-route] Server error:', e.message);
  process.exit(1);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
