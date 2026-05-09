import http from 'http';
import { Message, VaultSignal } from './types.js';
import { Config } from './config.js';

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

function getLastUserText(messages: Message[]): string {
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last) return '';
  const text = typeof last.content === 'string'
    ? last.content
    : Array.isArray(last.content) ? last.content.map((c: any) => c.text ?? '').join(' ') : '';

  // Subagent runtime headers are not meaningful vault queries.
  // Detect by checking if the last user message is an OpenClaw runtime preamble
  // (contains subagent depth markers). If so, fall back to the system prompt.
  const isRuntimeHeader = /subagent.*depth|\[Subagent Context\]|you are running as a subagent/i.test(text);
  if (isRuntimeHeader) {
    const sys = messages.find(m => m.role === 'system');
    if (sys) {
      const sysText = typeof sys.content === 'string' ? sys.content : '';
      // Extract meaningful text: skip boilerplate sections, grab first 300 chars of substance
      const stripped = sysText.replace(/##.*?\n/g, '').replace(/^[-*].*?\n/gm, '').trim();
      return stripped.slice(0, 300);
    }
  }
  return text;
}

export async function probeVault(messages: Message[], config: Config): Promise<VaultSignal> {
  const query = getLastUserText(messages).slice(0, 300).replace(/\n/g, ' ').replace(/-/g, ' ');
  if (!query) return { confidence: 'ABSENT', score: 0, chunks: [] };
  log('vault probe query', { query, timeoutMs: config.qmd.timeoutMs, url: config.qmd.baseUrl });

  const body = JSON.stringify({
    searches: [
      { type: 'vec', query },
    ],
    collections: [config.qmd.collection],
    limit: 5,
    minScore: config.qmd.minScore ?? 0.89,
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('vault probe timeout');
      resolve({ confidence: 'ABSENT', score: 0, chunks: [] });
    }, config.qmd.timeoutMs);

    const url = new URL('/query', config.qmd.baseUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 8181,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString());
          const results: any[] = Array.isArray(raw) ? raw : (raw.results ?? []);
          if (!results.length) return resolve({ confidence: 'ABSENT', score: 0, chunks: [] });

          const topScore: number = results[0].score ?? 0;
          const vaultChunks = results.slice(0, 3)
            .map((r: any) => r.snippet ?? r.content ?? '')
            .filter(Boolean);

          let confidence: VaultSignal['confidence'];
          if (topScore >= 0.92 && results.length >= 1) confidence = 'DIRECT';
          else if (topScore >= 0.89) confidence = 'ADJACENT';
          else confidence = 'ABSENT';

          resolve({ confidence, score: topScore, chunks: vaultChunks });
        } catch (e) {
          log('vault probe parse error', { error: (e as Error).message });
          resolve({ confidence: 'ABSENT', score: 0, chunks: [] });
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      log('vault probe error', { error: e.message });
      resolve({ confidence: 'ABSENT', score: 0, chunks: [] });
    });

    req.write(body);
    req.end();
  });
}
