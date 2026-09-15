import http from 'http';
import { RequestBody, Complexity, VaultSignal, SkillSignal, ConductorSignal, RoutingTarget, RoutingPlan, ChainEntry } from './types.js';
import { Config, ProviderConfig } from './config.js';
import { OllamaAdapter } from './providers/ollama.js';
import { groqAdapter, cerebrasAdapter, deepseekAdapter, openrouterFreeAdapter, googleAdapter, mistralAdapter, openrouterAdapter, ollamaProAdapter } from './providers/cloud.js';
import { kimiAdapter } from './providers/kimi.js';
import { glmAdapter } from './providers/glm.js';
import { qwenAdapter } from './providers/qwen.js';
import { copilotAdapter } from './providers/copilot.js';
import { LlamacppAdapter } from './providers/llamacpp.js';
import { injectVaultContext, estimateChars } from './injector.js';
import { isProviderAvailable } from './budget.js';
import { adjustTargetByReliability } from './reliability.js';
import { reliabilityGuardActive } from './reliabilityGuard.js';

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

/**
 * Frontier-gate coverage-vs-complexity matrix.
 *
 * LOCAL      → Ollama local models, request body unchanged.
 * LOCAL+CTX  → Ollama local models with vault context injected.
 * CLOUD      → Free cloud first (Groq/Cerebras/Google/Mistral/OpenRouter),
 *              paid cloud last (Copilot/OpenRouter).
 *
 * The matrix degrades a LOCAL/LOCAL+CTX cell to CLOUD when the request
 * (plus any injected context) does not fit in a local model appropriate to
 * the complexity class.
 */
export function decideTarget(
  complexity: Complexity,
  vault: VaultSignal,
  contextFits: boolean,
  skill: SkillSignal = { hasSkill: false },
): RoutingTarget {
  // Skill coverage can fill a vault gap: if we have a matching skill we treat
  // ABSENT knowledge as ADJACENT, because the skill procedure provides enough
  // structured context for a local model to attempt the task.
  const effectiveVault: VaultSignal['confidence'] =
    vault.confidence === 'ABSENT' && skill.hasSkill ? 'ADJACENT' : vault.confidence;

  switch (effectiveVault) {
    case 'DIRECT':
      return contextFits ? 'LOCAL' : 'CLOUD';
    case 'ADJACENT':
      if (complexity === 'LIGHT') return contextFits ? 'LOCAL' : 'CLOUD';
      if (complexity === 'MEDIUM') return contextFits ? 'LOCAL+CTX' : 'CLOUD';
      return 'CLOUD';
    case 'ABSENT':
    default:
      if (complexity === 'LIGHT') return contextFits ? 'LOCAL' : 'CLOUD';
      return 'CLOUD';
  }
}

function pickLocalModel(
  ollama: OllamaAdapter,
  complexity: Complexity,
  dispatchBody: RequestBody
): ReturnType<OllamaAdapter['pickModel']> {
  const chars = estimateChars(dispatchBody.messages);
  // Add headroom so the model isn't chosen right at its limit.
  const needed = Math.ceil(chars * 1.2);
  if (complexity === 'LIGHT') return ollama.pickModel(needed);
  if (complexity === 'MEDIUM') return ollama.pickModel(needed, 'medium');
  return ollama.pickModel(needed, 'heavy');
}

export async function buildChain(
  body: RequestBody,
  complexity: Complexity,
  vault: VaultSignal,
  config: Config,
  skill: SkillSignal = { hasSkill: false },
  persona?: string,
  taskType?: string,
  forcedTarget?: RoutingTarget,
  conductor: ConductorSignal = { matched: false },
): Promise<RoutingPlan> {
  const ollama = new OllamaAdapter(config.ollama.models, config.ollama.baseUrl);
  const ollamaOk = await ollama.isAvailable();
  const requestChars = estimateChars(body.messages);

  // Build a unified context list: vault chunks first, then the matching skill
  // procedure if the skill index covered the request domain, then conductor
  // domain context if a conductor manifest matched the request.
  const contextChunks: string[] = [
    ...(vault.confidence !== 'ABSENT' ? vault.chunks : []),
    ...(skill.hasSkill && skill.procedure ? [`Skill procedure: ${skill.skillName ?? 'unknown'}\n${skill.procedure}`] : []),
    ...(conductor.matched && conductor.contextBlock ? [conductor.contextBlock] : []),
  ];

  const enriched = contextChunks.length
    ? injectVaultContext(body, contextChunks)
    : body;

  // Decide the frontier-gate target. Fit checks use the actual model class
  // (light / medium / heavy) that would be dispatched for the complexity.
  let target: RoutingTarget;
  let localBody: RequestBody;
  if (vault.confidence === 'DIRECT') {
    const fits = ollamaOk && pickLocalModel(ollama, complexity, body) !== null;
    target = decideTarget(complexity, vault, fits, skill);
    localBody = body;
  } else if (vault.confidence === 'ADJACENT') {
    if (complexity === 'LIGHT') {
      const fits = ollamaOk && pickLocalModel(ollama, complexity, body) !== null;
      target = decideTarget(complexity, vault, fits, skill);
      localBody = body;
    } else if (complexity === 'MEDIUM') {
      const fits = ollamaOk && pickLocalModel(ollama, complexity, enriched) !== null;
      target = decideTarget(complexity, vault, fits, skill);
      localBody = enriched;
    } else {
      target = 'CLOUD';
      localBody = enriched;
    }
  } else { // ABSENT
    if (skill.hasSkill) {
      // Skill coverage fills the vault gap: route like ADJACENT using the
      // skill procedure as injected context.
      if (complexity === 'LIGHT') {
        const fits = ollamaOk && pickLocalModel(ollama, complexity, body) !== null;
        target = decideTarget(complexity, vault, fits, skill);
        localBody = body;
      } else if (complexity === 'MEDIUM') {
        const fits = ollamaOk && pickLocalModel(ollama, complexity, enriched) !== null;
        target = decideTarget(complexity, vault, fits, skill);
        localBody = enriched;
      } else {
        target = 'CLOUD';
        localBody = enriched;
      }
    } else {
      if (complexity === 'LIGHT') {
        const fits = ollamaOk && pickLocalModel(ollama, complexity, body) !== null;
        target = decideTarget(complexity, vault, fits, skill);
        localBody = body;
      } else {
        target = 'CLOUD';
        localBody = body;
      }
    }
  }

  // Cloud fallback uses the enriched body whenever any context was injected.
  const cloudBody = contextChunks.length ? enriched : body;

  // Conductor-aware routing: when a conductor domain matched, the context
  // block gives a local model enough structure to handle the task reliably.
  // Bias toward LOCAL+CTX (or LOCAL for LIGHT tasks) unless forced otherwise.
  if (conductor.matched && !forcedTarget) {
    // Treat conductor context like ADJACENT vault knowledge for routing:
    // a local model with the manifest injected can handle MEDIUM tasks.
    if (target === 'CLOUD') {
      const fits = ollamaOk && pickLocalModel(ollama, complexity, enriched) !== null;
      if (fits) {
        target = complexity === 'LIGHT' ? 'LOCAL' : 'LOCAL+CTX';
        localBody = enriched;
        log('conductor-routing', {
          domain: conductor.domainId,
          action: conductor.matchedActionId,
          before: 'CLOUD',
          after: target,
        });
      }
    }
  }

  // Persona reliability guard: only apply when persona+task_type are known
  // AND the R3-F.1 readiness guard reports the local stack is healthy.
  if (persona && taskType) {
    const reliabilityActive = await reliabilityGuardActive(config).catch(() => false);
    const adjusted = adjustTargetByReliability(target, persona, taskType, config, reliabilityActive);
    if (adjusted !== target) {
      log('reliability-bias', { persona, taskType, before: target, after: adjusted });
      target = adjusted;
    }
  }

  // Mode-resolver forced target (e.g. lockdown forces LOCAL, strips cloud).
  // This runs AFTER all other target logic so it can never be overridden.
  // It also overrides any reliability bias that would otherwise send an
  // absolute-local request to a cloud provider.
  const forceLocal = forcedTarget === 'LOCAL' || forcedTarget === 'LOCAL+CTX';
  const forceCloud = forcedTarget === 'CLOUD';
  if (forceLocal) {
    target = forcedTarget;
  } else if (forceCloud) {
    target = 'CLOUD';
  }

  log('routing', {
    complexity,
    vault: vault.confidence,
    vaultScore: vault.score.toFixed(2),
    skill: skill.hasSkill ? (skill.skillName ?? 'yes') : 'no',
    skillScore: skill.score ?? 0,
    conductor: conductor.matched ? (conductor.domainId ?? 'yes') : 'no',
    conductorScore: conductor.score ?? 0,
    conductorAction: conductor.matchedActionId ?? null,
    target,
    requestChars,
    enrichedChars: estimateChars(enriched.messages),
    confidenceEnabled: !!(config as any).confidence?.enabled,
  });

  const p = config.providers;
  const chain: ChainEntry[] = [];

  const groq      = p.groq      ? groqAdapter(p.groq)           : null;
  const cerebras  = p.cerebras  ? cerebrasAdapter(p.cerebras)   : null;
  const google    = p.google    ? googleAdapter(p.google)        : null;
  const mistral   = p.mistral   ? mistralAdapter(p.mistral)     : null;
  const openrouter = p.openrouter ? openrouterAdapter(p.openrouter) : null;
  const deepseek      = p.deepseek      ? deepseekAdapter(p.deepseek)           : null;
  const openrouterFree = p.openrouter_free ? openrouterFreeAdapter(p.openrouter_free) : null;
  const ollamapro = p.ollamapro ? ollamaProAdapter(p.ollamapro) : null;
  // Direct API adapters — preferred over OpenRouter/Ollama Pro for Kimi/GLM/Qwen
  const kimi = p.kimi ? kimiAdapter(p.kimi) : null;
  const glm  = p.glm  ? glmAdapter(p.glm)  : null;
  const qwen = p.qwen ? qwenAdapter(p.qwen) : null;
  const copilot   = copilotAdapter();

  const push = (name: string, fn: ChainEntry['fn'] | null, cfg?: ProviderConfig, dispatchBody: RequestBody = cloudBody) => {
    if (!fn) return;
    const sizeChars = estimateChars(dispatchBody.messages);
    if (cfg && !isProviderAvailable(name, cfg.dailyRequestLimit, cfg.maxRequestChars, sizeChars)) return;
    chain.push({ name, fn: () => fn(dispatchBody) });
  };
  const pushOllama = (model: ReturnType<OllamaAdapter['pickModel']>, dispatchBody: RequestBody) => {
    if (model) chain.push({ name: `ollama/${model.id}`, fn: () => ollama.dispatch(model, dispatchBody) });
  };

  // Build llamacpp adapters for any configured llama-server endpoints.
  // llama-server guarantees n_ctx (unlike Ollama's unknown num_ctx), so we
  // prefer it when available. Each endpoint is a separate local dispatch target.
  const llamacppAdapters = (config.llamacpp?.endpoints ?? []).map(ep => new LlamacppAdapter(ep));

  if (target === 'LOCAL' || target === 'LOCAL+CTX') {
    // Primary: local model appropriate to the complexity class.
    // Prefer llamacpp endpoints (guaranteed n_ctx) when available, then Ollama.
    for (const adapter of llamacppAdapters) {
      chain.push({ name: adapter.name, fn: () => adapter.dispatch(localBody) });
    }
    const localModel = pickLocalModel(ollama, complexity, localBody);
    pushOllama(localModel, localBody);

    if (forceLocal) {
      // Lockdown / forced-local: no cloud fallback, no copilot, no openrouter.
      log('forced-local', { forcedTarget, complexity });
    } else {
      // Fallback cloud chain in case local fails.
      // Ollama Pro is the primary cloud fallback (preferred cloud tier).
      push('ollamapro',      ollamapro      ? () => ollamapro(cloudBody)      : null, p.ollamapro, cloudBody);
      // Direct API adapters — bypass OpenRouter intermediary
      push('kimi',           kimi           ? () => kimi(cloudBody)           : null, p.kimi, cloudBody);
      push('glm',            glm            ? () => glm(cloudBody)            : null, p.glm, cloudBody);
      push('qwen',           qwen           ? () => qwen(cloudBody)           : null, p.qwen, cloudBody);
      // Free cloud tiers as deeper fallback
      push('google',         google         ? () => google(cloudBody)         : null, p.google, cloudBody);
      push('groq',           groq           ? () => groq(cloudBody)           : null, p.groq, cloudBody);
      push('deepseek',       deepseek       ? () => deepseek(cloudBody)       : null, p.deepseek, cloudBody);
      push('openrouter_free', openrouterFree ? () => openrouterFree(cloudBody) : null, p.openrouter_free, cloudBody);
      push('mistral',        mistral        ? () => mistral(cloudBody)        : null, p.mistral, cloudBody);
      push('cerebras',       cerebras       ? () => cerebras(cloudBody)       : null, p.cerebras, cloudBody);
      chain.push({ name: 'copilot', fn: () => copilot(cloudBody) });
    }
  } else { // CLOUD
    // Ollama Pro is the primary cloud target (preferred cloud tier).
    push('ollamapro',      ollamapro      ? () => ollamapro(cloudBody)      : null, p.ollamapro, cloudBody);
    // Direct API adapters — bypass OpenRouter intermediary
    push('kimi',           kimi           ? () => kimi(cloudBody)           : null, p.kimi, cloudBody);
    push('glm',            glm            ? () => glm(cloudBody)            : null, p.glm, cloudBody);
    push('qwen',           qwen           ? () => qwen(cloudBody)           : null, p.qwen, cloudBody);
    // Free cloud tiers as deeper fallback
    push('google',         google         ? () => google(cloudBody)         : null, p.google, cloudBody);
    push('groq',           groq           ? () => groq(cloudBody)           : null, p.groq, cloudBody);
    push('deepseek',       deepseek       ? () => deepseek(cloudBody)       : null, p.deepseek, cloudBody);
    push('openrouter_free', openrouterFree ? () => openrouterFree(cloudBody) : null, p.openrouter_free, cloudBody);
    push('mistral',        mistral        ? () => mistral(cloudBody)        : null, p.mistral, cloudBody);
    push('cerebras',       cerebras       ? () => cerebras(cloudBody)       : null, p.cerebras, cloudBody);
    chain.push({ name: 'copilot', fn: () => copilot(cloudBody) });
  }

  // Last resort (skipped in forced-local mode)
  if (!forceLocal && openrouter) chain.push({ name: 'openrouter', fn: () => openrouter(cloudBody) });

  return {
    target,
    chain,
    confidenceEnabled: !!(config as any).confidence?.enabled,
  };
}
