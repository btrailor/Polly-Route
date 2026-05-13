import http from 'http';
import { RequestBody, Complexity, VaultSignal } from './types.js';
import { Config, ProviderConfig } from './config.js';
import { OllamaAdapter } from './providers/ollama.js';
import { groqAdapter, cerebrasAdapter, googleAdapter, mistralAdapter, openrouterAdapter, ollamaProAdapter } from './providers/cloud.js';
import { copilotAdapter } from './providers/copilot.js';
import { injectVaultContext, estimateChars } from './injector.js';
import { isProviderAvailable } from './budget.js';

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
  const ollamapro = p.ollamapro ? ollamaProAdapter(p.ollamapro) : null;
  const copilot   = copilotAdapter();

  const push = (name: string, fn: ChainEntry['fn'] | null, cfg?: ProviderConfig) => {
    if (!fn) return;
    if (cfg && !isProviderAvailable(name, cfg.dailyRequestLimit, cfg.maxRequestChars, enrichedChars)) return;
    chain.push({ name, fn });
  };
  const pushOllama = (model: ReturnType<OllamaAdapter['pickModel']>, b: RequestBody) => {
    if (model) chain.push({ name: `ollama/${model.id}`, fn: (dispatchBody: RequestBody) => ollama.dispatch(model, dispatchBody) });
  };

  if (vault.confidence === 'DIRECT') {
    if (complexity === 'HEAVY') {
      push('google',    google    ? () => google(enriched)    : null, p.google);
      push('groq',      groq      ? () => groq(enriched)      : null, p.groq);
      push('ollamapro', ollamapro ? () => ollamapro(enriched) : null, p.ollamapro);
      chain.push({ name: 'copilot', fn: () => copilot(enriched) });
    } else {
      // LIGHT+DIRECT, MEDIUM+DIRECT: local-first with 32b minimum
      pushOllama(local32b, enriched);
      push('groq',      groq      ? () => groq(enriched)      : null, p.groq);
      push('google',    google    ? () => google(enriched)    : null, p.google);
      push('cerebras',  cerebras  ? () => cerebras(enriched)  : null, p.cerebras);
      push('ollamapro', ollamapro ? () => ollamapro(enriched) : null, p.ollamapro);
      chain.push({ name: 'copilot', fn: () => copilot(enriched) });
    }

  } else if (vault.confidence === 'ADJACENT') {
    if (complexity === 'LIGHT') {
      pushOllama(localAny, enriched);
      push('groq',      groq      ? () => groq(enriched)      : null, p.groq);
      push('cerebras',  cerebras  ? () => cerebras(enriched)  : null, p.cerebras);
      push('mistral',   mistral   ? () => mistral(enriched)   : null, p.mistral);
      push('google',    google    ? () => google(enriched)    : null, p.google);
      push('ollamapro', ollamapro ? () => ollamapro(enriched) : null, p.ollamapro);
    } else if (complexity === 'MEDIUM') {
      push('groq',      groq      ? () => groq(enriched)      : null, p.groq);
      push('google',    google    ? () => google(enriched)    : null, p.google);
      push('mistral',   mistral   ? () => mistral(enriched)   : null, p.mistral);
      pushOllama(localAny, enriched);
      push('cerebras',  cerebras  ? () => cerebras(enriched)  : null, p.cerebras);
      push('ollamapro', ollamapro ? () => ollamapro(enriched) : null, p.ollamapro);
    } else {
      push('google',    google    ? () => google(enriched)    : null, p.google);
      push('groq',      groq      ? () => groq(enriched)      : null, p.groq);
      push('ollamapro', ollamapro ? () => ollamapro(enriched) : null, p.ollamapro);
      chain.push({ name: 'copilot', fn: () => copilot(enriched) });
    }

  } else { // ABSENT
    if (complexity === 'LIGHT') {
      push('groq',      groq      ? () => groq(body)      : null, p.groq);
      push('cerebras',  cerebras  ? () => cerebras(body)  : null, p.cerebras);
      push('mistral',   mistral   ? () => mistral(body)   : null, p.mistral);
      push('google',    google    ? () => google(body)    : null, p.google);
      push('ollamapro', ollamapro ? () => ollamapro(body) : null, p.ollamapro);
    } else if (complexity === 'MEDIUM') {
      push('groq',      groq      ? () => groq(body)      : null, p.groq);
      push('google',    google    ? () => google(body)    : null, p.google);
      push('mistral',   mistral   ? () => mistral(body)   : null, p.mistral);
      push('cerebras',  cerebras  ? () => cerebras(body)  : null, p.cerebras);
      push('ollamapro', ollamapro ? () => ollamapro(body) : null, p.ollamapro);
    } else { // HEAVY
      push('google',    google    ? () => google(body)    : null, p.google);
      push('groq',      groq      ? () => groq(body)      : null, p.groq);
      push('ollamapro', ollamapro ? () => ollamapro(body) : null, p.ollamapro);
      chain.push({ name: 'copilot', fn: () => copilot(body) });
    }
  }

  // Last resort
  if (openrouter) chain.push({ name: 'openrouter', fn: () => openrouter(enriched) });

  return chain;
}
