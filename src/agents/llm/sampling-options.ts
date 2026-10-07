// sampling-options.ts — shared resolution of provider sampling knobs from
// LLMProvider.chat()/stream() `options`. Providers and llm.call publishers use
// the same helpers so the request and the audit row stay aligned.

import type { Logger } from '../../logger.js';

/**
 * Resolve `options.temperature` for an LLM request.
 *
 * Returns a finite number when the caller set one (including 0). Returns
 * undefined when the key is absent so the provider default applies. Logs a
 * warning and returns undefined when the value is present but not a finite
 * number — never silently drop a malformed knob.
 */
export function resolveTemperature(
  options: Record<string, unknown> | undefined,
  logger: Logger,
): number | undefined {
  if (options === undefined || !('temperature' in options)) {
    return undefined;
  }
  const value = options.temperature;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  logger.warn(
    { temperature: value, temperatureType: typeof value },
    'Ignoring non-numeric options.temperature — provider default will be used',
  );
  return undefined;
}
