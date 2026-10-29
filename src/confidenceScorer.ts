/**
 * Structural confidence scoring for model output.
 *
 * Inspects model output for structural signals that indicate whether
 * the response is likely correct:
 *
 * 1. Import validity — does the code reference real imports?
 * 2. Type consistency — do type annotations line up?
 * 3. API call validity — are API calls in the known set?
 * 4. Code structure — is the output well-formed (balanced braces, no truncation)?
 * 5. Hallucination markers — invented imports, phantom API calls, etc.
 * 6. Hook validation — runs pre-validation hook scripts against code blocks.
 *
 * The resulting ConfidenceSignal tells the router whether the local
 * model's output is trustworthy enough to return, or whether it should
 * be escalated to the next provider in the fallback chain.
 *
 * Design principles:
 * - Fast: all checks are regex/string-based, no parsing or compilation.
 * - Conservative: unknown symbols are not penalised, only clearly-wrong ones.
 * - Transparent: every check is named and weighted so the score is auditable.
 */

import { ConfidenceSignal, ConfidenceCheck, ConfidenceConfig } from './types.js';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, statSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_ESCALATION_THRESHOLD = 0.45;

const DEFAULT_KNOWN_IMPORTS: string[] = [
  // Node.js built-ins
  'fs', 'path', 'http', 'https', 'url', 'crypto', 'os', 'stream',
  'util', 'events', 'child_process', 'net', 'dns', 'zlib', 'querystring',
  'assert', 'buffer', 'process', 'readline', 'timers', 'tty', 'worker_threads',
  // Common npm packages
  'express', 'axios', 'lodash', 'chalk', 'dotenv', 'commander', 'inquirer',
  'zod', 'joi', 'winston', 'morgan', 'cors', 'helmet', 'body-parser',
  'jest', 'vitest', 'sinon', 'supertest',
  // TypeScript / OpenClaw
  'typescript', 'ts-node', 'openclaw',
];

const DEFAULT_KNOWN_API_CALLS: string[] = [
  // Standard OpenAI-compatible
  'createChatCompletion', 'createCompletion', 'listModels',
  'chat.completions.create', 'models.list',
  // Common Node patterns
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'console.log', 'console.error', 'console.warn', 'console.info',
  'JSON.parse', 'JSON.stringify',
  'Buffer.from', 'Buffer.concat', 'Buffer.alloc', 'Buffer.byteLength',
  'process.env', 'process.exit', 'process.cwd', 'process.uptime', 'process.on',
  'fs.readFile', 'fs.writeFile', 'fs.writeFileSync', 'fs.readFileSync',
  'fs.existsSync', 'fs.mkdirSync', 'fs.readdir', 'fs.appendFileSync',
  'path.join', 'path.resolve', 'path.dirname', 'path.basename', 'path.extname',
  'http.request', 'http.get', 'https.get', 'http.createServer',
  'exec', 'spawn', 'fork',
];

const DEFAULT_KNOWN_TYPES: string[] = [
  // Primitives
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'object', 'symbol', 'bigint',
  // TypeScript built-ins
  'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract',
  'Array', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error',
  'Function', 'Symbol', 'Number', 'String', 'Boolean', 'Object',
  // Node.js types
  'Buffer', 'Stream', 'Readable', 'Writable', 'EventEmitter',
  'IncomingMessage', 'ServerResponse', 'Server',
  'Request', 'Response', 'NextFunction',
  // Common patterns
  'Message', 'RequestBody', 'Config', 'ProviderConfig',
  'Tool', 'ToolCall', 'Complexity', 'RoutingTarget',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractCodeBlocks(text: string): string[] {
  // Extract fenced code blocks (```...```)
  const blocks: string[] = [];
  const fenceRegex = /```(?:\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  // If no code blocks found, treat entire text as code if it looks like code
  if (blocks.length === 0) {
    const codeish = /(?:^|\n)\s*(?:import |export |const |let |var |function |class |async |interface |type )/m.test(text);
    if (codeish) blocks.push(text);
  }
  return blocks;
}

function extractImports(code: string): string[] {
  const imports: string[] = [];
  // ES module imports: import X from 'Y', import { X } from 'Y',
  // import * as X from 'Y' (namespace), import type X from 'Y' (type-only)
  const esImportRegex = /import\s+(?:type\s+)?(?:\*\s+as\s+\w+|[\w{},\s]+)\s+from\s+['"]([^'"]+)['"]/g;
  // Side-effect imports: import 'Y' (no bindings)
  const sideEffectImportRegex = /import\s+['"]([^'"]+)['"]/g;
  // CommonJS requires: require('Y')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Dynamic imports: import('Y')
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = esImportRegex.exec(code)) !== null) imports.push(match[1]);
  while ((match = sideEffectImportRegex.exec(code)) !== null) {
    // Skip if already captured by esImportRegex (side-effect imports have no 'from')
    if (!imports.includes(match[1])) imports.push(match[1]);
  }
  while ((match = requireRegex.exec(code)) !== null) imports.push(match[1]);
  while ((match = dynamicImportRegex.exec(code)) !== null) imports.push(match[1]);
  return imports;
}

function extractTypeAnnotations(code: string): string[] {
  const types: string[] = [];
  // Type annotations: : TypeName or <TypeName> or as TypeName
  // Match `: TypeName` — both capitalized (CustomType) and primitive (string, number)
  const colonTypeRegex = /:\s*([A-Za-z][A-Za-z0-9_]*(?:<[^>]+>)?)/g;
  // Match `as TypeName`
  const asRegex = /\bas\s+([A-Z][A-Za-z0-9_]*)/g;
  // Match generic type parameters: <TypeName> — only capitalized
  const genericRegex = /<([A-Z][A-Za-z0-9_]*(?:<[^>]+>)?)>/g;

  let match: RegExpExecArray | null;
  while ((match = colonTypeRegex.exec(code)) !== null) types.push(match[1].split('<')[0]);
  while ((match = asRegex.exec(code)) !== null) types.push(match[1]);
  while ((match = genericRegex.exec(code)) !== null) types.push(match[1].split('<')[0]);
  return types;
}

function extractFunctionCalls(code: string): string[] {
  const calls: string[] = [];
  // Match function calls: word( or word.word(
  const callRegex = /\b([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(code)) !== null) {
    // Skip language keywords
    const keywordSet = new Set([
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return',
      'function', 'class', 'new', 'typeof', 'instanceof', 'void',
      'throw', 'try', 'catch', 'finally', 'import', 'export', 'default',
    ]);
    if (!keywordSet.has(match[1])) {
      calls.push(match[1]);
    }
  }
  return calls;
}

function isBalanced(code: string): boolean {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escaped = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (inString) {
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = true; stringChar = c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    if (c === '}' || c === ')' || c === ']') depth--;
    if (depth < 0) return false; // closing before opening
  }
  return depth === 0;
}

function looksTruncated(text: string): boolean {
  const trimmed = text.trim();
  // Truncated code often ends mid-statement
  if (trimmed.endsWith('...')) return true;
  if (trimmed.endsWith('/*')) return true;
  // Ends with a comment start or incomplete line
  if (/\b(?:TODO|FIXME|WIP)\s*$/i.test(trimmed)) return true;
  // Ends with an open string
  const lastChars = trimmed.slice(-5);
  if (lastChars.includes('`') && !lastChars.slice(0, -1).includes('`')) return true;
  return false;
}

// ─── Hook validation ───────────────────────────────────────────────────────

/** Map of fence language → file extension → hook script names to run. */
const LANG_HOOK_MAP: Record<string, { ext: string; hooks: string[] }> = {
  lua: { ext: 'lua', hooks: ['lua-syntax-check.sh'] },
  js: { ext: 'js', hooks: ['js-lint-check.sh', 'import-resolution-check.sh', 'statement-detection-check.sh'] },
  jsx: { ext: 'jsx', hooks: ['js-lint-check.sh', 'import-resolution-check.sh', 'statement-detection-check.sh'] },
  mjs: { ext: 'mjs', hooks: ['js-lint-check.sh', 'import-resolution-check.sh', 'statement-detection-check.sh'] },
  cjs: { ext: 'cjs', hooks: ['js-lint-check.sh', 'import-resolution-check.sh', 'statement-detection-check.sh'] },
  ts: { ext: 'ts', hooks: ['js-lint-check.sh', 'import-resolution-check.sh', 'statement-detection-check.sh', 'ts-type-check.sh'] },
  tsx: { ext: 'tsx', hooks: ['js-lint-check.sh', 'import-resolution-check.sh', 'statement-detection-check.sh', 'ts-type-check.sh'] },
};

/** Extract fenced code blocks with their language tag. */
function extractCodeBlocksWithLangs(text: string): { lang: string; code: string }[] {
  const blocks: { lang: string; code: string }[] = [];
  const fenceRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    blocks.push({ lang: (match[1] || '').toLowerCase(), code: match[2] });
  }
  // If no code blocks found, treat entire text as code if it looks like code
  if (blocks.length === 0) {
    const codeish = /(?:^|\n)\s*(?:import |export |const |let |var |function |class |async |interface |type )/m.test(text);
    if (codeish) blocks.push({ lang: '', code: text });
  }
  return blocks;
}

/** Run hook scripts against code blocks and return failures. */
function runHookValidation(
  output: string,
  hooksDir: string,
): { passed: boolean; detail: string } {
  const blocks = extractCodeBlocksWithLangs(output);
  const failures: string[] = [];
  const tmpDir = join(tmpdir(), 'syntaxis-hooks');

  try { mkdirSync(tmpDir, { recursive: true }); } catch { /* may already exist */ }

  for (const block of blocks) {
    const langDef = LANG_HOOK_MAP[block.lang];
    if (!langDef) continue; // no hooks for this language

    // Write code block to temp file
    const tmpFile = join(tmpDir, `syntaxis-score-${Date.now()}-${Math.random().toString(36).slice(2)}.${langDef.ext}`);
    try {
      writeFileSync(tmpFile, block.code, 'utf-8');
    } catch {
      continue; // can't write temp file, skip this block
    }

    // Run each hook
    for (const hookName of langDef.hooks) {
      const hookPath = join(hooksDir, hookName);
      try {
        execFileSync(hookPath, [tmpFile], {
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        });
        // exit code 0 = pass
      } catch (err: any) {
        // Non-zero exit or timeout = failure
        const stderr = err.stderr ? String(err.stderr).trim().slice(0, 200) : '';
        const reason = err.killed ? 'timeout' : `exit ${err.status ?? '?'}`;
        failures.push(`${hookName} (${block.lang}): ${reason}${stderr ? ' — ' + stderr : ''}`);
      }
    }

    // Clean up temp file
    try { unlinkSync(tmpFile); } catch { /* best effort */ }
  }

  if (failures.length === 0) {
    return { passed: true, detail: 'all hooks passed' };
  }
  return { passed: false, detail: `${failures.length} hook failure(s): ${failures.join('; ')}` };
}

// ─── Codemap Parsing ───────────────────────────────────────────────────────

/**
 * Parse codemap .md files from a directory and extract known symbols.
 *
 * Codemap files have these sections (among others):
 *   ## 3. Export Surfaces (function signatures)  → knownApiCalls
 *   ## 4. Dependency Graph (module-level #includes)  → knownImports
 *   ## 5. Type Index (typedefs from headers)  → knownTypes
 *
 * Returns merged lists of imports, types, and API calls extracted from
 * all .md files in the directory. Designed to be fast — regex-based, no
 * parsing of the actual code, just the codemap's structured markdown.
 */
function parseCodemapDir(dir: string): {
  imports: string[];
  types: string[];
  apiCalls: string[];
} {
  const imports: string[] = [];
  const types: string[] = [];
  const apiCalls: string[] = [];

  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    return { imports, types, apiCalls };
  }

  for (const entry of entries) {
    let content: string;
    try {
      content = readFileSync(join(dir, entry), 'utf-8');
    } catch {
      continue;
    }

    // ── Export Surfaces: [file] ret_type func_name(args) ──
    // Extract function names — the word(s) before the opening paren.
    const exportSection = extractSection(content, 'Export Surfaces');
    if (exportSection) {
      const funcRegex = /\]\s*[\w\s\*]+\b(\w+)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = funcRegex.exec(exportSection)) !== null) {
        if (m[1] && m[1].length > 1) apiCalls.push(m[1]);
      }
    }

    // ── Type Index: [file] N:typedef struct/enum/void(*name) ──
    // Extract type names — after typedef struct/enum, or the pointer alias.
    const typeSection = extractSection(content, 'Type Index');
    if (typeSection) {
      // typedef struct _Name { → Name
      const structRegex = /typedef\s+struct\s+_?(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = structRegex.exec(typeSection)) !== null) {
        if (m[1]) types.push(m[1]);
      }
      // typedef enum { → extract from following lines (best effort: the enum tag)
      const enumRegex = /typedef\s+enum\s+_?(\w+)/g;
      while ((m = enumRegex.exec(typeSection)) !== null) {
        if (m[1]) types.push(m[1]);
      }
      // typedef void(*name_t)(...) → name_t
      const typedefFuncRegex = /typedef\s+\w+\s*\(\s*\*\s*(\w+)\s*\)/g;
      while ((m = typedefFuncRegex.exec(typeSection)) !== null) {
        if (m[1]) types.push(m[1]);
      }
    }

    // ── Dependency Graph: module-level includes ──
    // Extract included header names.
    const depSection = extractSection(content, 'Dependency Graph');
    if (depSection) {
      const includeRegex = /#include\s+[<"]([^>"]+)[>"]/g;
      let m: RegExpExecArray | null;
      while ((m = includeRegex.exec(depSection)) !== null) {
        if (m[1]) {
          // Take the basename without extension as the module name
          const base = m[1].split('/').pop()?.replace(/\.[^.]+$/, '');
          if (base && base.length > 1) imports.push(base);
        }
      }
    }
  }

  return {
    imports: [...new Set(imports)],
    types: [...new Set(types)],
    apiCalls: [...new Set(apiCalls)],
  };
}

/** Extract a named section from codemap markdown. Returns the code block content. */
function extractSection(md: string, sectionName: string): string | null {
  const headerRegex = new RegExp(`## \\d+\\. ${sectionName}[^\\n]*\\n`);
  const headerMatch = headerRegex.exec(md);
  if (!headerMatch) return null;
  const start = headerMatch.index + headerMatch[0].length;
  // Section ends at the next ## header or end of file
  const nextHeader = md.indexOf('\n## ', start);
  const end = nextHeader === -1 ? md.length : nextHeader;
  const sectionText = md.slice(start, end);
  // Extract content from the first ``` code block in the section
  const blockMatch = /```[\s\S]*?\n([\s\S]*?)```/.exec(sectionText);
  return blockMatch ? blockMatch[1] : sectionText;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export function scoreOutput(
  output: string,
  config?: Partial<ConfidenceConfig>,
): ConfidenceSignal {
  const cfg: ConfidenceConfig = {
    enabled: config?.enabled ?? true,
    escalationThreshold: config?.escalationThreshold ?? DEFAULT_ESCALATION_THRESHOLD,
    knownImports: config?.knownImports ?? DEFAULT_KNOWN_IMPORTS,
    knownApiCalls: config?.knownApiCalls ?? DEFAULT_KNOWN_API_CALLS,
    knownTypes: config?.knownTypes ?? DEFAULT_KNOWN_TYPES,
    hookScriptsDir: config?.hookScriptsDir,
    codemapDir: config?.codemapDir,
  };

  // If scoring is disabled, return a high-confidence passthrough.
  if (!cfg.enabled) {
    return {
      score: 1.0,
      tier: 'high',
      checks: [],
      shouldEscalate: false,
    };
  }

  // ── Merge codemap-extracted symbols with config defaults ──────────────
  // If a codemap directory is configured, parse all .md files and merge
  // the extracted imports, types, and API calls into the known sets.
  // This gives the scorer project-specific symbol awareness without
  // requiring manual maintenance of the known* lists.
  if (cfg.codemapDir) {
    let dirExists = false;
    try {
      dirExists = statSync(cfg.codemapDir).isDirectory();
    } catch {
      dirExists = false;
    }
    if (dirExists) {
      const codemapSymbols = parseCodemapDir(cfg.codemapDir);
      if (codemapSymbols.imports.length > 0) {
        cfg.knownImports = [...new Set([...(cfg.knownImports ?? []), ...codemapSymbols.imports])];
      }
      if (codemapSymbols.types.length > 0) {
        cfg.knownTypes = [...new Set([...(cfg.knownTypes ?? []), ...codemapSymbols.types])];
      }
      if (codemapSymbols.apiCalls.length > 0) {
        cfg.knownApiCalls = [...new Set([...(cfg.knownApiCalls ?? []), ...codemapSymbols.apiCalls])];
      }
    }
  }

  const codeBlocks = extractCodeBlocks(output);
  const checks: ConfidenceCheck[] = [];

  // ── Check 1: Import validity (weight: 0.20) ──────────────────────────────
  // Does the code reference real imports? If it invents imports that
  // don't exist in the known set, that's a strong hallucination signal.
  {
    const allImports: string[] = [];
    for (const block of codeBlocks) allImports.push(...extractImports(block));
    const uniqueImports = [...new Set(allImports)];

    const knownSet = new Set(cfg.knownImports);
    // Also accept scoped packages (@scope/name) and relative paths
    const isKnownOrValid = (imp: string): boolean => {
      if (knownSet.has(imp)) return true;
      if (imp.startsWith('@')) return true; // scoped npm package
      if (imp.startsWith('.') || imp.startsWith('/')) return true; // relative or absolute path
      if (imp.startsWith('node:')) return true; // node: protocol
      // For unknown packages, we can't verify them, but we flag names that
      // look like built-in modules (lowercase, short, no special chars)
      // but aren't in the known set — these are likely hallucinations.
      // This is a soft check: only flag if the config provides a knownImports list.
      if (cfg.knownImports && cfg.knownImports.length > 0 && /^[a-z][a-z0-9_-]{1,10}$/.test(imp)) {
        return false; // looks built-in but not in known set
      }
      return true;
    };

    const validImports = uniqueImports.filter(isKnownOrValid);
    const invalidImports = uniqueImports.filter(imp => !isKnownOrValid(imp));

    const passed = invalidImports.length === 0;
    checks.push({
      name: 'import-validity',
      passed,
      weight: 0.15,
      detail: passed
        ? `${uniqueImports.length} import(s) checked`
        : `suspicious imports: ${invalidImports.join(', ')}`,
    });
  }

  // ── Check 2: Type consistency (weight: 0.15) ───────────────────────────────
  // Do type annotations reference known types? Invented types are a
  // sign that the model is guessing about the codebase.
  {
    const allTypes: string[] = [];
    for (const block of codeBlocks) allTypes.push(...extractTypeAnnotations(block));
    const uniqueTypes = [...new Set(allTypes)];

    const knownTypeSet = new Set(cfg.knownTypes);
    const unknownTypes = uniqueTypes.filter(t => !knownTypeSet.has(t));

    // Unknown types are not always wrong — the codebase may define them.
    // We only flag when more than 60% of types are unknown, suggesting
    // the model is inventing a type system rather than using the real one.
    const ratio = uniqueTypes.length > 0 ? unknownTypes.length / uniqueTypes.length : 0;
    const passed = ratio < 0.6;

    checks.push({
      name: 'type-consistency',
      passed,
      weight: 0.10,
      detail: passed
        ? `${uniqueTypes.length} type(s), ${unknownTypes.length} unknown`
        : `high unknown-type ratio: ${unknownTypes.length}/${uniqueTypes.length} (${(ratio * 100).toFixed(0)}%)`,
    });
  }

  // ── Check 3: API call validity (weight: 0.15) ──────────────────────────────
  // Are API calls in the known set? Fabricated API calls are a strong
  // signal that the model is hallucinating functionality.
  {
    const allCalls: string[] = [];
    for (const block of codeBlocks) allCalls.push(...extractFunctionCalls(block));
    const uniqueCalls = [...new Set(allCalls)];

    const knownCallSet = new Set(cfg.knownApiCalls);
    // We don't penalise unknown calls — the codebase may define them.
    // We only flag calls that look like they're trying to use a standard
    // API but got the name wrong (e.g. `fs.readFileAsync` instead of
    // `fs.readFile`).
    const suspiciousCalls = uniqueCalls.filter(call => {
      // Check if it's a near-miss of a known API call
      const parts = call.split('.');
      if (parts.length < 2) return false;
      const namespace = parts[0];
      const method = parts[parts.length - 1];
      // Check for common near-miss patterns
      for (const known of knownCallSet) {
        if (known.startsWith(namespace + '.')) {
          const knownMethod = known.split('.').pop()!;
          // Levenshtein-ish: same namespace, method differs by a small edit
          if (method.length > 3 && knownMethod.length > 3) {
            const diff = levenshtein(method, knownMethod);
            if (diff === 1 && method[0] === knownMethod[0]) {
              return true; // near-miss: probably a hallucinated method name
            }
          }
        }
      }
      return false;
    });

    const passed = suspiciousCalls.length === 0;
    checks.push({
      name: 'api-call-validity',
      passed,
      weight: 0.15,
      detail: passed
        ? `${uniqueCalls.length} call(s) checked`
        : `suspicious calls: ${suspiciousCalls.join(', ')}`,
    });
  }

  // ── Check 4: Code structure / well-formedness (weight: 0.15) ──────────────
  // Is the output well-formed? Balanced braces, not truncated.
  {
    const allCode = codeBlocks.join('\n');
    if (allCode.length === 0) {
      // No code in output — this is fine for non-coding tasks
      checks.push({
        name: 'code-structure',
        passed: true,
        weight: 0.10,
        detail: 'no code blocks in output',
      });
    } else {
      const balanced = isBalanced(allCode);
      const truncated = looksTruncated(allCode);
      const passed = balanced && !truncated;
      checks.push({
        name: 'code-structure',
        passed,
        weight: 0.10,
        detail: passed
          ? 'well-formed'
          : !balanced ? 'unbalanced braces/brackets' : 'output appears truncated',
      });
    }
  }

  // ── Check 5: Hallucination markers (weight: 0.15) ─────────────────────────
  // Direct detection of common hallucination patterns in model output.
  {
    const markers: string[] = [];
    const lowerOutput = output.toLowerCase();

    // "I believe this should work" / "this might work" / "this should probably"
    if (/\b(?:i believe|i think|this might|this should probably|this ought to|hopefully)\b/i.test(output)) {
      markers.push('hedging-language');
    }

    // Invented file paths that look plausible but are wrong
    const fakePathRegex = /(?:^|\s)\/(?:usr|opt|home|var|etc)\/[a-z]/gm;
    const fakePaths = (output.match(fakePathRegex) || []).length;
    if (fakePaths > 3) markers.push('excessive-fake-paths');

    // Placeholder code: "your implementation here", "TODO: implement"
    if (/\b(?:your implementation here|implement this|fill in|placeholder)\b/i.test(output)) {
      markers.push('placeholder-code');
    }

    // Contradictory statements
    if (/\b(?:note that|important).*(?:not|never|don't).*(?:actually|in fact|however).*\b/i.test(output)) {
      markers.push('contradictory-statements');
    }

    const passed = markers.length === 0;
    checks.push({
      name: 'hallucination-markers',
      passed,
      weight: 0.10,
      detail: passed
        ? 'no markers detected'
        : `markers: ${markers.join(', ')}`,
    });
    // (This check IS applicable to prose -- hedging, placeholders, fake
    // paths and contradictions all appear in prose. It is deliberately not
    // in the vacuous list.)
  }

  // ── Prose checks (weight: 0.20 total) ───────────────────────────────────
  //
  // The seven checks above all inspect CODE. A prose answer has no code
  // blocks, so every one of them passed vacuously: measured on 2026-10-29,
  // 1,962 of 1,975 scored responses returned score 1.0 and escalation never
  // fired once. The router could not tell a good paragraph from a truncated
  // one.
  //
  // These checks look for the specific failure modes a local model actually
  // produces on prose: emptiness, truncation mid-thought, and refusal.
  {
    const text = output.trim();
    const lower = text.toLowerCase();

    // The prose checks judge PROSE responses. When the answer is mostly code,
    // the code checks above are the relevant ones, and penalising a code
    // response for being short would be wrong.
    const codeBlockCount = extractCodeBlocks(output).length;
    const codeish = codeBlockCount > 0
      || /^\s*(?:import|export|def |class |function |const |let |var |#include|package )/m.test(text);
    const proseApplies = !codeish;

    // Check 8: Substantive content. A short or empty answer is not a
    // confident answer; it is a model that ran out of room.
    const wordCount = text ? text.split(/\s+/).filter(w => w.length > 0).length : 0;
    // A truncated reasoning response is usually long (it kept thinking) but
    // never produced a conclusion. Detect "thought, no answer" separately
    // from "no answer at all".
    const looksLikeTrace = /^(?:what|why|how|the user|explain|answer|one paragraph|probably|should be|causes?:)/i.test(text)
      && !/[.!?]\s+\S/.test(text.slice(-200));
    // A reasoning trace can be long and still contain no answer. Detect the
    // planning language a trace is full of and treat it as NOT substantive:
    // the model spent its budget thinking instead of answering.
    const thinkingNotAnswering = /\b(?:probably|should be|one paragraph|likely|possibly|perhaps|i'?ll|i will|need to|let me|answer:|question:)\b/i.test(text)
      && !/[.!?]["')\]]?\s*$/.test(text);
    const thinContent = (wordCount < 25 && !looksLikeTrace) || thinkingNotAnswering;
    checks.push({
      name: 'prose-substantive',
      passed: !thinContent,
      weight: proseApplies ? 0.30 : 0,
      detail: !proseApplies
        ? 'not applicable (response is code)'
        : thinContent
          ? (thinkingNotAnswering
              ? `${wordCount} words but no conclusion (reasoning trace, not an answer)`
              : `only ${wordCount} word(s) of content`)
          : `${wordCount} words`,
    });

    // Check 9: Not truncated mid-thought. A reasoning model that hits the
    // token ceiling leaves reasoning_content with the question restated and
    // no conclusion. That is a failed answer, not a confident one.
    //
    // Detected by: the text restates a question, AND it never lands on a
    // sentence-ending conclusion. A reasoning trace also betrays itself with
    // planning language ("Probably concise", "Should be accurate", "One
    // paragraph", "Possibl") -- a real answer does not narrate its own
    // plan in the third person.
    const restatesQuestion = /\b(?:what|why|how)\b[^.?]*\?/i.test(text.slice(0, 300));
    const noConclusion = !/[.!?]["')\]]?\s*$/.test(text);
    const planningLanguage = /\b(?:probably|should be|one paragraph|likely|possibly|perhaps|i'?ll|i will|need to|let me)\b/i.test(text);
    const truncated = wordCount >= 25
      && noConclusion
      && (restatesQuestion || planningLanguage);
    checks.push({
      name: 'prose-not-truncated',
      passed: !truncated,
      weight: proseApplies ? 0.15 : 0,
      detail: !proseApplies
        ? 'not applicable (response is code)'
        : truncated
          ? 'answer appears truncated mid-reasoning (no conclusion reached)'
          : 'complete answer',
    });

    // Check 10: Refusal / deflection. A model that declines or punts has not
    // answered, and must not be scored as high confidence.
    // Match refusal OPENINGS, not the whole text: "I'm sorry", "Sorry, but",
    // "I cannot", "As an AI", "I don't have access to".
    const refused = /^(?:i(?:'m| am)\s+(?:sorry|afraid|unable)|sorry[, ]|as an ai|i (?:can(?:not|'t)|won't|am unable to|must decline)|i don'?t have access to|i'?m not able to)/i.test(text);
    checks.push({
      name: 'prose-not-refused',
      passed: !refused,
      weight: proseApplies ? 0.15 : 0,
      detail: !proseApplies
        ? 'not applicable (response is code)'
        : refused ? 'answer is a refusal or deflection' : 'answered',
    });
  }

  // ── Check 6: Hook validation (weight: 0.20) ──────────────────────────────
  // Run pre-validation hook scripts against code blocks in the output.
  // If a hook fails, the output has a deterministic error and confidence drops.
  // Skipped (passes by default) when no hooks dir is configured or it doesn't exist.
  {
    const hooksDir = cfg.hookScriptsDir;
    let passed = true;
    let detail = 'hook validation skipped (not configured)';

    if (hooksDir) {
      // Check if the hooks directory exists
      let dirExists = false;
      try {
        dirExists = statSync(hooksDir).isDirectory();
      } catch {
        dirExists = false;
      }

      if (dirExists) {
        const result = runHookValidation(output, hooksDir);
        passed = result.passed;
        detail = result.detail;
      } else {
        detail = `hooks directory not found: ${hooksDir}`;
      }
    }

    checks.push({
      name: 'hook-validation',
      passed,
      weight: 0.20,
      detail,
    });
  }

  // ── Check 7: Conductor gate results (weight: 0.20) ───────────────────────
  // When the model runs conductor commands via exec, the conductor prints
  // gate pass/fail lines and a final result line. Gate failures mean the
  // output is deterministically wrong — a strong signal to escalate.
  // Skipped (passes by default) when no conductor output is detected.
  {
    const conductorGateFails = (output.match(/\[conductor\] gate \S+: FAIL/g) || []).length;
    const conductorGatePasses = (output.match(/\[conductor\] gate \S+: PASS/g) || []).length;
    const notCompleted = /\[conductor\] result: \d+ steps?, not completed/.test(output);
    const conductorError = /\[conductor\] (?:model|validation|state map) error:/.test(output);

    const hasConductorOutput = conductorGateFails > 0 || conductorGatePasses > 0 || notCompleted || conductorError;

    let passed = true;
    let detail = 'no conductor output detected';

    if (hasConductorOutput) {
      passed = conductorGateFails === 0 && !notCompleted && !conductorError;
      const parts: string[] = [];
      if (conductorGateFails > 0) parts.push(`${conductorGateFails} gate failure(s)`);
      if (conductorGatePasses > 0) parts.push(`${conductorGatePasses} gate pass(es)`);
      if (notCompleted) parts.push('conductor did not complete');
      if (conductorError) parts.push('conductor error');
      detail = passed ? `all gates passed (${conductorGatePasses})` : parts.join(', ');
    }

    checks.push({
      name: 'conductor-gates',
      passed,
      weight: 0.20,
      detail,
    });
  }

  // ── Compute weighted score ────────────────────────────────────────────────
  //
  // VACUOUS CHECKS DO NOT COUNT. A check that found nothing to inspect (no
  // code blocks, no hook configured, no conductor output) is not evidence that
  // the answer is good -- it is evidence that the check did not apply. Before
  // 2026-10-29 those checks contributed 0.70 of weight and passed
  // unconditionally, which diluted every real signal: a truncated prose answer
  // scored 0.96 and a refusal scored 0.92, so the router never escalated.
  //
  // A check is VACUOUS when it inspected nothing. Those get weight 0 and are
  // excluded from both the numerator and the denominator.
  const vacuousNames = new Set([
    'import-validity',
    'type-consistency',
    'api-call-validity',
    'code-structure',
    'hook-validation',
    'conductor-gates',
  ]);

  const effective = checks.filter((c) => {
    // A weight-0 check is not applicable -- exclude it from the denominator
    // entirely rather than letting it pass silently.
    if (c.weight === 0) return false;
    if (vacuousNames.has(c.name)) {
      // The detail text states how many items were inspected. Zero means the
      // check had nothing to look at.
      const detail = c.detail ?? '';
      const zeroInspected =
        /^0 (?:import|type|call)/.test(detail)
        || /no code blocks in output/i.test(detail)
        || /skipped/i.test(detail)
        || /no conductor output detected/i.test(detail);
      if (zeroInspected) return false;
    }
    return true;
  });

  const totalWeight = effective.reduce((sum, c) => sum + c.weight, 0);
  const passedWeight = effective.filter(c => c.passed).reduce((sum, c) => sum + c.weight, 0);
  const score = totalWeight > 0 ? passedWeight / totalWeight : 1.0;

  const tier = score >= 0.75 ? 'high' : score >= 0.45 ? 'medium' : 'low';
  const shouldEscalate = score < cfg.escalationThreshold;

  return {
    score: Math.round(score * 100) / 100,
    tier,
    checks,
    shouldEscalate,
  };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Simple Levenshtein distance for near-miss detection.
 * Not exported — used only internally for API call validation.
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

// ─── Router integration helper ──────────────────────────────────────────────

/**
 * Extract the assistant's text content from an OpenAI-compatible response body.
 * Returns empty string if no content is found.
 */
export function extractAssistantContent(responseBody: string): string {
  try {
    const parsed = JSON.parse(responseBody);
    const choices = parsed.choices ?? [];
    let content = '';
    let reasoning = '';
    for (const choice of choices) {
      const msg = choice.message ?? choice.delta;
      if (msg?.content) {
        content += typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      }
      if (msg?.reasoning_content) {
        reasoning += typeof msg.reasoning_content === 'string'
          ? msg.reasoning_content
          : JSON.stringify(msg.reasoning_content);
      }
    }
    // A reasoning model that runs out of tokens mid-thought puts EVERYTHING
    // in reasoning_content and leaves content EMPTY. Measured 2026-10-29:
    // 47 of 1,985 router responses had empty content with 800-1,600 chars of
    // reasoning. Those were scored as "no-content" -> score 1.0 -> a
    // truncated answer looked like a perfect one.
    //
    // If there is no final content but there IS reasoning, the response is
    // truncated, not empty. Return the reasoning so it can be inspected --
    // and let the prose checks below judge whether it is a usable answer.
    if (!content.trim() && reasoning.trim()) {
      return reasoning;
    }
    return content;
  } catch {
    return '';
  }
}

/**
 * Score a complete HTTP response body from a model provider.
 *
 * This is the main entry point for the router's dispatch loop:
 * after receiving a response from a provider, call this to get a
 * ConfidenceSignal. If `shouldEscalate` is true, the router should
 * try the next provider in the chain.
 *
 * For streaming responses, accumulate the full body first, then call this.
 */
export function scoreResponse(
  responseBody: string,
  config?: Partial<ConfidenceConfig>,
): ConfidenceSignal {
  const content = extractAssistantContent(responseBody);
  if (!content) {
    // No assistant content to score — could be a tool call, an empty response,
    // or a malformed body. Return an explicit no-content check so the score
    // remains auditable and does not look like a perfect pass.
    const cfg: ConfidenceConfig = {
      enabled: config?.enabled ?? true,
      escalationThreshold: config?.escalationThreshold ?? DEFAULT_ESCALATION_THRESHOLD,
      knownImports: config?.knownImports,
      knownApiCalls: config?.knownApiCalls,
      knownTypes: config?.knownTypes,
    };
    return {
      score: 1.0,
      tier: 'high',
      checks: [{
        name: 'no-content',
        passed: true,
        weight: 0,
        detail: 'no assistant content to score',
      }],
      shouldEscalate: false,
    };
  }
  return scoreOutput(content, config);
}