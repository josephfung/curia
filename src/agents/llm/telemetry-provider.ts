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
import { createLlmCall } from '../../bus/events.js';
import { createEstimateCostUsd } from './pricing.js';
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
    const response = await this.inner.chat(params);
    const latencyMs = Date.now() - start;

    // Only publish telemetry on successful responses — error responses carry no
    // usage data to report, and are already logged by the inner provider.
    if (response.type !== 'error') {
      try {
        const promptHash = createHash('sha256')
          .update(JSON.stringify({ messages: params.messages, tools: params.tools ?? [] }))
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

    return response;
  }
}
