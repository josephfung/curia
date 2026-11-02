// The current phone app invitation link, as the Devices page shows it (#2412).

export type InvitationState = 'waiting' | 'redeemed' | 'expired';

export interface InvitationStatus {
  id: string;
  state: InvitationState;
  expiresAt: string;
  redeemedAt: string | null;
  deviceName: string | null;
}

export interface MintedInvitation {
  id: string;
  pairUrl: string;
  expiresAt: string;
  warning: string | null;
}

const STATES: readonly string[] = ['waiting', 'redeemed', 'expired'];

export function isInvitationStatus(value: unknown): value is InvitationStatus {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string'
    && typeof row['state'] === 'string' && STATES.includes(row['state'])
    && typeof row['expiresAt'] === 'string'
    && (row['redeemedAt'] === null || typeof row['redeemedAt'] === 'string')
    && (row['deviceName'] === null || typeof row['deviceName'] === 'string');
}

export function isMintedInvitation(value: unknown): value is MintedInvitation {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string'
    && typeof row['pairUrl'] === 'string'
    && typeof row['expiresAt'] === 'string'
    && (row['warning'] === null || typeof row['warning'] === 'string');
}

/** The body of GET /api/pairing/invitation: the current link, or null for none. Undefined when malformed. */
export function readInvitationBody(body: unknown): InvitationStatus | null | undefined {
  if (typeof body !== 'object' || body === null || !('invitation' in body)) return undefined;
  const invitation = (body as { invitation: unknown }).invitation;
  if (invitation === null) return null;
  return isInvitationStatus(invitation) ? invitation : undefined;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * One line for the link's state. A waiting link the clock has passed reads
 * as expired before the next poll says so.
 */
export function invitationSummary(status: InvitationStatus, now = Date.now()): string {
  if (status.state === 'redeemed') {
    const device = status.deviceName ? ` · ${status.deviceName}` : '';
    const at = status.redeemedAt ? ` · ${when(status.redeemedAt)}` : '';
    return `Redeemed ✓${device}${at}`;
  }
  if (status.state === 'expired' || new Date(status.expiresAt).getTime() <= now) {
    return `Expired ${when(status.expiresAt)}. Create a new link to try again.`;
  }
  return `Waiting to be opened · expires ${when(status.expiresAt)}`;
}

/** Poll only while the link can still change state on its own. */
export function shouldPollInvitation(status: InvitationStatus | null): boolean {
  return status?.state === 'waiting';
}
