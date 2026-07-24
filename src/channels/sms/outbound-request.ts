// SMS outbound send request — owned by the SMS channel package.
//
// Part of the OutboundSendRequest discriminated union re-exported from
// outbound-gateway.ts (public API). Channel-owned so recipient projection
// (PrincipalChannelRules.extractRecipients) can live next to the wire shape
// without inverting the skills → channels layer dependency (ADR-035).

export interface SmsOutboundRequest {
  channel: 'sms';
  /**
   * Peer E.164 phone number (e.g. "+14155552671").
   * Principal-eligible — never the office DID.
   */
  recipient: string;
  message: string;
}

/** Type guard for SMS outbound requests. */
export function isSmsOutboundRequest(request: unknown): request is SmsOutboundRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return (
    r['channel'] === 'sms'
    && typeof r['recipient'] === 'string'
    && typeof r['message'] === 'string'
  );
}
