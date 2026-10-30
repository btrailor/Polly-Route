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
import { join } from 'path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'polly-router-test-'));

process.env.POLLY_RELIABILITY_PATH = join(tmpRoot, 'persona-reliability.jsonl');
process.env.POLLY_METRICS_PATH = join(tmpRoot, 'polly-metrics.jsonl');
process.env.POLLY_VAULT_ROOT = join(tmpRoot, 'vault');

// The modes loader resolves the repo's tracked modes.json (and falls back to
// ~/.openclaw/modes.json). No override is needed here: pointing tests at a
// separate fixture would create a second copy of the mode definitions that
// can drift from the canonical file. Leaving it unset also exercises the real
// resolution path, so a broken lookup fails the suite instead of passing
// against a fixture.
delete process.env.OPENCLAW_MODES_PATH;

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Best effort — a leftover temp dir is harmless.
  }
});
