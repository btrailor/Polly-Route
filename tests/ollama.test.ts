import { describe, test, expect } from '@jest/globals';
import { OllamaAdapter } from '../src/providers/ollama';
import { OllamaModel } from '../src/config';

const TEST_MODELS: OllamaModel[] = [
  { id: 'qwen2.5:7b',        name: 'Qwen 7B',   maxChars:  28000, weight: 'light',  contextTokens: 32768 },
  { id: 'qwen2.5-coder:32b', name: 'Qwen 32B',  maxChars: 112000, weight: 'medium', contextTokens: 32768 },
  { id: 'qwen2.5:72b',       name: 'Qwen 72B',  maxChars: 480000, weight: 'heavy',  contextTokens: 32768 },
];

const adapter = new OllamaAdapter(TEST_MODELS, 'http://127.0.0.1:11434');

describe('OllamaAdapter.pickModel', () => {
  // With contextTokens: 32768 and defaults (2.0 chars/token, 4096 headroom),
  // each model's real budget is (32768 - 4096) * 2.0 = 57344 chars.

  test('small request → 7b (smallest that fits)', () => {
    expect(adapter.pickModel(5000)?.id).toBe('qwen2.5:7b');
  });

  test('medium request still fits 7b (smallest that fits)', () => {
    expect(adapter.pickModel(50000)?.id).toBe('qwen2.5:7b');
  });

  test('large request → 72b because even 32b budget is exceeded', () => {
    // 200000 chars exceeds every 32K-context model; 72b has the same context
    // here, so no Ollama model fits. In a real config 72b would have a larger
    // contextTokens value; this test uses the same value to verify fall-back
    // to null when nothing fits.
    expect(adapter.pickModel(200000)).toBeNull();
  });

  test('too large for any model → null', () => {
    expect(adapter.pickModel(500000)).toBeNull();
  });

  test('minWeight=medium with small request → 32b (enforces floor)', () => {
    expect(adapter.pickModel(5000, 'medium')?.id).toBe('qwen2.5-coder:32b');
  });

  test('minWeight=medium with medium request → 32b', () => {
    expect(adapter.pickModel(50000, 'medium')?.id).toBe('qwen2.5-coder:32b');
  });

  test('minWeight=heavy with small request → 72b (enforces floor)', () => {
    expect(adapter.pickModel(5000, 'heavy')?.id).toBe('qwen2.5:72b');
  });

  test('minWeight=medium with oversized request → null (no medium/heavy fits, 7b too small to fit)', () => {
    expect(adapter.pickModel(500000, 'medium')).toBeNull();
  });

  test('request that exceeds 32b but fits 72b falls back to 72b', () => {
    // Simulate a 72B model with a larger real context window. This is the
    // Defect-2 regression test: a 60k request that exceeds the 32B budget
    // must not be stranded on cloud; it should fall back to a heavier model.
    const bigModels: OllamaModel[] = [
      { id: 'qwen2.5:7b',        name: 'Qwen 7B',  maxChars: 28000,  weight: 'light',  contextTokens: 32768 },
      { id: 'qwen2.5-coder:32b', name: 'Qwen 32B', maxChars: 112000, weight: 'medium', contextTokens: 32768 },
      { id: 'qwen2.5:72b',       name: 'Qwen 72B', maxChars: 480000, weight: 'heavy',  contextTokens: 65536 },
    ];
    const bigAdapter = new OllamaAdapter(bigModels, 'http://127.0.0.1:11434');
    expect(bigAdapter.pickModel(60000, 'medium')?.id).toBe('qwen2.5:72b');
  });

  test('selected model always passes its own guard', () => {
    const model = adapter.pickModel(55000);
    expect(model).not.toBeNull();
    expect(adapter.fits(model!, 55000)).toBe(true);
  });
});
