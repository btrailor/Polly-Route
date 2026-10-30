# Polly Router

**Vault-aware intelligent LLM routing for OpenClaw.**

Polly Router sits between your agents and model providers, making context-aware decisions about which model to use for each request. It prioritizes local (free) inference when possible, escalates to cloud models when complexity demands it, and injects vault context when queries touch your knowledge base.

---

## Why This Exists

Most agent frameworks hardcode a single model per agent. That wastes money on simple queries and breaks when complex queries hit a weak model. Polly Router solves both:

- **Free-first routing**: Local Ollama models handle routine work
- **Intelligent escalation**: Hard queries automatically reach cloud providers (Groq, Google, Copilot, etc.)
- **Vault integration**: Your Obsidian vault content is injected as context when relevant
- **Domain-aware routing**: Conductor domain manifests inject action menus and bias routing toward local models for domain-specific tasks
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
│ Conductor Probe │  ──► Scan domain manifests for matching actions
│ (domain-aware)  │     Inject action menu + bias toward local models
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

### Modes

`modes.json` holds the mode definitions. It is **tracked in this repo** and is the
canonical source — the router prefers it over `~/.openclaw/modes.json`, so the mode
definitions travel with the code and are reviewed like any other source file.

Resolution order:
1. `OPENCLAW_MODES_PATH` — explicit override (used by tests)
2. `modes.json` in the repo root — the tracked, canonical copy
3. `~/.openclaw/modes.json` — legacy per-machine location, still honored

| Mode | Routing | Subagents | Purpose |
|------|---------|-----------|---------|
| `default` | auto | yes | Balanced; defers to agent and router defaults |
| `fast` | local-first | no | Low-latency single turns, capped at MEDIUM complexity |
| `precise` | best | yes | High-accuracy reasoning, research and verification allowed |
| `creative` | best | yes | Generative and exploratory, web search enabled |
| `ops` | local | no | Local-only filesystem and config work, no cloud leakage |
| `syntaxis` | **local (absolute)** | **yes** | Local-only *with* delegation — for Syntaxis pipeline work |
| `lockdown` | local (absolute) | no | Absolute local-only, no network tools, no cloud models |

The `absolute` flag is what strips the cloud fallback chain entirely: when it is set,
`forceLocal` in `router.ts` removes the cloud providers from the chain, so a local
failure can never be silently absorbed by a cloud provider.

`syntaxis` exists because `ops` and `lockdown` both disable subagents, which makes them
unusable for pipeline work that fans out across agents. `syntaxis` is local-absolute for
*routing* while still permitting delegation.

---

## Conductor Domain Probes

Polly Router can detect when a user's request matches a domain you've defined and inject structured context that helps local models produce correct output.

### How it works

1. You create **domain manifests** — JSON files that describe a domain's available actions, their command templates, and trigger phrases
2. When a request comes in, the conductor probe scores the user's query against all manifests in your configured domains directory
3. If a match is found, the action menu is injected as context and routing is biased toward local models (which can now handle the task because they have the exact commands)
4. If no match, routing proceeds normally

### Defining a domain

Create a directory with a `manifest.json`:

```bash
mkdir -p ~/my-domains/my-project
cp manifest.example.json ~/my-domains/my-project/manifest.json
# Edit the manifest to define your actions
```

Manifest schema (see `manifest.example.json` for a full template):

```json
{
  "domain": "my-domain",
  "description": "Describe what this domain covers — used for keyword matching",
  "actions": [
    {
      "id": "my_action",
      "description": "What this action does",
      "triggers": ["generate", "create", "build"],
      "params": {
        "name": { "type": "string", "required": true }
      },
      "execute": "python3 run.py --name {{name}}",
      "gates": ["exit_zero"],
      "timeout": 60
    }
  ]
}
```

Key fields:

| Field | Purpose |
|-------|--------|
| `domain` | Stable identifier for the domain |
| `description` | Used for keyword matching against user queries |
| `actions[].triggers` | Phrases that boost the action's match score when they appear in the query. Domain-agnostic — any domain declares its own |
| `actions[].execute` | Command template with `{{param}}` substitution |
| `actions[].gates` | Deterministic checks to run after execution (`exit_zero`, `valid_json_output`, or custom scripts) |

### Wiring it into Polly Router

Add the conductor config block to your `polly-router.config.json`:

```json
{
  "conductor": {
    "domainsDir": "~/my-domains",
    "timeoutMs": 2000,
    "minScore": 0.35
  }
}
```

That's it. Drop manifests in the directory, restart the router, and domain-aware routing is active.

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
