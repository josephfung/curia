/**
 * Voice model capability preflight (#1553).
 *
 * Voice turns need true streaming (ADR-037) and tool calls. The provider
 * exposing `stream()` is necessary but not sufficient — OpenRouter implements
 * stream() for every routed model, including ones that don't stream or tool-call.
 * Gate on the resolved model's registry capabilities instead.
 */

export const VOICE_REQUIRED_CAPABILITIES = ['streaming', 'tools'] as const;

export type VoiceCapabilityResult =
  | { ok: true }
  | { ok: false; missing: string[]; unknownModel: boolean };

export function evaluateVoiceModelCapabilities(
  _modelId: string,
  capabilities: readonly string[] | undefined,
): VoiceCapabilityResult {
  if (!capabilities) {
    return {
      ok: false,
      missing: [...VOICE_REQUIRED_CAPABILITIES],
      unknownModel: true,
    };
  }
  const missing = VOICE_REQUIRED_CAPABILITIES.filter((c) => !capabilities.includes(c));
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing: [...missing], unknownModel: false };
}
