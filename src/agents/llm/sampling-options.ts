// sampling-options.ts — shared resolution of provider sampling knobs from
// LLMProvider.chat()/stream() `options`. Providers and llm.call publishers use
// the same helpers so the request and the audit row stay aligned.

import type { Logger } from '../../logger.js';

/**
 * Provider-neutral reasoning effort (ADR-048). Each provider maps it onto the
 * model's own control. `none` asks for no reasoning where the model can turn
 * it off cleanly.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

/** Every effort, in increasing order. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze(['none', 'low', 'medium', 'high', 'max']);

/** `options.reasoning` and `model_routing.tiers.<tier>.reasoning` (ADR-048). */
export interface ReasoningSetting {
  effort: ReasoningEffort;
}

/**
 * What every non-agent call site sends: the judges, infra-llm, the scoring
 * pass, the drift detector, summarization and voice (ADR-048 §3). A provider
 * sends it only to models whose registry entry lists `none`, so each of those
 * requests stays as it was before the reasoning setting existed.
 */
export const NO_REASONING: Readonly<ReasoningSetting> = Object.freeze({ effort: 'none' });

/** Pure parse of `options.reasoning` — no logging. */
export type ParsedReasoning =
  | { kind: 'unset' }
  | { kind: 'set'; effort: ReasoningEffort }
  | { kind: 'invalid'; value: unknown };

/**
 * Parse `options.reasoning` without side effects. `undefined` is unset, so
 * `options: { reasoning: tierCfg.reasoning }` with an unset tier does not warn.
 */
export function parseReasoning(options: Record<string, unknown> | undefined): ParsedReasoning {
  const value = options?.reasoning;
  if (value === undefined) return { kind: 'unset' };
  if (typeof value === 'object' && value !== null) {
    const effort = (value as { effort?: unknown }).effort;
    if (typeof effort === 'string' && (REASONING_EFFORTS as readonly string[]).includes(effort)) {
      return { kind: 'set', effort: effort as ReasoningEffort };
    }
  }
  return { kind: 'invalid', value };
}

/**
 * Log a requested effort the model's registry entry does not list, which the
 * provider then leaves out. `none` is the expected case for the non-agent call
 * sites on models that cannot turn reasoning off, so it logs at debug.
 */
export function logUnsentReasoningEffort(
  logger: Logger,
  model: string,
  effort: ReasoningEffort,
  supported: readonly ReasoningEffort[] | undefined,
): void {
  const fields = { model, effort, supported: supported ?? [] };
  if (effort === 'none') {
    logger.debug(fields, 'Not sending reasoning effort none — the model cannot turn reasoning off cleanly; provider default applies');
  } else {
    logger.warn(fields, 'Not sending reasoning effort — the model does not list it; provider default applies');
  }
}

/**
 * Resolve `options.reasoning` for a provider request: the effort the caller
 * asked for, or undefined when unset. Warns and returns undefined on a
 * malformed value, so the provider default applies. Providers then check the
 * effort against the model's registry entry.
 */
export function resolveReasoning(
  options: Record<string, unknown> | undefined,
  logger: Logger,
): ReasoningEffort | undefined {
  const parsed = parseReasoning(options);
  if (parsed.kind === 'set') return parsed.effort;
  if (parsed.kind === 'invalid') {
    logger.warn({ reasoning: parsed.value }, 'Ignoring malformed options.reasoning — provider default will be used');
  }
  return undefined;
}

/** Pure parse of `options.temperature` — no logging. */
export type ParsedTemperature =
  | { kind: 'unset' }
  | { kind: 'set'; value: number }
  | { kind: 'invalid'; value: unknown };

/**
 * Parse `options.temperature` without side effects.
 *
 * `undefined` (key absent or explicitly undefined) is unset. `null` and other
 * non-finite values are invalid. Range validation is the provider's job —
 * Anthropic accepts 0–1 and OpenRouter 0–2; this helper only checks finiteness.
 */
export function parseTemperature(
  options: Record<string, unknown> | undefined,
): ParsedTemperature {
  // Treat missing key and explicit `undefined` the same so
  // `options: { temperature: tierCfg.temperature }` with an unset tier does not warn.
  if (options?.temperature === undefined) {
    return { kind: 'unset' };
  }
  const value = options.temperature;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { kind: 'set', value };
  }
  return { kind: 'invalid', value };
}

/**
 * Resolve `options.temperature` for an LLM request.
 *
 * Returns a finite number when the caller set one (including 0). Returns
 * undefined when unset so the provider default applies. Logs a warning and
 * returns undefined when the value is present but not a finite number — never
 * silently drop a malformed knob. Call this from the provider path only; audit
 * publishers should use `parseTemperature` so a bad value is not warned twice.
 */
export function resolveTemperature(
  options: Record<string, unknown> | undefined,
  logger: Logger,
): number | undefined {
  const parsed = parseTemperature(options);
  if (parsed.kind === 'unset') {
    return undefined;
  }
  if (parsed.kind === 'set') {
    return parsed.value;
  }
  logger.warn(
    { temperature: parsed.value, temperatureType: typeof parsed.value },
    'Ignoring non-numeric options.temperature — provider default will be used',
  );
  return undefined;
}

/**
 * The temperature a provider request actually carries, for `llm.call` audit
 * rows. `null` when the request omits it: the caller left it unset or passed
 * an invalid value, or the model rejects sampling parameters, in which case
 * the provider drops it whatever the caller passed (#2077).
 *
 * `rejectsSamplingParams` must come from the same registry lookup the provider
 * makes (`ModelRegistry.rejectsSamplingParams(requestedModel)`) so the audit
 * row cannot claim a temperature that was never sent (#2038).
 */
export function sentTemperature(
  options: Record<string, unknown> | undefined,
  rejectsSamplingParams: boolean,
): number | null {
  if (rejectsSamplingParams) {
    return null;
  }
  const parsed = parseTemperature(options);
  return parsed.kind === 'set' ? parsed.value : null;
}
