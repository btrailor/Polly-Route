import http from 'http';
import { RequestBody, Complexity, VaultSignal, SkillSignal, ConductorSignal, RoutingTarget, RoutingPlan, ChainEntry, ModelTier, RoutingMetadata } from './types.js';
import { Config, ProviderConfig, providerIsConfigured, OllamaModel } from './config.js';
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
  explicitCloud = false,
): RoutingTarget {
  // Skill coverage can fill a vault gap: if we have a matching skill we treat
  // ABSENT knowledge as ADJACENT, because the skill procedure provides enough
  // structured context for a local model to attempt the task.
  const effectiveVault: VaultSignal['confidence'] =
    vault.confidence === 'ABSENT' && skill.hasSkill ? 'ADJACENT' : vault.confidence;

  // Explicit caller intent for the cloud tier outranks the inferred vault
  // signal.
  //
  // The vault probe is a semantic heuristic: measured on 2026-10-29, a
  // nonsense query ("zzz definitely not in vault qqq") scored 0.855 and
  // classified as DIRECT, so the probe returned DIRECT for every request and
  // the CLOUD branch was unreachable in practice. When a caller explicitly
  // asks for the cloud tier, that intent must win over a heuristic that
  // cannot currently tell "in the vault" from "not in the vault".
  //
  // This mirrors the precedence already used for model-over-tier.
  if (explicitCloud) return 'CLOUD';

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
  // Use the same real budget helper that the size guard uses. Do NOT apply
  // an extra multiplier here; pickModel already reserves output headroom via
  // maxCharsForContext. Adding 1.2x here created Defect 2: pickModel selected a
  // model that the guard then rejected, stranding requests on cloud.
  if (complexity === 'LIGHT') return ollama.pickModel(chars);
  if (complexity === 'MEDIUM') return ollama.pickModel(chars, 'medium');
  return ollama.pickModel(chars, 'heavy');
}

/**
 * Resolve a requested capability tier to a concrete local weight class.
 *
 * The chain-execution contract: a chain step declares `tier`, and the router
 * honours it instead of guessing from complexity. Returns the minimum weight
 * class to select within, or null when the tier means "no local model".
 */
function tierToWeight(tier: ModelTier): 'light' | 'medium' | 'heavy' | null {
  if (tier === 'light') return 'light';
  if (tier === 'medium') return 'medium';
  if (tier === 'heavy') return 'heavy';
  return null; // 'none' and 'cloud' select no local weight class
}

/**
 * Find an exact model id among the registered Ollama models or the configured
 * llama.cpp endpoints.
 *
 * An unresolvable id must NOT silently resolve to a different model -- a chain
 * step that asked for a specific model must not be served another one.
 */
function resolveExactModel(
  modelId: string,
  ollamaModels: OllamaModel[],
  llamacppEndpoints: { model: string }[],
): { ollama: OllamaModel | null; llamacpp: { model: string } | null } {
  return {
    ollama: ollamaModels.find(m => m.id === modelId) ?? null,
    llamacpp: llamacppEndpoints.find(e => e.model === modelId) ?? null,
  };
}

/**
 * Build a local-only chain: every local endpoint that fits, no cloud.
 *
 * Used when `metadata.localOnly` is set but the routing target resolved to
 * CLOUD (for example because the caller also asked for the cloud tier). The
 * constraint wins.
 */
function buildLocalOnlyChain(
  ollama: OllamaAdapter,
  llamacppAdapters: LlamacppAdapter[],
  localBody: RequestBody,
): ChainEntry[] {
  const out: ChainEntry[] = [];
  const localChars = estimateChars(localBody.messages);

  for (const adapter of llamacppAdapters) {
    const maxChars = adapter.maxChars();
    if (maxChars > 0 && localChars > maxChars) continue;
    out.push({ name: adapter.name, fn: () => adapter.dispatch(localBody) });
  }

  const model = ollama.pickModel(localChars);
  if (model) {
    const localChars2 = localChars;
    if (ollama.fits(model, localChars2)) {
      out.push({ name: `ollama/${model.id}`, fn: () => ollama.dispatch(model, localBody) });
    }
  }
  return out;
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
  const ollama = new OllamaAdapter(config.ollama.models, config.ollama.baseUrl, config.ollama);
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

  // Explicit caller intent for the cloud tier outranks the inferred vault
  // signal. See the `explicitCloud` note below.
  // `localOnly` is a HARD constraint ("never leave this machine"), so it
  // overrides even an explicit `tier: 'cloud'`. Without this, the two hints
  // contradict each other and the chain would silently reach the cloud.
  const explicitCloud = body.metadata?.tier === 'cloud'
    && body.metadata?.localOnly !== true;
  if (vault.confidence === 'DIRECT') {
    const fits = ollamaOk && pickLocalModel(ollama, complexity, body) !== null;
    target = decideTarget(complexity, vault, fits, skill, explicitCloud);
    localBody = body;
  } else if (vault.confidence === 'ADJACENT') {
    if (complexity === 'LIGHT') {
      const fits = ollamaOk && pickLocalModel(ollama, complexity, body) !== null;
      target = decideTarget(complexity, vault, fits, skill, explicitCloud);
      localBody = body;
    } else if (complexity === 'MEDIUM') {
      const fits = ollamaOk && pickLocalModel(ollama, complexity, enriched) !== null;
      target = decideTarget(complexity, vault, fits, skill, explicitCloud);
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
        target = decideTarget(complexity, vault, fits, skill, explicitCloud);
        localBody = body;
      } else if (complexity === 'MEDIUM') {
        const fits = ollamaOk && pickLocalModel(ollama, complexity, enriched) !== null;
        target = decideTarget(complexity, vault, fits, skill, explicitCloud);
        localBody = enriched;
      } else {
        target = 'CLOUD';
        localBody = enriched;
      }
    } else {
      if (complexity === 'LIGHT') {
        const fits = ollamaOk && pickLocalModel(ollama, complexity, body) !== null;
        target = decideTarget(complexity, vault, fits, skill, explicitCloud);
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
    if (cfg && !providerIsConfigured(cfg)) {
      log('skip-no-credentials', { provider: name });
      return;
    }
    const sizeChars = estimateChars(dispatchBody.messages);
    if (cfg && !isProviderAvailable(name, cfg.dailyRequestLimit, cfg.maxRequestChars, sizeChars)) return;
    chain.push({ name, fn: () => fn(dispatchBody) });
  };
  const pushOllama = (model: ReturnType<OllamaAdapter['pickModel']>, dispatchBody: RequestBody) => {
    if (!model) return;
    const localChars = estimateChars(dispatchBody.messages);
    if (!ollama.fits(model, localChars)) {
      log('ollama-skip-size', { provider: `ollama/${model.id}`, requestChars: localChars, maxChars: ollama.maxCharsFor(model.id) });
      return;
    }
    chain.push({ name: `ollama/${model.id}`, fn: () => ollama.dispatch(model, dispatchBody) });
  };

  // Build llamacpp adapters for any configured llama-server endpoints.
  // llama-server guarantees n_ctx (unlike Ollama's unknown num_ctx), so we
  // prefer it when available. Each endpoint is a separate local dispatch target.
  const llamacppAdapters = (config.llamacpp?.endpoints ?? []).map(ep => new LlamacppAdapter(ep, config.llamacpp));

  // Chain-execution routing hints. `metadata.model` pins an exact model id and
  // wins over `metadata.tier`. `metadata.localOnly` strips the cloud fallback
  // chain so a local failure surfaces as an error instead of silently
  // escalating to a cloud provider.
  const routingMeta: RoutingMetadata = body.metadata ?? {};
  const requestedTier = routingMeta.tier;
  const requestedModel = routingMeta.model;
  const localOnly = routingMeta.localOnly === true;


  // An explicit tier/model pin also forces the local target, unless the
  // caller explicitly asked for the cloud tier.
  const tierForcesLocal = requestedModel !== undefined
    || (requestedTier !== undefined && requestedTier !== 'cloud');

  if (target === 'LOCAL' || target === 'LOCAL+CTX' || tierForcesLocal) {
    // Primary: local model appropriate to the complexity class.
    // Prefer llamacpp endpoints (guaranteed n_ctx), then Ollama.
    // Skip endpoints whose guaranteed n_ctx can't fit the request.
    const localChars = estimateChars(localBody.messages);

    let exactOllama: OllamaModel | null = null;
    let exactLlamacpp: { model: string } | null = null;
    if (requestedModel !== undefined) {
      const resolved = resolveExactModel(requestedModel, config.ollama.models, config.llamacpp?.endpoints ?? []);
      exactOllama = resolved.ollama;
      exactLlamacpp = resolved.llamacpp;
      if (!exactOllama && !exactLlamacpp) {
        // Fail loudly. Do NOT silently substitute a different model: a chain
        // step that asked for a specific model must not be served another one.
        log('exact-model-unresolvable', { requestedModel, chainId: routingMeta.chainId, chainStep: routingMeta.chainStep });
        chain.push({
          name: `unresolvable:${requestedModel}`,
          fn: () => Promise.reject(new Error(`Requested model is unresolvable: ${requestedModel}`)),
        });
        return { target: 'LOCAL', chain, confidenceEnabled: !!(config as any).confidence?.enabled };
      }
      log('exact-model-pinned', { requestedModel, resolvedAs: exactOllama ? `ollama/${exactOllama.id}` : `llamacpp/${exactLlamacpp!.model}` });
    }

    if (exactLlamacpp) {
      const adapter = llamacppAdapters.find(a => a.modelId === exactLlamacpp!.model);
      if (adapter) {
        chain.push({ name: adapter.name, fn: () => adapter.dispatch(localBody) });
      }
    } else {
      for (const adapter of llamacppAdapters) {
        // When an exact model is pinned, other llamacpp endpoints are skipped.
        if (requestedModel !== undefined) continue;
        const endpoint = config.llamacpp?.endpoints?.find(ep => ep.model === adapter.modelId);
        const maxChars = adapter.maxChars();
        if (maxChars > 0 && localChars > maxChars) {
          log('llamacpp-skip-size', { provider: adapter.name, requestChars: localChars, maxChars, estimatedTokens: Math.ceil(localChars / 2.0) });
          continue;
        }
        chain.push({ name: adapter.name, fn: () => adapter.dispatch(localBody) });
      }
    }

    if (exactOllama) {
      pushOllama(exactOllama, localBody);
    } else if (requestedModel === undefined) {
      // Tier-aware selection: when a tier is requested, select within that
      // weight class rather than the complexity-derived class.
      const tierWeight = requestedTier !== undefined ? tierToWeight(requestedTier) : null;
      const localModel = tierWeight
        ? ollama.pickModel(localChars, tierWeight)
        : pickLocalModel(ollama, complexity, localBody);
      if (localModel) {
        pushOllama(localModel, localBody);
      } else if (llamacppAdapters.length === 0 || llamacppAdapters.every(a => {
        const maxChars = a.maxChars();
        return maxChars > 0 && localChars > maxChars;
      })) {
        log('local-request-exceeds-all-endpoints', { target, requestChars: localChars, ollamaModels: config.ollama.models.map(m => ({ id: m.id, budget: ollama.maxCharsFor(m.id) })) });
      }
    }

    if (forceLocal || localOnly) {
      // Lockdown / forced-local / chain localOnly: no cloud fallback, no
      // copilot, no openrouter. A local failure surfaces as an error rather
      // than silently escalating to a cloud provider.
      log('forced-local', { forcedTarget, complexity, localOnly, chainId: routingMeta.chainId, chainStep: routingMeta.chainStep });
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
    // `localOnly` is a hard constraint ("never leave this machine"). It
    // overrides the cloud target, including one forced by an explicit
    // `metadata.tier: 'cloud'`. Without this the two hints contradict each
    // other and a chain step could silently reach a cloud provider.
    if (localOnly) {
      log('local-only-overrides-cloud-target', {
        chainId: routingMeta.chainId,
        chainStep: routingMeta.chainStep,
      });
      const forced = buildLocalOnlyChain(ollama, llamacppAdapters, localBody);
      chain.push(...forced);
      return { target: 'LOCAL', chain, confidenceEnabled: !!(config as any).confidence?.enabled };
    }
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
  if (!forceLocal && !localOnly && openrouter) chain.push({ name: 'openrouter', fn: () => openrouter(cloudBody) });

  return {
    target,
    chain,
    confidenceEnabled: !!(config as any).confidence?.enabled,
  };
}
