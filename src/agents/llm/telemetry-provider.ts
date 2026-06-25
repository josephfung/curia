// telemetry-provider.ts — LLMProvider wrapper that publishes llm.call bus events.
//
// Used to add telemetry to system services (ScoringPass, DriftDetector) that
// receive LLMProvider directly at bootstrap rather than going through the skill
// execution path. Wrapping at construction time means no changes to the services
// themselves — they call chat() normally and get telemetry for free.
//
// For skill-layer LLM access, use InfraLlmService instead (constrained API).

import { createHash } from 'node:crypto';
import type { LLMProvider, LLMResponse, LLMUsage, Message, ToolDefinition, ToolResult } from './provider.js';
import type { EventBus } from '../../bus/bus.js';
import type { ModelRegistry } from './model-registry.js';
import { createLlmCall, createLlmError } from '../../bus/events.js';
import { createEstimateCostUsd } from './pricing.js';
import { classifyError } from '../../errors/classify.js';
import type { Logger } from '../../logger.js';

export class TelemetryLlmProvider implements LLMProvider {
  readonly id: string;
  private readonly estimateCost: (actualModel: string, usage: LLMUsage, logger?: Logger) => number;

  constructor(
    private readonly inner: LLMProvider,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    /** Identifier for the system service (e.g. 'scoring-pass', 'drift-detector'). */
    private readonly serviceId: string,
    modelRegistry: ModelRegistry,
  ) {
    this.id = inner.id;
    this.estimateCost = createEstimateCostUsd(modelRegistry);
  }

  async chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): Promise<LLMResponse> {
    const start = Date.now();
    let response: LLMResponse;
    try {
      response = await this.inner.chat(params);
    } catch (err) {
      // LLMProvider contract says chat() never throws, but network-level exceptions
      // can slip through. Normalise to an error response to honour the contract.
      this.logger.error(
        { err, serviceId: this.serviceId },
        'TelemetryLlmProvider: inner.chat() threw unexpectedly',
      );
      // Publish llm.error before returning so HealthService tracks this transport
      // failure. The try-catch below is fire-and-forget: telemetry failure must not
      // propagate. Note: this path bypasses the response.type === 'error' block below
      // via early return, so we publish here explicitly.
      try {
        await this.bus.publish('agent', createLlmError({
          agentId: `system:${this.serviceId}`,
          conversationId: 'system',
          // params.model identifies the tier model; fall back to this.inner.id (provider
          // slug) when absent. System services always pass params.model, so the fallback
          // is a don't-care in practice, but the health tracker will miss it if reached.
          requestedModel: params.model ?? this.inner.id,
          provider: this.inner.id,
          errorType: 'UNKNOWN',
          parentEventId: 'system',
        }));
      } catch (publishErr) {
        this.logger.warn(
          { err: publishErr, serviceId: this.serviceId },
          'TelemetryLlmProvider: failed to publish llm.error for thrown exception',
        );
      }
      return { type: 'error', error: classifyError(err, this.inner.id) };
    }
    const latencyMs = Date.now() - start;

    // Only publish telemetry on successful responses — error responses carry no
    // usage data to report, and are already logged by the inner provider.
    if (response.type !== 'error') {
      try {
        const promptHash = createHash('sha256')
          .update(JSON.stringify({
            messages: params.messages,
            tools: params.tools ?? [],
            toolResults: params.toolResults ?? [],
          }))
          .digest('hex');
        const responseText = response.type === 'text'
          ? response.content
          : JSON.stringify(response.toolCalls);
        const responseHash = createHash('sha256').update(responseText).digest('hex');

        const event = createLlmCall({
          agentId: `system:${this.serviceId}`,
          conversationId: 'system',
          requestedModel: response.provenance.requestedModel,
          actualModel: response.provenance.actualModel,
          provider: this.inner.id,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
          cacheReadInputTokens: response.usage.cacheReadInputTokens,
          estimatedCostUsd: this.estimateCost(response.provenance.actualModel, response.usage, this.logger),
          latencyMs,
          providerRequestId: response.provenance.providerRequestId,
          promptHash,
          responseHash,
          parentEventId: 'system',
        });

        await this.bus.publish('agent', event);
      } catch (err) {
        // Telemetry failure must not break the system service.
        this.logger.warn(
          { err, serviceId: this.serviceId },
          'TelemetryLlmProvider: failed to publish llm.call event',
        );
      }
    }

    // Publish llm.error on failed responses so HealthService can track tier health
    // without billed probe calls. Fire-and-forget inside try-catch — telemetry
    // failure must never propagate to the system service.
    if (response.type === 'error') {
      try {
        const event = createLlmError({
          agentId: `system:${this.serviceId}`,
          conversationId: 'system',
          // Fall back to the inner provider's id when params.model is absent —
          // 'unknown' would break the HealthService tier reverse-map lookup.
          requestedModel: params.model ?? this.inner.id,
          provider: this.inner.id,
          errorType: response.error.type,
          parentEventId: 'system',
        });
        await this.bus.publish('agent', event);
      } catch (err) {
        this.logger.warn(
          { err, serviceId: this.serviceId },
          'TelemetryLlmProvider: failed to publish llm.error event',
        );
      }
    }

    return response;
  }
}
