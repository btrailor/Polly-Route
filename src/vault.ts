import http from 'http';
import { Message, VaultSignal } from './types.js';
import { Config } from './config.js';

// ---------------------------------------------------------------------------
// Knowledge Skill types
// ---------------------------------------------------------------------------

interface KSResult {
  chunk_id: string;
  text: string;
  title: string;
  section: string;
  score: number;
  retrieval_tier: 'DIRECT' | 'ADJACENT';
}

interface KSResponse {
  results: KSResult[];
  query_time_ms: number;
  error?: string;
}

// Thresholds from RAG_ROUTING_ARCHITECTURE.md (validated Feb 1 2026)
const KS_DIRECT_THRESHOLD = 0.75;
const KS_ADJACENT_THRESHOLD = 0.45;
const MIN_HIGH_QUALITY = 2;
const MIN_CONTEXT_CHARS = 500;

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
      // Prefer ## Your Role content — that's the actual task, most relevant for vault probe
      // Match ## Your Role followed by any text until next ## heading or end of string
      const yourRoleMatch = sysText.match(/## Your Role\n([\s\S]{10,300}?)(?=\n## |$)/);
      if (yourRoleMatch?.[1]) {
        // Strip any leading boilerplate like "handle:" or "Your assigned task is"
        const task = yourRoleMatch[1].replace(/^handle[^:]*:\s*/i, '').replace(/^Your assigned task is\s*/i, '').trim();
        if (task.length >= 10) return task.slice(0, 300);
      }
      // Fallback: grab first 300 chars of substance after stripping boilerplate headings
      const stripped = sysText.replace(/##.*?\n/g, '').replace(/^[-*].*?\n/gm, '').trim();
      return stripped.slice(0, 300);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Knowledge Skill probe (primary)
// ---------------------------------------------------------------------------

async function probeKnowledgeSkill(
  query: string,
  baseUrl: string,
  timeoutMs: number,
): Promise<VaultSignal | null> {
  try {
    const res = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.slice(0, 500), top_k: 10, include_adjacent: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as KSResponse;
    if (data.error || !data.results || data.results.length === 0) return null;

    const results = data.results;
    const topScore = results[0]?.score ?? 0;
    const highQualityCount = results.filter(r => r.score >= KS_DIRECT_THRESHOLD).length;
    const contextChars = results
      .slice(0, 10)
      .reduce((sum, r) => sum + (r.text?.length ?? 0), 0);

    const vaultChunks = results
      .slice(0, 3)
      .map((r: KSResult) => r.text ?? '')
      .filter(Boolean);

    let confidence: VaultSignal['confidence'];
    if (
      topScore >= KS_DIRECT_THRESHOLD &&
      highQualityCount >= MIN_HIGH_QUALITY &&
      contextChars >= MIN_CONTEXT_CHARS
    ) {
      confidence = 'DIRECT';
    } else if (topScore >= KS_ADJACENT_THRESHOLD) {
      confidence = 'ADJACENT';
    } else {
      confidence = 'ABSENT';
    }

    return { confidence, score: topScore, chunks: vaultChunks };
  } catch {
    return null; // unavailable or timed out
  }
}

// ---------------------------------------------------------------------------
// QMD fallback probe
// ---------------------------------------------------------------------------

function probeQMD(
  query: string,
  config: Config,
  resolve: (value: VaultSignal) => void,
): void {
  const body = JSON.stringify({
    searches: [
      { type: 'vec', query },
    ],
    collections: [config.qmd.collection],
    limit: 5,
    minScore: config.qmd.minScore ?? 0.89,
  });

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
}

export async function probeVault(messages: Message[], config: Config): Promise<VaultSignal> {
  const query = getLastUserText(messages).slice(0, 300).replace(/\n/g, ' ').replace(/-/g, ' ');
  if (!query) return { confidence: 'ABSENT', score: 0, chunks: [] };

  // Try Knowledge Skill first
  if (config.knowledgeSkill) {
    log('vault probe: trying Knowledge Skill', { url: config.knowledgeSkill.baseUrl });
    const ksResult = await probeKnowledgeSkill(
      query,
      config.knowledgeSkill.baseUrl,
      config.knowledgeSkill.timeoutMs,
    );
    if (ksResult !== null) {
      log('vault probe: Knowledge Skill result', { confidence: ksResult.confidence, score: ksResult.score });
      return ksResult;
    }
    log('vault probe: Knowledge Skill unavailable, falling back to QMD');
  }

  // Fall back to QMD
  log('vault probe: trying QMD', { query, timeoutMs: config.qmd.timeoutMs, url: config.qmd.baseUrl });
  return new Promise((resolve) => {
    probeQMD(query, config, resolve);
  });
}
