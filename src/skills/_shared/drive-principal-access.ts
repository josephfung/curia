// drive-principal-access.ts — the principal always gets edit access on a Drive share.
//
// google-workspace's manage_drive_access defaults a grant to `reader`, and nothing tells
// the model which role the principal should get, so it shared files Curia made for the
// principal as read-only (scenario 13a, principal_can_edit 0-1 of 5 on main). A file
// shared with the principal is theirs to work on, so the handler raises any grant to the
// principal's own address to `writer` before it reaches the server. Everyone else gets
// the role the model chose: what fits the content and situation is a judgment call
// (skills/google-workspace/references/drive-files.md).
//
// Only `grant` and `grant_batch` name a recipient. `update` names a permission ID, so a
// role change on an existing principal permission passes through unchanged.

import type { ChannelIdentity } from '../../contacts/types.js';

export const DRIVE_ACCESS_TOOL = 'manage_drive_access';
export const PRINCIPAL_DRIVE_ROLE = 'writer';

export interface PrincipalDriveGrant {
  /** The input to send: unchanged when nothing was raised. */
  input: Record<string, unknown>;
  /** The roles that were raised to writer, one per principal recipient. Empty when none. */
  raisedFrom: string[];
}

/** The principal's email addresses, lowercased, from the identity snapshot. */
function principalEmails(identities: readonly ChannelIdentity[]): Set<string> {
  return new Set(
    identities
      .filter(id => id.channel === 'email' && id.verified && id.status === 'active')
      .map(id => id.channelIdentifier.trim().toLowerCase()),
  );
}

function isPrincipalAddress(value: unknown, emails: Set<string>): boolean {
  return typeof value === 'string' && emails.has(value.trim().toLowerCase());
}

/** A user share (the default type) or none named: a group or domain is never the principal. */
function isUserShare(shareType: unknown): boolean {
  return shareType === undefined || shareType === null || shareType === 'user';
}

/** The role as the server would apply it: an unset grant role means reader. */
function effectiveRole(role: unknown): string {
  return typeof role === 'string' && role !== '' ? role : 'reader';
}

/**
 * Raise every grant to the principal's email address to writer.
 * Returns the input untouched for any other tool, action or recipient.
 */
export function raisePrincipalDriveGrant(
  toolName: string,
  input: Record<string, unknown>,
  principalIdentities: readonly ChannelIdentity[],
): PrincipalDriveGrant {
  if (toolName !== DRIVE_ACCESS_TOOL) return { input, raisedFrom: [] };
  const emails = principalEmails(principalIdentities);
  if (emails.size === 0) return { input, raisedFrom: [] };

  if (input.action === 'grant') {
    if (!isUserShare(input.share_type) || !isPrincipalAddress(input.share_with, emails)) {
      return { input, raisedFrom: [] };
    }
    const role = effectiveRole(input.role);
    if (role === PRINCIPAL_DRIVE_ROLE) return { input, raisedFrom: [] };
    return { input: { ...input, role: PRINCIPAL_DRIVE_ROLE }, raisedFrom: [role] };
  }

  if (input.action === 'grant_batch' && Array.isArray(input.recipients)) {
    const raisedFrom: string[] = [];
    const recipients = input.recipients.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      const recipient = entry as Record<string, unknown>;
      if (!isUserShare(recipient.share_type) || !isPrincipalAddress(recipient.email, emails)) {
        return recipient;
      }
      const role = effectiveRole(recipient.role);
      if (role === PRINCIPAL_DRIVE_ROLE) return recipient;
      raisedFrom.push(role);
      return { ...recipient, role: PRINCIPAL_DRIVE_ROLE };
    });
    if (raisedFrom.length === 0) return { input, raisedFrom };
    return { input: { ...input, recipients }, raisedFrom };
  }

  return { input, raisedFrom: [] };
}

/** The line appended to a successful result, so the model reports the access truthfully. */
export function principalDriveGrantNote(raisedFrom: readonly string[]): string {
  const asked = [...new Set(raisedFrom)].join(' / ');
  return `Note: the principal was given ${PRINCIPAL_DRIVE_ROLE} (edit) access, not ${asked}. ` +
    'The principal always gets edit access to files shared with them.';
}
