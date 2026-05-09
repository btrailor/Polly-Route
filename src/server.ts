import http from 'http';
import { loadConfig } from './config.js';
import { classifyComplexity, getLastUserMessage } from './classifier.js';
import { probeVault } from './vault.js';
import { buildChain } from './router.js';
import { estimateCost } from './cost.js';
import { record, recent, stats } from './log.js';
import { RequestBody } from './types.js';
import { contractTranslate, DEFAULT_LOCAL_SURFACE } from './contractTranslation.js';

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

/**
 * Qwen-coder-32b (and some other local models) emit tool calls as plain text
 * JSON in message.content instead of structured tool_calls. Detect and reformat.
 *
 * Detection: content is non-empty, tool_calls is empty or absent, and content
 * parses as JSON with a "name" string field (and optionally "arguments" object).
 */
function rewriteTextToolCall(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const choices: any[] = parsed.choices ?? [];
    let rewritten = false;

    for (const choice of choices) {
      const msg = choice.message;
      if (!msg) continue;
      const content = msg.content;
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (hasToolCalls || !content || typeof content !== 'string') continue;

      // Try to parse content as a tool call
      let toolCall: any;
      try {
        toolCall = JSON.parse(content.trim());
      } catch { continue; }

      if (typeof toolCall?.name !== 'string' || !toolCall.name) continue;

      // Reformat into structured tool_calls
      msg.content = null;
      msg.tool_calls = [{
        id: `call_${Date.now()}`,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments ?? toolCall.parameters ?? {}),
        },
      }];
      choice.finish_reason = 'tool_calls';
      rewritten = true;
    }

    if (rewritten) {
      return JSON.stringify(parsed);
    }
  } catch { /* not JSON, pass through */ }
  return raw;
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

  // Token budgets by model (chars not tokens, ~4 chars/token)
  const LOCAL_BUDGETS: Record<string, number> = {
    'qwen2.5:7b':        8000 * 4,
    'qwen2.5-coder:32b': 32000 * 4,
  };

  for (const entry of chain) {
    try {
      // Contract translation for local model dispatch (design.md I1–I7)
      const isLocal = entry.name.startsWith('ollama/');
      let dispatchBody = body;
      if (isLocal && body.tools?.length) {
        const modelId = entry.name.replace('ollama/', '');
        const maxChars = LOCAL_BUDGETS[modelId] ?? 8000 * 4;
        const translated = contractTranslate(
          body.messages ?? [],
          body.tools,
          { localSurface: DEFAULT_LOCAL_SURFACE, maxTokens: Math.floor(maxChars / 4), model: modelId },
        );
        log('contract-translation', {
          provider: entry.name,
          removedTools: translated.removedTools,
          compressed: translated.compressed,
          estimatedTokens: translated.estimatedTokens,
        });
        dispatchBody = { ...body, messages: translated.messages, tools: translated.tools };
      }

      const upstream = await entry.fn(dispatchBody);

      // Step 1 diagnostic: log exact body sent to local model
      if (isLocal) {
  log('local-dispatch-body', {
          provider: entry.name,
          systemPromptLength: (dispatchBody.messages?.find((m: any) => m.role === 'system')?.content as string ?? '').length,
          systemPromptPreview: (dispatchBody.messages?.find((m: any) => m.role === 'system')?.content as string ?? '').slice(0, 200),
          toolCount: dispatchBody.tools?.length ?? 0,
          toolNames: (dispatchBody.tools ?? []).map((t: any) => t.function?.name),
          messageCount: dispatchBody.messages?.length ?? 0,
        });
      }

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

      const clientWantsStream = body.stream === true;
      const upstreamContentType = upstream.headers['content-type'] ?? '';
      const upstreamIsStream = upstreamContentType.includes('text/event-stream');

      // If client wants SSE but upstream returns JSON, wrap in SSE format
      if (clientWantsStream && !upstreamIsStream) {
        res.writeHead(upstream.statusCode ?? 200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Polly-Provider': entry.name,
          'X-Polly-Vault': vaultSignal.confidence,
          'X-Polly-Complexity': complexity,
        });

        const rawChunks: Buffer[] = [];
        upstream.on('data', (c: Buffer) => rawChunks.push(c));
        upstream.on('end', () => {
          let raw = Buffer.concat(rawChunks).toString();
          // Rewrite text-format tool calls from any model (local or cloud)
          raw = rewriteTextToolCall(raw);
          const ms = Date.now() - startMs;
          let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
          let streamChunk: string;
          try {
            const parsed = JSON.parse(raw);
            usage = parsed.usage;
            // Convert non-streaming response to a single SSE chunk
            const choice = parsed.choices?.[0];
            const msg = choice?.message ?? {};
            // Build delta: preserve tool_calls if present (structured tool call response)
            const delta: Record<string, unknown> = { role: 'assistant' };
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
              delta.tool_calls = msg.tool_calls.map((tc: any, i: number) => ({
                index: i,
                id: tc.id,
                type: tc.type ?? 'function',
                function: tc.function,
              }));
            } else {
              delta.content = msg.content ?? '';
            }
            const sseData = JSON.stringify({
              id: parsed.id ?? 'chatcmpl-polly',
              object: 'chat.completion.chunk',
              created: parsed.created ?? Math.floor(Date.now() / 1000),
              model: parsed.model ?? entry.name,
              choices: [{
                index: 0,
                delta,
                finish_reason: choice?.finish_reason ?? 'stop',
              }],
            });
            streamChunk = `data: ${sseData}\n\ndata: [DONE]\n\n`;
          } catch {
            streamChunk = `data: [DONE]\n\n`;
          }
          res.write(streamChunk);
          res.end();

          const cost = estimateCost(entry.name, usage);
          log('complete', { provider: entry.name, complexity, vault: vaultSignal.confidence, ms, costUsd: cost?.total?.toFixed(6) ?? '0' });
          record({ ts: new Date().toISOString(), provider: entry.name, complexity, vault: vaultSignal.confidence, ms, costUsd: cost?.total ?? 0, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 });
        });
        upstream.on('error', (e: Error) => {
          log('stream error', { provider: entry.name, error: e.message });
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        });
        return;
      }

      // Normal passthrough (upstream already streams, or client doesn't need SSE)
      // For local models: buffer to allow text tool-call rewriting before sending
      const headers: Record<string, string> = {
        'Content-Type': upstream.headers['content-type'] ?? 'application/json',
        'X-Polly-Provider': entry.name,
        'X-Polly-Vault': vaultSignal.confidence,
        'X-Polly-Complexity': complexity,
      };
      if (upstream.headers['transfer-encoding'] && !isLocal) headers['transfer-encoding'] = upstream.headers['transfer-encoding'] as string;

      if (isLocal) {
        // Buffer local model response to allow tool-call rewriting
        const rawChunks: Buffer[] = [];
        upstream.on('data', (c: Buffer) => rawChunks.push(c));
        upstream.on('end', () => {
          let rawBody = rewriteTextToolCall(Buffer.concat(rawChunks).toString());
          const ms = Date.now() - startMs;
          let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
          try { const p = JSON.parse(rawBody); usage = p.usage; } catch {}
          res.writeHead(upstream.statusCode ?? 200, { ...headers, 'content-length': Buffer.byteLength(rawBody).toString() });
          res.end(rawBody);
          const cost = estimateCost(entry.name, usage);
          log('complete', { provider: entry.name, complexity, vault: vaultSignal.confidence, ms, costUsd: cost?.total?.toFixed(6) ?? '0' });
          record({ ts: new Date().toISOString(), provider: entry.name, complexity, vault: vaultSignal.confidence, ms, costUsd: cost?.total ?? 0, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 });
        });
        upstream.on('error', (e: Error) => { log('stream error', { provider: entry.name, error: e.message }); if (!res.writableEnded) res.end(); });
        return;
      }

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

server.listen(config.port, '127.0.0.1', async () => {
  log(`polly-route v0.6 listening on http://127.0.0.1:${config.port}`);
  log('providers', { available: Object.keys(config.providers).filter(k => !!(config.providers as any)[k]) });
  log('ollama', { models: config.ollama.models.map(m => m.id) });
  log('qmd', { url: config.qmd.baseUrl });

  // 0a.6 — QMD daemon boot check
  try {
    const qmdRes = await new Promise<boolean>((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: 8181,
        path: '/query',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
      }, (res) => { resolve(res.statusCode === 200); res.resume(); });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
      req.write('{}');
      req.end();
    });
    log(`[boot] QMD daemon reachable: ${qmdRes ? 'yes' : 'NO — vault probe will return ABSENT until daemon starts'}`);
  } catch {
    log('[boot] QMD daemon reachable: NO — vault probe will return ABSENT until daemon starts');
  }
});

server.on('error', (e: Error & { code?: string }) => {
  if (e.code === 'EADDRINUSE') console.error(`[polly-route] Port ${config.port} in use`);
  else console.error('[polly-route] Server error:', e.message);
  process.exit(1);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
