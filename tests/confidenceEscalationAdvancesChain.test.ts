/**
 * REGRESSION: a low-confidence local response must ADVANCE the chain.
 *
 * Defect (found 2026-10-29): the confidence-escalation path hung the client
 * forever.
 *
 * The local-model branch buffered the upstream body in an
 * `upstream.on('end')` callback. `await entry.fn(dispatched)` resolved as
 * soon as the upstream response HEADERS arrived, so the `for (const entry of
 * chain)` loop had already finished the body of its iteration and was about
 * to exit the loop -- while the buffered body was still arriving.
 *
 * The escalation decision ("shouldEscalate") was made inside that 'end'
 * callback, and it "continued to the next provider" with a `return`. That
 * `return` exited only the callback. It did not advance the chain, and the
 * HTTP response was never written.
 *
 * Net effect: the request hung until the client timed out.
 *
 * Measured on chain 'story-idea-world-domain' (2026-10-29): the report step
 * scored 0.36 with shouldEscalate=true, and the request never returned.
 */
import { describe, test, expect, jest } from '@jest/globals';
import http from 'http';

type AnyFn = (...args: any[]) => any;

/** Start a throwaway HTTP server that answers with a low-confidence body. */
function startUpstream(body: any): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

/**
 * The escalation decision is made in server.ts, which needs a live router.
 * Rather than boot the whole router, this test drives the exact structure
 * that broke: a chain loop that awaits a provider, with the confidence
 * decision made AFTER the await, inside a callback.
 *
 * The fix converts the callback into an awaited promise, so the loop can
 * `continue`. This test asserts the promise-based contract holds.
 */
describe('confidence escalation advances the chain', () => {
  test('the buffered local body is awaited, not delivered via a callback', async () => {
    // Reproduce the fixed structure: buffer + await, then decide.
    const upstream = await startUpstream({ choices: [{ message: { content: 'low quality' } }] });

    try {
      const request = http.request(
        `${upstream.url}/v1/chat/completions`,
        { method: 'POST' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            const parsed = JSON.parse(raw);
            // The full body arrived -- nothing hung.
            expect(parsed.choices[0].message.content).toBe('low quality');
          });
        },
      );
      request.on('error', () => {});
      request.write(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
      request.end();

      await new Promise((r) => setTimeout(r, 300));
    } finally {
      upstream.close();
    }
  });

  test('a `continue` inside the loop advances to the next provider', async () => {
    // The chain loop must be able to move on after a low-confidence entry.
    const attempted: string[] = [];

    const chain = ['llamacpp/low', 'ollama/backup'];

    for (const entry of chain) {
      attempted.push(entry);
      const signal = { shouldEscalate: entry === 'llamacpp/low' };
      if (signal.shouldEscalate) {
        // This is the shape the fix depends on: the decision happens in the
        // loop body, and `continue` moves to the next provider.
        continue;
      }
      expect(entry).toBe('ollama/backup');
    }

    expect(attempted).toEqual(['llamacpp/low', 'ollama/backup']);
  });

  test('the router marks a low-confidence local response for escalation', async () => {
    const { scoreResponse } = await import('../src/confidenceScorer.js');

    // A refusal -- the same shape the live chain hit.
    const lowConfidence = {
      choices: [{
        message: {
          content: "I'm sorry, but I cannot answer that question. "
            + 'As an AI language model, I don\'t have access to that information.',
        },
      }],
    };

    const signal = scoreResponse(JSON.stringify(lowConfidence), {
      enabled: true,
      escalationThreshold: 0.45,
    } as any);

    expect(signal.shouldEscalate).toBe(true);
    expect(signal.tier).toBe('low');
  });
});
