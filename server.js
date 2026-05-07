#!/usr/bin/env node
/**
 * polly-router — Phase 2
 * Provider adapters: Ollama, Groq, Cerebras, Google AI Studio, Mistral,
 *                    GitHub Copilot OAuth, OpenRouter (overflow)
 * Routing: Phase 1 heuristic complexity classification only (Phase 3 adds QMD vault probe)
 *
 * Port: 4200   Config: ./config.json
 */

"use strict";

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.POLLY_ROUTER_CONFIG
  || path.join(__dirname, "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    console.error("[polly-router] Config load failed:", e.message);
    process.exit(1);
  }
}

let config = loadConfig();
fs.watchFile(CONFIG_PATH, { interval: 3000 }, () => {
  try { config = loadConfig(); log("config reloaded"); }
  catch (e) { console.error("[polly-router] Config reload failed:", e.message); }
});

const PORT = parseInt(process.env.POLLY_ROUTER_PORT || "4200", 10);

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg, meta = {}) {
  const ts = new Date().toISOString();
  const s  = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  console.log(`[${ts}] ${msg}${s}`);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const useHttps = parsed.protocol === "https:";
    const lib     = useHttps ? https : http;
    const payload = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null;

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (useHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ""),
      method:   options.method || "GET",
      headers:  { ...options.headers },
    };
    if (payload) {
      opts.headers["Content-Length"] = payload.length;
    }

    const req = lib.request(opts, resolve);
    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 30000, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data",  c => chunks.push(c));
    stream.on("end",   () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
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
  const text  = (Array.isArray(last.content)
    ? last.content.map(c => c.text || "").join(" ")
    : last.content || "").toLowerCase();
  const toks  = text.split(/\s+/).length;

  if (LIGHT_PATTERNS.some(p => p.test(text)) && toks < 30) return "LIGHT";
  if (HEAVY_PATTERNS.some(p => p.test(text)) || toks > 800) return "HEAVY";
  return "MEDIUM";
}

// ─── Copilot OAuth token ──────────────────────────────────────────────────────

let _copilotToken = null;
let _copilotTokenExpiry = 0;

async function getCopilotToken() {
  if (_copilotToken && Date.now() < _copilotTokenExpiry) return _copilotToken;

  // Load stored OAuth token
  const appsPath = path.join(process.env.HOME, ".config/github-copilot/apps.json");
  let oauthToken;
  try {
    const apps = JSON.parse(fs.readFileSync(appsPath, "utf-8"));
    const entry = Object.values(apps)[0];
    oauthToken = entry.oauth_token;
  } catch (e) {
    throw new Error("Copilot OAuth token not found: " + e.message);
  }

  // Exchange for short-lived Copilot API token
  const res = await httpRequest(
    "https://api.github.com/copilot_internal/v2/token",
    {
      method: "GET",
      headers: {
        "Authorization": `token ${oauthToken}`,
        "Accept": "application/json",
        "User-Agent": "polly-router/0.2",
      },
    }
  );
  const body = await readStream(res);
  const data = JSON.parse(body);
  if (!data.token) throw new Error("Copilot token exchange failed: " + body);

  _copilotToken = data.token;
  _copilotTokenExpiry = Date.now() + (data.expires_in ? data.expires_in * 1000 : 25 * 60 * 1000);
  log("copilot token refreshed", { expiresIn: data.expires_in });
  return _copilotToken;
}

// ─── Provider Adapters ────────────────────────────────────────────────────────

/**
 * Generic OpenAI-compatible dispatch (streaming passthrough).
 * Returns the upstream IncomingMessage on success, throws on error.
 */
async function dispatchOpenAI({ baseUrl, apiKey, model, body, extraHeaders = {} }) {
  const url     = new URL(`${baseUrl}/chat/completions`);
  const payload = Buffer.from(JSON.stringify({ ...body, model }));
  const useHttps = url.protocol === "https:";
  const lib = useHttps ? https : http;

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port:     url.port || (useHttps ? 443 : 80),
      path:     url.pathname,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": payload.length,
        "Authorization":  `Bearer ${apiKey}`,
        "User-Agent":     "polly-router/0.2",
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

/** Ollama via its native /api/chat (OpenAI-compat endpoint also available). */
async function dispatchOllama({ model, body }) {
  const baseUrl = config.providers.ollama?.baseUrl || "http://127.0.0.1:11434";
  return dispatchOpenAI({
    baseUrl: baseUrl + "/v1",
    apiKey: "ollama",
    model,
    body,
  });
}

async function dispatchGroq({ body }) {
  const p = config.providers.groq;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body });
}

async function dispatchCerebras({ body }) {
  const p = config.providers.cerebras;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body });
}

async function dispatchGoogle({ body }) {
  const p = config.providers.google;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body });
}

async function dispatchMistral({ body }) {
  const p = config.providers.mistral;
  return dispatchOpenAI({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.defaultModel, body });
}

async function dispatchCopilot({ body, model }) {
  const token = await getCopilotToken();
  return dispatchOpenAI({
    baseUrl: "https://api.githubcopilot.com",
    apiKey: token,
    model: model || "claude-sonnet-4.6",
    body,
    extraHeaders: {
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.95.0",
    },
  });
}

async function dispatchOpenRouter({ body, model }) {
  const p = config.providers.openrouter;
  if (!p?.apiKey) throw new Error("openrouter not configured");
  return dispatchOpenAI({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: p.apiKey,
    model: model || "qwen/qwen3-235b-a22b:free",
    body,
    extraHeaders: { "HTTP-Referer": "https://polly-router" },
  });
}

// ─── Ollama health check ──────────────────────────────────────────────────────

let _ollamaAvailable = null;
let _ollamaCheckTime = 0;

async function isOllamaAvailable() {
  if (Date.now() - _ollamaCheckTime < 15000) return _ollamaAvailable;
  try {
    const base = config.providers.ollama?.baseUrl || "http://127.0.0.1:11434";
    const res  = await new Promise((resolve, reject) => {
      const req = http.get(base + "/api/tags", resolve);
      req.on("error", reject);
      req.setTimeout(1500, () => req.destroy(new Error("timeout")));
    });
    _ollamaAvailable = res.statusCode === 200;
  } catch {
    _ollamaAvailable = false;
  }
  _ollamaCheckTime = Date.now();
  return _ollamaAvailable;
}

function ollamaModelFor(complexity) {
  const models = {
    LIGHT:  "qwen2.5:7b",
    MEDIUM: "qwen2.5-coder:32b",
    HEAVY:  "qwen2.5-coder:32b",
  };
  return models[complexity] || "qwen2.5:7b";
}

// ─── Routing (Phase 2: complexity + provider priority) ────────────────────────

/**
 * Build an ordered list of dispatch attempts for the request.
 * Each entry: { name, fn }
 */
async function buildDispatchChain(body, complexity) {
  const ollamaOk = await isOllamaAvailable();
  const chain = [];

  if (complexity === "LIGHT") {
    if (ollamaOk) chain.push({ name: "ollama/qwen2.5:7b",         fn: () => dispatchOllama({ model: "qwen2.5:7b", body }) });
    chain.push({ name: "groq/llama-3.3-70b-versatile",            fn: () => dispatchGroq({ body }) });
    chain.push({ name: "cerebras/llama-3.3-70b",                  fn: () => dispatchCerebras({ body }) });
    chain.push({ name: "mistral/mistral-small-latest",            fn: () => dispatchMistral({ body }) });
    chain.push({ name: "google/gemini-2.5-flash",                 fn: () => dispatchGoogle({ body }) });
  } else if (complexity === "MEDIUM") {
    if (ollamaOk) chain.push({ name: "ollama/qwen2.5-coder:32b",  fn: () => dispatchOllama({ model: "qwen2.5-coder:32b", body }) });
    chain.push({ name: "groq/llama-3.3-70b-versatile",            fn: () => dispatchGroq({ body }) });
    chain.push({ name: "google/gemini-2.5-flash",                 fn: () => dispatchGoogle({ body }) });
    chain.push({ name: "cerebras/llama-3.3-70b",                  fn: () => dispatchCerebras({ body }) });
    chain.push({ name: "mistral/mistral-small-latest",            fn: () => dispatchMistral({ body }) });
  } else {
    // HEAVY — go to frontier early
    chain.push({ name: "copilot/claude-sonnet-4.6",               fn: () => dispatchCopilot({ body, model: "claude-sonnet-4.6" }) });
    chain.push({ name: "google/gemini-2.5-flash",                 fn: () => dispatchGoogle({ body }) });
    if (ollamaOk) chain.push({ name: "ollama/qwen2.5-coder:32b",  fn: () => dispatchOllama({ model: "qwen2.5-coder:32b", body }) });
    chain.push({ name: "groq/llama-3.3-70b-versatile",            fn: () => dispatchGroq({ body }) });
  }

  // Always: OpenRouter as final overflow
  if (config.providers?.openrouter?.apiKey) {
    chain.push({ name: "openrouter/qwen3-235b-a22b:free",         fn: () => dispatchOpenRouter({ body }) });
  }
  // Absolute last resort: Copilot (if not already first)
  if (complexity !== "HEAVY") {
    chain.push({ name: "copilot/claude-sonnet-4.6",               fn: () => dispatchCopilot({ body, model: "claude-sonnet-4.6" }) });
  }

  return chain;
}

// ─── Request handlers ─────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data",  c => chunks.push(c));
    req.on("end",   () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
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

  const complexity = classifyComplexity(body.messages);
  const chain      = await buildDispatchChain(body, complexity);
  const startMs    = Date.now();

  log("routing", { complexity, chain: chain.map(c => c.name) });

  let lastError;
  for (const attempt of chain) {
    try {
      const upstream = await attempt.fn();

      if (upstream.statusCode >= 500 || upstream.statusCode === 429) {
        const errBody = await readStream(upstream);
        log("provider error — trying next", { provider: attempt.name, status: upstream.statusCode });
        lastError = `${attempt.name} → ${upstream.statusCode}: ${errBody.slice(0, 120)}`;
        continue;
      }

      if (upstream.statusCode >= 400) {
        // 4xx (other than 429) — likely a bad request, don't retry
        res.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
        upstream.pipe(res);
        return;
      }

      const headers = {
        "Content-Type":      upstream.headers["content-type"] || "application/json",
        "Cache-Control":     "no-cache",
        "X-Polly-Provider":  attempt.name,
        "X-Polly-Complexity": complexity,
      };
      if (body.stream) headers["Transfer-Encoding"] = "chunked";

      res.writeHead(200, headers);
      upstream.pipe(res);
      upstream.on("end", () => log("complete", { provider: attempt.name, complexity, ms: Date.now() - startMs }));
      return;

    } catch (e) {
      log("dispatch error — trying next", { provider: attempt.name, error: e.message });
      lastError = `${attempt.name} → ${e.message}`;
    }
  }

  // All providers failed
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
  sendJson(res, 200, {
    status: "ok",
    phase: 2,
    uptime: process.uptime(),
    port: PORT,
    providers: Object.keys(config.providers || {}),
    ollamaAvailable: _ollamaAvailable,
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (method === "POST" && url === "/v1/chat/completions") return handleCompletions(req, res);
  if (method === "GET"  && url === "/v1/models")           return handleModels(req, res);
  if (method === "GET"  && (url === "/status" || url === "/health")) return handleStatus(req, res);

  sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`polly-router Phase 2 listening on http://127.0.0.1:${PORT}`);
  log("providers", { available: Object.keys(config.providers || {}) });
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") console.error(`[polly-router] Port ${PORT} in use`);
  else console.error("[polly-router] Server error:", e.message);
  process.exit(1);
});

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT",  () => { server.close(); process.exit(0); });
