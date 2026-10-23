/**
 * Tests for the vault-probe fallback chain.
 *
 * Background: the Knowledge Skill (:4201) probe falls back to a QMD daemon
 * (:8181). No QMD daemon is deployed, so that fallback failed on every
 * attempt and converted a degraded probe into a terminal one. The router
 * gained a `qmd.enabled` flag so the dead stage can be skipped.
 */

import { describe, test, expect } from '@jest/globals';
import { probeVault } from '../src/vault';
import { Config } from '../src/config';
import { Message } from '../src/types';

const messages: Message[] = [{ role: 'user', content: 'Quarry story world bible' }];

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    ollama: { baseUrl: 'http://127.0.0.1:11434', models: [] },
    providers: {},
    qmd: {
      baseUrl: 'http://localhost:8181',
      collection: 'vault',
      timeoutMs: 500,
      minScore: 0.89,
    },
    conductor: { domainsDir: '/nonexistent', timeoutMs: 2000, minScore: 0.35 },
    ...overrides,
  } as Config;
}

describe('probeVault fallback chain', () => {
  // The Knowledge Skill is not running in the test environment, so the
  // knowledge-skill probe always fails and the fallback path is exercised.
  const noKnowledgeSkill = baseConfig({ knowledgeSkill: undefined });

  test('qmd disabled -> ABSENT without attempting the QMD probe', async () => {
    const config = baseConfig({
      knowledgeSkill: undefined,
      qmd: {
        baseUrl: 'http://localhost:8181',
        collection: 'vault',
        timeoutMs: 500,
        minScore: 0.89,
        enabled: false,
      },
    });

    const signal = await probeVault(messages, config);

    expect(signal.confidence).toBe('ABSENT');
    expect(signal.score).toBe(0);
    expect(signal.chunks).toEqual([]);
  });

  test('qmd with empty baseUrl -> ABSENT without throwing', async () => {
    // `new URL('/query', '')` throws. An empty baseUrl must not reach that
    // call, or every request that loses its Knowledge Skill probe would
    // fail outright.
    const config = baseConfig({
      knowledgeSkill: undefined,
      qmd: {
        baseUrl: '',
        collection: 'vault',
        timeoutMs: 500,
        minScore: 0.89,
        enabled: false,
      },
    });

    const signal = await probeVault(messages, config);
    expect(signal.confidence).toBe('ABSENT');
  });

  test('qmd enabled by default (backward compatible)', () => {
    // A config with no `enabled` key must keep the previous behaviour.
    const config = baseConfig();
    expect(config.qmd.enabled).toBeUndefined();
  });

  test('empty user text -> ABSENT without probing anything', async () => {
    const signal = await probeVault([{ role: 'user', content: '' }], noKnowledgeSkill);
    expect(signal.confidence).toBe('ABSENT');
  });
});
