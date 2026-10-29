import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'http';
import { AddressInfo } from 'net';
import { buildChain } from '../src/router';
import { Config } from '../src/config';
import { RequestBody, VaultSignal } from '../src/types';

/**
 * DIRECT-branch context injection (2026-10-29).
 *
 * Found by measurement, not by reading. A real norns request produced:
 *
 *   vault probe   -> DIRECT (0.8364)
 *   pack probe    -> norns-lua/norns-clock (0.8718)
 *   conductor     -> norns domain matched
 *   enrichedChars -> 3643
 *
 * and then the LOCAL model received messageCount=1 and systemPromptLength=0.
 *
 * The router spent ~200ms building 3,643 characters of exactly the context a
 * small local model needs -- the norns-lua clock pattern, the vault
 * excerpts, the conductor's norns manifest -- and threw it away before
 * dispatch. The CLOUD path received it.
 *
 * Root cause: in the DIRECT branch buildChain sets `localBody = body` (the
 * bare request) while `cloudBody` uses `enriched`. The cheap, fast path --
 * the one that needs the context most -- got LESS context than the paid one.
 *
 * This also made the pack probe inert on the local path: it fires, builds a
 * procedure, and that procedure is discarded.
 *
 * Before the Sept 14 restructure (66e6ac09) every provider received the
 * enriched body.
 */

// ── Capture server: stands in for Ollama, records what was dispatched ──────

let received: RequestBody | null = null;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    try {
      received = JSON.parse(raw);
    } catch {
      received = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-capture',
      object: 'chat.completion',
      created: 0,
      model: 'capture',
      choices: [{ index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    }));
  });
});

let baseUrl = '';
let CONFIG: Config;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  CONFIG = {
    ollama: {
      baseUrl,
      timeoutMs: 2000,
      models: [
        { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', maxChars: 28000, weight: 'light', contextTokens: 32768 },
      ],
    },
    providers: {},
    llamacpp: { endpoints: [] },
  } as unknown as Config;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const VAULT_DIRECT: VaultSignal = {
  confidence: 'DIRECT',
  score: 0.84,
  chunks: ['VAULT EXCERPT ONE', 'VAULT EXCERPT TWO', 'VAULT EXCERPT THREE'],
};

const SKILL = {
  hasSkill: true,
  skillName: 'norns-lua/norns-clock',
  procedure: 'SKILL PROCEDURE BODY',
  score: 87,
};

function body(): RequestBody {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'Create a norns script that plays a note on the clock transport' }],
    max_tokens: 40,
  } as RequestBody;
}

describe('DIRECT-branch context injection', () => {
  test('the LOCAL dispatch carries the vault chunks and the skill procedure', async () => {
    received = null;
    const plan = await buildChain(body(), 'MEDIUM', VAULT_DIRECT, CONFIG, SKILL);
    expect(plan.target).toBe('LOCAL');

    const local = plan.chain.find(e => e.name.startsWith('ollama/'));
    expect(local).toBeDefined();
    await local!.fn(body()).catch(() => undefined);

    expect(received).not.toBeNull();
    const sent = received!;
    const allText = JSON.stringify(sent.messages);

    // The skill procedure is what makes a SMALL local model capable of the
    // task. If it is not in the dispatched body, the pack probe fired for
    // nothing.
    expect(allText).toContain('SKILL PROCEDURE BODY');
    // The vault excerpts are the retrieved evidence for the DIRECT verdict.
    expect(allText).toContain('VAULT EXCERPT ONE');
    // And the original request must survive.
    expect(allText).toContain('clock transport');
  });

  test('LIGHT complexity keeps the bare body, matching the other branches', async () => {
    // The ADJACENT and ABSENT branches both use the bare body for LIGHT:
    // a simple task does not need injected context, and injecting it wastes
    // a small model's context window. The DIRECT branch now follows the same
    // convention.
    received = null;
    const plan = await buildChain(body(), 'LIGHT', VAULT_DIRECT, CONFIG, SKILL);
    const local = plan.chain.find(e => e.name.startsWith('ollama/'));
    expect(local).toBeDefined();
    await local!.fn(body()).catch(() => undefined);

    expect(received).not.toBeNull();
    const allText = JSON.stringify(received!.messages);
    expect(allText).not.toContain('SKILL PROCEDURE BODY');
    expect(allText).toContain('clock transport');
  });

  test('no context built means no injection (unchanged behaviour)', async () => {
    received = null;
    const ABSENT: VaultSignal = { confidence: 'ABSENT', score: 0, chunks: [] };
    // LIGHT keeps this on the local path; MEDIUM with no vault and no skill
    // routes to CLOUD by design.
    const plan = await buildChain(body(), 'LIGHT', ABSENT, CONFIG, { hasSkill: false });
    const local = plan.chain.find(e => e.name.startsWith('ollama/'));
    expect(local).toBeDefined();
    await local!.fn(body()).catch(() => undefined);

    expect(received).not.toBeNull();
    const allText = JSON.stringify(received!.messages);
    expect(allText).not.toContain('SKILL PROCEDURE BODY');
    expect(allText).not.toContain('VAULT EXCERPT ONE');
  });
});
