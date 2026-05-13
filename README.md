# Polly Router

**Vault-aware intelligent LLM routing for OpenClaw.**

Polly Router sits between your agents and model providers, making context-aware decisions about which model to use for each request. It prioritizes local (free) inference when possible, escalates to cloud models when complexity demands it, and injects vault context when queries touch your knowledge base.

---

## Why This Exists

Most agent frameworks hardcode a single model per agent. That wastes money on simple queries and breaks when complex queries hit a weak model. Polly Router solves both:

- **Free-first routing**: Local Ollama models handle routine work
- **Intelligent escalation**: Hard queries automatically reach cloud providers (Groq, Google, Copilot, etc.)
- **Vault integration**: Your Obsidian vault content is injected as context when relevant
- **Cost tracking**: Per-model budgets and daily limits prevent runaway spending
- **Agent-aware contracts**: Local models get reduced toolsets; cloud models get full capability

---

## Quick Start

```bash
# 1. Clone and build
git clone https://github.com/brettgershon/polly-router.git
cd polly-router
npm install
npm run build

# 2. Configure (copy example and edit)
cp polly-router.config.example.json polly-router.config.json
# Edit: add your API keys, set Ollama URL, configure QMD

# 3. Start the router
npm start
# Router listens on http://127.0.0.1:4000 by default

# 4. Point OpenClaw at it
# In openclaw.json: "model": "http://127.0.0.1:4000/v1/chat/completions"
```

---

## Architecture

```
User Request
    │
    ▼
┌─────────────────┐
│   Classifier    │  ──► Simple vs Hard? (token heuristics)
└─────────────────┘
    │
    ▼
┌─────────────────┐
│   Vault Probe   │  ──► Query QMD for relevant vault chunks
│   (QMD/RAG)     │     ABSENT | LOW | MEDIUM | HIGH confidence
└─────────────────┘
    │
    ▼
┌─────────────────┐
│    Router       │  ──► Build prioritized chain:
│   (buildChain)  │     Local Ollama → Cloud fallback → Budget check
└─────────────────┘
    │
    ▼
┌─────────────────┐
│  Contract       │  ──► Reduce tools for local models
│  Translation    │     (exec preserved if agent needs it)
└─────────────────┘
    │
    ▼
┌─────────────────┐
│   Provider      │  ──► Execute chain until success
│   Chain         │     (Ollama → Groq → Cerebras → Google → ...)
└─────────────────┘
    │
    ▼
┌─────────────────┐
│   Response      │  ──► Plain-text tool call rewriting
│   (rewrite)     │     (Qwen/Cerebras compatibility)
└─────────────────┘
```

---

## Configuration

`polly-router.config.json`:

```json
{
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434"
  },
  "providers": {
    "groq": {
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKey": "YOUR_GROQ_KEY",
      "defaultModel": "llama-3.3-70b-versatile",
      "dailyRequestLimit": 100,
      "maxRequestChars": 40000
    },
    "google": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
      "apiKey": "YOUR_GOOGLE_KEY",
      "defaultModel": "gemini-2.5-flash",
      "dailyRequestLimit": 1500,
      "maxRequestChars": 400000
    }
  },
  "qmd": {
    "baseUrl": "http://localhost:8181",
    "collection": "vault",
    "timeoutMs": 3000
  }
}
```

**Provider priority** (from cheapest to most capable):
1. **Ollama** (local, free) — `llama3.2`, `qwen2.5-coder:32b`, etc.
2. **Groq** (free tier) — Fast inference, generous limits
3. **Cerebras** (free tier) — LPU-style inference, Groq backup
4. **Google** (free tier) — `gemini-2.5-flash`, large context
5. **Mistral** (free tier) — Structured JSON reliable
6. **Ollama Pro** (paid) — Cloud Ollama, premium fallback
7. **GitHub Copilot** (paid) — Claude Sonnet, Opus

---

## Routing Logic

### Complexity Detection

| Signal | Local Model | Cloud Fallback |
|--------|-------------|----------------|
| Simple query (<2k chars, no tools) | Ollama any | None |
| Medium query (2k-8k chars, basic tools) | Ollama 32B | Groq/Mistral |
| Hard query (>8k chars, complex tools) | None | Google/Copilot |
| Vault-relevant (HIGH confidence) | All get vault context | — |

### Vault Confidence Levels

- **ABSENT** — No relevant vault content → skip local, go straight to cloud
- **LOW** (0.5-0.7) — Some context → inject, prefer cloud
- **MEDIUM** (0.7-0.89) — Good context → inject, local acceptable
- **HIGH** (>0.89) — Strong match → inject, local preferred

### Budget Enforcement

Each provider has `dailyRequestLimit`. When exceeded:
1. Log warning
2. Skip to next provider in chain
3. If all exhausted, return error

---

## Agent-Aware Contract Translation

Local models can't handle 20+ tools. Polly Router reduces the tool surface:

**Default local surface** (5 tools):
- `memory_search`, `memory_get`, `update_plan`, `read`, `write`

**Agent-aware preservation**:
- If agent's original tools include `exec` → preserve it for local
- This lets filesystem-exploration agents (cartographer, scheduler) work locally

**System prompt rewrite**:
- Cloud models get full system prompt
- Local models get compressed version with reduced tool descriptions

---

## Testing

```bash
# Run all tests
npm test

# Specific test
npx jest contractTranslation
npx jest router

# Coverage
npx jest --coverage
```

**Test files**:
- `contractTranslation.test.ts` — Tool reduction invariants
- `router.test.ts` — Chain building logic
- `router-honesty.test.ts` — Fallback behavior verification
- `injector.test.ts` — Vault context injection
- `ollama.test.ts` — Local model availability

---

## Design Principles

1. **Transparent routing** — Every decision is logged; you can trace why a model was chosen
2. **Vault-first context** — Your knowledge base is the primary signal, not cost
3. **Free-tier maximalism** — Exhaust free options before paid
4. **Agent capability preservation** — Never strip tools an agent genuinely needs
5. **Fail-open** — If router breaks, requests fall through to configured fallback

---

## Requirements

- **Node.js** 18+ (async iterators, fetch)
- **Ollama** (optional, for local inference)
- **QMD** (optional, for vault RAG — any OpenAI-compatible embedding service)
- **OpenClaw** 2026.4+ (for agent contract translation)

---

## License

MIT — See [LICENSE](./LICENSE)

---

## Related

- [OpenClaw](https://github.com/openclaw/openclaw) — Agent orchestration platform
- [QMD](https://github.com/yourname/qmd) — Vault query service (plug your own)
- [Polly Framework](https://github.com/yourname/polly) — Full agent framework (WIP)

---

*Built by Brett Gershon for the Polly framework. Not affiliated with OpenClaw officially.*
