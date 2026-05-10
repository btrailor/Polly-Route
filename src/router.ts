import http from 'http';
import { RequestBody, Complexity, VaultSignal } from './types.js';
import { Config } from './config.js';
import { OllamaAdapter } from './providers/ollama.js';
import { groqAdapter, cerebrasAdapter, googleAdapter, mistralAdapter, openrouterAdapter } from './providers/cloud.js';
import { copilotAdapter } from './providers/copilot.js';
import { injectVaultContext, estimateChars } from './injector.js';

export interface ChainEntry {
  name: string;
  fn: (body: RequestBody) => Promise<http.IncomingMessage>;
}

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

export async function buildChain(
  body: RequestBody,
  complexity: Complexity,
  vault: VaultSignal,
  config: Config
): Promise<ChainEntry[]> {
  const ollama = new OllamaAdapter(config.ollama.models, config.ollama.baseUrl);
  const ollamaOk = await ollama.isAvailable();
  const requestChars = estimateChars(body.messages);

  // Vault context injection — the ONLY body modification permitted.
  // Cloud providers receive enriched body; local providers also receive it
  // (vault context helps local models too).
  const enriched = vault.confidence !== 'ABSENT' && vault.chunks.length
    ? injectVaultContext(body, vault.chunks)
    : body;

  // Pick local models — selection is on the UNMODIFIED request size (enriched may be slightly larger)
  const enrichedChars = estimateChars(enriched.messages);
  const localAny   = ollamaOk ? ollama.pickModel(enrichedChars) : null;
  const local32b   = ollamaOk ? ollama.pickModel(enrichedChars, 'medium') : null;

  log('routing', {
    complexity,
    vault: vault.confidence,
    vaultScore: vault.score.toFixed(2),
    requestChars,
    enrichedChars,
    localAny: localAny?.id ?? 'none',
    local32b: local32b?.id ?? 'none',
  });

  const p = config.providers;
  const chain: ChainEntry[] = [];

  const groq      = p.groq      ? groqAdapter(p.groq)           : null;
  const cerebras  = p.cerebras  ? cerebrasAdapter(p.cerebras)   : null;
  const google    = p.google    ? googleAdapter(p.google)        : null;
  const mistral   = p.mistral   ? mistralAdapter(p.mistral)     : null;
  const openrouter = p.openrouter ? openrouterAdapter(p.openrouter) : null;
  const copilot   = copilotAdapter();

  const push = (name: string, fn: ChainEntry['fn'] | null) => { if (fn) chain.push({ name, fn }); };
  const pushOllama = (model: ReturnType<OllamaAdapter['pickModel']>, b: RequestBody) => {
    if (model) chain.push({ name: `ollama/${model.id}`, fn: (dispatchBody: RequestBody) => ollama.dispatch(model, dispatchBody) });
  };

  if (vault.confidence === 'DIRECT') {
    if (complexity === 'HEAVY') {
      // HEAVY+DIRECT: cloud-first — prompt too complex for 32b, but inject vault context
      push('google',   google   ? () => google(enriched)   : null);
      push('groq',     groq     ? () => groq(enriched)     : null);
      chain.push({ name: 'copilot', fn: () => copilot(enriched) });
    } else {
      // LIGHT+DIRECT, MEDIUM+DIRECT: local-first with 32b minimum
      pushOllama(local32b, enriched);
      push('google',   google   ? () => google(enriched)   : null);
      push('groq',     groq     ? () => groq(enriched)     : null);
      push('cerebras', cerebras ? () => cerebras(enriched) : null);
      chain.push({ name: 'copilot', fn: () => copilot(enriched) });
    }

  } else if (vault.confidence === 'ADJACENT') {
    if (complexity === 'LIGHT') {
      pushOllama(localAny, enriched);
      push('groq',     groq     ? () => groq(enriched)     : null);
      push('cerebras', cerebras ? () => cerebras(enriched) : null);
      push('mistral',  mistral  ? () => mistral(enriched)  : null);
      push('google',   google   ? () => google(enriched)   : null);
    } else if (complexity === 'MEDIUM') {
      push('google',   google   ? () => google(enriched)   : null);
      push('groq',     groq     ? () => groq(enriched)     : null);
      pushOllama(localAny, enriched);
      push('cerebras', cerebras ? () => cerebras(enriched) : null);
    } else {
      push('google',   google   ? () => google(enriched)   : null);
      push('groq',     groq     ? () => groq(enriched)     : null);
      chain.push({ name: 'copilot', fn: () => copilot(enriched) });
    }

  } else { // ABSENT
    if (complexity === 'LIGHT') {
      push('groq',     groq     ? () => groq(body)     : null);
      push('cerebras', cerebras ? () => cerebras(body) : null);
      push('mistral',  mistral  ? () => mistral(body)  : null);
      push('google',   google   ? () => google(body)   : null);
    } else if (complexity === 'MEDIUM') {
      push('groq',     groq     ? () => groq(body)     : null);
      push('google',   google   ? () => google(body)   : null);
      push('cerebras', cerebras ? () => cerebras(body) : null);
      push('mistral',  mistral  ? () => mistral(body)  : null);
    } else {
      chain.push({ name: 'copilot', fn: () => copilot(body) });
      push('google',   google   ? () => google(body)   : null);
      push('groq',     groq     ? () => groq(body)     : null);
    }
  }

  // Last resort
  if (openrouter) chain.push({ name: 'openrouter', fn: () => openrouter(enriched) });

  return chain;
}
