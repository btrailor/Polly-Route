import { RequestBody, Message, Complexity, VaultSignal, RoutingTarget } from './types.js';
import { writeCapture, CaptureNote } from './vaultWriter.js';
import { recordCapture } from './metrics.js';

export interface CapturePayload {
  body: RequestBody;
  provider: string;
  vaultSignal: VaultSignal;
  complexity: Complexity;
  target: RoutingTarget;
  rawResponseText: string;
}

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

function getLastUserText(messages: Message[]): string {
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last) return '';
  return typeof last.content === 'string'
    ? last.content
    : Array.isArray(last.content)
      ? last.content.map((c: any) => c.text ?? '').join(' ')
      : '';
}

function makeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  sigils:   ['code', 'python', 'javascript', 'api', 'database', 'architecture',
            'schema', 'function', 'class', 'module', 'typescript', 'sql'],
  signals:  ['audio', 'music', 'sound', 'podcast', 'recording', 'daw', 'midi',
            'frequency', 'waveform'],
  scrolls:  ['writing', 'essay', 'draft', 'blog', 'article', 'prose', 'narrative',
            'story', 'outline'],
  glyphs:   ['design', 'visual', 'image', 'svg', 'figma', 'ui', 'ux', 'icon',
            'diagram', 'illustration'],
  grids:    ['system', 'infrastructure', 'network', 'deployment', 'ops',
            'kubernetes', 'docker', 'server', 'config'],
};

function classifyDomain(query: string, summary: string, chunks: string[]): {
  domain: string;
  domain_confidence: number;
  domain_source: string;
  domain_evidence: number;
} {
  const text = `${query} ${summary} ${chunks.join(' ')}`.toLowerCase();
  let bestDomain = '';
  let bestScore = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = keywords.reduce((acc, kw) => (text.includes(kw) ? acc + 1 : acc), 0);
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  if (bestDomain && bestScore >= 2) {
    return {
      domain: bestDomain,
      domain_confidence: Math.min(0.95, 0.35 + 0.12 * bestScore),
      domain_source: 'keywords',
      domain_evidence: bestScore,
    };
  }
  return {
    domain: 'unknown',
    domain_confidence: 0.1,
    domain_source: 'unknown',
    domain_evidence: 0,
  };
}

function classifyGap(vaultSignal: VaultSignal): 'knowledge_gap' | 'capability_gap' {
  return vaultSignal.confidence === 'ABSENT' ? 'knowledge_gap' : 'capability_gap';
}

/**
 * Try to extract the final assistant content from either:
 * - a non-streaming JSON completion, or
 * - a server-sent-events (SSE) stream body.
 *
 * Falls back to the first ~300 characters of the raw response.
 */
function extractAnswerSummary(rawResponseText: string): string {
  const trimmed = rawResponseText.trim();
  if (!trimmed) return '';

  // 1. Plain JSON completion
  try {
    const parsed = JSON.parse(trimmed);
    const content = parsed.choices?.[0]?.message?.content ?? parsed.choices?.[0]?.text;
    if (typeof content === 'string' && content.trim()) return content.trim();
  } catch {
    // not plain JSON, continue
  }

  // 2. SSE stream: parse `data: {...}` lines and accumulate delta content.
  let content = '';
  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const dataPrefix = 'data: ';
    if (!line.startsWith(dataPrefix)) continue;
    const payload = line.slice(dataPrefix.length).trim();
    if (payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc?.function?.arguments) content += tc.function.arguments;
        }
      }
    } catch {
      // ignore malformed SSE lines
    }
  }

  if (content.trim()) return content.trim();

  // 3. Fallback: first 300 chars of raw response, cleaned up.
  return trimmed.replace(/\s+/g, ' ').slice(0, 300);
}

function buildCaptureNote(payload: CapturePayload): CaptureNote {
  const query = getLastUserText(payload.body.messages ?? []);
  const slug = makeSlug(query) || 'untitled';
  const capturedAt = new Date().toISOString();
  const date = capturedAt.slice(0, 10);
  const gap = classifyGap(payload.vaultSignal);
  const summary = extractAnswerSummary(payload.rawResponseText);
  const domain = classifyDomain(query, summary, payload.vaultSignal.chunks);

  const frontmatter = [
    '---',
    'bloom: raw-ingest',
    'source: polly-router',
    `captured_at: ${capturedAt}`,
    `provider: ${payload.provider}`,
    `vault_gap: ${gap}`,
    `complexity: ${payload.complexity}`,
    `domain: ${domain.domain}`,
    `domain_confidence: ${domain.domain_confidence.toFixed(2)}`,
    `domain_source: ${domain.domain_source}`,
    `domain_evidence: ${domain.domain_evidence}`,
    '---',
  ].join('\n');

  const body = [
    '# Captured Q\u0026A',
    '',
    '## Query',
    '',
    query || '(no user message)',
    '',
    '## Answer Summary',
    '',
    summary,
    '',
    '## Full Response',
    '',
    '\u0060\u0060\u0060',
    payload.rawResponseText,
    '\u0060\u0060\u0060',
    '',
  ].join('\n');

  return {
    filename: `${date}-${slug}.md`,
    content: `${frontmatter}\n\n${body}`,
  };
}

/**
 * Capture a cloud-routed request/response pair to the vault.
 *
 * The caller should not await this function; it is designed to run in the
 * background so the client response is never delayed. Errors are logged and
 * swallowed.
 */
export async function captureCloudResponse(payload: CapturePayload): Promise<void> {
  if (payload.target !== 'CLOUD') {
    log('capture skipped: not a cloud route', { target: payload.target });
    return;
  }

  const note = buildCaptureNote(payload);

  // Fire-and-forget from the caller's perspective; this async function handles
  // its own errors so it never throws.
  try {
    const writtenPath = await writeCapture(note);
    if (writtenPath) {
      recordCapture(payload.provider, classifyGap(payload.vaultSignal), payload.complexity, true);
      log('capture complete', {
        provider: payload.provider,
        vault_gap: classifyGap(payload.vaultSignal),
        complexity: payload.complexity,
        path: writtenPath,
      });
    } else {
      recordCapture(payload.provider, classifyGap(payload.vaultSignal), payload.complexity, false);
      log('capture dropped: vault unavailable or write failed', {
        provider: payload.provider,
        vault_gap: classifyGap(payload.vaultSignal),
      });
    }
  } catch (e) {
    log('capture error', {
      provider: payload.provider,
      error: (e as Error).message,
    });
  }
}
