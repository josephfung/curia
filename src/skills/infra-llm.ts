// infra-llm.ts — constrained LLM service for infrastructure skills.
//
// Purpose-built operations (classify, extract) that:
// 1. Route through ModelRouter for tier selection
// 2. Publish llm.call bus events for telemetry
// 3. Do NOT expose raw chat() — skills cannot use this for arbitrary LLM access
//
// This is the replacement for the raw llmProvider + modelRouter capabilities
// that were temporarily exposed on SkillContext (#637). The narrow API surface
// IS the security policy: any skill can declare 'infraLlm', but all it gets
// is classify/extract with full telemetry, not unbounded LLM access.

import { createHash } from 'node:crypto';
import type { EventBus } from '../bus/bus.js';
import type { LLMProvider, LLMUsage, LLMCallProvenance } from '../agents/llm/provider.js';
import type { ModelRouter } from '../agents/llm/model-router.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import { createLlmCall } from '../bus/events.js';
import { createEstimateCostUsd } from '../agents/llm/pricing.js';
import type { Logger } from '../logger.js';

/**
 * Result from an InfraLlm operation — errors as values, never thrown.
 */
export type InfraLlmResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Constrained LLM interface exposed to skills via ctx.infraLlm.
 * Only classify and extract operations — no raw chat.
 */
export interface InfraLlm {
  /** Quick yes/no classification — routed to 'fast' tier. */
  classify(prompt: string): Promise<InfraLlmResult>;

  /** Structured extraction — routed to 'standard' tier. */
  extract(prompt: string, options?: {
    maxTokens?: number;
    /** For vision: base64 image + MIME type. */
    image?: { base64: string; mediaType: string };
  }): Promise<InfraLlmResult>;
}

/**
 * Per-invocation telemetry context — set by ExecutionLayer when injecting
 * infraLlm into SkillContext, so bus events carry the correct IDs.
 */
export interface InfraLlmScope {
  agentId?: string;
  taskEventId?: string;
  conversationId?: string;
  skillName: string;
}

/**
 * InfraLlmService — the singleton created at bootstrap. Call .scoped() to
 * create per-invocation wrappers that carry telemetry context.
 */
export class InfraLlmService {
  private readonly estimateCost: (actualModel: string, usage: LLMUsage, logger?: Logger) => number;
  private readonly modelRegistry: ModelRegistry;

  constructor(
    private readonly providerRouter: LLMProvider,
    private readonly modelRouter: ModelRouter,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    modelRegistry: ModelRegistry,
  ) {
    this.modelRegistry = modelRegistry;
    this.estimateCost = createEstimateCostUsd(modelRegistry);
  }

  /**
   * Create a scoped InfraLlm instance for a single skill invocation.
   * The scope carries agent/task/conversation IDs for telemetry events.
   */
  scoped(scope: InfraLlmScope): InfraLlm {
    return {
      classify: (prompt: string) => this.doClassify(prompt, scope),
      extract: (prompt: string, options?) => this.doExtract(prompt, options, scope),
    };
  }

  private async doClassify(prompt: string, scope: InfraLlmScope): Promise<InfraLlmResult> {
    const resolved = this.modelRouter.resolve('fast');
    const start = Date.now();

    const response = await this.providerRouter.chat({
      model: resolved.model,
      messages: [{ role: 'user', content: prompt }],
      options: { max_tokens: 10 },
    });

    const latencyMs = Date.now() - start;

    if (response.type !== 'text') {
      const errorMsg = response.type === 'error' ? response.error.message : 'Unexpected non-text response';
      this.logger.error(
        { type: response.type, skillName: scope.skillName, model: resolved.model },
        'infraLlm.classify failed',
      );
      return { ok: false, error: errorMsg };
    }

    await this.publishTelemetry(response.usage, response.provenance, latencyMs, prompt, response.content, scope);
    return { ok: true, text: response.content };
  }

  private async doExtract(
    prompt: string,
    options: { maxTokens?: number; image?: { base64: string; mediaType: string } } | undefined,
    scope: InfraLlmScope,
  ): Promise<InfraLlmResult> {
    const resolved = this.modelRouter.resolve('standard');
    const start = Date.now();

    // Build message — plain text or mixed vision content
    const message = options?.image
      ? {
          role: 'user' as const,
          content: [
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: options.image.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                data: options.image.base64,
              },
            },
            { type: 'text' as const, text: prompt },
          ],
        }
      : { role: 'user' as const, content: prompt };

    const response = await this.providerRouter.chat({
      model: resolved.model,
      messages: [message],
      options: { max_tokens: options?.maxTokens ?? 4000 },
    });

    const latencyMs = Date.now() - start;

    if (response.type !== 'text') {
      const errorMsg = response.type === 'error' ? response.error.message : 'Unexpected non-text response';
      this.logger.error(
        { type: response.type, skillName: scope.skillName, model: resolved.model },
        'infraLlm.extract failed',
      );
      return { ok: false, error: errorMsg };
    }

    await this.publishTelemetry(response.usage, response.provenance, latencyMs, prompt, response.content, scope);
    return { ok: true, text: response.content };
  }

  private async publishTelemetry(
    usage: LLMUsage,
    provenance: LLMCallProvenance,
    latencyMs: number,
    prompt: string,
    responseText: string,
    scope: InfraLlmScope,
  ): Promise<void> {
    try {
      const promptHash = createHash('sha256').update(prompt).digest('hex');
      const responseHash = createHash('sha256').update(responseText).digest('hex');

      const event = createLlmCall({
        agentId: scope.agentId ?? `skill:${scope.skillName}`,
        conversationId: scope.conversationId ?? 'system',
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
        parentEventId: scope.taskEventId ?? 'system',
      });

      await this.bus.publish('agent', event);
    } catch (err) {
      // Telemetry failure must not break the skill — log and continue.
      this.logger.warn(
        { err, skillName: scope.skillName },
        'infraLlm: failed to publish llm.call telemetry event',
      );
    }
  }
}
