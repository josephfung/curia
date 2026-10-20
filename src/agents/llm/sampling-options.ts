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
