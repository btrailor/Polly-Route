#!/usr/bin/env node
/**
 * polly-router — Phase 4
 * Adds QMD vault probe to routing intelligence.
 *
 * Routing decision matrix:
 *   DIRECT   (vault score ≥ 0.75) + LIGHT   → Ollama small
 *   DIRECT   (vault score ≥ 0.75) + MEDIUM  → Ollama 32b
 *   DIRECT   (vault score ≥ 0.75) + HEAVY   → Ollama 32b (escalate on fail)
 *   ADJACENT (0.50–0.74)          + LIGHT   → Groq/Cerebras/Mistral + vault context
 *   ADJACENT                      + MEDIUM  → Groq/Google + vault context
 *   ADJACENT                      + HEAVY   → Google/Groq + vault context
 *   ABSENT   (< 0.50)             + LIGHT   → Groq/Cerebras/Mistral
 *   ABSENT                        + MEDIUM  → Groq/Google/Cerebras
 *   ABSENT                        + HEAVY   → Copilot → Google → Groq
 *
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
      { timeout: 8000, env: { ...process.env } },
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

function getWorker() {
  if (_worker && !_worker.killed) return _worker;
  log("starting QMD worker");
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
        const cb  = _workerCbs[msg.id];
        if (cb) { clearTimeout(cb.timer); delete _workerCbs[msg.id]; cb.resolve(msg); }
      } catch {}
    }
  });
  _worker.stderr.on("data", () => {}); // suppress QMD progress output
  _worker.on("exit", (code) => {
    log("QMD worker exited", { code });
    _worker = null;
    // Reject any pending callbacks
    for (const [id, cb] of Object.entries(_workerCbs)) {
      clearTimeout(cb.timer);
      cb.resolve({ id, error: "worker exited" });
    }
    _workerCbs = {};
    // Restart after 1s
    setTimeout(getWorker, 1000);
  });
  // Warm up: send a dummy query so models load now
  setTimeout(() => {
    const warmId = "warm_" + Date.now();
    _worker.stdin.write(JSON.stringify({ id: warmId, query: "polly router" }) + "\n");
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
        if (topScore >= 0.75 && results.length >= 2 && totalLen >= 300) confidence = "DIRECT";
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

async function dispatchOpenAI({ baseUrl, apiKey, model, body, extraHeaders = {} }) {
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
    req.setTimeout(60000, () => req.destroy(new Error("timeout")));
    req.write(payload);
    req.end();
  });
}

async function dispatchOllama(model, body) {
  const base = (config.providers.ollama?.baseUrl || "http://127.0.0.1:11434") + "/v1";
  return dispatchOpenAI({ baseUrl: base, apiKey: "ollama", model, body });
}
async function dispatchGroq(body) {
  const p = config.providers.groq;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body });
}
async function dispatchCerebras(body) {
  const p = config.providers.cerebras;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body });
}
async function dispatchGoogle(body) {
  const p = config.providers.google;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body });
}
async function dispatchMistral(body) {
  const p = config.providers.mistral;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body });
}
async function dispatchCopilot(body, model = "claude-sonnet-4.6") {
  const token = await getCopilotToken();
  return dispatchOpenAI({
    baseUrl: "https://api.githubcopilot.com",
    apiKey: token, model, body,
    extraHeaders: { "Copilot-Integration-Id": "vscode-chat", "Editor-Version": "vscode/1.95.0" },
  });
}
async function dispatchOpenRouter(body, model = "qwen/qwen3-235b-a22b:free") {
  const p = config.providers.openrouter;
  if (!p?.apiKey) throw new Error("openrouter not configured");
  return dispatchOpenAI({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: p.apiKey, model, body,
    extraHeaders: { "HTTP-Referer": "https://polly-router" },
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

  // Inject vault context for DIRECT/ADJACENT
  const enriched = (confidence !== "ABSENT" && chunks.length)
    ? injectVaultContext(body, chunks)
    : body;

  const chain = [];

  if (confidence === "DIRECT") {
    // Vault has the answer — local first regardless of complexity
    if (ollamaOk) {
      const model = complexity === "LIGHT" ? "qwen2.5:7b" : "qwen2.5-coder:32b";
      chain.push({ name: `ollama/${model}`, fn: () => dispatchOllama(model, enriched) });
    }
    chain.push({ name: "groq",     fn: () => dispatchGroq(enriched) });
    chain.push({ name: "google",   fn: () => dispatchGoogle(enriched) });
    chain.push({ name: "cerebras", fn: () => dispatchCerebras(enriched) });

  } else if (confidence === "ADJACENT") {
    if (complexity === "LIGHT") {
      if (ollamaOk) chain.push({ name: "ollama/qwen2.5:7b", fn: () => dispatchOllama("qwen2.5:7b", enriched) });
      chain.push({ name: "groq",     fn: () => dispatchGroq(enriched) });
      chain.push({ name: "cerebras", fn: () => dispatchCerebras(enriched) });
      chain.push({ name: "mistral",  fn: () => dispatchMistral(enriched) });
      chain.push({ name: "google",   fn: () => dispatchGoogle(enriched) });
    } else if (complexity === "MEDIUM") {
      chain.push({ name: "groq",   fn: () => dispatchGroq(enriched) });
      chain.push({ name: "google", fn: () => dispatchGoogle(enriched) });
      if (ollamaOk) chain.push({ name: "ollama/qwen2.5-coder:32b", fn: () => dispatchOllama("qwen2.5-coder:32b", enriched) });
      chain.push({ name: "cerebras", fn: () => dispatchCerebras(enriched) });
    } else { // HEAVY
      chain.push({ name: "google", fn: () => dispatchGoogle(enriched) });
      chain.push({ name: "groq",   fn: () => dispatchGroq(enriched) });
      if (ollamaOk) chain.push({ name: "ollama/qwen2.5-coder:32b", fn: () => dispatchOllama("qwen2.5-coder:32b", enriched) });
    }

  } else { // ABSENT
    if (complexity === "LIGHT") {
      if (ollamaOk) chain.push({ name: "ollama/qwen2.5:7b", fn: () => dispatchOllama("qwen2.5:7b", body) });
      chain.push({ name: "groq",     fn: () => dispatchGroq(body) });
      chain.push({ name: "cerebras", fn: () => dispatchCerebras(body) });
      chain.push({ name: "mistral",  fn: () => dispatchMistral(body) });
      chain.push({ name: "google",   fn: () => dispatchGoogle(body) });
    } else if (complexity === "MEDIUM") {
      if (ollamaOk) chain.push({ name: "ollama/qwen2.5-coder:32b", fn: () => dispatchOllama("qwen2.5-coder:32b", body) });
      chain.push({ name: "groq",     fn: () => dispatchGroq(body) });
      chain.push({ name: "google",   fn: () => dispatchGoogle(body) });
      chain.push({ name: "cerebras", fn: () => dispatchCerebras(body) });
      chain.push({ name: "mistral",  fn: () => dispatchMistral(body) });
    } else { // HEAVY + ABSENT — frontier first
      chain.push({ name: "copilot/claude-sonnet-4.6", fn: () => dispatchCopilot(body) });
      chain.push({ name: "google",   fn: () => dispatchGoogle(body) });
      if (ollamaOk) chain.push({ name: "ollama/qwen2.5-coder:32b", fn: () => dispatchOllama("qwen2.5-coder:32b", body) });
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
  // For inline context injection we use a 2s race.
  const vaultPromise = probeVault(userMsg);

  // Give vault probe up to 2s before we route without it
  const vaultSignal = await Promise.race([
    vaultPromise,
    new Promise(r => setTimeout(() => r({ confidence: "ABSENT", score: 0, chunks: [] }), 2000)),
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
