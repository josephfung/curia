// principal-recipient.ts — structural principal recipient checks.
//
// Determines whether an outbound recipient matches the principal's verified channel
// identities. Used by the outbound content filter, outbound gateway, and Gate C
// (issue #1301). Never uses display name, role, or unverified identifiers.

import type { ChannelIdentity } from './types.js';

export interface TaggedRecipient {
  identifier: string;
  isPrincipal: boolean;
}

/** Whether an email address matches one of the principal's verified email identities. */
export function isPrincipalEmail(
  email: string | undefined | null,
  principalIdentities: readonly ChannelIdentity[],
): boolean {
  if (!email || principalIdentities.length === 0) return false;
  const normalized = email.toLowerCase();
  return principalIdentities.some(
    (id) => id.channel === 'email' && id.channelIdentifier.toLowerCase() === normalized,
  );
}

/** Whether a Signal identifier (E.164) matches the principal's verified Signal identity. */
export function isPrincipalSignal(
  identifier: string | undefined | null,
  principalIdentities: readonly ChannelIdentity[],
): boolean {
  if (!identifier || principalIdentities.length === 0) return false;
  return principalIdentities.some(
    (id) => id.channel === 'signal' && id.channelIdentifier === identifier,
  );
}

/**
 * After deduplicating by case-insensitive identifier, true only when exactly one
 * recipient remains and it is the principal.
 */
export function computePrincipalIsSoleRecipient(recipients: readonly TaggedRecipient[]): boolean {
  const seen = new Set<string>();
  const deduped: TaggedRecipient[] = [];
  for (const r of recipients) {
    const key = r.identifier.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped.length === 1 && deduped[0]!.isPrincipal;
}

/**
 * Resolve whether a skill invocation's recipient set is exclusively the principal,
 * using verified channel identities. Returns false when recipients cannot be
 * determined from the input (e.g. email-reply without explicit to/cc).
 */
export function resolvePrincipalIsSoleRecipientFromSkillInput(
  input: Record<string, unknown>,
  principalIdentities: readonly ChannelIdentity[],
): boolean {
  if (principalIdentities.length === 0) return false;

  // Signal 1:1 — group sends are never principal-only.
  const recipient = input['recipient'];
  const groupId = input['group_id'] ?? input['groupId'];
  if (typeof recipient === 'string' && recipient.length > 0) {
    if (groupId !== undefined && groupId !== null && String(groupId).length > 0) {
      return false;
    }
    return isPrincipalSignal(recipient, principalIdentities);
  }

  // Email — to + optional cc (comma-separated).
  const to = input['to'];
  if (typeof to === 'string' && to.trim().length > 0) {
    const emails: string[] = [to.trim()];
    const cc = input['cc'];
    if (typeof cc === 'string' && cc.trim().length > 0) {
      for (const part of cc.split(',')) {
        const trimmed = part.trim();
        if (trimmed.length > 0) emails.push(trimmed);
      }
    }
    const tagged = emails.map((email) => ({
      identifier: email,
      isPrincipal: isPrincipalEmail(email, principalIdentities),
    }));
    return computePrincipalIsSoleRecipient(tagged);
  }

  return false;
}
