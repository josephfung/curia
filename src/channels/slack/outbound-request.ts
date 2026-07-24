// Slack outbound send request — owned by the Slack channel package.
//
// Part of the OutboundSendRequest discriminated union re-exported from
// outbound-gateway.ts (public API). Channel-owned so recipient projection
// (PrincipalChannelRules.extractRecipients) can live next to the wire shape
// without inverting the skills → channels layer dependency (ADR-035).

export interface SlackOutboundRequest {
  channel: 'slack';
  /** Slack conversation id (D… for DM, C…/G… for channel). Never principal-eligible. */
  slackChannelId: string;
  /** When set, reply in this thread (channel mentions / DM threads). */
  threadTs?: string;
  message: string;
  /**
   * Slack user id (U…) of the human recipient when known (DM peer or
   * dispatcher-stamped recipientId). Used for principal checks, blocked-contact
   * resolution, and disclosure tier — never the D…/C… conversation id.
   */
  slackUserId?: string;
}

/** Type guard for Slack outbound requests. */
export function isSlackOutboundRequest(request: unknown): request is SlackOutboundRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return (
    r['channel'] === 'slack'
    && typeof r['slackChannelId'] === 'string'
    && typeof r['message'] === 'string'
  );
}
