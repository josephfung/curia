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
import type { LLMProvider, LLMUsage, LLMCallProvenance } from '../agents/llm/provider.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createLlmCall } from '../bus/events.js';
import { createEstimateCostUsd } from '../agents/llm/pricing.js';
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

export interface EscalationJudgeConfig {
  /** When false, both classifiers return 'escalate' without calling the model. */
  enabled: boolean;
  /** Model string passed to the provider router. Validated against the registry at startup. */
  model: string;
  /** Hard timeout for each LLM call in ms. */
  timeoutMs: number;
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
  /** Reason from the LLM or a failure description — suitable for audit logging. */
  reason: string;
}

const TIMEOUT = Symbol('escalation-judge-timeout');

type LlmKind = 'disclosure' | 'action';

interface LlmCallResult {
  content: string;
  usage: LLMUsage;
  provenance: LLMCallProvenance;
  latencyMs: number;
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
    const result = await this.callLlm(userPrompt, DISCLOSURE_SYSTEM_PROMPT, input.conversationId, 'disclosure');

    if (result === null) {
      return { decision: 'escalate', reason: 'judge unreachable or timed out' };
    }

    const verdict = parseDisclosureVerdict(result.content);
    if (verdict === null) {
      this.logger.warn(
        {
          responseHash: createHash('sha256').update(result.content).digest('hex'),
          conversationId: input.conversationId,
        },
        'escalation-judge: unparseable disclosure verdict — escalating',
      );
      return { decision: 'escalate', reason: 'malformed judge verdict' };
    }

    await this.publishTelemetry(result, userPrompt, input.conversationId, 'disclosure');

    const decision = applyDisclosurePolicy(input.recipientTier, verdict.class);
    return { decision, disclosureClass: verdict.class, reason: verdict.reason };
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
    const result = await this.callLlm(userPrompt, ACTION_SYSTEM_PROMPT, input.conversationId, 'action');

    if (result === null) {
      return { decision: 'escalate', reason: 'judge unreachable or timed out' };
    }

    const verdict = parseActionVerdict(result.content);
    if (verdict === null) {
      this.logger.warn(
        {
          responseHash: createHash('sha256').update(result.content).digest('hex'),
          conversationId: input.conversationId,
        },
        'escalation-judge: unparseable action verdict — escalating',
      );
      return { decision: 'escalate', reason: 'malformed judge verdict' };
    }

    await this.publishTelemetry(result, userPrompt, input.conversationId, 'action');

    const decision = applyActionPolicy(input.initiatingTier, verdict.class, verdict.isThirdPartyFacing);
    return { decision, actionClass: verdict.class, reason: verdict.reason };
  }

  /** Make a single LLM call with timeout and abort. Returns null on any failure. */
  private async callLlm(
    userPrompt: string,
    systemPrompt: string,
    conversationId: string,
    kind: LlmKind,
  ): Promise<LlmCallResult | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();

    // The action verdict has three fields (class, isThirdPartyFacing, reason) vs two
    // for disclosure — give it more room so verbose reason strings don't truncate.
    // Truncated JSON → parseVerdict returns null → escalate (safe failure mode).
    const maxTokens = kind === 'action' ? 200 : 120;

    try {
      const chatPromise = this.provider.chat({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options: { temperature: 0, max_tokens: maxTokens, signal: controller.signal },
      });
      // Guard against a late rejection from an orphaned provider call after timeout.
      // LLMProvider.chat() is non-throwing by contract but guard anyway.
      chatPromise.catch(() => { /* handled via race + abort */ });

      const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), this.config.timeoutMs);
      });

      const raced = await Promise.race([chatPromise, timeoutPromise]);

      if (raced === TIMEOUT) {
        controller.abort();
        this.logger.warn({ timeoutMs: this.config.timeoutMs, kind, conversationId }, 'escalation-judge: timed out');
        return null;
      }

      if (raced.type === 'error') {
        this.logger.warn({ error: raced.error.message, kind, conversationId }, 'escalation-judge: provider error');
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
      };
    } catch (err) {
      this.logger.warn({ err, kind, conversationId }, 'escalation-judge: provider threw');
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
        parentEventId: 'system',
      });
      await this.bus.publish('agent', event);
    } catch (err) {
      this.logger.warn({ err }, 'escalation-judge: failed to publish llm.call telemetry');
    }
  }
}
