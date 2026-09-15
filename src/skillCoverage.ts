import fs from 'fs';
import path from 'path';
import { Message, SkillSignal } from './types.js';
import { Config } from './config.js';

interface SkillIndexEntry {
  name: string;
  purpose: string;
  triggers: string[];
}

interface PackMatch {
  packId: string;
  entryId: string;
  entryName: string;
  text: string;
  score: number;
}

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

function getLastUserText(messages: Message[]): string {
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last) return '';
  const text = typeof last.content === 'string'
    ? last.content
    : Array.isArray(last.content) ? last.content.map((c: any) => c.text ?? '').join(' ') : '';
  return text;
}

/**
 * Parse the available-skills table format:
 * | `skill-name` | One-line purpose | trigger, keywords |
 */
function parseSkillTable(indexText: string): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = [];
  const lines = indexText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .split('|')
      .map(c => c.trim())
      .filter(c => c && c !== 'Skill' && c !== 'One-line purpose' && c !== 'Trigger keywords');
    if (cells.length < 3) continue;
    const [nameCell, purpose, triggerCell] = cells;
    const nameMatch = nameCell.match(/`([^`]+)`/);
    const name = nameMatch?.[1]?.trim();
    if (!name) continue;
    const triggers = triggerCell
      .split(/[,;]/)
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);
    entries.push({ name, purpose, triggers });
  }
  return entries;
}

/**
 * Parse the ranked-list fallback format:
 * 1. **skill-name.md** — description
 */
function parseSkillList(indexText: string): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = [];
  const re = /^\s*\d+\.\s*\*\*([^*]+\.md)\*\*\s*[—–-]\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexText)) !== null) {
    const fileName = m[1].trim();
    const name = fileName.replace(/\.md$/, '');
    const purpose = m[2].trim();
    entries.push({ name, purpose, triggers: [name.toLowerCase()] });
  }
  return entries;
}

function parseIndex(indexText: string): SkillIndexEntry[] {
  const table = parseSkillTable(indexText);
  if (table.length > 0) return table;
  return parseSkillList(indexText);
}

function scoreQueryAgainstSkill(query: string, entry: SkillIndexEntry): number {
  const q = query.toLowerCase();
  const words = new Set(q.split(/\W+/).filter(Boolean));
  let score = 0;
  for (const trigger of entry.triggers) {
    if (q.includes(trigger)) {
      score += trigger.split(/\s+/).length * 2;
    }
    for (const word of words) {
      if (trigger.includes(word)) score += 1;
    }
  }
  // Boost when the skill name itself appears in the query.
  if (q.includes(entry.name.toLowerCase())) score += 5;
  return score;
}

function resolveSkillPath(skillName: string, indexPath: string): string | null {
  const dir = path.dirname(indexPath);
  const candidates = [
    path.join(dir, skillName, 'SKILL.md'),
    path.join(dir, `${skillName}.md`),
    path.join(dir, '..', skillName, 'SKILL.md'),
    path.join(dir, '..', `${skillName}.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function readFileWithTimeout(filePath: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('skill coverage probe timeout', { filePath });
      resolve(null);
    }, timeoutMs);

    fs.readFile(filePath, 'utf-8', (err, data) => {
      clearTimeout(timer);
      if (err) {
        log('skill coverage probe file error', { filePath, error: err.message });
        resolve(null);
        return;
      }
      resolve(data);
    });
  });
}

async function probeSyntaxisPacks(query: string, config: Config): Promise<PackMatch | null> {
  const cfg = config.knowledgeSkill;
  if (!cfg?.baseUrl) return null;

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/search`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, collection: 'syntaxis_packs', top_k: 5 }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      log('syntaxis pack probe HTTP error', { status: response.status, url });
      return null;
    }

    const data = await response.json() as { results?: Array<Record<string, any>> };
    const results = data.results ?? [];
    if (results.length === 0) return null;

    const top = results[0];
    const score = Number(top.score ?? 0);
    if (score < 0.80) return null;

    const relPath = String(top.rel_path ?? top.path ?? '');
    const parts = relPath.replace(/\.md$/, '').split(/[\/\\]+/).filter(Boolean);
    const packId = top.domain ?? parts[0] ?? '';
    const entryId = parts[1] ?? top.section ?? '';
    const entryName = top.title ?? entryId;

    if (!packId || !entryId) return null;

    return {
      packId: String(packId),
      entryId: String(entryId),
      entryName: String(entryName),
      text: String(top.text ?? ''),
      score,
    };
  } catch (err) {
    clearTimeout(timer);
    log('syntaxis pack probe failed', { error: (err as Error).message, url });
    return null;
  }
}

function buildPackProcedure(match: PackMatch): string {
  return [
    `Pack: ${match.packId}`,
    `Entry: ${match.entryId} (${match.entryName})`,
    `Semantic score: ${match.score.toFixed(4)}`,
    '',
    match.text,
  ].join('\n');
}

/**
 * Probe the skill index to see if a loaded skill covers the request domain.
 *
 * Returns a SkillSignal with the best-matching skill's procedure text when
 * the query matches a skill's triggers; otherwise hasSkill=false.
 */
export async function probeSkillCoverage(
  messages: Message[],
  config: Config,
): Promise<SkillSignal> {
  const query = getLastUserText(messages).slice(0, 300).trim();
  if (!query) return { hasSkill: false };

  // 1. Try semantic pack matching first.
  const packMatch = await probeSyntaxisPacks(query, config);
  if (packMatch) {
    log('syntaxis pack probe result', {
      pack: packMatch.packId,
      entry: packMatch.entryId,
      score: packMatch.score,
    });
    return {
      hasSkill: true,
      skillName: `${packMatch.packId}/${packMatch.entryId}`,
      procedure: buildPackProcedure(packMatch),
      score: Math.round(packMatch.score * 100),
    };
  }

  // 2. Fall back to the static skill index.
  const cfg = config.skillCoverage;
  if (!cfg) return { hasSkill: false };

  const indexText = await readFileWithTimeout(cfg.indexPath, cfg.timeoutMs);
  if (indexText === null) return { hasSkill: false };

  const entries = parseIndex(indexText);
  if (entries.length === 0) return { hasSkill: false };

  let best: SkillIndexEntry | null = null;
  let bestScore = 0;
  for (const entry of entries) {
    const score = scoreQueryAgainstSkill(query, entry);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  // Threshold tuned so trivial overlaps (single shared word) do not trigger a skill.
  if (!best || bestScore < 3) return { hasSkill: false };

  const skillPath = resolveSkillPath(best.name, cfg.indexPath);
  if (!skillPath) {
    log('skill coverage probe: matched skill but procedure not found', { skill: best.name });
    return { hasSkill: true, skillName: best.name, score: bestScore };
  }

  const procedure = await readFileWithTimeout(skillPath, cfg.timeoutMs);
  if (procedure === null) {
    return { hasSkill: true, skillName: best.name, score: bestScore };
  }

  log('skill coverage probe result', { skill: best.name, score: bestScore, procedureChars: procedure.length });
  return {
    hasSkill: true,
    skillName: best.name,
    procedure,
    score: bestScore,
  };
}
