import { describe, test, expect } from '@jest/globals';
import { OllamaAdapter } from '../src/providers/ollama';
import { OllamaModel } from '../src/config';

const TEST_MODELS: OllamaModel[] = [
  { id: 'qwen2.5:7b',        name: 'Qwen 7B',   maxChars:  28000, weight: 'light'  },
  { id: 'qwen2.5-coder:32b', name: 'Qwen 32B',  maxChars: 112000, weight: 'medium' },
  { id: 'qwen2.5:72b',       name: 'Qwen 72B',  maxChars: 480000, weight: 'heavy'  },
];

const adapter = new OllamaAdapter(TEST_MODELS, 'http://127.0.0.1:11434');

describe('OllamaAdapter.pickModel', () => {
  test('small request → 7b (smallest that fits)', () => {
    expect(adapter.pickModel(5000)?.id).toBe('qwen2.5:7b');
  });

  test('medium request → 32b', () => {
    expect(adapter.pickModel(50000)?.id).toBe('qwen2.5-coder:32b');
  });

  test('large request → 72b', () => {
    expect(adapter.pickModel(200000)?.id).toBe('qwen2.5:72b');
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

  test('minWeight=medium with oversized request → null', () => {
    expect(adapter.pickModel(500000, 'medium')).toBeNull();
  });

  test('applies 1.2x headroom — request at exact 7b limit needs overflow to 32b', () => {
    // 28000 chars * 1.2 = 33600 needed, which exceeds 7b's 28000
    expect(adapter.pickModel(24000)?.id).toBe('qwen2.5-coder:32b');
    // 23000 * 1.2 = 27600, fits in 7b (28000)
    expect(adapter.pickModel(23000)?.id).toBe('qwen2.5:7b');
  });
});
