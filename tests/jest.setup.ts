/**
 * Jest setup — isolate the router's file-writing side effects.
 *
 * Without this, the test suite writes to the REAL production data files:
 *   - src/reliability.ts  -> ~/.openclaw/workspace/system/persona-reliability.jsonl
 *   - src/metrics.ts      -> ~/.openclaw/workspace/system/polly-metrics.jsonl
 *   - src/vaultWriter.ts  -> ~/.openclaw/workspace/vault/
 *
 * That pollutes the reliability feedback loop and the knowledge vault with
 * synthetic test data, and makes the router's routing decisions depend on
 * whether a test suite happened to run.
 *
 * Each test file gets its own temp directory, removed on exit.
 */

import { afterAll } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'polly-router-test-'));

process.env.POLLY_RELIABILITY_PATH = join(tmpRoot, 'persona-reliability.jsonl');
process.env.POLLY_METRICS_PATH = join(tmpRoot, 'polly-metrics.jsonl');
process.env.POLLY_VAULT_ROOT = join(tmpRoot, 'vault');

// Point the modes loader at the tracked fixture instead of a developer's live
// ~/.openclaw/modes.json. Without this the modes test suite depends on a file
// that does not exist in CI or on a fresh checkout, and the tests fail with
// "Cannot read properties of undefined" rather than testing anything.
process.env.OPENCLAW_MODES_PATH = resolve(__dirname, 'fixtures/modes.json');

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Best effort — a leftover temp dir is harmless.
  }
});
