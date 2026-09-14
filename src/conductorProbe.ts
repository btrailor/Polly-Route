import fs from 'fs';
import path from 'path';
import { Message, ConductorSignal, ConductorAction } from './types.js';
import { Config } from './config.js';

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

interface DomainManifest {
  domain: string;
  description: string;
  system_prompt?: string;
  actions: Array<{
    id: string;
    description: string;
    execute: string;
    /** Trigger phrases that boost this action's match score. */
    triggers?: string[];
    params?: Record<string, { type: string; required?: boolean; description?: string; default?: unknown }>;
    gates?: string[];
  }>;
}

function loadManifest(dirPath: string): DomainManifest | null {
  const manifestPath = path.join(dirPath, 'manifest.json');
  try {
    if (!fs.existsSync(manifestPath)) return null;
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(raw) as DomainManifest;
  } catch {
    return null;
  }
}

/**
 * Score a user query against a domain manifest.
 *
 * Matching strategy:
 * 1. Keyword overlap between query and domain description / action descriptions.
 * 2. Action id and param description keyword matches.
 * 3. Boost when action-specific verbs appear (generate, validate, search, list, revise).
 *
 * Returns a score in [0, 1] and the best-matching action id.
 */
function scoreDomain(
  query: string,
  manifest: DomainManifest,
): { score: number; matchedActionId: string | null } {
  const q = query.toLowerCase();
  // Filter out common stop words that cause false keyword matches
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'was',
    'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
    'our', 'out', 'his', 'how', 'its', 'let', 'may', 'own', 'too',
    'use', 'via', 'way', 'who', 'why', 'yes', 'also', 'into', 'like',
    'just', 'both', 'such', 'than', 'them', 'then', 'when', 'will',
    'want', 'about', 'after', 'again', 'below', 'being', 'could',
    'every', 'here', 'there', 'where', 'which', 'while', 'would',
  ]);
  const queryWords = new Set(
    q.split(/\W+/).filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
  if (queryWords.size === 0) return { score: 0, matchedActionId: null };

  // Build a keyword set from the domain description
  const domainWords = new Set(
    manifest.description.toLowerCase().split(/\W+/).filter(w => w.length > 2)
  );

  // Domain-level overlap
  let domainOverlap = 0;
  for (const w of queryWords) {
    if (domainWords.has(w)) domainOverlap += 1;
  }

  // Action-level scoring
  let bestActionScore = 0;
  let bestActionId: string | null = null;

  for (const action of manifest.actions) {
    const actionText = `${action.id} ${action.description}`.toLowerCase();
    const actionWords = new Set(actionText.split(/\W+/).filter(w => w.length > 2));

    let actionScore = 0;
    for (const w of queryWords) {
      if (actionWords.has(w)) actionScore += 1;
    }

    // Check param descriptions for keyword matches too
    if (action.params) {
      for (const [, pspec] of Object.entries(action.params)) {
        if (pspec.description) {
          const paramWords = new Set(
            pspec.description.toLowerCase().split(/\W+/).filter(w => w.length > 2)
          );
          for (const w of queryWords) {
            if (paramWords.has(w)) actionScore += 0.5;
          }
        }
      }
    }

    // Boost for action-specific trigger phrases from the manifest.
    // Triggers are declared per-action in the manifest's `triggers` field.
    // This is domain-agnostic — any domain can declare its own triggers
    // without changes to the probe code.
    const triggers = action.triggers ?? [];
    let hasTriggerMatch = false;
    for (const trigger of triggers) {
      if (q.includes(trigger)) {
        actionScore += 2;
        hasTriggerMatch = true;
      }
    }

    // Negative signal: if the action has triggers but none matched,
    // dampen the score. This prevents keyword overlap from falsely
    // matching an action when the user's intent points elsewhere.
    // Only applies when the action has 2+ triggers (enough signal to
    // distinguish intent). Actions with 0-1 triggers are left alone.
    if (triggers.length >= 2 && !hasTriggerMatch) {
      actionScore *= 0.5;
    }

    // Normalize by query length to keep scores in range
    const normalized = actionScore / Math.max(queryWords.size, 1);

    if (normalized > bestActionScore) {
      bestActionScore = normalized;
      bestActionId = action.id;
    }
  }

  // Combine domain and action scores
  const domainNormalized = domainOverlap / Math.max(queryWords.size, 1);
  const combined = Math.min(1, domainNormalized * 0.4 + bestActionScore * 0.6);

  return { score: combined, matchedActionId: bestActionId };
}

/**
 * Build a context block from a matched domain manifest.
 *
 * This is injected into the request as a system message so the model
 * knows the exact action menu, command templates, and constraints.
 */
function buildContextBlock(
  manifest: DomainManifest,
  matchedActionId: string | null,
  domainsDir: string,
): string {
  const actionLines = manifest.actions.map(a => {
    const params = a.params
      ? Object.entries(a.params)
          .map(([k, v]) => `${k}: ${v.type}${v.required ? ' (required)' : ''}`)
          .join(', ')
      : 'none';
    const gates = a.gates?.length ? a.gates.join(', ') : 'none';
    return `- ${a.id}: ${a.description}\n  params: ${params}\n  execute: ${a.execute}\n  gates: ${gates}`;
  });

  const matchedHint = matchedActionId
    ? `\n\n**Suggested action**: "${matchedActionId}" — use the execute command template above.`
    : '';

  // Build gate verification instructions for the matched action.
  // This tells the agent how to verify the action's output using the
  // deterministic gate scripts from the domain's gates/ directory.
  const gateInstructions = buildGateInstructions(manifest, matchedActionId, domainsDir);

  return [
    `Conductor domain: ${manifest.domain}`,
    ``,
    manifest.description,
    ``,
    `Available actions (use these exact commands):`,
    actionLines.join('\n\n'),
    matchedHint,
    ``,
    manifest.system_prompt ?? '',
    gateInstructions,
  ].filter(Boolean).join('\n');
}

/**
 * Build gate verification instructions for the agent.
 *
 * When a conductor domain matches, the agent should verify the action's
 * output by running the domain's gate scripts after executing the command.
 * This tells the agent which gates to run, where to find them, and how to
 * pass context (params, stdout, exit code) to each gate.
 */
function buildGateInstructions(
  manifest: DomainManifest,
  matchedActionId: string | null,
  domainsDir: string,
): string {
  if (!matchedActionId) return '';
  const action = manifest.actions.find(a => a.id === matchedActionId);
  if (!action || !action.gates || action.gates.length === 0) return '';

  const domainDir = path.join(domainsDir, manifest.domain);
  const gatesDir = path.join(domainDir, 'gates');

  // Check which gates have scripts
  const BUILTIN_GATES = new Set(['exit_zero', 'valid_json_output']);
  const gateEntries = action.gates.map(g => {
    if (BUILTIN_GATES.has(g)) {
      return { name: g, type: 'builtin' as const, desc: builtinGateDesc(g) };
    }
    // Look for .sh or .py gate script
    const shPath = path.join(gatesDir, `${g}.sh`);
    const pyPath = path.join(gatesDir, `${g}.py`);
    if (fs.existsSync(shPath)) {
      return { name: g, type: 'script' as const, path: shPath, interpreter: 'bash' };
    }
    if (fs.existsSync(pyPath)) {
      return { name: g, type: 'script' as const, path: pyPath, interpreter: 'python3' };
    }
    return { name: g, type: 'unknown' as const, desc: 'no script found' };
  });

  const hasScripts = gateEntries.some(g => g.type === 'script');
  if (!hasScripts && gateEntries.every(g => g.type === 'builtin')) {
    // All builtin gates — just list what to check
    const checks = gateEntries.map(g => `- ${g.desc}`).join('\n');
    return `\n## Verification\n\nAfter executing "${matchedActionId}", verify the output:\n${checks}`;
  }

  // Build gate runner instructions
  const paramNames = action.params
    ? Object.keys(action.params).map(k => `{{${k}}}`)
    : [];
  const paramEnvVars = paramNames.length > 0
    ? paramNames.map(p => `GATE_PARAM_${p.replace(/\{\{|\}\}/g, '').toUpperCase()}="<value>"`)
    : [];

  const gateRunCommands = gateEntries
    .filter(g => g.type === 'script')
    .map(g => {
      if (g.type === 'script') {
        const cmd = g.interpreter === 'bash'
          ? `bash ${g.path}`
          : `python3 ${g.path}`;
        return `  ${g.name}: ${cmd}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');

  const builtinChecks = gateEntries
    .filter(g => g.type === 'builtin')
    .map(g => `  ${g.name}: ${g.desc}`)
    .join('\n');

  const sections = [
    `\n## Verification`,
    ``,
    `After executing "${matchedActionId}", verify the output by running these gates:`,
  ];

  if (gateRunCommands) {
    sections.push('', 'Gate scripts (run each, exit 0 = pass, exit 1 = fail):');
    sections.push(gateRunCommands);
    sections.push('');
    sections.push('Pass context to gates via environment variables:');
    sections.push('- CONDUCTOR_WORKSPACE: the working directory');
    sections.push('- GATE_PARAM_<KEY>: each param value (e.g. GATE_PARAM_PROJECT=quarry)');
    sections.push('- GATE_ACTION_ID: the action that was executed');
    sections.push('- GATE_EXIT_CODE: the exit code from the action');
    sections.push('');
    sections.push('Or write a context JSON file and set CONDUCTOR_GATE_CONTEXT_FILE to its path.');
  }

  if (builtinChecks) {
    sections.push('', 'Built-in checks:');
    sections.push(builtinChecks);
  }

  return sections.join('\n');
}

function builtinGateDesc(name: string): string {
  switch (name) {
    case 'exit_zero':
      return 'Verify the command exited with code 0.';
    case 'valid_json_output':
      return 'Verify the command stdout is valid JSON.';
    default:
      return name;
  }
}

/**
 * Probe conductor domain manifests to see if the request matches a domain.
 *
 * Parallel to probeVault() and probeSkillCoverage(). Scans the configured
 * domains directory, loads each manifest.json, and scores the user's query
 * against the domain description and action descriptions.
 *
 * Returns a ConductorSignal with the best match, or matched=false.
 */
export async function probeConductor(
  messages: Message[],
  config: Config,
): Promise<ConductorSignal> {
  const cfg = config.conductor;
  if (!cfg) return { matched: false };

  const query = getLastUserText(messages).slice(0, 500).trim();
  if (!query) return { matched: false };

  const domainsDir = cfg.domainsDir;
  if (!fs.existsSync(domainsDir)) {
    log('conductor probe: domains dir not found', { dir: domainsDir });
    return { matched: false };
  }

  // Scan domain directories
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(domainsDir).filter(name => {
      const fullPath = path.join(domainsDir, name);
      return fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'manifest.json'));
    });
  } catch {
    log('conductor probe: cannot read domains dir', { dir: domainsDir });
    return { matched: false };
  }

  if (entries.length === 0) {
    log('conductor probe: no domain packs found', { dir: domainsDir });
    return { matched: false };
  }

  // Score each domain
  let bestDomain: { id: string; manifest: DomainManifest; score: number; matchedActionId: string | null } | null = null;

  for (const domainId of entries) {
    const manifest = loadManifest(path.join(domainsDir, domainId));
    if (!manifest) continue;

    const { score, matchedActionId } = scoreDomain(query, manifest);

    if (score > 0 && (!bestDomain || score > bestDomain.score)) {
      bestDomain = { id: domainId, manifest, score, matchedActionId };
    }
  }

  if (!bestDomain || bestDomain.score < cfg.minScore) {
    log('conductor probe: no domain above threshold', {
      checked: entries.length,
      bestScore: bestDomain?.score ?? 0,
      threshold: cfg.minScore,
    });
    return { matched: false };
  }

  // Domain relevance gate: require at least one query word to overlap with
  // the domain description. This prevents false matches where a generic verb
  // (e.g. "write") boosts an action score but the query has nothing to do
  // with the domain (e.g. "write a blog post about AI" vs the Loom domain).
  const domainDescWords = new Set(
    bestDomain.manifest.description.toLowerCase().split(/\W+/).filter(w => w.length > 2)
  );
  // Also include action descriptions and ids as domain-relevant words
  for (const action of bestDomain.manifest.actions) {
    const actionDescWords = `${action.id} ${action.description}`.toLowerCase().split(/\W+/);
    for (const w of actionDescWords) if (w.length > 2) domainDescWords.add(w);
  }
  const queryLower = query.toLowerCase();
  const queryWordsForGate = new Set(
    queryLower.split(/\W+/).filter((w: string) => w.length > 2)
  );
  let hasDomainOverlap = false;
  for (const w of queryWordsForGate) {
    if (domainDescWords.has(w as string)) { hasDomainOverlap = true; break; }
  }
  if (!hasDomainOverlap) {
    log('conductor probe: domain matched but no keyword overlap with domain description', {
      domain: bestDomain.id,
      score: bestDomain.score.toFixed(3),
    });
    return { matched: false };
  }

  // Build the context block and signal
  const contextBlock = buildContextBlock(bestDomain.manifest, bestDomain.matchedActionId, domainsDir);

  const actions: ConductorAction[] = bestDomain.manifest.actions.map(a => ({
    id: a.id,
    description: a.description,
    execute: a.execute,
    params: a.params ?? {},
    gates: a.gates ?? [],
  }));

  log('conductor probe: domain matched', {
    domain: bestDomain.id,
    score: bestDomain.score.toFixed(3),
    action: bestDomain.matchedActionId,
    contextChars: contextBlock.length,
  });

  return {
    matched: true,
    domainId: bestDomain.id,
    domainDescription: bestDomain.manifest.description,
    systemPrompt: bestDomain.manifest.system_prompt,
    actions,
    matchedActionId: bestDomain.matchedActionId ?? undefined,
    score: bestDomain.score,
    contextBlock,
  };
}