import { describe, test, expect } from '@jest/globals';
import { scoreOutput } from '../src/confidenceScorer';
import { existsSync } from 'fs';
import { join } from 'path';

// ─── Constants ───────────────────────────────────────────────────────────────

const HOOKS_DIR = '/Users/brettgershon/.openclaw/workspace/hooks';
const hooksAvailable = existsSync(join(HOOKS_DIR, 'lua-syntax-check.sh'));

// ─── Hook validation check ──────────────────────────────────────────────────

describe('scoreOutput — hook validation', () => {
  test('6th check is named hook-validation with weight 0.20', () => {
    const signal = scoreOutput('hello world');
    const hookCheck = signal.checks.find(c => c.name === 'hook-validation');
    expect(hookCheck).toBeDefined();
    expect(hookCheck!.weight).toBe(0.20);
  });

  test('check passes by default when no hookScriptsDir configured', () => {
    const signal = scoreOutput('```lua\nprint("hello")\n```');
    const hookCheck = signal.checks.find(c => c.name === 'hook-validation')!;
    expect(hookCheck.passed).toBe(true);
    expect(hookCheck.detail).toContain('skipped');
  });

  test('check passes when hooks directory does not exist', () => {
    const signal = scoreOutput('```lua\nprint("hello")\n```', {
      hookScriptsDir: '/nonexistent/path/that/does/not/exist',
    });
    const hookCheck = signal.checks.find(c => c.name === 'hook-validation')!;
    expect(hookCheck.passed).toBe(true);
    expect(hookCheck.detail).toContain('not found');
  });

  test('check passes when no recognized language code blocks are present', () => {
    const signal = scoreOutput('```python\nprint("hello")\n```', {
      hookScriptsDir: HOOKS_DIR,
    });
    const hookCheck = signal.checks.find(c => c.name === 'hook-validation')!;
    expect(hookCheck.passed).toBe(true);
    expect(hookCheck.detail).toContain('all hooks passed');
  });

  test('check passes for valid Lua code when hooks enabled', () => {
    if (!hooksAvailable) {
      console.warn('Skipping: hooks directory not available');
      return;
    }
    const code = '```lua\nlocal x = 1\nlocal y = x + 2\nprint(y)\n```';
    const signal = scoreOutput(code, { hookScriptsDir: HOOKS_DIR });
    const hookCheck = signal.checks.find(c => c.name === 'hook-validation')!;
    expect(hookCheck.passed).toBe(true);
    expect(hookCheck.detail).toContain('all hooks passed');
  });

  test('check fails for invalid Lua syntax when hooks enabled', () => {
    if (!hooksAvailable) {
      console.warn('Skipping: hooks directory not available');
      return;
    }
    // Missing 'end' for the if block — luac will catch this
    const badLua = '```lua\nif true then\n  print("broken")\n```';
    const signal = scoreOutput(badLua, { hookScriptsDir: HOOKS_DIR });
    const hookCheck = signal.checks.find(c => c.name === 'hook-validation')!;
    expect(hookCheck.passed).toBe(false);
    expect(hookCheck.detail).toContain('lua-syntax-check.sh');
    expect(hookCheck.detail).toContain('fail');
  });

  test('failed hook drops the overall score', () => {
    if (!hooksAvailable) {
      console.warn('Skipping: hooks directory not available');
      return;
    }
    const badLua = '```lua\nif true then\n  print("broken")\n```';
    const signalWithHooks = scoreOutput(badLua, { hookScriptsDir: HOOKS_DIR });
    const signalWithoutHooks = scoreOutput(badLua);

    // Score with hooks should be lower than without (one more check failing)
    expect(signalWithHooks.score).toBeLessThan(signalWithoutHooks.score);

    // The hook-validation check should be the difference
    const hookCheck = signalWithHooks.checks.find(c => c.name === 'hook-validation')!;
    expect(hookCheck.passed).toBe(false);
  });

  test('failed hook can trigger escalation', () => {
    if (!hooksAvailable) {
      console.warn('Skipping: hooks directory not available');
      return;
    }
    // Construct code that fails only the hook check (Lua syntax error)
    // but is otherwise clean — no imports, no types, no suspicious calls,
    // balanced braces (if/then/print is balanced enough for the brace checker),
    // no hallucination markers.
    // With hooks disabled, all 6 checks pass → score 1.0
    // With hooks enabled, hook-validation fails → score = (1.0 - 0.20) / 1.0 = 0.80
    // With a high escalation threshold (0.85), 0.80 < 0.85 → escalate
    const badLua = '```lua\nif true then\n  print("broken")\n```';
    const signal = scoreOutput(badLua, {
      hookScriptsDir: HOOKS_DIR,
      escalationThreshold: 0.85,
    });
    expect(signal.shouldEscalate).toBe(true);
  });

  test('all 6 check weights sum to 1.0', () => {
    const signal = scoreOutput('```lua\nprint("hi")\n```', {
      hookScriptsDir: HOOKS_DIR,
    });
    const totalWeight = signal.checks.reduce((sum, c) => sum + c.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
    expect(signal.checks).toHaveLength(7);
  });
});