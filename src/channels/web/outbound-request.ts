// Web outbound send request — the principal's phone app (#2341, ADR-055).
//
// Principal-only. There is no third-party address on this channel: the
// recipient is the alias "principal".

export interface WebOutboundRequest {
  channel: 'web';
  /** Always the principal. The app has no other recipient. */
  recipient: 'principal';
  message: string;
}

export function isWebOutboundRequest(request: unknown): request is WebOutboundRequest {
  if (typeof request !== 'object' || request === null) return false;
  const row = request as Record<string, unknown>;
  return row['channel'] === 'web'
    && row['recipient'] === 'principal'
    && typeof row['message'] === 'string';
}
