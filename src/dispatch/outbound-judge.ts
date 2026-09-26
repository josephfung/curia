// outbound-judge.ts — Stage 2 outbound content filter: single-purpose LLM judge.
//
// Given an outbound message body and its recipient set, decide whether the body
// leaks internal monologue / system status / side-channel notes to a mixed audience
// (any non-principal recipient on the message). Returns FilterFinding[] ([] = pass)
// so it slots directly into OutboundContentFilter.runLlmReview().
//
// This is a security boundary, not a skill: it owns its own LLM call, timeout,
// verdict parsing, failure semantics, and telemetry. It NEVER throws — all failure
// is handled per the configured failMode and returned as findings (or []).
//
// Prompt-injection defense: the body + recipients are JSON-encoded inside delimiters
// by outbound-judge-prompt.ts; the system prompt marks them as opaque data.
//
// Observability (#1911): every Stage-2 decision publishes an `outbound.judge` audit
// event (`judged_pass` | `judged_block` | `skipped_principal_sole` | `failed_open` |
// `failed_closed`). Fail-open/closed outages are queryable via outcome alone;
// `reasonCode` separates a real leak verdict from unreachable / unparseable failures.
// Alarm surface is `outbound.judge` + existing `logger.warn` — not `llm.error`
// (HealthService only tracks tier models; the judge model is usually not one).

import { createHash } from 'node:crypto';
import type { LLMProvider, LLMUsage, LLMCallProvenance } from '../agents/llm/provider.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createLlmCall, createOutboundJudge } from '../bus/events.js';
import type { OutboundJudgeOutcome, OutboundJudgeReasonCode } from '../bus/events.js';
import { createEstimateCostUsd } from '../agents/llm/pricing.js';
import type { FilterFinding, FilterRecipient } from './outbound-filter.js';
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt } from './outbound-judge-prompt.js';

/** Cap free-text `reason` so unbounded provider messages don't bloat audit_log. */
const REASON_MAX_LEN = 200;

export interface JudgeConfig {
  /** When false, review() returns [] without calling the model. */
  enabled: boolean;
  /** Model string passed to the provider router. Validated against the registry at startup. */
  model: string;
  /** Hard timeout for the LLM call in ms. */
  timeoutMs: number;
  /**
   * 'split'  — unreachable (timeout/API error) → deliver ([]); malformed verdict → block.
   * 'open'   — any failure → deliver ([]).
   * 'closed' — any failure → block (finding).
   */
  failMode: 'split' | 'open' | 'closed';
}

export interface JudgeInput {
  content: string;
  recipients: FilterRecipient[];
  principalIncluded: boolean;
  principalIsSoleRecipient: boolean;
  /** Telemetry correlation. */
  conversationId: string;
  channelId: string;
}

export interface OutboundJudge {
  review(input: JudgeInput): Promise<FilterFinding[]>;
}

const TIMEOUT = Symbol('judge-timeout');

interface Verdict {
  leak: boolean;
  reason: string;
}

function truncateReason(reason: string): string {
  if (reason.length <= REASON_MAX_LEN) return reason;
  return `${reason.slice(0, REASON_MAX_LEN - 1)}…`;
}

export class OutboundLlmJudge implements OutboundJudge {
  private readonly estimateCost: (actualModel: string, usage: LLMUsage, logger?: Logger) => number;

  constructor(
    private readonly provider: LLMProvider,
    private readonly config: JudgeConfig,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly modelRegistry: ModelRegistry,
  ) {
    this.estimateCost = createEstimateCostUsd(modelRegistry);
  }

  async review(input: JudgeInput): Promise<FilterFinding[]> {
    // Skip conditions — no LLM call.
    if (!this.config.enabled) return [];
    // Principal alone is a private channel: internal language is permitted.
    // NOTE: only skip when the principal is the SOLE recipient. Principal + third
    // parties on the same message still runs the judge.
    if (input.principalIsSoleRecipient) {
      await this.publishDecision(input, 'skipped_principal_sole');
      return [];
    }

    // No principalIsSoleRecipient arg: that case is already short-circuited above, so
    // by here at least one recipient is a non-principal. Passing it would always be false.
    const userPrompt = buildJudgeUserPrompt(
      input.content,
      input.recipients,
      input.principalIncluded,
    );

    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raced: Awaited<ReturnType<LLMProvider['chat']>> | typeof TIMEOUT;
    // Abort the in-flight provider request on timeout so a slow judge call doesn't
    // keep running in the background consuming provider capacity/cost. Providers that
    // honor options.signal (Anthropic, OpenRouter) cancel the HTTP request; providers
    // that ignore it still behave correctly (the race already returned).
    const controller = new AbortController();
    try {
      const chatPromise = this.provider.chat({
        model: this.config.model,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        // Deterministic, short verdict. 100 tokens is ample for {"leak":..,"reason":".."}.
        // If a model ever emits a verbose reason that gets truncated, parseVerdict treats
        // the cut-off JSON as malformed — which fails toward blocking (split/closed), the
        // safe direction for a security boundary.
        options: { temperature: 0, max_tokens: 100, signal: controller.signal },
      });
      // Once we stop awaiting chatPromise (on timeout/abort), a late rejection would be
      // unhandled. LLMProvider.chat() is non-throwing by contract, but guard anyway.
      chatPromise.catch(() => { /* handled via race + abort below */ });
      const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), this.config.timeoutMs);
      });
      raced = await Promise.race([chatPromise, timeoutPromise]);
    } catch (err) {
      // LLMProvider.chat() is contractually non-throwing, but guard anyway.
      this.logger.warn({ err, channelId: input.channelId }, 'outbound-judge: provider threw — treating as unreachable');
      return this.onUnreachable(input, 'provider threw');
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (raced === TIMEOUT) {
      controller.abort(); // cancel the orphaned provider call
      this.logger.warn({ timeoutMs: this.config.timeoutMs, channelId: input.channelId }, 'outbound-judge: timed out');
      return this.onUnreachable(input, `timed out after ${this.config.timeoutMs}ms`);
    }

    const response = raced;
    const latencyMs = Date.now() - start;

    if (response.type === 'error') {
      this.logger.warn({ error: response.error.message, channelId: input.channelId }, 'outbound-judge: provider returned error');
      return this.onUnreachable(input, `provider error: ${response.error.message ?? 'unknown'}`);
    }
    if (response.type !== 'text') {
      // A tool_use response is unexpected for a judge — treat as malformed.
      // Log here like every sibling failure branch so this path is observable.
      this.logger.warn(
        { responseType: response.type, channelId: input.channelId },
        'outbound-judge: unexpected non-text response — treating as malformed',
      );
      return this.onMalformed(input, `unexpected response type: ${response.type}`);
    }

    const verdict = parseVerdict(response.content);
    if (verdict === null) {
      // Log non-sensitive metadata only — the raw model output can echo fragments of
      // the (possibly sensitive) outbound body, which must not land in plain logs or
      // in the outbound.blocked audit finding. Hash + length stay debuggable.
      const responseHash = createHash('sha256').update(response.content).digest('hex');
      this.logger.warn(
        { responseHash, responseLength: response.content.length, channelId: input.channelId },
        'outbound-judge: unparseable verdict',
      );
      return this.onMalformed(input, 'unparseable JSON verdict');
    }

    // Telemetry only on a real, parsed model response.
    await this.publishTelemetry(response.usage, response.provenance, latencyMs, userPrompt, response.content, input);

    if (verdict.leak) {
      await this.publishDecision(input, 'judged_block', 'audience_leak', 'llm-judge-audience-leak');
      return [{ rule: 'llm-judge-audience-leak', detail: verdict.reason || 'judge flagged an audience leak' }];
    }
    await this.publishDecision(input, 'judged_pass');
    return [];
  }

  /** Judge unreachable (timeout / API error). split+open → deliver; closed → block. */
  private async onUnreachable(input: JudgeInput, reason: string): Promise<FilterFinding[]> {
    if (this.config.failMode === 'closed') {
      // Outage under closed is not a model verdict — keep it out of judged_block.
      await this.publishDecision(input, 'failed_closed', 'unreachable', reason);
      return [{ rule: 'llm-judge-unavailable', detail: reason }];
    }
    // split / open → deliver with Stage-1-only filtering. This used to be silent;
    // failed_open makes the availability choice visible in audit_log (#1911).
    await this.publishDecision(input, 'failed_open', 'unreachable', reason);
    return [];
  }

  /** Live model produced an unparseable verdict. split+closed → block; open → deliver. */
  private async onMalformed(input: JudgeInput, raw: string): Promise<FilterFinding[]> {
    if (this.config.failMode === 'open') {
      await this.publishDecision(input, 'failed_open', 'unparseable', raw);
      return [];
    }
    // Live model responded but we couldn't parse — still a block, tagged unparseable
    // so queries don't conflate it with audience_leak.
    await this.publishDecision(input, 'judged_block', 'unparseable', raw);
    return [{ rule: 'llm-judge-parse-error', detail: raw }];
  }

  private async publishDecision(
    input: JudgeInput,
    outcome: OutboundJudgeOutcome,
    reasonCode?: OutboundJudgeReasonCode,
    reason?: string,
  ): Promise<void> {
    try {
      await this.bus.publish('dispatch', createOutboundJudge({
        conversationId: input.conversationId || 'system',
        channelId: input.channelId,
        outcome,
        // Skip has no failMode / reasonCode semantics; omit so queries can tell
        // skip from fail-open and from a real verdict.
        ...(outcome === 'skipped_principal_sole'
          ? {}
          : {
              failMode: this.config.failMode,
              ...(reasonCode ? { reasonCode } : {}),
            }),
        ...(reason ? { reason: truncateReason(reason) } : {}),
      }));
    } catch (err) {
      this.logger.warn({ err, outcome, channelId: input.channelId }, 'outbound-judge: failed to publish outbound.judge event');
    }
  }

  private async publishTelemetry(
    usage: LLMUsage,
    provenance: LLMCallProvenance,
    latencyMs: number,
    prompt: string,
    responseText: string,
    input: JudgeInput,
  ): Promise<void> {
    try {
      const promptHash = createHash('sha256').update(prompt).digest('hex');
      const responseHash = createHash('sha256').update(responseText).digest('hex');
      const event = createLlmCall({
        agentId: 'outbound-judge',
        conversationId: input.conversationId || 'system',
        requestedModel: provenance.requestedModel,
        actualModel: provenance.actualModel,
        provider: this.modelRegistry.getProvider(provenance.actualModel) ?? 'unknown',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        estimatedCostUsd: this.estimateCost(provenance.actualModel, usage, this.logger),
        latencyMs,
        providerRequestId: provenance.providerRequestId,
        promptHash,
        responseHash,
        parentEventId: 'system',
        archive: {
          prompt: {
            system: JUDGE_SYSTEM_PROMPT,
            user: prompt,
          },
          response: { type: 'text', content: responseText },
        },
      });
      await this.bus.publish('agent', event);
    } catch (err) {
      this.logger.warn({ err }, 'outbound-judge: failed to publish llm.call telemetry');
    }
  }
}

/**
 * Parse the judge verdict from raw model output. Tolerates surrounding whitespace
 * and ```json code fences. Returns null if no valid {leak, reason} object is found.
 */
export function parseVerdict(raw: string): Verdict | null {
  let text = raw.trim();
  // Strip a leading/trailing markdown code fence if present.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1]!.trim();
  // Extract the FIRST balanced {...} object, ignoring any surrounding prose or
  // trailing text. A greedy /\{[\s\S]*\}/ would span from the first "{" to the
  // LAST "}" — so a model that appends extra brace-containing text after a valid
  // verdict (e.g. `{"leak":false} Note: see {appendix}`) would over-capture, fail
  // JSON.parse, and be treated as malformed (blocked under split/closed). Scanning
  // for the first balanced object avoids that false positive.
  const extracted = extractFirstJsonObject(text);
  if (extracted === null) return null;
  text = extracted;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.leak !== 'boolean') return null;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return { leak: obj.leak, reason };
}

/**
 * Return the first balanced top-level JSON object substring in `text`, or null if
 * none is complete. Tracks string literals and escapes so braces inside strings
 * don't affect nesting depth (e.g. a reason containing "}" won't end the object early).
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
