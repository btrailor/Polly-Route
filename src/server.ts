import http from 'http';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';
import { classifyComplexity, getLastUserMessage } from './classifier.js';
import { probeVault } from './vault.js';
import { probeSkillCoverage } from './skillCoverage.js';
import { probeConductor } from './conductorProbe.js';
import { buildChain } from './router.js';
import { captureCloudResponse } from './capture.js';
import { estimateCost } from './cost.js';
import { record, recent, stats } from './log.js';
import { recordRequest, budgetStatus } from './budget.js';
import { metricsSnapshot, metricsTimeSeries, recordRoutingDecision } from './metrics.js';
import { recordReliability, gcReliability, recordLocalSuccess } from './reliability.js';
import { classifyForReliability, getReliabilityDiagnostics, reliabilityGuardActive } from './reliabilityGuard.js';
import { RequestBody, RoutingTarget, ConfidenceSignal, ConductorSignal } from './types.js';
import { scoreResponse } from './confidenceScorer.js';
import { maxCharsForContext } from './config.js';
import { scanLogSignals } from './logSignals.js';
import { contractTranslate, DEFAULT_LOCAL_SURFACE } from './contractTranslation.js';
import { loadModesConfig } from './modes/loader.js';
import { resolveMode, RequestMetadata } from './modes/resolver.js';
import { applyModeToRequest, AgentToolPolicy } from './modes/apply.js';
import { findModeCommandInMessages } from './modes/parser.js';
import { ModesConfig } from './modes/schema.js';

const config = loadConfig();
const modesConfig: ModesConfig = loadModesConfig();
let reliabilityActive = false;
let reliabilityDiagnostics: Awaited<ReturnType<typeof getReliabilityDiagnostics>> | null = null;

function log(msg: string, meta?: object) {
  const s = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${new Date().toISOString()}] ${msg}${s}`);
}

/**
 * Extract a persona identifier from the request body.
 *
 * Looks at:
 * 1. body.metadata.persona (OpenClaw agent convention)
 * 2. body.agent.name / body.agent.id
 * 3. Falls back to "default" so reliability can still aggregate per-task.
 */
function extractPersona(body: RequestBody): string {
  if (typeof body.metadata === 'object' && body.metadata !== null) {
    const persona = (body.metadata as Record<string, unknown>).persona;
    if (typeof persona === 'string' && persona) return persona;
  }
  if (typeof body.agent === 'object' && body.agent !== null) {
    const agentName = (body.agent as Record<string, unknown>).name;
    if (typeof agentName === 'string' && agentName) return agentName;
    const agentId = (body.agent as Record<string, unknown>).id;
    if (typeof agentId === 'string' && agentId) return agentId;
  }
  return 'default';
}

/**
 * Classify a task type from the last user message.
 *
 * This is intentionally coarse — the reliability loop only needs enough
 * granularity to detect when a persona repeatedly fails on a category of
 * work, not a perfect semantic label.
 */
function classifyTaskType(userText: string): string {
  const text = userText.toLowerCase();
  if (/\b(code|refactor|debug|implement|script|function|bug|fix)\b/.test(text)) return 'coding';
  if (/\b(write|draft|edit|summarize|outline|note|blog|email|memo)\b/.test(text)) return 'writing';
  if (/\b(plan|schedule|reminder|calendar|sprint|todo|task)\b/.test(text)) return 'planning';
  if (/\b(research|investigate|compare|explain|what|how|why|who|when)\b/.test(text)) return 'research';
  if (/\b(config|setup|install|deploy|env|service|systemd|nginx|crontab)\b/.test(text)) return 'infra';
  return 'general';
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Qwen-coder-32b (and some other local models) emit tool calls as plain text
 * JSON in message.content instead of structured tool_calls. Detect and reformat.
 *
 * Detection: content is non-empty, tool_calls is empty or absent, and content
 * parses as JSON with a "name" string field (and optionally "arguments" object).
 */
function rewriteTextToolCall(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const choices: any[] = parsed.choices ?? [];
    let rewritten = false;

    for (const choice of choices) {
      const msg = choice.message;
      if (!msg) continue;
      const content = msg.content;
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (hasToolCalls || !content || typeof content !== 'string') continue;

      // Try to parse content as a tool call
      // Handles four formats:
      // 1. {"name": "tool", "arguments": {...}}  (standard JSON, single call)
      // 2. tool_name {"arg": ...}                (Qwen bare format)
      // 3. prose text followed by JSON tool call  (Qwen mixed format)
      // 4. {"type":"function","name":"t",...}; {...}  (Cerebras multi-call, '; '-delimited)
      const trimmed = content.trim();

      /** Parse one JSON blob into a normalised {name, args} pair, or null. */
      function parseSingleCall(s: string): { name: string; args: Record<string, unknown> } | null {
        try {
          const obj = JSON.parse(s.trim());
          const name = obj.name ?? obj.function?.name;
          if (typeof name !== 'string' || !name) return null;
          return { name, args: obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? {} };
        } catch {
          return null;
        }
      }

      // Format 4: Cerebras '; '-delimited multi-call
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      if (trimmed.includes('}; {')) {
        const segments = trimmed.split(/;\s*(?=\{)/);
        for (const seg of segments) {
          const parsed = parseSingleCall(seg);
          if (parsed) toolCalls.push(parsed);
        }
      }

      // Formats 1/2/3: single call
      if (toolCalls.length === 0) {
        let single = parseSingleCall(trimmed);
        if (!single) {
          // Bare format: "tool_name {...}"
          const bareMatch = trimmed.match(/^(\w+)\s+(\{[\s\S]*\})$/);
          if (bareMatch) {
            try { single = { name: bareMatch[1], args: JSON.parse(bareMatch[2]) }; } catch { /* fall through */ }
          }
        }
        if (!single) {
          // Mixed format: prose + JSON tool call at end
          const jsonMatch = trimmed.match(/\{\s*"name"\s*:\s*"(\w+)"[\s\S]*\}(?=[^\}]*$)/);
          if (jsonMatch) {
            single = parseSingleCall(jsonMatch[0]);
          }
        }
        if (single) toolCalls.push(single);
      }

      if (toolCalls.length === 0) continue;

      // Reformat into structured tool_calls
      msg.content = null;
      msg.tool_calls = toolCalls.map((tc, i) => ({
        id: `call_${Date.now()}_${i}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        },
      }));
      choice.finish_reason = 'tool_calls';
      rewritten = true;
    }

    if (rewritten) {
      return JSON.stringify(parsed);
    }
  } catch { /* not JSON, pass through */ }
  return raw;
}

async function handleCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: RequestBody;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON' } });
  }


  // --- Mode resolution ---
  // Check for /mode commands before any routing logic.
  // Cast messages to the simpler mode-resolver shape (content: string | null).
  const modeMessages = (body.messages ?? []) as unknown as Array<{ role: string; content?: string | null }>;
  const modeCmd = findModeCommandInMessages(modeMessages);

  // /mode list — return available modes as a JSON response.
  if (modeCmd?.list) {
    const modes = Object.entries(modesConfig.modes).map(([id, m]) => ({
      id,
      name: m.name,
      description: m.description,
    }));
    return sendJson(res, 200, {
      object: 'mode.list',
      defaultMode: modesConfig.defaultMode,
      modes,
    });
  }

  // /mode reset — clear metadata.mode so resolution falls through to env/default.
  let metadata: RequestMetadata | undefined;
  if (typeof body.metadata === 'object' && body.metadata !== null) {
    metadata = body.metadata as RequestMetadata;
    if (modeCmd?.reset) {
      delete (metadata as Record<string, unknown>).mode;
    }
  } else if (modeCmd?.reset) {
    // Reset requested but no metadata object present: create an empty metadata
    // container so resolveMode sees no mode override and falls back to env/default.
    metadata = {};
  } else {
    metadata = body.metadata as RequestMetadata | undefined;
  }

  // Resolve the active mode for this request.
  let resolvedModeId = 'default';
  let resolvedProvenance = 'default';
  let forcedTarget: RoutingTarget | undefined;
  try {
    const resolution = resolveMode(modesConfig, modeMessages, metadata, process.env, false);
    resolvedModeId = resolution.modeId;
    resolvedProvenance = resolution.provenance;

    // Capture pre-application state so we can log what the mode changed.
    const originalModel = body.model;
    const originalToolNames = (body.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);

    // Capture chain-execution routing hints BEFORE mode application.
    // applyModeToRequest() rebuilds the request body and may drop `metadata`,
    // and a mode's `model.primary` would otherwise clobber an explicit
    // per-request model pin. An explicit pin wins over a mode default.
    const routingMetadata = body.metadata ? { ...body.metadata } : undefined;
    const pinnedModel = routingMetadata?.model;

    // Apply mode overrides to the request body (model, tools, prompt, etc.).
    const agentPolicy: AgentToolPolicy = {};
    body = applyModeToRequest(resolution.mode, body as unknown as import('./modes/apply.js').RequestBody, agentPolicy) as unknown as RequestBody;

    // Re-attach routing metadata after mode resolution, preserving an
    // explicit model pin even when the mode set a different primary.
    if (routingMetadata) {
      body.metadata = { ...routingMetadata };
      if (pinnedModel) {
        body.metadata.model = pinnedModel;
        body.model = 'auto';
      }
    }

    const appliedToolNames = (body.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);
    const removedTools = originalToolNames.filter((n: string) => !appliedToolNames.includes(n));
    const modelChanged = originalModel !== body.model;

    // Determine forced target from mode flags.
    if (resolution.mode.flags.absolute) {
      // Lockdown: force local, no cloud providers.
      forcedTarget = 'LOCAL';
    } else if (resolution.mode.routing.target === 'local') {
      // Explicit local target: force LOCAL.
      forcedTarget = 'LOCAL';
    } else if (resolution.mode.routing.localFirst) {
      // Local-first preference: hint the router but don't override.
      // The router's existing logic will prefer local when it fits.
      forcedTarget = undefined;
    }

    log('mode-resolved', {
      mode: resolvedModeId,
      provenance: resolvedProvenance,
      forcedTarget: forcedTarget ?? null,
      modelChanged,
      model: body.model ?? null,
      removedTools: removedTools.length ? removedTools : undefined,
      temperature: body.temperature ?? null,
    });
  } catch (e) {
    log('mode-resolution-failed', { error: (e as Error).message });
  }

  const complexity     = classifyComplexity(body.messages ?? []);
  const userMsg        = getLastUserMessage(body.messages ?? []);
  const vaultSignal    = await probeVault(body.messages ?? [], config);
  const skillSignal    = await probeSkillCoverage(body.messages ?? [], config);
  const conductorSignal = await probeConductor(body.messages ?? [], config);

  log('dispatch', { complexity, vault: vaultSignal.confidence, vaultScore: vaultSignal.score.toFixed(2), skill: skillSignal.hasSkill ? (skillSignal.skillName ?? 'yes') : 'no', conductor: conductorSignal.matched ? (conductorSignal.domainId ?? 'yes') : 'no' });

  const persona = extractPersona(body);
  const taskType = classifyTaskType(userMsg);

  const { target, chain } = await buildChain(body, complexity, vaultSignal, config, skillSignal, persona, taskType, forcedTarget, conductorSignal);
  const startMs = Date.now();

  const triggerCapture = (provider: string, rawResponseText: string) => {
    void captureCloudResponse({
      body,
      provider,
      vaultSignal,
      complexity,
      target,
      rawResponseText,
    });
  };

  for (const entry of chain) {
    try {
      // Contract translation for local model dispatch (design.md I1–I7)
      // Both Ollama and llama-server are local providers that need contract translation.
      const isLocal = entry.name.startsWith('ollama/') || entry.name.startsWith('llamacpp/');
      const isCerebras = entry.name === 'cerebras';
      let dispatchBody = body;

      // Cerebras emits tool calls as serialized JSON text and ignores SOUL-level
      // tool suppression instructions. Strip tools entirely so it answers in prose.
      if (isCerebras && body.tools?.length) {
        dispatchBody = { ...body, tools: undefined };
        log('cerebras-tool-strip', { removedCount: body.tools.length });
      }

      // Contract translation for local models happens in the ROUTER, inside
      // the chain entry, because only there do we have BOTH the captured body
      // (which carries the injected vault/skill/conductor context) and the
      // target model id.
      //
      // It used to happen here, on the server's own `body` -- which lacks the
      // injected context -- and the result was then DISCARDED, because the
      // chain entries dispatched their own captured body and ignored this
      // argument. Measured 2026-10-29: a request with 40 tools sent 2,237
      // tokens of tool definitions to the local model, where contract
      // translation would have reduced 40 tools to the ~9 in
      // DEFAULT_LOCAL_SURFACE.
      // The body ACTUALLY dispatched is the chain entry's own body (the
      // router's captured, enriched, contract-translated body). The server's
      // local `dispatchBody` variable is the server's own copy, which lacks
      // the injected context -- reporting it made this diagnostic lie.
      const dispatched = entry.requestBody ?? dispatchBody;
      const upstream = await entry.fn(dispatched);

      // Step 1 diagnostic: log exact body sent to local model
      if (isLocal) {
        const systemContent =
          dispatched.messages?.find((m: any) => m.role === 'system')?.content as string ?? '';
        log('local-dispatch-body', {
          provider: entry.name,
          systemPromptLength: systemContent.length,
          systemPromptPreview: systemContent.slice(0, 200),
          toolCount: dispatched.tools?.length ?? 0,
          toolNames: (dispatched.tools ?? []).map((t: any) => t.function?.name),
          messageCount: dispatched.messages?.length ?? 0,
        });
      }

      if (upstream.statusCode && upstream.statusCode >= 400) {
        const errBody = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          upstream.on('data', c => chunks.push(c));
          upstream.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });

        // Classify the local failure for the reliability guard before falling back.
        if (isLocal && persona && taskType) {
          const { failureClass, countable } = await classifyForReliability(config, undefined, upstream.statusCode, errBody);
          recordReliability({
            ts: new Date().toISOString(),
            persona,
            task_type: taskType,
            provider: entry.name,
            success: false,
            failure_class: failureClass,
          }, config);
          log('local-failure-classified', { provider: entry.name, persona, taskType, failureClass, counted: countable });
        }

        log('dispatch error — trying next', { provider: entry.name, status: upstream.statusCode, body: errBody.slice(0, 200) });
        continue;
      }

      log('streaming', { provider: entry.name });

      const clientWantsStream = body.stream === true;
      const upstreamContentType = upstream.headers['content-type'] ?? '';
      const upstreamIsStream = upstreamContentType.includes('text/event-stream');

      // If client wants SSE but upstream returns JSON, wrap in SSE format
      if (clientWantsStream && !upstreamIsStream) {
        // Confidence scoring metadata for SSE responses
        const confidenceCfg = (config as any).confidence;
        let confidenceScore: string | undefined;
        let confidenceTier: string | undefined;
        if (confidenceCfg?.enabled) {
          // Defer scoring until we have the raw body (done in the 'end' handler below)
        }

        res.writeHead(upstream.statusCode ?? 200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Polly-Provider': entry.name,
          'X-Polly-Vault': vaultSignal.confidence,
          'X-Polly-Complexity': complexity,
        });

        const rawChunks: Buffer[] = [];
        upstream.on('data', (c: Buffer) => rawChunks.push(c));
        upstream.on('end', () => {
          let raw = Buffer.concat(rawChunks).toString();
          // Rewrite text-format tool calls from any model (local or cloud)
          raw = rewriteTextToolCall(raw);
          const ms = Date.now() - startMs;
          let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
          let streamChunk: string;
          try {
            const parsed = JSON.parse(raw);
            usage = parsed.usage;
            // Convert non-streaming response to a single SSE chunk
            const choice = parsed.choices?.[0];
            const msg = choice?.message ?? {};
            // Build delta: preserve tool_calls if present (structured tool call response)
            const delta: Record<string, unknown> = { role: 'assistant' };
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
              delta.tool_calls = msg.tool_calls.map((tc: any, i: number) => ({
                index: i,
                id: tc.id,
                type: tc.type ?? 'function',
                function: tc.function,
              }));
            } else {
              delta.content = msg.content ?? '';
            }
            const sseData = JSON.stringify({
              id: parsed.id ?? 'chatcmpl-polly',
              object: 'chat.completion.chunk',
              created: parsed.created ?? Math.floor(Date.now() / 1000),
              model: parsed.model ?? entry.name,
              choices: [{
                index: 0,
                delta,
                finish_reason: choice?.finish_reason ?? 'stop',
              }],
            });
            streamChunk = `data: ${sseData}\n\ndata: [DONE]\n\n`;
          } catch {
            streamChunk = `data: [DONE]\n\n`;
          }
          res.write(streamChunk);
          res.end();

          // Score the response for confidence (metadata only — can't escalate after sending)
          if (confidenceCfg?.enabled) {
            const signal = scoreResponse(raw, confidenceCfg);
            log('confidence-score', {
              provider: entry.name,
              score: signal.score,
              tier: signal.tier,
              shouldEscalate: signal.shouldEscalate,
              checks: signal.checks.map(c => ({ name: c.name, passed: c.passed })),
            });
            if (signal.shouldEscalate) {
              log('confidence-escalation-unavailable', {
                provider: entry.name,
                score: signal.score,
                detail: signal.checks.filter(c => !c.passed).map(c => c.name).join(','),
              });
            }
          }

          const cost = estimateCost(entry.name, usage);
          log('complete', { provider: entry.name, complexity, vault: vaultSignal.confidence, skill: skillSignal.hasSkill ? (skillSignal.skillName ?? 'yes') : 'no', ms, costUsd: cost?.total?.toFixed(6) ?? '0' });
          record({ ts: new Date().toISOString(), provider: entry.name, complexity, vault: vaultSignal.confidence, skill: skillSignal.hasSkill, skillName: skillSignal.skillName, conductor: conductorSignal.matched, conductorDomain: conductorSignal.domainId, ms, costUsd: cost?.total ?? 0, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 });
          recordRequest(entry.name);
          recordRoutingDecision(complexity, vaultSignal.confidence, target, entry.name, 'success', skillSignal.hasSkill, skillSignal.skillName, conductorSignal.matched, conductorSignal.domainId, {
            ms, costUsd: cost?.total ?? 0, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0,
          });
          if (entry.name.startsWith('ollama/') || entry.name.startsWith('llamacpp/')) {
            recordLocalSuccess({ ts: new Date().toISOString(), persona, task_type: taskType, provider: entry.name }, config);
          }
          triggerCapture(entry.name, raw);
        });
        upstream.on('error', (e: Error) => {
          log('stream error', { provider: entry.name, error: e.message });
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        });
        return;
      }

      // Normal passthrough (upstream already streams, or client doesn't need SSE)
      // For local models: buffer to allow text tool-call rewriting before sending
      const headers: Record<string, string> = {
        'Content-Type': upstream.headers['content-type'] ?? 'application/json',
        'X-Polly-Provider': entry.name,
        'X-Polly-Vault': vaultSignal.confidence,
        'X-Polly-Complexity': complexity,
      };
      if (upstream.headers['transfer-encoding'] && !isLocal) headers['transfer-encoding'] = upstream.headers['transfer-encoding'] as string;

      if (isLocal) {
        // Buffer local model response to allow tool-call rewriting and confidence scoring.
        //
        // The whole body must be buffered BEFORE the chain can decide anything,
        // so this branch awaits a promise that resolves with the buffered
        // result. Previously the buffering lived in an `upstream.on('end')`
        // callback and the escalation decision was made there, which meant:
        //
        //   - `await entry.fn(dispatched)` resolved as soon as the upstream
        //     response HEADERS arrived, so the `for (const entry of chain)`
        //     loop was already at the end of its body;
        //   - the `return` inside the 'end' callback that meant "escalate to
        //     the next provider" only exited the callback, not the loop;
        //   - the HTTP response was never written.
        //
        // Net effect: a low-confidence local response HUNG THE CLIENT
        // FOREVER instead of advancing to the next provider.
        // Measured 2026-10-29 on chain 'story-idea-world-domain': the report
        // step scored 0.36 (shouldEscalate) and the request never returned.
        const buffered = await new Promise<{ rawBody: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }>((resolve, reject) => {
          const rawChunks: Buffer[] = [];
          upstream.on('data', (c: Buffer) => rawChunks.push(c));
          upstream.on('end', () => {
            let rawBody = rewriteTextToolCall(Buffer.concat(rawChunks).toString());
            let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
            try { const p = JSON.parse(rawBody); usage = p.usage; } catch {}
            resolve({ rawBody, usage });
          });
          upstream.on('error', (e: Error) => reject(e));
        });

        {
          const { rawBody, usage } = buffered;
          const ms = Date.now() - startMs;

          // ── Confidence scoring: structural signal for router escalation ──
          // Score the local model's output. If confidence is low and there
          // are more providers in the chain, escalate to the next one
          // instead of returning a potentially-wrong answer.
          const confidenceCfg = (config as any).confidence;
          let escalateToNext = false;
          if (confidenceCfg?.enabled) {
            const signal = scoreResponse(rawBody, confidenceCfg);
            log('confidence-score', {
              provider: entry.name,
              score: signal.score,
              tier: signal.tier,
              shouldEscalate: signal.shouldEscalate,
              checks: signal.checks.map(c => ({ name: c.name, passed: c.passed })),
            });

            if (signal.shouldEscalate) {
              // Low confidence: don't send this response. Try the next provider.
              log('confidence-escalation', {
                provider: entry.name,
                score: signal.score,
                detail: signal.checks.filter(c => !c.passed).map(c => c.name).join(','),
              });
              // Record as a soft failure for reliability tracking (not counted against persona)
              if (persona && taskType) {
                recordReliability({
                  ts: new Date().toISOString(),
                  persona,
                  task_type: taskType,
                  provider: entry.name,
                  success: false,
                  failure_class: 'ambiguous',
                }, config);
              }
              // Advance to the next provider in the chain. This is now a
              // `continue` (not a `return` from a callback): the whole body is
              // buffered and awaited, so the chain loop is still on this
              // iteration and can move on. The previous `return` exited only
              // the callback, leaving the client hanging with no response.
              escalateToNext = true;
            }

            if (!escalateToNext) {
              // Add confidence headers to the response
              headers['X-Polly-Confidence'] = signal.score.toFixed(2);
              headers['X-Polly-Confidence-Tier'] = signal.tier;
            }
          }

          if (escalateToNext) {
            continue;
          }

          res.writeHead(upstream.statusCode ?? 200, { ...headers, 'content-length': Buffer.byteLength(rawBody).toString() });
          res.end(rawBody);
          const cost = estimateCost(entry.name, usage);
          log('complete', { provider: entry.name, complexity, vault: vaultSignal.confidence, skill: skillSignal.hasSkill ? (skillSignal.skillName ?? 'yes') : 'no', ms, costUsd: cost?.total?.toFixed(6) ?? '0' });
          record({ ts: new Date().toISOString(), provider: entry.name, complexity, vault: vaultSignal.confidence, skill: skillSignal.hasSkill, skillName: skillSignal.skillName, conductor: conductorSignal.matched, conductorDomain: conductorSignal.domainId, ms, costUsd: cost?.total ?? 0, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 });
          recordRequest(entry.name);
          recordRoutingDecision(complexity, vaultSignal.confidence, target, entry.name, 'success', skillSignal.hasSkill, skillSignal.skillName, conductorSignal.matched, conductorSignal.domainId, {
            ms, costUsd: cost?.total ?? 0, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0,
          });
          recordLocalSuccess({ ts: new Date().toISOString(), persona, task_type: taskType, provider: entry.name }, config);
          triggerCapture(entry.name, rawBody);
          return;
        }
      }

      res.writeHead(upstream.statusCode ?? 200, headers);

      let rawBody = '';
      upstream.on('data', (chunk: Buffer) => {
        res.write(chunk);
        rawBody += chunk.toString();
      });

      upstream.on('end', () => {
        res.end();
        const ms = Date.now() - startMs;

        let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
        try {
          const parsed = JSON.parse(rawBody);
          usage = parsed.usage;
        } catch {}

        const cost = estimateCost(entry.name, usage);
        log('complete', { provider: entry.name, complexity, vault: vaultSignal.confidence, skill: skillSignal.hasSkill ? (skillSignal.skillName ?? 'yes') : 'no', ms, costUsd: cost?.total?.toFixed(6) ?? '0' });

        record({
          ts: new Date().toISOString(),
          provider: entry.name,
          complexity,
          vault: vaultSignal.confidence,
          skill: skillSignal.hasSkill,
          skillName: skillSignal.skillName,
          conductor: conductorSignal.matched,
          conductorDomain: conductorSignal.domainId,
          ms,
          costUsd: cost?.total ?? 0,
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
        });

        recordRequest(entry.name);
        recordRoutingDecision(complexity, vaultSignal.confidence, target, entry.name, 'success', skillSignal.hasSkill, skillSignal.skillName, conductorSignal.matched, conductorSignal.domainId, {
          ms, costUsd: cost?.total ?? 0, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0,
        });
        triggerCapture(entry.name, rawBody);
      });

      upstream.on('error', (e: Error) => {
        log('stream error', { provider: entry.name, error: e.message });
        if (!res.writableEnded) res.end();
      });

      return;

    } catch (e: unknown) {
      // Classify exceptions thrown by the provider chain. For local providers,
      // this feeds the persona reliability guard so config failures are not
      // counted against the model.
      if (persona && taskType && (entry.name.startsWith('ollama/') || entry.name.startsWith('llamacpp/'))) {
        const { failureClass, countable } = await classifyForReliability(config, e);
        recordReliability({
          ts: new Date().toISOString(),
          persona,
          task_type: taskType,
          provider: entry.name,
          success: false,
          failure_class: failureClass,
        }, config);
        log('local-failure-classified', { provider: entry.name, persona, taskType, failureClass, counted: countable });
      }

      log('dispatch error — trying next', { provider: entry.name, error: (e as Error).message });
    }
  }

  sendJson(res, 502, { error: { message: 'All providers failed' } });
  recordRoutingDecision(complexity, vaultSignal.confidence, target, chain[chain.length - 1]?.name ?? 'none', 'error', skillSignal.hasSkill, skillSignal.skillName, conductorSignal.matched, conductorSignal.domainId);

  // If the final provider was local, also log a reliability failure so the
  // persona track record reflects that no provider could satisfy the request.
  const lastLocal = chain[chain.length - 1]?.name?.startsWith('ollama/') || chain[chain.length - 1]?.name?.startsWith('llamacpp/');
  if (lastLocal && persona && taskType) {
    recordReliability({
      ts: new Date().toISOString(),
      persona,
      task_type: taskType,
      provider: chain[chain.length - 1].name,
      success: false,
      failure_class: 'ambiguous',
    }, config);
  }
}

function handleModels(_req: http.IncomingMessage, res: http.ServerResponse) {
  sendJson(res, 200, {
    object: 'list',
    data: [{ id: 'auto', object: 'model', created: 1700000000, owned_by: 'polly-route' }],
  });
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
  sendJson(res, 200, {
    status: 'ok',
    uptime: process.uptime(),
    ...stats(),
    budget: budgetStatus(),
    metrics: metricsSnapshot(),
    reliability: {
      enabled: config.reliability?.enabled ?? false,
      active: reliabilityActive,
      diagnostics: reliabilityDiagnostics,
    },
    confidence: {
      enabled: config.confidence?.enabled ?? false,
      escalationThreshold: config.confidence?.escalationThreshold ?? 0.45,
    },
  });
}

function handleLogSignals(_req: http.IncomingMessage, res: http.ServerResponse) {
  sendJson(res, 200, scanLogSignals());
}

function handleMetrics(_req: http.IncomingMessage, res: http.ServerResponse) {
  sendJson(res, 200, metricsTimeSeries());
}

function handleLog(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200);
  sendJson(res, 200, { ...stats(), entries: recent(limit) });
}

/** Serve the static metrics dashboard HTML. Works from both src/ (ts-node) and dist/. */
function handleDashboard(_req: http.IncomingMessage, res: http.ServerResponse) {
  const filePath = path.join(__dirname, '..', 'dashboard.html');
  fs.readFile(filePath, 'utf-8', (err, html) => {
    if (err) {
      sendJson(res, 500, { error: { message: 'Dashboard not available' } });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url ?? '/';
  if (req.method === 'POST' && url === '/v1/chat/completions') return handleCompletions(req, res);
  if (req.method === 'GET'  && url === '/v1/models')           return handleModels(req, res);
  if (req.method === 'GET'  && (url === '/status' || url === '/health')) return handleStatus(req, res);
  if (req.method === 'GET'  && url === '/metrics')           return handleMetrics(req, res);
  if (req.method === 'GET'  && url === '/log-signals')     return handleLogSignals(req, res);
  if (req.method === 'GET'  && url === '/dashboard')         return handleDashboard(req, res);
  if (req.method === 'GET'  && url.startsWith('/log'))         return handleLog(req, res);
  sendJson(res, 404, { error: { message: 'Not found' } });
});

server.listen(config.port, '127.0.0.1', async () => {
  log(`polly-route v0.6 listening on http://127.0.0.1:${config.port}`);
  log('providers', { available: Object.keys(config.providers).filter(k => !!(config.providers as any)[k]) });
  log('ollama', { models: config.ollama.models.map(m => m.id) });
  log('llamacpp', { endpoints: (config.llamacpp?.endpoints ?? []).map(e => `${e.model}@${e.baseUrl}`) });

  // 0a.7 — Reliability guard boot check (off by default; diagnostics surfaced on /status)
  try {
    reliabilityDiagnostics = await getReliabilityDiagnostics(config);
    reliabilityActive = await reliabilityGuardActive(config);
    log('[boot] reliability guard', { active: reliabilityActive, details: reliabilityDiagnostics.details });
  } catch (e) {
    log('[boot] reliability guard check failed', { error: (e as Error).message });
    reliabilityActive = false;
  }
});

server.on('error', async (e: Error & { code?: string }) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[polly-route] Port ${config.port} in use — checking for stale listener...`);
    try {
      const killed = await new Promise<boolean>((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: config.port,
          path: '/health',
          method: 'GET',
          timeout: 500,
        }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
        req.end();
      });
      if (killed) {
        console.error(`[polly-route] Stale listener confirmed on port ${config.port}; attempting graceful exit...`);
        // Cannot actually kill the other process from here, so just exit gracefully
        console.error(`[polly-route] Please stop the other process and restart.`);
        process.exit(1);
      } else {
        console.error(`[polly-route] Port ${config.port} appears occupied but unresponsive; retrying in 1s...`);
        setTimeout(() => server.listen(config.port, '127.0.0.1'), 1000);
      }
    } catch {
      console.error(`[polly-route] Port ${config.port} in use, retrying in 1s...`);
      setTimeout(() => server.listen(config.port, '127.0.0.1'), 1000);
    }
  } else {
    console.error('[polly-route] Server error:', e.message);
    process.exit(1);
  }
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
