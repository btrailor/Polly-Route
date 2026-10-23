import { describe, test, expect } from '@jest/globals';
import {
  scoreOutput,
  scoreResponse,
  extractAssistantContent,
} from '../src/confidenceScorer';
import { ConfidenceSignal } from '../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCodeResponse(code: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: code } }],
    usage: { prompt_tokens: 10, completion_tokens: 100 },
  });
}

function makeTextResponse(text: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 50 },
  });
}

// ─── scoreOutput: basic behaviour ────────────────────────────────────────────

describe('scoreOutput — basic behaviour', () => {
  test('returns high confidence for clean, well-formed code', () => {
    const code = `import fs from 'fs';
import path from 'path';

const filePath = path.join(process.cwd(), 'config.json');
const content = fs.readFileSync(filePath, 'utf-8');
console.log(content);
`;
    const signal = scoreOutput(code);
    expect(signal.score).toBeGreaterThan(0.7);
    expect(signal.tier).toBe('high');
    expect(signal.shouldEscalate).toBe(false);
  });

  test('returns high confidence for non-code text (no code blocks)', () => {
    const text = 'This is a helpful response about planning a sprint. No code needed here.';
    const signal = scoreOutput(text);
    expect(signal.score).toBeGreaterThanOrEqual(0.7);
    expect(signal.tier).toBe('high');
  });

  test('returns a signal with named checks', () => {
    const signal = scoreOutput('hello world');
    expect(signal.checks).toHaveLength(7);
    expect(signal.checks.map(c => c.name)).toEqual([
      'import-validity',
      'type-consistency',
      'api-call-validity',
      'code-structure',
      'hallucination-markers',
      'hook-validation',
      'conductor-gates',
    ]);
  });

  test('disabled config returns high confidence', () => {
    const signal = scoreOutput('anything', { enabled: false });
    expect(signal.score).toBe(1.0);
    expect(signal.tier).toBe('high');
    expect(signal.shouldEscalate).toBe(false);
    expect(signal.checks).toHaveLength(0);
  });
});

// ─── Check: import validity ──────────────────────────────────────────────────

describe('scoreOutput — import validity', () => {
  test('real imports pass', () => {
    const code = '```ts\nimport fs from "fs";\nimport path from "path";\n```';
    const signal = scoreOutput(code);
    const importCheck = signal.checks.find(c => c.name === 'import-validity')!;
    expect(importCheck.passed).toBe(true);
  });

  test('namespace imports (* as X) are extracted and pass', () => {
    const code = '```ts\nimport * as fs from "fs";\nimport * as path from "path";\n```';
    const signal = scoreOutput(code);
    const importCheck = signal.checks.find(c => c.name === 'import-validity')!;
    expect(importCheck.passed).toBe(true);
    expect(importCheck.detail).toContain('2 import(s)');
  });

  test('type-only imports (import type) are extracted and pass', () => {
    const code = '```ts\nimport type http from "http";\n```';
    const signal = scoreOutput(code);
    const importCheck = signal.checks.find(c => c.name === 'import-validity')!;
    expect(importCheck.passed).toBe(true);
    expect(importCheck.detail).toContain('1 import(s)');
  });

  test('side-effect imports (import "x") are extracted', () => {
    const code = '```ts\nimport "./polyfill";\n```';
    const signal = scoreOutput(code);
    const importCheck = signal.checks.find(c => c.name === 'import-validity')!;
    expect(importCheck.passed).toBe(true);
  });

  test('scoped packages are accepted', () => {
    const code = '```ts\nimport { something } from "@scope/package";\n```';
    const signal = scoreOutput(code);
    const importCheck = signal.checks.find(c => c.name === 'import-validity')!;
    expect(importCheck.passed).toBe(true);
  });

  test('relative paths are accepted', () => {
    const code = '```ts\nimport { helper } from "./utils";\n```';
    const signal = scoreOutput(code);
    const importCheck = signal.checks.find(c => c.name === 'import-validity')!;
    expect(importCheck.passed).toBe(true);
  });

  test('node: protocol imports are accepted', () => {
    const code = '```ts\nimport { readFileSync } from "node:fs";\n```';
    const signal = scoreOutput(code);
    const importCheck = signal.checks.find(c => c.name === 'import-validity')!;
    expect(importCheck.passed).toBe(true);
  });

  test('suspicious built-in-like imports are flagged', () => {
    // 'fse' looks like a built-in but isn't in the known set
    const code = '```ts\nimport { readFile } from "fse";\n```';
    const signal = scoreOutput(code, {
      knownImports: ['fs', 'path', 'http'],
    });
    const importCheck = signal.checks.find(c => c.name === 'import-validity')!;
    expect(importCheck.passed).toBe(false);
    expect(importCheck.detail).toContain('fse');
  });
});

// ─── Check: type consistency ─────────────────────────────────────────────────

describe('scoreOutput — type consistency', () => {
  test('known types pass', () => {
    const code = '```ts\nconst x: string = "hello";\nconst y: number = 42;\n```';
    const signal = scoreOutput(code);
    const typeCheck = signal.checks.find(c => c.name === 'type-consistency')!;
    expect(typeCheck.passed).toBe(true);
  });

  test('high ratio of unknown types is flagged', () => {
    const code = '```ts\nconst x: FooBar = create();\nconst y: BazQux = make();\nconst z: Widget = build();\n```';
    const signal = scoreOutput(code, {
      knownTypes: ['string', 'number', 'boolean'],
    });
    const typeCheck = signal.checks.find(c => c.name === 'type-consistency')!;
    expect(typeCheck.passed).toBe(false);
  });

  test('mixed known and unknown types pass when majority known', () => {
    const code = '```ts\nconst a: string = "x";\nconst b: number = 1;\nconst c: CustomType = {};\n```';
    const signal = scoreOutput(code, {
      knownTypes: ['string', 'number', 'boolean', 'void'],
    });
    const typeCheck = signal.checks.find(c => c.name === 'type-consistency')!;
    // 1 unknown out of 3 = 33% < 60% threshold
    expect(typeCheck.passed).toBe(true);
  });
});

// ─── Check: code structure ─────────────────────────────────────────────────────

describe('scoreOutput — code structure', () => {
  test('balanced braces pass', () => {
    const code = '```ts\nfunction foo() {\n  if (true) {\n    console.log("hello");\n  }\n}\n```';
    const signal = scoreOutput(code);
    const structCheck = signal.checks.find(c => c.name === 'code-structure')!;
    expect(structCheck.passed).toBe(true);
  });

  test('unbalanced braces are flagged', () => {
    const code = '```ts\nfunction foo() {\n  if (true) {\n    console.log("hello");\n  }\n// missing closing brace\n```';
    const signal = scoreOutput(code);
    const structCheck = signal.checks.find(c => c.name === 'code-structure')!;
    expect(structCheck.passed).toBe(false);
  });

  test('truncated output is flagged', () => {
    const code = '```ts\nfunction foo() {\n  // TODO: implement this\n```';
    const signal = scoreOutput(code);
    const structCheck = signal.checks.find(c => c.name === 'code-structure')!;
    expect(structCheck.passed).toBe(false);
  });

  test('no code blocks — structure check passes', () => {
    const text = 'This is a prose answer with no code.';
    const signal = scoreOutput(text);
    const structCheck = signal.checks.find(c => c.name === 'code-structure')!;
    expect(structCheck.passed).toBe(true);
  });
});

// ─── Check: hallucination markers ─────────────────────────────────────────────

describe('scoreOutput — hallucination markers', () => {
  test('hedging language is flagged', () => {
    const text = 'I believe this should work. Let me know if you need changes.';
    const signal = scoreOutput(text);
    const hallCheck = signal.checks.find(c => c.name === 'hallucination-markers')!;
    expect(hallCheck.passed).toBe(false);
    expect(hallCheck.detail).toContain('hedging-language');
  });

  test('placeholder code is flagged', () => {
    const text = '```ts\n// your implementation here\nfunction foo() {}\n```';
    const signal = scoreOutput(text);
    const hallCheck = signal.checks.find(c => c.name === 'hallucination-markers')!;
    expect(hallCheck.passed).toBe(false);
    expect(hallCheck.detail).toContain('placeholder-code');
  });

  test('confident, clean text passes', () => {
    const text = 'The configuration file is at config.json. Restart the server after editing.';
    const signal = scoreOutput(text);
    const hallCheck = signal.checks.find(c => c.name === 'hallucination-markers')!;
    expect(hallCheck.passed).toBe(true);
  });
});

// ─── Check: API call validity ──────────────────────────────────────────────────

describe('scoreOutput — API call validity', () => {
  test('known API calls pass', () => {
    const code = '```ts\nconst data = fs.readFileSync("file.txt", "utf-8");\nconsole.log(data);\n```';
    const signal = scoreOutput(code);
    const apiCheck = signal.checks.find(c => c.name === 'api-call-validity')!;
    expect(apiCheck.passed).toBe(true);
  });

  test('near-miss API calls are flagged', () => {
    // 'fs.readFileSynch' is a near-miss of 'fs.readFileSync' (1 edit distance)
    const code = '```ts\nconst data = fs.readFileSynch("file.txt", "utf-8");\n```';
    const signal = scoreOutput(code, {
      knownApiCalls: ['fs.readFileSync', 'fs.readFile', 'console.log', 'JSON.parse', 'JSON.stringify', 'path.join', 'path.resolve', 'path.dirname', 'path.basename', 'process.env', 'process.exit', 'process.cwd', 'Buffer.from', 'Buffer.concat', 'Buffer.alloc', 'fs.writeFile', 'fs.writeFileSync', 'fs.existsSync', 'fs.mkdirSync', 'fs.readdir', 'http.request', 'http.get', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
    });
    const apiCheck = signal.checks.find(c => c.name === 'api-call-validity')!;
    expect(apiCheck.passed).toBe(false);
  });

  test('custom API calls are not penalised', () => {
    const code = '```ts\nconst result = myCustomFunction(arg1, arg2);\n```';
    const signal = scoreOutput(code);
    const apiCheck = signal.checks.find(c => c.name === 'api-call-validity')!;
    expect(apiCheck.passed).toBe(true);
  });
});

// ─── Integration: scoreResponse ───────────────────────────────────────────────

describe('scoreResponse — HTTP response body', () => {
  test('scores a valid OpenAI-compatible response', () => {
    const rawBody = makeCodeResponse(`import fs from 'fs';
const content = fs.readFileSync('file.txt', 'utf-8');
console.log(content);
`);
    const signal = scoreResponse(rawBody);
    expect(signal.score).toBeGreaterThan(0.6);
    expect(signal.shouldEscalate).toBe(false);
  });

  test('scores a response with hedging language as lower confidence', () => {
    const rawBody = makeTextResponse(
      'I believe this code might work. // your implementation here\n' +
      'import { readFileSynch } from "fse";\n' +
      'const x: FooBarBaz = something();'
    );
    const signal = scoreResponse(rawBody, {
      knownImports: ['fs', 'path', 'http'],
      knownTypes: ['string', 'number', 'boolean'],
      knownApiCalls: ['fs.readFileSync', 'fs.readFile', 'console.log', 'JSON.parse', 'JSON.stringify', 'path.join', 'path.resolve', 'path.dirname', 'path.basename', 'process.env', 'process.exit', 'process.cwd', 'Buffer.from', 'Buffer.concat', 'Buffer.alloc', 'fs.writeFile', 'fs.writeFileSync', 'fs.existsSync', 'fs.mkdirSync', 'fs.readdir', 'http.request', 'http.get', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
    });
    expect(signal.tier).not.toBe('high');
  });

  test('returns high confidence for empty content (tool calls)', () => {
    const rawBody = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'exec', arguments: '{}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const signal = scoreResponse(rawBody);
    expect(signal.score).toBe(1.0);
    expect(signal.shouldEscalate).toBe(false);
  });

  test('returns high confidence for invalid JSON', () => {
    const signal = scoreResponse('not json at all');
    expect(signal.score).toBe(1.0);
  });
  test('empty or null assistant content returns explicit no-content check', () => {
    const rawBody = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    });
    const signal = scoreResponse(rawBody);
    expect(signal.score).toBe(1.0);
    expect(signal.shouldEscalate).toBe(false);
    expect(signal.checks).toHaveLength(1);
    expect(signal.checks[0].name).toBe('no-content');
    expect(signal.checks[0].passed).toBe(true);
    expect(signal.checks[0].weight).toBe(0);
  });

  test('empty string assistant content returns no-content check', () => {
    const rawBody = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '' } }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    });
    const signal = scoreResponse(rawBody);
    expect(signal.checks[0].name).toBe('no-content');
  });
});

// ─── Integration: extractAssistantContent ──────────────────────────────────────

describe('extractAssistantContent', () => {
  test('extracts content from a standard response', () => {
    const raw = makeTextResponse('hello world');
    expect(extractAssistantContent(raw)).toBe('hello world');
  });

  test('returns empty string for invalid JSON', () => {
    expect(extractAssistantContent('not json')).toBe('');
  });

  test('concatenates content from multiple choices', () => {
    const raw = JSON.stringify({
      choices: [
        { message: { content: 'part 1 ' } },
        { message: { content: 'part 2' } },
      ],
    });
    expect(extractAssistantContent(raw)).toBe('part 1 part 2');
  });

  test('handles null content (tool call responses)', () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [] } }],
    });
    expect(extractAssistantContent(raw)).toBe('');
  });
});

// ─── Escalation threshold ─────────────────────────────────────────────────────

describe('scoreOutput — escalation threshold', () => {
  test('low-quality output triggers escalation', () => {
    const code = '```ts\n' +
      '// I believe this should work\n' +
      'import { readFileSynch } from "fse";\n' +
      'const x: FooBarBaz = something();\n' +
      'function broken(\n' +
      '```\n' +
      '// your implementation here';
    const signal = scoreOutput(code, {
      escalationThreshold: 0.6,
      knownImports: ['fs', 'path'],
      knownTypes: ['string', 'number'],
      knownApiCalls: ['fs.readFileSync', 'fs.readFile', 'console.log', 'JSON.parse', 'JSON.stringify', 'path.join', 'path.resolve', 'path.dirname', 'path.basename', 'process.env', 'process.exit', 'process.cwd', 'Buffer.from', 'Buffer.concat', 'Buffer.alloc', 'fs.writeFile', 'fs.writeFileSync', 'fs.existsSync', 'fs.mkdirSync', 'fs.readdir', 'http.request', 'http.get', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
    });
    expect(signal.score).toBeLessThanOrEqual(0.55);
    expect(signal.shouldEscalate).toBe(true);
  });

  test('clean output does not trigger escalation', () => {
    const code = '```ts\nimport fs from "fs";\nconst data = fs.readFileSync("file.txt");\nconsole.log(data);\n```';
    const signal = scoreOutput(code, { escalationThreshold: 0.45 });
    expect(signal.shouldEscalate).toBe(false);
  });

  test('custom escalation threshold is respected', () => {
    const text = 'I believe this might work. // your implementation here';
    const signal = scoreOutput(text, { escalationThreshold: 0.9 });
    // Two checks fail (hedging + placeholder) → score = (1.0 - 0.10 - 0.10) / 1.0 = 0.80
    // With threshold 0.9, 0.80 < 0.9 → should escalate
    expect(signal.shouldEscalate).toBe(true);
  });
});

// ─── Weight consistency ────────────────────────────────────────────────────────

describe('scoreOutput — weight consistency', () => {
  test('check weights sum to 1.0', () => {
    const signal = scoreOutput('hello');
    const totalWeight = signal.checks.reduce((sum, c) => sum + c.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  test('score equals fraction of passed weights', () => {
    const signal = scoreOutput('hello world');
    const passedWeight = signal.checks.filter(c => c.passed).reduce((sum, c) => sum + c.weight, 0);
    const totalWeight = signal.checks.reduce((sum, c) => sum + c.weight, 0);
    const expected = Math.round((passedWeight / totalWeight) * 100) / 100;
    expect(signal.score).toBe(expected);
  });
});

// ─── Conductor gate detection ─────────────────────────────────────────────────

describe('scoreOutput — conductor-gates check', () => {
  test('conductor-gates check exists', () => {
    const signal = scoreOutput('Hello world');
    const check = signal.checks.find(c => c.name === 'conductor-gates');
    expect(check).toBeDefined();
  });

  test('passes when no conductor output is detected', () => {
    const signal = scoreOutput('Hello world, this is a normal response with no code.');
    const check = signal.checks.find(c => c.name === 'conductor-gates');
    expect(check!.passed).toBe(true);
    expect(check!.detail).toBe('no conductor output detected');
  });

  test('passes when all conductor gates pass and result is completed', () => {
    const output = 'Here is the result:\n[conductor] gate scene_file_exists: PASS — ok\n[conductor] gate frontmatter_valid: PASS — ok\n[conductor] result: 3 steps, completed';
    const signal = scoreOutput(output);
    const check = signal.checks.find(c => c.name === 'conductor-gates');
    expect(check!.passed).toBe(true);
    expect(check!.detail).toContain('all gates passed');
  });

  test('fails when a conductor gate fails', () => {
    const output = '[conductor] gate word_count_gt_500: FAIL — only 200 words\n[conductor] result: 2 steps, not completed';
    const signal = scoreOutput(output);
    const check = signal.checks.find(c => c.name === 'conductor-gates');
    expect(check!.passed).toBe(false);
    expect(check!.detail).toContain('gate failure');
  });

  test('fails when conductor result is not completed', () => {
    const output = '[conductor] gate scene_file_exists: PASS — ok\n[conductor] result: 5 steps, not completed';
    const signal = scoreOutput(output);
    const check = signal.checks.find(c => c.name === 'conductor-gates');
    expect(check!.passed).toBe(false);
    expect(check!.detail).toContain('did not complete');
  });

  test('fails when conductor has an error', () => {
    const output = '[conductor] model error: connection refused';
    const signal = scoreOutput(output);
    const check = signal.checks.find(c => c.name === 'conductor-gates');
    expect(check!.passed).toBe(false);
    expect(check!.detail).toContain('conductor error');
  });

  test('triggers escalation when conductor gates fail', () => {
    const output = '[conductor] gate word_count_gt_500: FAIL — only 200 words';
    const signal = scoreOutput(output, { escalationThreshold: 0.9 });
    expect(signal.shouldEscalate).toBe(true);
  });
});
// ─── Codemap parsing ─────────────────────────────────────────────────────────

describe('scoreOutput — codemap integration', () => {
  test('codemapDir pointing to non-existent directory does not crash', () => {
    const signal = scoreOutput('hello world', {
      codemapDir: '/nonexistent/path/that/does/not/exist',
    });
    expect(signal).toBeDefined();
    expect(signal.score).toBeGreaterThanOrEqual(0);
  });

  test('codemapDir with no .md files does not crash', () => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-test-'));
    try {
      const signal = scoreOutput('hello world', { codemapDir: tmpDir });
      expect(signal).toBeDefined();
      expect(signal.score).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('codemapDir with a fake codemap .md file extracts symbols', () => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-test-'));
    try {
      const fakeCodemap = [
        '## 3. Export Surfaces (function signatures)',
        '```',
        '[src/foo.h] void init_foo(void)',
        '[src/foo.h] int get_foo_count(void)',
        '[src/bar.h] const char* bar_name(void)',
        '```',
        '',
        '## 4. Dependency Graph (module-level #includes)',
        '```',
        '[src/foo.c] #include <stdio.h>',
        '[src/foo.c] #include <foo.h>',
        '[src/bar.c] #include "bar.h"',
        '```',
        '',
        '## 5. Type Index (typedefs from headers)',
        '```',
        '[src/foo.h] 10:typedef struct _FooState {',
        '[src/bar.h] 5:typedef void(*bar_handler_t)(void*);',
        '```',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'fake-codemap.md'), fakeCodemap);

      const signal = scoreOutput('hello world', { codemapDir: tmpDir });
      expect(signal).toBeDefined();
      expect(signal.checks.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('codemap symbols augment known lists with real aleph codemap', () => {
    const os = require('os');
    const fs = require('fs');
    const codemapDir = os.homedir() + '/.openclaw/codemaps';
    if (!fs.existsSync(codemapDir + '/aleph.md')) {
      return; // skip if no codemap available
    }
    const signal = scoreOutput('hello world', { codemapDir });
    expect(signal).toBeDefined();
    expect(signal.checks.length).toBeGreaterThan(0);
  });
});
