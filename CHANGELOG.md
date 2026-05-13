# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-13

### Added
- Initial public release
- Vault-aware routing with QMD integration
- Intelligent complexity classification (simple/medium/hard)
- Provider chain building with budget enforcement
- Agent-aware contract translation for local models
- Plain-text tool call rewriting (Qwen/Cerebras compatibility)
- Cost tracking and daily budget limits per provider
- Support for 7 provider tiers: Ollama, Groq, Cerebras, Google, Mistral, Ollama Pro, Copilot
- TypeScript implementation with full type coverage
- Jest test suite covering core invariants

### Architecture
- **Classifier**: Token-based complexity detection
- **Vault Probe**: QMD/RAG context injection with confidence scoring
- **Router**: Priority chain construction (local → cloud fallback)
- **Contract Translation**: Dynamic tool surface reduction
- **Budget Manager**: Per-provider daily limits and tracking

### Design Decisions
- Free-tier-first routing (maximize free model usage)
- Vault confidence as primary routing signal
- Agent capability preservation (exec maintained when needed)
- Transparent logging (every routing decision is traceable)

## [0.1.0] - 2026-04-08 (Pre-release)

### Added
- Initial prototype
- Basic OpenAI-compatible proxy
- Ollama and Groq provider adapters
- Simple request forwarding

[1.0.0]: https://github.com/brettgershon/polly-router/releases/tag/v1.0.0
