// escalation-judge.ts — EscalationJudge: LLM-powered escalation-line classifier.
//
// Classifies (a) the sensitivity of proposed outbound disclosures and (b) the
// consequence class of proposed actions, then applies the deterministic policy
// tables in escalation-policy.ts to produce an allow / escalate decision.
//
// Design: the LLM classifies; code enforces. The policy is never inside a prompt.
// This separation makes the policy transparent, auditable, and testable without
// mocking the LLM.
//
// Security boundary: this is a security gate, not a skill. It hard-codes fail-closed
// — any LLM unreachability, timeout, or malformed verdict results in 'escalate'.
//
// The judge NEVER throws. All failure paths return EscalationVerdict with
// decision='escalate' and a reason string suitable for audit logging.

import { createHash } from 'node:crypto';
import type { LLMProvider, LLMUsage, LLMCallProvenance, ReasoningOmission } from '../agents/llm/provider.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { buildLlmArchiveResponse } from '../audit/llm-archive-response.js';
import { createLlmCall } from '../bus/events.js';
import { createEstimateCostUsd } from '../agents/llm/pricing.js';
import { sentTemperature } from '../agents/llm/sampling-options.js';
import { llmCallReasoningFields } from '../agents/llm/llm-call-reasoning.js';
import type { ContactTier } from '../contacts/types.js';
import {
  applyDisclosurePolicy,
  applyActionPolicy,
  type DisclosureClass,
  type ActionConsequenceClass,
  type EscalationDecision,
} from './escalation-policy.js';
import {
  DISCLOSURE_SYSTEM_PROMPT,
  ACTION_SYSTEM_PROMPT,
  buildDisclosureUserPrompt,
  buildActionUserPrompt,
  parseDisclosureVerdict,
  parseActionVerdict,
} from './escalation-judge-prompt.js';
import {
  BRIEF_SYSTEM_PROMPT,
  buildBriefUserPrompt,
  parseBriefVerdict,
  type BriefInput,
  type BriefVerdict,
} from './judge-brief.js';

export interface EscalationJudgeConfig {
  /** When false, both classifiers return 'escalate' without calling the model. */
  enabled: boolean;
  /** Model string passed to the provider router. Validated against the registry at startup. */
  model: string;
  /** Hard timeout for each LLM call in ms. */
  timeoutMs: number;
  /**
   * Timeout for the band brief (review(), #2159). It reads the drafting turn's evidence and
   * can quote several sentences back, so it needs longer than a one-word classification.
   * Default 15000.
   */
  reviewTimeoutMs?: number;
}

export interface DisclosureInput {
  /** The text content being evaluated for disclosure sensitivity. */
  content: string;
  /** The tier of the contact who will receive this disclosure. */
  recipientTier: ContactTier;
  /** Telemetry correlation. */
  conversationId: string;
}

export interface ActionInput {
  /**
   * Natural language description of the proposed action. Expected to come from
   * the coordinator before decomposition into tool calls — e.g. "book a flight to
   * Toronto for Joseph on Tuesday" rather than individual skill invocations.
   */
  description: string;
  /** The tier of the contact who initiated the task. */
  initiatingTier: ContactTier;
  /** Telemetry correlation. */
  conversationId: string;
}

export interface EscalationVerdict {
  decision: EscalationDecision;
  /** LLM-assigned disclosure class — present when classifyDisclosure succeeds. */
  disclosureClass?: DisclosureClass;
  /** LLM-assigned action class — present when classifyAction succeeds. */
  actionClass?: ActionConsequenceClass;
  /** LLM-assigned third-party-facing flag — present when classifyAction succeeds. Absent on
   *  any failure path (which always carries decision='escalate'), so callers that recompute
   *  the policy from this flag must treat `undefined` as a fail-closed escalate. */
  isThirdPartyFacing?: boolean;
  /** Reason from the LLM or a failure description — suitable for audit logging. */
  reason: string;
}

const TIMEOUT = Symbol('escalation-judge-timeout');

/** Deterministic verdict sampling — used for both the chat() call and llm.call audit. */
const JUDGE_TEMPERATURE = 0;

type LlmKind = 'disclosure' | 'action' | 'review';

const DEFAULT_REVIEW_TIMEOUT_MS = 15_000;
// The brief can quote several sentences back (#2159), so it gets the most room.
// A four-question brief over a six-claim message measured 229 tokens on Haiku 4.5
// and up to 408 on Haiku 5.5; 1200 keeps the ~3x headroom 800 used to give (#2077).
const REVIEW_MAX_TOKENS = 1200;

interface LlmCallResult {
  content: string;
  usage: LLMUsage;
  provenance: LLMCallProvenance;
  latencyMs: number;
  reasoning?: string;
  reasoningOmitted?: ReasoningOmission;
}

export class EscalationJudge {
  private readonly estimateCost: (actualModel: string, usage: LLMUsage, logger?: Logger) => number;

  constructor(
    private readonly provider: LLMProvider,
    private readonly config: EscalationJudgeConfig,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly modelRegistry: ModelRegistry,
  ) {
    this.estimateCost = createEstimateCostUsd(modelRegistry);
  }

  /** Returns false when the judge's kill switch is off. Used by callers to skip invocation entirely. */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Classify the sensitivity of a proposed disclosure and determine whether
   * sharing it with a contact at the given tier should be allowed or escalated.
   *
   * Fail-closed: any unreachability, timeout, or malformed verdict → escalate.
   */
  async classifyDisclosure(input: DisclosureInput): Promise<EscalationVerdict> {
    if (!this.config.enabled) {
      // Disabled judge is fail-closed: escalate rather than silently allowing.
      return { decision: 'escalate', reason: 'escalation judge disabled' };
    }

    const userPrompt = buildDisclosureUserPrompt(input.content);
    const result = await this.callLlm(userPrompt, DISCLOSURE_SYSTEM_PROMPT, input.conversationId, 'disclosure', this.config.timeoutMs);

    if (result === null) {
      return { decision: 'escalate', reason: 'judge unreachable or timed out' };
    }

    const verdict = parseDisclosureVerdict(result.content);
    if (verdict === null) {
      this.logger.error(
        {
          responseHash: createHash('sha256').update(result.content).digest('hex'),
          conversationId: input.conversationId,
        },
        'escalation-judge: unparseable disclosure verdict — escalating',
      );
      return { decision: 'escalate', reason: 'malformed judge verdict' };
    }

    // Fire-and-forget: telemetry failure must never delay or block the security gate decision.
    void this.publishTelemetry(result, userPrompt, input.conversationId, 'disclosure');

    try {
      const decision = applyDisclosurePolicy(input.recipientTier, verdict.class);
      return { decision, disclosureClass: verdict.class, reason: verdict.reason };
    } catch (err) {
      this.logger.warn({ err, conversationId: input.conversationId }, 'escalation-judge: disclosure policy threw — escalating');
      return { decision: 'escalate', reason: 'policy enforcement error' };
    }
  }

  /**
   * Classify the consequence of a proposed action and determine whether a contact
   * at the given tier is permitted to initiate it.
   *
   * Fail-closed: any unreachability, timeout, or malformed verdict → escalate.
   */
  async classifyAction(input: ActionInput): Promise<EscalationVerdict> {
    if (!this.config.enabled) {
      return { decision: 'escalate', reason: 'escalation judge disabled' };
    }

    const userPrompt = buildActionUserPrompt(input.description);
    const result = await this.callLlm(userPrompt, ACTION_SYSTEM_PROMPT, input.conversationId, 'action', this.config.timeoutMs);

    if (result === null) {
      return { decision: 'escalate', reason: 'judge unreachable or timed out' };
    }

    const verdict = parseActionVerdict(result.content);
    if (verdict === null) {
      this.logger.error(
        {
          responseHash: createHash('sha256').update(result.content).digest('hex'),
          conversationId: input.conversationId,
        },
        'escalation-judge: unparseable action verdict — escalating',
      );
      return { decision: 'escalate', reason: 'malformed judge verdict' };
    }

    // Fire-and-forget: telemetry failure must never delay or block the security gate decision.
    void this.publishTelemetry(result, userPrompt, input.conversationId, 'action');

    try {
      const decision = applyActionPolicy(input.initiatingTier, verdict.class, verdict.isThirdPartyFacing);
      // Expose isThirdPartyFacing so a caller (e.g. Gate C) can recompute the policy against a
      // trusted consequence-class floor instead of taking the judge's class verbatim.
      return { decision, actionClass: verdict.class, isThirdPartyFacing: verdict.isThirdPartyFacing, reason: verdict.reason };
    } catch (err) {
      this.logger.warn({ err, conversationId: input.conversationId }, 'escalation-judge: action policy threw — escalating');
      return { decision: 'escalate', reason: 'policy enforcement error' };
    }
  }

  /**
   * Ask the band brief's questions (#2159). Never throws. A failure is returned as such,
   * never as a pass: the caller decides what a failure does at the current band.
   */
  async review(input: BriefInput): Promise<BriefVerdict> {
    if (!this.config.enabled) return { ok: false, failure: 'disabled' };
    // No questions would parse as a vacuous pass. A caller that built an empty list has a bug;
    // treat it as a failure so it cannot read as a clean review.
    if (input.questions.length === 0) {
      this.logger.error({ conversationId: input.conversationId }, 'escalation-judge: review called with no questions');
      return { ok: false, failure: 'malformed' };
    }
    const userPrompt = buildBriefUserPrompt(input);
    const result = await this.callLlm(
      userPrompt,
      BRIEF_SYSTEM_PROMPT,
      input.conversationId,
      'review',
      this.config.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    );
    if (result === null) return { ok: false, failure: 'unreachable' };
    // Before parsing, so a malformed verdict's raw response is archived too: under band
    // gating a malformed verdict can send unreviewed at 80+, and the archive is how to tell
    // a truncated answer from a garbled one. Fire-and-forget: never delays the review.
    void this.publishTelemetry(result, userPrompt, input.conversationId, 'review');
    const answers = parseBriefVerdict(result.content, input.questions);
    if (answers === null) {
      this.logger.error(
        {
          responseHash: createHash('sha256').update(result.content).digest('hex'),
          conversationId: input.conversationId,
          questions: input.questions,
          outputTokens: result.usage.outputTokens,
          maxTokens: REVIEW_MAX_TOKENS,
          likelyTruncated: result.usage.outputTokens >= REVIEW_MAX_TOKENS,
        },
        'escalation-judge: unparseable brief verdict',
      );
      return { ok: false, failure: 'malformed' };
    }
    return { ok: true, ...answers };
  }

  /** Make a single LLM call with timeout and abort. Returns null on any failure. */
  private async callLlm(
    userPrompt: string,
    systemPrompt: string,
    conversationId: string,
    kind: LlmKind,
    timeoutMs: number,
  ): Promise<LlmCallResult | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();

    // The action verdict has three fields (class, isThirdPartyFacing, reason) vs two
    // for disclosure — give it more room so verbose reason strings don't truncate.
    // The brief can quote several sentences back (#2159), so it gets the most room.
    // Truncated JSON → parseVerdict returns null → escalate (safe failure mode).
    // Haiku 5.5 verdicts measured up to 91 (action) and 66 (disclosure) tokens,
    // about 1.6x Haiku 4.5, so both caps were raised to keep ~3x headroom (#2077).
    const maxTokens = kind === 'review' ? REVIEW_MAX_TOKENS : kind === 'action' ? 300 : 200;

    try {
      const chatPromise = this.provider.chat({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options: { temperature: JUDGE_TEMPERATURE, max_tokens: maxTokens, signal: controller.signal },
      });
      // Suppress unhandled-rejection for post-timeout orphaned provider calls.
      // The primary error path is the outer catch; this handles the late-rejection race edge case.
      chatPromise.catch((err) => {
        this.logger.warn({ err, kind, conversationId }, 'escalation-judge: orphaned provider rejection after race/abort');
      });

      const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      });

      const raced = await Promise.race([chatPromise, timeoutPromise]);

      if (raced === TIMEOUT) {
        controller.abort();
        this.logger.warn({ timeoutMs, kind, conversationId }, 'escalation-judge: timed out');
        return null;
      }

      if (raced.type === 'error') {
        this.logger.error({ error: raced.error.message, kind, conversationId }, 'escalation-judge: provider error');
        return null;
      }

      if (raced.type !== 'text') {
        this.logger.warn({ responseType: raced.type, kind, conversationId }, 'escalation-judge: unexpected non-text response');
        return null;
      }

      return {
        content: raced.content,
        usage: raced.usage,
        provenance: raced.provenance,
        latencyMs: Date.now() - start,
        reasoning: raced.reasoning,
        reasoningOmitted: raced.reasoningOmitted,
      };
    } catch (err) {
      // Provider threw despite the non-throwing contract — treat as a gate failure and escalate.
      this.logger.error({ err, kind, conversationId }, 'escalation-judge: provider threw');
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Publish an llm.call telemetry event. Failure is logged and swallowed. */
  private async publishTelemetry(
    result: LlmCallResult,
    userPrompt: string,
    conversationId: string,
    kind: LlmKind,
  ): Promise<void> {
    try {
      const event = createLlmCall({
        agentId: `escalation-judge-${kind}`,
        conversationId: conversationId || 'system',
        requestedModel: result.provenance.requestedModel,
        actualModel: result.provenance.actualModel,
        provider: this.modelRegistry.getProvider(result.provenance.actualModel) ?? 'unknown',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
        cacheReadInputTokens: result.usage.cacheReadInputTokens,
        estimatedCostUsd: this.estimateCost(result.provenance.actualModel, result.usage, this.logger),
        latencyMs: result.latencyMs,
        providerRequestId: result.provenance.providerRequestId,
        promptHash: createHash('sha256').update(userPrompt).digest('hex'),
        responseHash: createHash('sha256').update(result.content).digest('hex'),
        // What the request carried, not the constant: a model that rejects
        // sampling parameters is sent no temperature at all (#2077).
        temperature: sentTemperature(
          { temperature: JUDGE_TEMPERATURE },
          this.modelRegistry.rejectsSamplingParams(result.provenance.requestedModel),
        ),
        ...llmCallReasoningFields(result.usage, result.provenance),
        parentEventId: 'system',
        archive: {
          prompt: {
            system: kind === 'disclosure'
              ? DISCLOSURE_SYSTEM_PROMPT
              : kind === 'action' ? ACTION_SYSTEM_PROMPT : BRIEF_SYSTEM_PROMPT,
            user: userPrompt,
          },
          response: buildLlmArchiveResponse({
            type: 'text',
            content: result.content,
            usage: result.usage,
            reasoning: result.reasoning,
            reasoningOmitted: result.reasoningOmitted,
          }),
        },
      });
      await this.bus.publish('agent', event);
    } catch (err) {
      this.logger.warn({ err }, 'escalation-judge: failed to publish llm.call telemetry');
    }
  }
}
