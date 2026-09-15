# Persona Reliability Feedback Loop — Readiness Checklist

> Card: R3-F.1 — Guardrail spec: distinguish real local failures from gateway misconfiguration
> Date: 2026-07-13

This checklist must be completed before `reliability.enabled` is set to `true` in `polly-router.config.json`.

## Gateway / Ollama health

- [ ] `ollama` process is running and `GET http://127.0.0.1:11434/api/tags` returns 200 within 1500 ms.
- [ ] Every model listed in `polly-router.config.json` → `ollama.models[].id` appears in `/api/tags`.
- [ ] No `HTTP_PROXY` / `HTTPS_PROXY` environment variables are set without `NO_PROXY` covering `localhost,127.0.0.1`.
- [ ] `OLLAMA_KEEP_ALIVE` is not `0` for models you want the router to keep loaded.

## Context / capacity

- [ ] Effective `num_ctx` (from `/api/show`) for each configured model is at least:
  - light model: 4096
  - medium model: 8192
  - heavy model: 32768
- [ ] The largest expected request + injected vault context fits inside the heavy model's effective `num_ctx`.
- [ ] `OLLAMA_NUM_PARALLEL` ≥ 1 and `OLLAMA_MAX_QUEUE` ≥ 1 (or tuned for expected load).

## Capability probes

- [ ] A synthetic end-to-end probe succeeds for every configured local model:
  - POST `/v1/chat/completions`
  - tiny prompt: "Say 'ok' and nothing else."
  - response contains HTTP 200 and the text "ok"
- [ ] The probe is reflected in `/status` under `reliability.diagnostics.details`.

## Configuration

- [ ] `reliability.enabled` is explicitly set to `true` in `polly-router.config.json`.
- [ ] `reliability.windowDays`, `reliability.minAttempts`, and `reliability.minSuccessRate` are reviewed and appropriate for the persona mix.
- [ ] `reliability.gcDays` is set (default 30) so stale records do not accumulate.

## Router behavior

- [ ] `/status` returns `reliability.active: true` after startup.
- [ ] A local-routed LIGHT request completes without falling back to cloud.
- [ ] An artificially induced 404 from a local model is logged with `failure_class: config_error` and does **not** move the reliability success rate.
- [ ] An artificially induced JSON/contract failure from a local model is logged with `failure_class: model_error` and **does** count toward the 7-day success rate.
- [ ] When the success rate for a `(persona, task_type)` drops below `minSuccessRate` after `minAttempts` model_error attempts, the router biases from `LOCAL` → `LOCAL+CTX` or `LOCAL+CTX` → `CLOUD`.
- [ ] Cloud bias never upgrades a `CLOUD` cell back to local.

## Operational safety

- [ ] `system/persona-reliability.jsonl` is writable and rotates via `gcReliability()`.
- [ ] A plan exists to periodically review captured `ambiguous` failures.
- [ ] A rollback procedure exists: set `reliability.enabled: false`, restart router, and optionally delete `system/persona-reliability.jsonl`.

## Sign-off

- [ ] Design doc reviewed: `projects/polly/research/2026-07-13-persona-reliability-guardrails.md`
- [ ] Code compiles (`npm run build` passes with no errors).
- [ ] Existing test suite passes (`npm test`).
- [ ] Production dry-run completed with `reliability.enabled: true` and observed for at least 24 hours.
