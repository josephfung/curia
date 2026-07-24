// Signal outbound send request — owned by the Signal channel package.
//
// Part of the OutboundSendRequest discriminated union re-exported from
// outbound-gateway.ts (public API). Channel-owned so recipient projection
// (PrincipalChannelRules.extractRecipients) can live next to the wire shape
// without inverting the skills → channels layer dependency (ADR-035).

export interface SignalOutboundRequest {
  channel: 'signal';
  /**
   * E.164 phone number for 1:1 sends (e.g. "+14155552671").
   * Mutually exclusive with groupId — set exactly one.
   */
  recipient?: string;
  /**
   * Base64-encoded group V2 ID for group sends.
   * Mutually exclusive with recipient — set exactly one.
   * Never principal-eligible (other members present).
   */
  groupId?: string;
  message: string;
}

/** Type guard for Signal outbound requests. */
export function isSignalOutboundRequest(request: unknown): request is SignalOutboundRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return r['channel'] === 'signal' && typeof r['message'] === 'string';
}
