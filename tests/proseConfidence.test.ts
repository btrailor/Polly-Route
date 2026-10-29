import { describe, test, expect } from '@jest/globals';
import { scoreOutput, scoreResponse, extractAssistantContent } from '../src/confidenceScorer';

/**
 * Prose confidence checks (2026-10-29).
 *
 * The seven original confidence checks all inspect CODE blocks. A prose answer
 * has none, so every one of them passed vacuously: measured on 2026-10-29,
 * 1,962 of 1,975 scored responses returned score 1.0 and the router never
 * escalated once. A truncated answer scored as a perfect one.
 *
 * These tests pin the behaviour that fixes it.
 */

// Real shapes captured from the live router on 2026-10-29.
const TRUNCATED_REASONING = `What causes ocean tides? Explain in one paragraph.

Explain in one paragraph. Probably concise. Should be accurate. Causes: gravitational pull of moon and sun, differential gravity across Earth, centrifugal force due to Earth-Moon system orbiting barycenter. Tides are bulges.

One paragraph. Possibl`;

const GOOD_PROSE = `Ocean tides are caused by the differential gravitational pull of the Moon and the Sun across the Earth. Because the Moon's pull is stronger on the near side of the Earth than on the far side, water is drawn toward it, creating a bulge. A smaller bulge forms on the opposite side because the Moon's pull there is weaker than the combined pull of the Earth itself, and the Earth and Moon orbit a common barycenter. The Sun contributes a smaller tidal effect of roughly 46 percent of the Moon's.`;

const REFUSAL = `I'm sorry, but I cannot answer that question. As an AI language model, I don't have access to that information.`;

const TRIVIAL = `Tides.`;

describe('prose confidence checks', () => {
  test('a substantive, complete answer scores high', () => {
    const signal = scoreOutput(GOOD_PROSE);
    expect(signal.score).toBeGreaterThanOrEqual(0.75);
    expect(signal.shouldEscalate).toBe(false);
  });

  test('a truncated reasoning trace scores low and escalates', () => {
    const signal = scoreOutput(TRUNCATED_REASONING);
    expect(signal.shouldEscalate).toBe(true);
    const names = signal.checks.map(c => c.name);
    expect(names).toContain('prose-substantive');
    expect(names).toContain('prose-not-truncated');
  });

  test('a refusal scores low and escalates', () => {
    const signal = scoreOutput(REFUSAL);
    expect(signal.shouldEscalate).toBe(true);
    const refusal = signal.checks.find(c => c.name === 'prose-not-refused');
    expect(refusal?.passed).toBe(false);
  });

  test('a trivial one-word answer is not high confidence', () => {
    const signal = scoreOutput(TRIVIAL);
    expect(signal.score).toBeLessThan(0.75);
  });

  test('the prose checks are present and weighted', () => {
    const signal = scoreOutput(GOOD_PROSE);
    for (const name of ['prose-substantive', 'prose-not-truncated', 'prose-not-refused']) {
      const check = signal.checks.find(c => c.name === name);
      expect(check).toBeDefined();
      expect(check!.weight).toBeGreaterThan(0);
    }
  });
});

describe('reasoning_content handling', () => {
  test('empty content with reasoning returns the reasoning, not empty', () => {
    // This is the shape that caused 47 of 1,985 responses to score as
    // "no-content" -> score 1.0 -> a truncated answer looked perfect.
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: TRUNCATED_REASONING } }],
    });
    const content = extractAssistantContent(body);
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('tides');
  });

  test('a normal response still prefers content over reasoning', () => {
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: GOOD_PROSE, reasoning_content: 'thinking...' } }],
    });
    expect(extractAssistantContent(body)).toBe(GOOD_PROSE);
  });

  test('a truncated response is no longer scored as perfect', () => {
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: TRUNCATED_REASONING } }],
    });
    const signal = scoreResponse(body);
    expect(signal.shouldEscalate).toBe(true);
    expect(signal.score).toBeLessThan(0.75);
  });

  test('a genuinely empty response is still reported as no-content', () => {
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '' } }],
    });
    const signal = scoreResponse(body);
    expect(signal.checks[0].name).toBe('no-content');
  });
});
