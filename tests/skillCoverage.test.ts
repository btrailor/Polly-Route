import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { probeSkillCoverage } from '../src/skillCoverage';
import { Config } from '../src/config';

function makeConfig(indexPath: string): Config {
  return {
    port: 4200,
    ollama: { baseUrl: 'http://127.0.0.1:11434', models: [] },
    providers: {},
    qmd: { baseUrl: 'http://localhost:8181', collection: 'vault', timeoutMs: 500, minScore: 0.89 },
    skillCoverage: { indexPath, timeoutMs: 1000 },
  };
}

describe('probeSkillCoverage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-skill-coverage-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns hasSkill=false when skillCoverage config is missing', async () => {
    const cfg = makeConfig('');
    delete cfg.skillCoverage;
    const result = await probeSkillCoverage([{ role: 'user', content: 'scope a sprint' }], cfg);
    expect(result.hasSkill).toBe(false);
  });

  test('returns hasSkill=false when index file is missing', async () => {
    const cfg = makeConfig(path.join(tmpDir, 'missing.md'));
    const result = await probeSkillCoverage([{ role: 'user', content: 'scope a sprint' }], cfg);
    expect(result.hasSkill).toBe(false);
  });

  test('matches a skill by trigger keyword and loads its procedure', async () => {
    const index = [
      '# Available Skills Index',
      '',
      '| Skill | One-line purpose | Trigger keywords |',
      '|-------|------------------|------------------|',
      '| `scope-a-sprint` | Sprint brief template | scope, sprint, brief |',
      '| `debug-from-logs` | Diagnose from logs | debug, logs, error |',
    ].join('\n');

    const indexPath = path.join(tmpDir, 'skills', 'available-skills', 'SKILL.md');
    const skillDir = path.join(tmpDir, 'skills', 'scope-a-sprint');
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(indexPath, index, 'utf-8');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '## Scope-a-sprint\nUse the seven-section brief.', 'utf-8');

    const cfg = makeConfig(indexPath);
    const result = await probeSkillCoverage([{ role: 'user', content: 'Can you help me scope this sprint?' }], cfg);

    expect(result.hasSkill).toBe(true);
    expect(result.skillName).toBe('scope-a-sprint');
    expect(result.procedure).toContain('seven-section brief');
    expect(result.score).toBeGreaterThan(0);
  });

  test('returns hasSkill=false when query does not match any trigger', async () => {
    const index = [
      '| Skill | One-line purpose | Trigger keywords |',
      '|-------|------------------|------------------|',
      '| `debug-from-logs` | Diagnose from logs | debug, logs, error |',
    ].join('\n');

    const indexPath = path.join(tmpDir, 'skills', 'available-skills', 'SKILL.md');
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, index, 'utf-8');

    const cfg = makeConfig(indexPath);
    const result = await probeSkillCoverage([{ role: 'user', content: 'What is the weather today?' }], cfg);

    expect(result.hasSkill).toBe(false);
  });

  test('returns hasSkill=true without procedure when skill file is missing', async () => {
    const index = [
      '| Skill | One-line purpose | Trigger keywords |',
      '|-------|------------------|------------------|',
      '| `missing-skill` | Unknown | missing, skill |',
    ].join('\n');

    const indexPath = path.join(tmpDir, 'skills', 'available-skills', 'SKILL.md');
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, index, 'utf-8');

    const cfg = makeConfig(indexPath);
    const result = await probeSkillCoverage([{ role: 'user', content: 'missing skill' }], cfg);

    expect(result.hasSkill).toBe(true);
    expect(result.skillName).toBe('missing-skill');
    expect(result.procedure).toBeUndefined();
  });

  test('falls back to ranked-list index format', async () => {
    const index = [
      '# Skills Index',
      '1. **scope-a-sprint.md** — Seven-section brief template.',
    ].join('\n');

    const indexPath = path.join(tmpDir, 'skills', 'polly-skills-index', 'SKILL.md');
    const skillDir = path.join(tmpDir, 'skills', 'scope-a-sprint');
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(indexPath, index, 'utf-8');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '## Scope-a-sprint', 'utf-8');

    const cfg = makeConfig(indexPath);
    const result = await probeSkillCoverage([{ role: 'user', content: 'scope a sprint' }], cfg);

    expect(result.hasSkill).toBe(true);
    expect(result.skillName).toBe('scope-a-sprint');
  });
});
