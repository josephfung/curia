// sampling-options.ts — shared resolution of provider sampling knobs from
// LLMProvider.chat()/stream() `options`. Providers and llm.call publishers use
// the same helpers so the request and the audit row stay aligned.

import type { Logger } from '../../logger.js';

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
