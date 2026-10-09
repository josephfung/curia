// outbound-filter-wiring.ts — bootstrap construction of the EscalationJudge and the
// OutboundContentFilter (#1870).
//
// This lives outside index.ts so the integration suite can build the filter the way
// production does. Before #1870, index.ts built the filter fifty lines before the
// escalation judge and never passed it in, so Stage 2.5 never ran in production. The
// unit tests injected a judge directly, which is a configuration production never
// built, so they kept passing.

import { EscalationJudge, type EscalationJudgeConfig } from '../autonomy/escalation-judge.js';
import { LLMProviderRouter } from '../agents/llm/provider-router.js';
import type { LLMProvider } from '../agents/llm/provider.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import type { EventBus } from '../bus/bus.js';
import type { YamlConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { OutboundContentFilter, type OutboundContentFilterConfig } from './outbound-filter.js';

/** Thrown for an escalation.judge config that would leave Gate C and Stage 2.5 broken. */
export class EscalationJudgeConfigError extends Error {
  constructor(message: string, readonly detail: Record<string, unknown>) {
    super(message);
    this.name = 'EscalationJudgeConfigError';
  }
}

/**
 * Build the EscalationJudge from the `escalation.judge` config block, or return
 * undefined when the block disables it. Gate C and Stage 2.5 both consume it.
 *
 * Throws EscalationJudgeConfigError for a bad timeout, an unregistered model, or a model
 * whose provider is not registered. A typo should fail at startup, not escalate every
 * ambiguous Gate C decision and block every Stage 2.5 send later.
 */
export function buildEscalationJudge(deps: {
  yaml: NonNullable<YamlConfig['escalation']>['judge'];
  modelRegistry: ModelRegistry;
  providerRegistry: Map<string, LLMProvider>;
  bus: EventBus;
  logger: Logger;
}): EscalationJudge | undefined {
  const { yaml, modelRegistry, providerRegistry, bus, logger } = deps;
  if (!(yaml?.enabled ?? true)) {
    logger.info('Escalation judge disabled via config (escalation.judge.enabled=false) — Gate C fails closed on ambiguous actions; Stage 2.5 disclosure gate inactive');
    return undefined;
  }

  const config: EscalationJudgeConfig = {
    enabled: true,
    model: yaml?.model ?? 'claude-haiku-4-5',
    timeoutMs: yaml?.timeout_ms ?? 5000,
  };
  // local.yaml overrides are deep-merged but not schema-checked, so validate here.
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 250) {
    throw new EscalationJudgeConfigError(
      'escalation.judge.timeout_ms must be an integer >= 250 (ms) — fix config (default.yaml or local.yaml)',
      { timeoutMs: config.timeoutMs },
    );
  }
  if (!modelRegistry.isKnownModel(config.model)) {
    throw new EscalationJudgeConfigError(
      'escalation.judge.model is not in the model registry — fix config (default.yaml or local.yaml)',
      { model: config.model },
    );
  }
  const providerName = modelRegistry.getProvider(config.model);
  if (!providerName || !providerRegistry.has(providerName)) {
    throw new EscalationJudgeConfigError(
      'escalation.judge.model maps to a provider that is not registered — set the corresponding API key or change the model',
      { model: config.model, provider: providerName },
    );
  }

  // Dedicated stateless router: the infra LLM router is constructed later in bootstrap.
  const router = new LLMProviderRouter(modelRegistry, providerRegistry);
  const judge = new EscalationJudge(router, config, bus, logger, modelRegistry);
  logger.info({ model: config.model }, 'Escalation judge enabled (Gate C third-party-facing classifier, Stage 2.5 disclosure classifier)');
  return judge;
}

/**
 * Construct the OutboundContentFilter and log whether Stage 2.5 is active.
 *
 * `escalationJudge` is a required key, though its value may be undefined, so a call
 * site that forgets it fails to compile. Leaving the judge out is how Stage 2.5 went
 * dark before (#1870).
 */
export function buildOutboundContentFilter(
  config: OutboundContentFilterConfig & {
    escalationJudge: EscalationJudge | undefined;
    logger: Logger;
  },
): OutboundContentFilter {
  const filter = new OutboundContentFilter(config);
  const disclosureGate = filter.disclosureGateStatus();
  if (disclosureGate === 'active') {
    config.logger.info(
      { markerCount: config.systemPromptMarkers.length, disclosureGate },
      'Outbound content filter initialized — Stage 2.5 disclosure gate active',
    );
  } else {
    config.logger.warn(
      { markerCount: config.systemPromptMarkers.length, disclosureGate },
      'Outbound content filter initialized — Stage 2.5 disclosure gate INACTIVE (no enabled escalation judge)',
    );
  }
  return filter;
}
