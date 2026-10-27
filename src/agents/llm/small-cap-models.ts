// small-cap-models.ts — boot check for models on small-cap NO_REASONING call sites (#2224).
//
// Several call sites send NO_REASONING with an output cap too small for thinking. A
// model that cannot turn thinking off spends those caps on thinking. The failures
// are quiet: the drift detector reads a failed call as no drift, and the outbound
// judge blocks the send.
//
// Each slot below is a config key whose model serves such a call site, with the call
// sites it serves. Boot refuses a model that fails ModelRegistry.canTurnThinkingOff.
// Unknown models are skipped: the registry checks for each key already refuse them,
// or disable voice.
//
// The standard tier is not a slot: no small-cap call site runs on it.
// tests/unit/agents/llm/small-cap-models.test.ts fails if any `infraLlm.extract` is
// left on it.

import type { YamlConfig } from '../../config.js';
import type { ModelRegistry } from './model-registry.js';

export interface SmallCapModelSlot {
  /** The config key that sets the model, for the boot error. */
  configKey: string;
  model: string;
  /** The small-cap call sites this model serves, for the boot error. */
  callSites: string;
}

// Same default the judge builders use when the block names no model.
const DEFAULT_JUDGE_MODEL = 'claude-haiku-5-5';

const FAST_TIER_CALL_SITES =
  'the infra-llm classifier (10 tokens), setup name suggestion (16), activity summarizer (40), '
  + 'drift detector (200), extract-facts and extract-relationships (1,000), voice-learn (1,200), '
  + 'scan-grant-recommendations and file-parse (4,000) and, with no channels.voice.model, voice turns';

/**
 * The models that serve a small-cap NO_REASONING call site under this config, checked
 * early in boot. A disabled judge serves none. The voice override is not listed: it is
 * checked by voiceModelSlot only when the voice adapter will start.
 */
export function smallCapModelSlots(yaml: YamlConfig): SmallCapModelSlot[] {
  const slots: SmallCapModelSlot[] = [];
  const fast = yaml.model_routing?.tiers.fast?.model;
  if (fast) slots.push({ configKey: 'model_routing.tiers.fast.model', model: fast, callSites: FAST_TIER_CALL_SITES });
  const outboundJudge = yaml.filter?.llmJudge;
  if (outboundJudge?.enabled ?? true) {
    slots.push({
      configKey: 'filter.llmJudge.model',
      model: outboundJudge?.model ?? DEFAULT_JUDGE_MODEL,
      callSites: 'the outbound leak judge (200 tokens)',
    });
  }
  const escalationJudge = yaml.escalation?.judge;
  if (escalationJudge?.enabled ?? true) {
    slots.push({
      configKey: 'escalation.judge.model',
      model: escalationJudge?.model ?? DEFAULT_JUDGE_MODEL,
      callSites: 'the escalation judge: disclosure (200 tokens), action (300) and band review (1,200)',
    });
  }
  return slots;
}

/**
 * The slot for the trimmed `channels.voice.model` override. Boot checks it where the
 * voice adapter is built, so an override on a channel that never starts cannot stop
 * boot. Without an override voice runs on the fast tier, which smallCapModelSlots lists.
 */
export function voiceModelSlot(voiceModel: string): SmallCapModelSlot {
  return { configKey: 'channels.voice.model', model: voiceModel, callSites: 'voice turns, which are latency-bound' };
}

/**
 * One line per slot whose model cannot turn thinking off, naming the config key and
 * the call sites it serves. Empty when every model can.
 */
export function smallCapThinkingViolations(slots: SmallCapModelSlot[], registry: ModelRegistry): string[] {
  return slots
    .filter((s) => registry.isKnownModel(s.model) && !registry.canTurnThinkingOff(s.model))
    .map((s) =>
      `${s.configKey}: "${s.model}" cannot turn thinking off, or has not been measured to, so it may spend `
      + `the output caps of ${s.callSites} on thinking. Choose a model whose registry entry lists reasoning `
      + 'effort none or records thinksByDefault: false.',
    );
}
