#!/usr/bin/env node
/**
 * polly-router — Phase 5
 * Context shim: strips OpenClaw system prompt for local models.
 * Hot model swap: 7b → 32b → 72b based on stripped prompt size.
 *
 * Routing decision matrix:
 *   DIRECT   (vault score ≥ 0.75, ≥1 result)
 *   ADJACENT (0.50–0.74)          + LIGHT   → local (stripped) → Groq → Cerebras → Google
 *   ADJACENT                      + MEDIUM  → Google → Groq → local (stripped)
 *   ADJACENT                      + HEAVY   → Google → Groq → Copilot
 *   ABSENT                        + LIGHT   → Groq → Cerebras → Mistral → Google
 *   ABSENT                        + MEDIUM  → Groq → Google → Cerebras → Mistral
 *   ABSENT                        + HEAVY   → Copilot → Google → Groq
 *
 * Context windows (tokens): 7b=8k, 32b=32k, 72b=128k
 * Port: 4200   Config: ./config.json
 */

"use strict";

const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const { execFile } = require("child_process");

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.POLLY_ROUTER_CONFIG
  || path.join(__dirname, "config.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
  catch (e) { console.error("[polly-router] Config load failed:", e.message); process.exit(1); }
}

let config = loadConfig();
fs.watchFile(CONFIG_PATH, { interval: 3000 }, () => {
  try { config = loadConfig(); log("config reloaded"); }
  catch (e) { console.error("[polly-router] Config reload failed:", e.message); }
});

const PORT    = parseInt(process.env.POLLY_ROUTER_PORT || "4200", 10);
const NODE_BIN = process.env.NODE_BIN || "/Users/brettgershon/.nvm/versions/node/v22.22.2/bin/node";
const QMD_JS  = process.env.QMD_JS  || "/Users/brettgershon/.nvm/versions/node/v22.22.2/lib/node_modules/@tobilu/qmd/dist/cli/qmd.js";

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg, meta = {}) {
  const ts = new Date().toISOString();
  const s  = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  console.log(`[${ts}] ${msg}${s}`);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data",  c => chunks.push(c));
    stream.on("end",   () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
  });
}

// ─── QMD Vault Probe ─────────────────────────────────────────────────────────

/**
 * Warm QMD worker — keeps a persistent node process alive so the
 * embedding + reranker models stay loaded between requests.
 * Communicates via stdin/stdout JSON-lines.
 */
const WORKER_SRC = `
const { execFile } = require('child_process');
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', d => {
  buf += d;
  const lines = buf.split('\\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    const { id, query } = req;
    execFile(
      process.argv[2],
      [process.argv[3], 'query', query, '-c', 'vault', '--no-rerank', '--json'],
      { timeout: 12000, env: { ...process.env } },
      (err, stdout) => {
        if (err || !stdout) {
          process.stdout.write(JSON.stringify({ id, error: err?.message || 'no output' }) + '\\n');
          return;
        }
        try {
          // QMD --json outputs a raw array
          const raw = JSON.parse(stdout);
          const results = Array.isArray(raw) ? raw : (raw.results || []);
          process.stdout.write(JSON.stringify({ id, results }) + '\\n');
        } catch(e) {
          process.stdout.write(JSON.stringify({ id, error: 'parse: ' + e.message }) + '\\n');
        }
      }
    );
  }
});
`;

const { spawn } = require("child_process");
const fs2 = require("fs");
const os  = require("os");

const WORKER_PATH = path.join(os.tmpdir(), "polly-qmd-worker.js");
fs2.writeFileSync(WORKER_PATH, WORKER_SRC);

let _worker = null;
let _workerCbs = {}; // id → { resolve, timer }
let _reqId = 0;
let _workerBuf = "";

let _workerReady = false;

function getWorker() {
  if (_worker && !_worker.killed) return _worker;
  log("starting QMD worker");
  _workerReady = false;
  _worker = spawn(NODE_BIN, [WORKER_PATH, NODE_BIN, QMD_JS], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  _workerBuf = "";
  _worker.stdout.setEncoding("utf8");
  _worker.stdout.on("data", d => {
    _workerBuf += d;
    const lines = _workerBuf.split("\n");
    _workerBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        // Mark worker ready on first response (warmup or real)
        if (!_workerReady) {
          _workerReady = true;
          log("QMD worker ready");
        }
        const cb  = _workerCbs[msg.id];
        if (cb) { clearTimeout(cb.timer); delete _workerCbs[msg.id]; cb.resolve(msg); }
      } catch {}
    }
  });
  _worker.stderr.on("data", () => {}); // suppress QMD progress output
  _worker.on("exit", (code) => {
    log("QMD worker exited", { code });
    _worker = null;
    _workerReady = false;
    // Reject any pending callbacks
    for (const [id, cb] of Object.entries(_workerCbs)) {
      clearTimeout(cb.timer);
      cb.resolve({ id, error: "worker exited" });
    }
    _workerCbs = {};
    // Restart after 1s
    setTimeout(getWorker, 1000);
  });
  // Warm up: send a real query so models load and _workerReady flips
  setTimeout(() => {
    const warmId = "warm_" + Date.now();
    _workerCbs[warmId] = {
      timer: setTimeout(() => { delete _workerCbs[warmId]; }, 30000),
      resolve: (msg) => {
        delete _workerCbs[warmId];
        if (!_workerReady) { _workerReady = true; log("QMD worker ready (warmup)"); }
      },
    };
    _worker.stdin.write(JSON.stringify({ id: warmId, query: "polly router routing logic" }) + "\n");
  }, 500);
  return _worker;
}

// Start worker immediately on boot
getWorker();

function probeVault(userMessage) {
  return new Promise((resolve) => {
    const worker = getWorker();
    if (!worker) return resolve({ confidence: "ABSENT", score: 0, chunks: [] });

    const id    = String(++_reqId);
    const query = userMessage.slice(0, 200).replace(/\n/g, " ");

    const timer = setTimeout(() => {
      delete _workerCbs[id];
      log("vault probe timeout");
      resolve({ confidence: "ABSENT", score: 0, chunks: [] });
    }, 2000);

    _workerCbs[id] = {
      timer,
      resolve: (msg) => {
        if (msg.error) {
          log("vault probe error", { error: msg.error });
          return resolve({ confidence: "ABSENT", score: 0, chunks: [] });
        }
        const results = msg.results || [];
        if (!results.length) return resolve({ confidence: "ABSENT", score: 0, chunks: [] });

        const topScore = results[0].score || 0;
        const totalLen = results.slice(0, 3).reduce((n, r) => n + (r.snippet?.length || 0), 0);
        const chunks   = results.slice(0, 3).map(r => r.snippet || "").filter(Boolean);

        let confidence;
        if (topScore >= 0.75 && results.length >= 1) confidence = "DIRECT";
        else if (topScore >= 0.50) confidence = "ADJACENT";
        else confidence = "ABSENT";

        resolve({ confidence, score: topScore, chunks });
      },
    };

    try {
      worker.stdin.write(JSON.stringify({ id, query }) + "\n");
    } catch (e) {
      clearTimeout(timer);
      delete _workerCbs[id];
      log("vault probe write error", { error: e.message });
      resolve({ confidence: "ABSENT", score: 0, chunks: [] });
    }
  });
}

// ─── Complexity Classifier ────────────────────────────────────────────────────

const HEAVY_PATTERNS = [
  /architect/i, /refactor/i, /design system/i, /debug.*complex/i,
  /multi.?file/i, /implement.*from scratch/i, /optimize.*algorithm/i,
  /security audit/i, /threat model/i, /distributed/i,
];
const LIGHT_PATTERNS = [
  /^(hi|hello|hey|thanks|ok|yes|no|sure)\b/i,
  /what (is|are|does|time|day)/i,
  /translate/i, /define /i, /spell /i,
  /remind me/i, /heartbeat/i, /status check/i,
];

function classifyComplexity(messages) {
  const last = (messages || []).filter(m => m.role === "user").pop();
  if (!last) return "MEDIUM";
  const text = (Array.isArray(last.content)
    ? last.content.map(c => c.text || "").join(" ")
    : last.content || "").toLowerCase();
  const toks = text.split(/\s+/).length;
  if (LIGHT_PATTERNS.some(p => p.test(text)) && toks < 30) return "LIGHT";
  if (HEAVY_PATTERNS.some(p => p.test(text)) || toks > 800)  return "HEAVY";
  return "MEDIUM";
}

function getLastUserMessage(messages) {
  const last = (messages || []).filter(m => m.role === "user").pop();
  if (!last) return "";
  return Array.isArray(last.content)
    ? last.content.map(c => c.text || "").join(" ")
    : last.content || "";
}

// ─── Vault context injection ──────────────────────────────────────────────────

/**
 * Prepend top vault chunks as a system message when vault has signal.
 */
function injectVaultContext(body, chunks) {
  if (!chunks.length) return body;
  const vaultCtx = chunks.map((c, i) => `[Vault excerpt ${i+1}]\n${c}`).join("\n\n");
  const systemMsg = {
    role: "system",
    content: `Relevant context from the user's personal knowledge vault:\n\n${vaultCtx}\n\nUse this context where relevant.`,
  };
  const messages = body.messages || [];
  // Insert after existing system messages
  const firstNonSystem = messages.findIndex(m => m.role !== "system");
  const insertAt = firstNonSystem === -1 ? messages.length : firstNonSystem;
  return {
    ...body,
    messages: [
      ...messages.slice(0, insertAt),
      systemMsg,
      ...messages.slice(insertAt),
    ],
  };
}

// ─── Context shim for local models ─────────────────────────────────────────

/**
 * Local model context windows (chars, ~4 chars/token).
 * Used for hot-swap selection.
 */
const LOCAL_MODELS = [
  { name: "qwen2.5:7b",         maxChars:  28000,  weight: "light"  },
  { name: "qwen2.5-coder:32b",  maxChars: 112000,  weight: "medium" },
  { name: "qwen2.5:72b",        maxChars: 480000,  weight: "heavy"  },
];

/**
 * Estimate chars in a messages array.
 */
function estimateChars(messages) {
  return (messages || []).reduce((n, m) => {
    const c = m.content || "";
    return n + (Array.isArray(c) ? c.map(x => x.text || "").join("").length : c.length);
  }, 0);
}

/**
 * Smart context shim for local models.
 *
 * OpenClaw system prompt injection order (confirmed):
 *   AGENTS.md → SOUL.md → TOOLS.md → IDENTITY.md → USER.md → HEARTBEAT.md → MEMORY.md
 *   followed by skills list (<available_skills>), tool schemas (JSON), then
 *   OPENCLAW_CACHE_BOUNDARY, dynamic project context.
 *
 * We keep: SOUL.md block + IDENTITY.md block + vault chunks
 * We discard: AGENTS.md, TOOLS.md, USER.md, HEARTBEAT.md, MEMORY.md,
 *             tool schemas, skills list, dynamic context
 */
function stripForLocal(body, vaultChunks = []) {
  const messages = (body.messages || []).slice();
  const stripped = [];

  // Tools are already filtered by OpenClaw per-agent config before reaching polly-router.
  // Pass them through unchanged to local models.
  const filteredTools = body.tools;

  for (const msg of messages) {
    if (msg.role !== "system") {
      stripped.push(msg);
      continue;
    }

    const raw = Array.isArray(msg.content)
      ? msg.content.map(c => c.text || "").join("")
      : (msg.content || "");

    let text = raw;

    // --- Strip everything after OPENCLAW_CACHE_BOUNDARY (dynamic context) ---
    const cacheIdx = text.indexOf("OPENCLAW_CACHE_BOUNDARY");
    if (cacheIdx !== -1) text = text.slice(0, cacheIdx);

    // --- Strip <available_skills> block ---
    text = text.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, "");

    // --- Strip tool JSON schemas (large JSON blocks with 'parameters'/'properties') ---
    text = text.replace(/\{[\s\S]{500,}?\}/g, (match) => {
      if (match.includes('"parameters"') || match.includes('"properties"') || match.includes('"description"')) return "";
      return match;
    });

    // --- Extract SOUL.md block ---
    // Matches: ## /path/SOUL.md ... next ## /path/XXX.md section
    let soul = "";
    const soulMatch = text.match(/##\s+\/[^\n]*SOUL\.md[\s\S]*?(?=##\s+\/[^\n]*\.md|$)/);
    if (soulMatch) {
      soul = soulMatch[0].trim();
    } else {
      // Fallback: look for # SOUL.md header
      const soulHeader = text.match(/#+ SOUL\.md[\s\S]*?(?=#+\s+\S+\.md|<available_skills|$)/);
      if (soulHeader) soul = soulHeader[0].trim();
    }

    // --- Extract IDENTITY.md block ---
    let identity = "";
    const identMatch = text.match(/##\s+\/[^\n]*IDENTITY\.md[\s\S]*?(?=##\s+\/[^\n]*\.md|$)/);
    if (identMatch) {
      identity = identMatch[0].trim();
    } else {
      const identHeader = text.match(/#+ IDENTITY\.md[\s\S]*?(?=#+\s+\S+\.md|<available_skills|$)/);
      if (identHeader) identity = identHeader[0].trim();
    }

    // --- Build minimal system prompt ---
    // Local models are RAG answer engines only — no persona, no orchestration identity.
    // Just a neutral instruction + vault context.
    const parts = [];
    parts.push("You are a helpful assistant. Answer the user's question accurately and concisely.");

    if (vaultChunks.length) {
      const vaultCtx = vaultChunks.map((c, i) => `[Vault ${i+1}]\n${c}`).join("\n\n");
      parts.push(`## Relevant vault context\n${vaultCtx}`);
    }

    parts.push("Answer concisely using the vault context above where relevant.");

    stripped.push({ role: "system", content: parts.join("\n\n") });
    log("shim", { soulStripped: true, partsChars: parts.join("\n\n").length });
  }

  return { ...body, messages: stripped, tools: filteredTools?.length ? filteredTools : undefined, tool_choice: filteredTools?.length ? body.tool_choice : undefined };
}

/**
 * For DIRECT vault hits, enforce a minimum of 32b (capable enough to synthesize vault content).
 * Returns model name, or null if no local model is large enough.
 */
function selectLocalModel(body, preferWeight = null, minWeight = null) {
  const chars = estimateChars(body.messages);
  // Add 20% headroom for response tokens
  const needed = Math.ceil(chars * 1.2);
  const weightOrder = ["light", "medium", "heavy"];
  const minIdx = minWeight ? weightOrder.indexOf(minWeight) : 0;
  const candidates = LOCAL_MODELS.filter(m => m.maxChars >= needed && weightOrder.indexOf(m.weight) >= minIdx);
  if (!candidates.length) return null;
  // If a preference is given, try to honour it
  if (preferWeight) {
    const preferred = candidates.find(m => m.weight === preferWeight);
    if (preferred) return preferred.name;
  }
  return candidates[0].name; // smallest that fits
}

// ─── Copilot OAuth ────────────────────────────────────────────────────────────

let _copilotToken = null;
let _copilotTokenExpiry = 0;

async function getCopilotToken() {
  if (_copilotToken && Date.now() < _copilotTokenExpiry) return _copilotToken;
  const appsPath = path.join(process.env.HOME, ".config/github-copilot/apps.json");
  let oauthToken;
  try {
    const apps = JSON.parse(fs.readFileSync(appsPath, "utf-8"));
    oauthToken = Object.values(apps)[0].oauth_token;
  } catch (e) { throw new Error("Copilot OAuth token not found: " + e.message); }

  await new Promise((resolve, reject) => {
    const lib = https;
    const req = lib.request({
      hostname: "api.github.com",
      path: "/copilot_internal/v2/token",
      method: "GET",
      headers: {
        "Authorization": `token ${oauthToken}`,
        "Accept": "application/json",
        "User-Agent": "polly-router/0.3",
      },
    }, async (res) => {
      const body = await readStream(res);
      const data = JSON.parse(body);
      if (!data.token) return reject(new Error("Copilot token exchange failed"));
      _copilotToken = data.token;
      _copilotTokenExpiry = Date.now() + ((data.expires_in || 1500) * 1000);
      log("copilot token refreshed");
      resolve();
    });
    req.on("error", reject);
    req.end();
  });
  return _copilotToken;
}

// ─── Provider dispatch ────────────────────────────────────────────────────────

async function dispatchOpenAI({ baseUrl, apiKey, model, body, extraHeaders = {}, timeoutMs = 25000 }) {
  const url     = new URL(`${baseUrl}/chat/completions`);
  const payload = Buffer.from(JSON.stringify({ ...body, model }));
  const lib     = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": payload.length,
        "Authorization":  `Bearer ${apiKey}`,
        "User-Agent":     "polly-router/0.3",
        ...extraHeaders,
      },
    };
    const req = lib.request(opts, resolve);
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.write(payload);
    req.end();
  });
}

async function dispatchOllama(model, body) {
  const base = (config.providers.ollama?.baseUrl || "http://127.0.0.1:11434") + "/v1";
  return dispatchOpenAI({ baseUrl: base, apiKey: "ollama", model, body, timeoutMs: PROVIDER_TIMEOUTS.ollama });
}
async function dispatchGroq(body) {
  const p = config.providers.groq;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body, timeoutMs: PROVIDER_TIMEOUTS.groq });
}
async function dispatchCerebras(body) {
  const p = config.providers.cerebras;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body, timeoutMs: PROVIDER_TIMEOUTS.cerebras });
}
async function dispatchGoogle(body) {
  const p = config.providers.google;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body, timeoutMs: PROVIDER_TIMEOUTS.google });
}
async function dispatchMistral(body) {
  const p = config.providers.mistral;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body, timeoutMs: PROVIDER_TIMEOUTS.mistral });
}
async function dispatchCopilot(body, model = "claude-sonnet-4.6") {
  const token = await getCopilotToken();
  return dispatchOpenAI({
    baseUrl: "https://api.githubcopilot.com",
    apiKey: token, model, body,
    extraHeaders: { "Copilot-Integration-Id": "vscode-chat", "Editor-Version": "vscode/1.95.0" },
    timeoutMs: PROVIDER_TIMEOUTS.copilot,
  });
}
async function dispatchOpenRouter(body, model = "qwen/qwen3-235b-a22b:free") {
  const p = config.providers.openrouter;
  if (!p?.apiKey) throw new Error("openrouter not configured");
  return dispatchOpenAI({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: p.apiKey, model, body,
    extraHeaders: { "HTTP-Referer": "https://polly-router" },
    timeoutMs: PROVIDER_TIMEOUTS.openrouter,
  });
}

// ─── Ollama health ────────────────────────────────────────────────────────────

let _ollamaOk = null, _ollamaCheckAt = 0;
async function isOllamaAvailable() {
  if (Date.now() - _ollamaCheckAt < 15000) return _ollamaOk;
  try {
    const base = config.providers.ollama?.baseUrl || "http://127.0.0.1:11434";
    await new Promise((resolve, reject) => {
      const req = http.get(base + "/api/tags", resolve);
      req.on("error", reject);
      req.setTimeout(1500, () => req.destroy(new Error("timeout")));
    });
    _ollamaOk = true;
  } catch { _ollamaOk = false; }
  _ollamaCheckAt = Date.now();
  return _ollamaOk;
}

// ─── Dispatch chain builder ───────────────────────────────────────────────────

async function buildDispatchChain(body, complexity, vaultSignal) {
  const { confidence, chunks } = vaultSignal;
  const ollamaOk = await isOllamaAvailable();

  // Detect main/orchestrator agent — force cloud only.
  // Signals: >20 tools (main has 60+, all others are tightly scoped)
  // or IDENTITY.md contains 'main' agent marker.
  const toolCount = (body.tools || []).length;
  const isOrchestratorAgent = toolCount > 20;
  if (isOrchestratorAgent) {
    log("routing-note", { reason: "orchestrator agent — cloud only", tools: toolCount });
  }

  // Build enriched body (vault context injected) for cloud routes
  const enriched = (confidence !== "ABSENT" && chunks.length)
    ? injectVaultContext(body, chunks)
    : body;

  // Build stripped body for local routes — minimal context, persona + vault only
  const strippedBody = stripForLocal(body, confidence !== "ABSENT" ? chunks : []);
  // DIRECT: minimum 32b for quality; ADJACENT/ABSENT LIGHT: any model fine
  // Orchestrator agents never route local
  const directLocalModel   = (ollamaOk && !isOrchestratorAgent) ? selectLocalModel(strippedBody, null, "medium") : null;
  const adjacentLocalModel = (ollamaOk && !isOrchestratorAgent) ? selectLocalModel(strippedBody) : null;

  log("context", {
    fullChars: estimateChars(body.messages),
    strippedChars: estimateChars(strippedBody.messages),
    localModel: (directLocalModel || adjacentLocalModel) || "none (too large or unavailable)",
  });

  const chain = [];

  if (confidence === "DIRECT") {
    // Vault has the answer — local first with stripped context, hot-swap to fit
    if (directLocalModel) {
      chain.push({ name: `ollama/${directLocalModel}`, fn: () => dispatchOllama(directLocalModel, strippedBody) });
    }
    chain.push({ name: "google",   fn: () => dispatchGoogle(enriched) });
    chain.push({ name: "groq",     fn: () => dispatchGroq(enriched) });
    chain.push({ name: "cerebras", fn: () => dispatchCerebras(enriched) });
    chain.push({ name: "copilot/claude-sonnet-4.6", fn: () => dispatchCopilot(enriched) });

  } else if (confidence === "ADJACENT") {
    if (complexity === "LIGHT") {
      if (adjacentLocalModel) chain.push({ name: `ollama/${adjacentLocalModel}`, fn: () => dispatchOllama(adjacentLocalModel, strippedBody) });
      chain.push({ name: "groq",     fn: () => dispatchGroq(enriched) });
      chain.push({ name: "cerebras", fn: () => dispatchCerebras(enriched) });
      chain.push({ name: "mistral",  fn: () => dispatchMistral(enriched) });
      chain.push({ name: "google",   fn: () => dispatchGoogle(enriched) });
    } else if (complexity === "MEDIUM") {
      chain.push({ name: "google", fn: () => dispatchGoogle(enriched) });
      chain.push({ name: "groq",   fn: () => dispatchGroq(enriched) });
      if (adjacentLocalModel) chain.push({ name: `ollama/${adjacentLocalModel}`, fn: () => dispatchOllama(adjacentLocalModel, strippedBody) });
      chain.push({ name: "cerebras", fn: () => dispatchCerebras(enriched) });
    } else { // HEAVY
      chain.push({ name: "google",   fn: () => dispatchGoogle(enriched) });
      chain.push({ name: "groq",     fn: () => dispatchGroq(enriched) });
      chain.push({ name: "copilot/claude-sonnet-4.6", fn: () => dispatchCopilot(enriched) });
    }

  } else { // ABSENT
    if (complexity === "LIGHT") {
      chain.push({ name: "groq",     fn: () => dispatchGroq(body) });
      chain.push({ name: "cerebras", fn: () => dispatchCerebras(body) });
      chain.push({ name: "mistral",  fn: () => dispatchMistral(body) });
      chain.push({ name: "google",   fn: () => dispatchGoogle(body) });
    } else if (complexity === "MEDIUM") {
      chain.push({ name: "groq",     fn: () => dispatchGroq(body) });
      chain.push({ name: "google",   fn: () => dispatchGoogle(body) });
      chain.push({ name: "cerebras", fn: () => dispatchCerebras(body) });
      chain.push({ name: "mistral",  fn: () => dispatchMistral(body) });
    } else { // HEAVY + ABSENT — frontier first
      chain.push({ name: "copilot/claude-sonnet-4.6", fn: () => dispatchCopilot(body) });
      chain.push({ name: "google",   fn: () => dispatchGoogle(body) });
      chain.push({ name: "groq",     fn: () => dispatchGroq(body) });
    }
  }

  // Overflow fallbacks always at the end
  if (config.providers?.openrouter?.apiKey) {
    chain.push({ name: "openrouter", fn: () => dispatchOpenRouter(body) });
  }
  if (complexity !== "HEAVY") {
    chain.push({ name: "copilot/claude-sonnet-4.6", fn: () => dispatchCopilot(body) });
  }

  return chain;
}

// ─── Request handlers ─────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data",  c => chunks.push(c));
    req.on("end",   () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { reject(e); } });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function handleCompletions(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { error: { message: e.message, type: "invalid_request_error" } }); }

  const userMsg    = getLastUserMessage(body.messages);
  const complexity = classifyComplexity(body.messages);

  // Fire vault probe async — don't block routing on it
  // We'll use it to influence the chain for the NEXT tier decision.
  // For inline context injection we use a race — longer if worker is still warming up.
  const vaultPromise = probeVault(userMsg);

  // Give vault probe up to 5s (warm) or 15s (cold boot) before routing without it
  const probeRaceMs = _workerReady ? 5000 : 15000;
  const vaultSignal = await Promise.race([
    vaultPromise,
    new Promise(r => setTimeout(() => r({ confidence: "ABSENT", score: 0, chunks: [] }), probeRaceMs)),
  ]);

  const chain   = await buildDispatchChain(body, complexity, vaultSignal);
  const startMs = Date.now();

  log("routing", {
    complexity,
    vault: vaultSignal.confidence,
    vaultScore: vaultSignal.score.toFixed(2),
    chain: chain.map(c => c.name),
  });

  let lastError;
  for (const attempt of chain) {
    try {
      const upstream = await attempt.fn();

      if (upstream.statusCode === 429 || upstream.statusCode >= 500) {
        const errBody = await readStream(upstream);
        log("provider error — trying next", { provider: attempt.name, status: upstream.statusCode });
        lastError = `${attempt.name} → ${upstream.statusCode}`;
        continue;
      }

      if (upstream.statusCode >= 400) {
        res.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
        upstream.pipe(res);
        return;
      }

      const headers = {
        "Content-Type":          upstream.headers["content-type"] || "application/json",
        "Cache-Control":         "no-cache",
        "X-Polly-Provider":      attempt.name,
        "X-Polly-Complexity":    complexity,
        "X-Polly-Vault":         vaultSignal.confidence,
        "X-Polly-Vault-Score":   vaultSignal.score.toFixed(2),
      };
      if (body.stream) headers["Transfer-Encoding"] = "chunked";

      res.writeHead(200, headers);

      // Intercept response to capture usage for cost logging
      if (!body.stream) {
        // Non-streaming: buffer the full response, parse usage, then forward
        const chunks = [];
        upstream.on("data", c => chunks.push(c));
        upstream.on("end", () => {
          const raw  = Buffer.concat(chunks);
          res.end(raw);
          try {
            const parsed = JSON.parse(raw.toString());
            const cost   = estimateCost(attempt.name, parsed.usage);
            const entry  = {
              ts:         new Date().toISOString(),
              provider:   attempt.name,
              complexity,
              vault:      vaultSignal.confidence,
              vaultScore: vaultSignal.score,
              ms:         Date.now() - startMs,
              tokens:     parsed.usage || null,
              cost,
            };
            recordRequest(entry);
            log("complete", { provider: attempt.name, complexity, vault: vaultSignal.confidence, ms: entry.ms, costUsd: cost?.total?.toFixed(6) ?? "0" });
          } catch {}
        });
      } else {
        upstream.pipe(res);
        upstream.on("end", () => {
          const entry = {
            ts: new Date().toISOString(), provider: attempt.name,
            complexity, vault: vaultSignal.confidence, vaultScore: vaultSignal.score,
            ms: Date.now() - startMs, tokens: null, cost: null,
          };
          recordRequest(entry);
          log("complete", { provider: attempt.name, complexity, vault: vaultSignal.confidence, ms: entry.ms });
        });
      }
      return;

    } catch (e) {
      log("dispatch error — trying next", { provider: attempt.name, error: e.message });
      lastError = `${attempt.name} → ${e.message}`;
    }
  }

  log("all providers failed", { lastError });
  sendJson(res, 502, { error: { message: `All providers failed. Last: ${lastError}`, type: "provider_error" } });
}

function handleModels(req, res) {
  sendJson(res, 200, {
    object: "list",
    data: [{ id: "auto", object: "model", created: 1700000000, owned_by: "polly-router" }],
  });
}

function handleStatus(req, res) {
  const providerBreakdown = {};
  for (const e of requestLog) {
    const p = e.provider || "unknown";
    if (!providerBreakdown[p]) providerBreakdown[p] = { calls: 0, costUsd: 0 };
    providerBreakdown[p].calls++;
    if (e.cost?.total) providerBreakdown[p].costUsd += e.cost.total;
  }
  const vaultHits = requestLog.filter(e => e.vault === "DIRECT" || e.vault === "ADJACENT").length;

  sendJson(res, 200, {
    status:       "ok",
    phase:        4,
    uptime:       process.uptime(),
    port:         PORT,
    providers:    Object.keys(config.providers || {}),
    ollamaAvailable: _ollamaOk,
    stats: {
      totalRequests,
      totalCostUsd:    parseFloat(totalCostUsd.toFixed(6)),
      copilotCalls,
      vaultHits,
      providerBreakdown,
    },
  });
}

function handleLog(req, res) {
  const url    = new URL(req.url, "http://localhost");
  const limit  = Math.min(parseInt(url.searchParams.get("limit") || "50"), MAX_LOG_ENTRIES);
  const recent = requestLog.slice(-limit).reverse();
  sendJson(res, 200, { total: totalRequests, entries: recent });
}

// ─── Provider timeouts ─────────────────────────────────────────────────────

const PROVIDER_TIMEOUTS = {
  "ollama":     120000, // 120s — 32b/72b generation can take 60-90s on M4 Max
  "groq":       20000,
  "cerebras":   20000,
  "google":     30000,
  "mistral":    25000,
  "copilot":    45000,
  "openrouter": 30000,
};

function timeoutFor(providerName) {
  const key = Object.keys(PROVIDER_TIMEOUTS).find(k => providerName.startsWith(k));
  return key ? PROVIDER_TIMEOUTS[key] : 25000;
}

// ─── Cost table (USD per 1M tokens) ────────────────────────────────────────

const COST_TABLE = {
  // Groq
  "groq":                        { input: 0.59,  output: 0.79 },
  // Cerebras
  "cerebras":                    { input: 0.60,  output: 0.60 },
  // Google AI Studio (free tier — mark as 0)
  "google":                      { input: 0,     output: 0    },
  // Mistral Small (free tier)
  "mistral":                     { input: 0,     output: 0    },
  // Ollama — local, always free
  "ollama/qwen2.5:7b":           { input: 0,     output: 0    },
  "ollama/qwen2.5-coder:32b":    { input: 0,     output: 0    },
  // Copilot — treat as quota cost, not cash cost; flag with sentinel
  "copilot/claude-sonnet-4.6":   { input: 3.00,  output: 15.00, quota: true },
  // OpenRouter free
  "openrouter":                  { input: 0,     output: 0    },
};

function estimateCost(providerName, usage) {
  if (!usage) return null;
  const key = Object.keys(COST_TABLE).find(k => providerName.startsWith(k));
  if (!key) return null;
  const rates = COST_TABLE[key];
  const inputCost  = ((usage.prompt_tokens     || 0) / 1e6) * rates.input;
  const outputCost = ((usage.completion_tokens  || 0) / 1e6) * rates.output;
  return { inputCost, outputCost, total: inputCost + outputCost, quota: !!rates.quota };
}

// ─── Request log ring buffer ─────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 200;
const requestLog = [];
let totalRequests  = 0;
let totalCostUsd   = 0;
let copilotCalls   = 0;

function recordRequest(entry) {
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_ENTRIES) requestLog.shift();
  totalRequests++;
  if (entry.cost?.total)  totalCostUsd += entry.cost.total;
  if (entry.provider?.startsWith("copilot")) copilotCalls++;
}

// ─── Server ─────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (method === "POST" && url === "/v1/chat/completions") return handleCompletions(req, res);
  if (method === "GET"  && url === "/v1/models")           return handleModels(req, res);
  if (method === "GET"  && (url === "/status" || url === "/health")) return handleStatus(req, res);
  if (method === "GET"  && url.startsWith("/log"))          return handleLog(req, res);
  sendJson(res, 404, { error: { message: "Not found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`polly-router Phase 3 listening on http://127.0.0.1:${PORT}`);
  log("providers", { available: Object.keys(config.providers || {}) });
  log("vault probe", { bin: NODE_BIN, qmd: QMD_JS, collection: "vault" });
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") console.error(`[polly-router] Port ${PORT} in use`);
  else console.error("[polly-router] Server error:", e.message);
  process.exit(1);
});

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT",  () => { server.close(); process.exit(0); });
