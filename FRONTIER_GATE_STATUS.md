# Polly-Router — Frontier Gate Status

**Date:** 2026-07-14  
**Card:** `[P1] Revive Polly-Router as Frontier Gate` (`2965fa4f`)  
**Repo:** `/Users/brettgershon/.openclaw/workspace/polly-router`  
**Service:** Running on port `4200` (PID 28782, LaunchAgent `com.brett.polly-router`)  

---

## What Was Delivered

### 1. Service on port 4200 ✅
- Live and responding to `/status` and `/v1/chat/completions`
- LaunchAgent installed at `~/Library/LaunchAgents/com.brett.polly-router.plist`
- Hardened: `ThrottleInterval: 10s`, `KeepAlive: SuccessfulExit=false` (no restart spiral)
- Port enforced via `config.ts`: `Number(process.env.POLLY_ROUTER_PORT) || 4200`

### 2. Secrets-based config ✅
- API keys resolved via three-tier chain: `config.json apiKey` → env var → `~/.openclaw/secrets/<provider>_api_key`
- Secret files exist for: `groq`, `cerebras`, `google`, `mistral`, `ollamapro`
- `openrouter` / `openrouter_free` keys provided via `OPENROUTER_API_KEY` env var (set in gateway env)
- `deepseek` has no direct key (routes through OpenRouter fallback)
- Inline keys in `config.json` cleared (all empty strings; keys come from env/secrets)

### 3. OpenClaw provider registration ✅
- Registered in `~/.openclaw/openclaw.json` as `models.providers.polly-router`
- `baseUrl: "http://127.0.0.1:4200/v1"`, `api: "openai-completions"`, `authHeader: false`
- Model: `auto` (alias: "Polly Router")
- Listed in `agents.defaults.models` as `polly-router/auto → { alias: "Polly Router" }`

### 4. Vault-coverage probe ✅
- **Primary:** Knowledge Skill at `http://localhost:4201` (healthy, 5625 notes indexed)
- **Fallback:** QMD at `http://localhost:8181` (deprecated, used when KS unavailable)
- Probe sends user query → gets `confidence: DIRECT | ADJACENT | ABSENT` + score
- DIRECT (score ≥ 0.75): vault has the answer → prefer local
- ADJACENT (score 0.5–0.75): partial context → inject and route
- ABSENT (score < 0.5): no vault coverage → route by complexity

### 5. Skill-coverage probe ✅
- `src/skillCoverage.ts` parses `available-skills` table from workspace skills index
- Checks if any loaded skill covers the request domain
- Can upgrade an `ABSENT` vault signal to `ADJACENT` when a skill matches
- Configurable via `config.skillCoverage.indexPath` and `timeoutMs`

### 6. Model capability matrix ✅

| Tier | Provider | Model(s) | Role |
|------|----------|----------|------|
| 0 (Local, free) | Ollama | `qwen2.5:7b` | LIGHT: factual, short Q&A |
| 0 | Ollama | `qwen2.5-coder:32b` | MEDIUM: code, reasoning, summarization |
| 0 | Ollama | `qwen2.5:72b` | HEAVY: architecture, complex reasoning |
| 1 (Free cloud) | Groq | `llama-3.3-70b-versatile` | MEDIUM/HEAVY: fast cloud, 100 req/day |
| 1 | Cerebras | `gpt-oss-120b` | MEDIUM/HEAVY: Groq backup |
| 1 | Google | `gemini-2.5-flash` | HEAVY: 1M context, long docs, 1500 req/day |
| 1 | Mistral | `mistral-small-latest` | MEDIUM: structured JSON, 500 req/day |
| 1 | OpenRouter Free | `qwen3-coder:free` | MEDIUM: free tier overflow |
| 1 | Ollama Pro | `gemma4:31b`, `kimi-k2.7-code`, `glm-5.2` | MEDIUM/HEAVY: cloud Ollama (intermediary fallback) |
| 1 | Kimi Direct | `moonshot-v1-auto` | MEDIUM/HEAVY: direct Moonshot API, 300 req/day |
| 1 | GLM Direct | `glm-4-flash` | MEDIUM/HEAVY: direct Zhipu API, 300 req/day |
| 1 | Qwen Direct | `qwen-plus` | MEDIUM/HEAVY: direct DashScope API, 300 req/day |
| 2 (Paid cloud) | OpenRouter | `deepseek-chat-v3`, `deepseek-r1` | HEAVY: paid overflow |
| 3 (Scarce) | Copilot | (via OAuth) | LAST RESORT: scarce resource |

### 7. Escalation rules ✅

```
DIRECT + LIGHT   → Tier 0 (7B)
DIRECT + MEDIUM  → Tier 0 (32B)
DIRECT + HEAVY   → Tier 0 (72B) → Tier 1 on failure
ADJACENT + LIGHT → Tier 0 (7B) with vault context injected
ADJACENT + MEDIUM→ Tier 1 (Groq/Google/Mistral) with vault context
ADJACENT + HEAVY → Tier 1 (Google/Ollama Pro) → Tier 2 on failure
ABSENT + LIGHT   → Tier 0 (7B) — no capture needed
ABSENT + MEDIUM  → Tier 1 (free cloud) → capture response for vault
ABSENT + HEAVY   → Tier 1 → Tier 2 → Tier 3 (Copilot last)
```

On any provider error (429, 5xx, timeout): fall through to next provider in chain. All failures logged with provider + error. If all fail → structured error returned (no silent drop).

### 8. Mode/persona-substrate respect ✅
- Mode resolver wired into `server.ts` request pipeline (lines 191–247)
- Loads `~/.openclaw/modes.json` at startup; fails soft to default if missing
- Parses `/mode` commands from latest user message (`/mode list`, `/mode reset`, `/mode <id>`)
- Resolution order: `/mode` command → request `metadata.mode` → `OPENCLAW_MODE` env → `modes.json` default
- `lockdown` mode sets `forcedTarget = 'LOCAL'` → router skips all cloud providers
- `ops` mode sets `forcedTarget = 'LOCAL'` for ops-sensitive tasks
- Mode overrides applied before vault/skill/routing probes
- Resolved mode logged with provenance

### 9. Capture pipeline ✅
- When cloud provider handles an ABSENT/ADJACENT request, response is captured
- Captured notes written to `vault/20-Active/captured/` with `bloom: raw-ingest` frontmatter
- `vault_gap` labeled: `knowledge_gap` (ABSENT) or `capability_gap` (ADJACENT + cloud)
- Nightly bloom job processes captured notes into domain notes

### 10. Metrics ✅
- Rolling 7-day JSONL log at `system/polly-metrics.jsonl`
- Events: `routing_decision`, `capture`, `bloom`
- `/status` endpoint exposes rolling snapshot: cloud dependency ratio, local success rate, vault coverage, capture rate, bloom lag
- Per-day time-series available

---

## Test Suite

```
Test Suites: 19 passed, 19 total
Tests:       185 passed, 185 total
Time:        3.354s
```

Integration tests cover:
- ABSENT + MEDIUM → cloud + capture
- DIRECT + MEDIUM → local (no capture)
- ABSENT + LIGHT → local (no capture)
- ADJACENT + HEAVY → cloud + capability_gap capture
- Metrics aggregation across all scenarios

---

## What Remains (Out of Scope for This Card)

1. **Reliability feedback loop** — gated on R3-F.1 checklist (`RELIABILITY_READINESS_CHECKLIST.md`)
2. **Mode resolver wiring** — separate card `4369c7ad` (todo, high priority)
3. **Direct API adapters for Kimi/GLM/Qwen** — ✅ DELIVERED (see Direct API Adapters section below)
4. **Copilot OAuth adapter** — spec mentions it but it's not in the current provider mesh
5. **Cost dashboard UI** — not in scope
6. **Multi-modal routing** — images/audio, future

---

## Direct API Adapters (Kimi/GLM/Qwen)

**Date:** 2026-08-12
**Card:** `64a5edc4` — Direct API adapters for Kimi/GLM/Qwen

### What Was Delivered

Direct API adapters for three Chinese AI providers, bypassing the OpenRouter/Ollama Pro intermediary layer:

| Provider | Adapter File | Endpoint | Default Model | Daily Limit |
|----------|-------------|----------|---------------|------------|
| Kimi (Moonshot) | `src/providers/kimi.ts` | `https://api.moonshot.cn/v1` | `moonshot-v1-auto` | 300 req/day |
| GLM (Zhipu) | `src/providers/glm.ts` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 300 req/day |
| Qwen (DashScope) | `src/providers/qwen.ts` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 300 req/day |

### Key Resolution

Each provider follows the existing three-tier key resolution chain:
1. `config.json` `apiKey` field (empty by default)
2. Environment variable (`KIMI_API_KEY`, `GLM_API_KEY`, `QWEN_API_KEY`)
3. Secret file at `~/.openclaw/secrets/{kimi,glm,qwen}_api_key`

### Routing Priority

Direct adapters are inserted into the cloud fallback chain **before** Ollama Pro and OpenRouter, ensuring direct APIs are preferred when available. If a direct API fails (429/5xx/timeout), the router falls through to the intermediary providers (Ollama Pro → OpenRouter) which also expose Kimi/GLM/Qwen models.

### Adapter Features

- All three endpoints are OpenAI-compatible, using the existing `dispatchOpenAI` base helper
- `max_completion_tokens` is remapped to `max_tokens` (Kimi/GLM/Qwen use the older parameter name)
- `model: 'auto'` in the request body triggers fallback to the provider's `defaultModel` from config
- Per-provider configurable timeout (default: 60s)

### Test Coverage

- 20 unit tests in `tests/direct-adapters.test.ts`
- Tests cover: correct baseUrl/apiKey/model dispatch, model override behavior, max_completion_tokens remapping, timeout configuration, empty apiKey handling, routing preference over OpenRouter
- Full suite: 21 test suites, 247 tests passing (up from 19 suites, 185 tests)

### What Remains

- API keys need to be placed in `~/.openclaw/secrets/` (`kimi_api_key`, `glm_api_key`, `qwen_api_key`) to activate live API access
- Live API smoke tests should be run once keys are provisioned
- Daily request limits are conservative defaults (300/day); adjust per provider's actual tier

---

## Unblocks

- **R4** (mode resolver integration) — card `4369c7ad` can proceed
- **R6** (reliability guardrails) — gated on R3-F.1 checklist sign-off
- **R1** (provider consolidation) — polly-router is now the single seam