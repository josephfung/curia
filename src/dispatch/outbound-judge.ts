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

import { createHash } from 'node:crypto';
import type { LLMProvider, LLMUsage, LLMCallProvenance } from '../agents/llm/provider.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createLlmCall } from '../bus/events.js';
import { createEstimateCostUsd } from '../agents/llm/pricing.js';
import type { FilterFinding, FilterRecipient } from './outbound-filter.js';
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt } from './outbound-judge-prompt.js';

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
    if (input.principalIsSoleRecipient) return [];

    const userPrompt = buildJudgeUserPrompt(
      input.content,
      input.recipients,
      input.principalIncluded,
      input.principalIsSoleRecipient,
    );

    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raced: Awaited<ReturnType<LLMProvider['chat']>> | typeof TIMEOUT;
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
        options: { temperature: 0, max_tokens: 100 },
      });
      const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), this.config.timeoutMs);
      });
      raced = await Promise.race([chatPromise, timeoutPromise]);
    } catch (err) {
      // LLMProvider.chat() is contractually non-throwing, but guard anyway.
      this.logger.warn({ err, channelId: input.channelId }, 'outbound-judge: provider threw — treating as unreachable');
      return this.onUnreachable('provider threw');
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (raced === TIMEOUT) {
      this.logger.warn({ timeoutMs: this.config.timeoutMs, channelId: input.channelId }, 'outbound-judge: timed out');
      return this.onUnreachable(`timed out after ${this.config.timeoutMs}ms`);
    }

    const response = raced;
    const latencyMs = Date.now() - start;

    if (response.type === 'error') {
      this.logger.warn({ error: response.error.message, channelId: input.channelId }, 'outbound-judge: provider returned error');
      return this.onUnreachable(`provider error: ${response.error.message ?? 'unknown'}`);
    }
    if (response.type !== 'text') {
      // A tool_use response is unexpected for a judge — treat as malformed.
      return this.onMalformed(`unexpected response type: ${response.type}`);
    }

    const verdict = parseVerdict(response.content);
    if (verdict === null) {
      this.logger.warn({ raw: response.content.slice(0, 200), channelId: input.channelId }, 'outbound-judge: unparseable verdict');
      return this.onMalformed(response.content.slice(0, 200));
    }

    // Telemetry only on a real, parsed model response.
    await this.publishTelemetry(response.usage, response.provenance, latencyMs, userPrompt, response.content, input);

    if (verdict.leak) {
      return [{ rule: 'llm-judge-audience-leak', detail: verdict.reason || 'judge flagged an audience leak' }];
    }
    return [];
  }

  /** Judge unreachable (timeout / API error). split+open → deliver; closed → block. */
  private onUnreachable(reason: string): FilterFinding[] {
    if (this.config.failMode === 'closed') {
      return [{ rule: 'llm-judge-unavailable', detail: reason }];
    }
    return [];
  }

  /** Live model produced an unparseable verdict. split+closed → block; open → deliver. */
  private onMalformed(raw: string): FilterFinding[] {
    if (this.config.failMode === 'open') {
      return [];
    }
    return [{ rule: 'llm-judge-parse-error', detail: raw }];
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
  // If there is surrounding prose, extract the first {...} block.
  if (!text.startsWith('{')) {
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) text = brace[0];
  }
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
