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

/**
 * Send skills whose input recipient shape is fully modeled in
 * `resolvePrincipalIsSoleRecipientFromSkillInput`. Gate C's principal-only carve-out
 * applies ONLY here — the parser sniffs input keys by convention (not types), so any
 * skill not on this list, or any input with recipient-shaped keys we do not parse,
 * fails closed (no carve-out). Update this set when adding a new outbound send skill.
 */
export const GATE_C_PRINCIPAL_CARVEOUT_SKILLS = new Set(['email-send', 'signal-send']);

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

function hasPresentValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function splitCommaSeparatedAddresses(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Parse email-send recipients from skill input. Returns null when the input contains
 * recipient-shaped keys this parser does not model (fail closed).
 */
function parseEmailSendRecipients(input: Record<string, unknown>): string[] | null {
  const unparsedRecipientKeys = ['bcc', 'recipients', 'recipient', 'group_id', 'groupId'] as const;
  for (const key of unparsedRecipientKeys) {
    if (hasPresentValue(input[key])) return null;
  }

  const to = input['to'];
  const cc = input['cc'];
  if (to !== undefined && to !== null && typeof to !== 'string') return null;
  if (cc !== undefined && cc !== null && typeof cc !== 'string') return null;
  if (!hasPresentValue(to) || typeof to !== 'string') return null;

  const emails = splitCommaSeparatedAddresses(to);
  if (typeof cc === 'string' && cc.trim().length > 0) {
    emails.push(...splitCommaSeparatedAddresses(cc));
  }
  return emails;
}

/**
 * Parse signal-send 1:1 recipient from skill input. Returns null for group sends or
 * when the input contains recipient-shaped keys this parser does not model.
 */
function parseSignalSendRecipient(input: Record<string, unknown>): string | null {
  const unparsedRecipientKeys = ['to', 'cc', 'bcc', 'recipients'] as const;
  for (const key of unparsedRecipientKeys) {
    if (hasPresentValue(input[key])) return null;
  }

  const recipient = input['recipient'];
  const groupId = input['group_id'] ?? input['groupId'];
  if (recipient !== undefined && recipient !== null && typeof recipient !== 'string') return null;
  if (hasPresentValue(groupId)) return null;
  if (!hasPresentValue(recipient)) return null;

  return (recipient as string).trim();
}

/**
 * Resolve whether a skill invocation's recipient set is exclusively the principal,
 * using verified channel identities. Returns false when recipients cannot be
 * determined from the input (e.g. email-reply without explicit to/cc) or when the
 * skill/input shape is not fully understood (fail closed).
 */
export function resolvePrincipalIsSoleRecipientFromSkillInput(
  skillName: string,
  input: Record<string, unknown>,
  principalIdentities: readonly ChannelIdentity[],
): boolean {
  if (principalIdentities.length === 0) return false;
  if (!GATE_C_PRINCIPAL_CARVEOUT_SKILLS.has(skillName)) return false;

  if (skillName === 'email-send') {
    const emails = parseEmailSendRecipients(input);
    if (emails === null) return false;
    const tagged = emails.map((email) => ({
      identifier: email,
      isPrincipal: isPrincipalEmail(email, principalIdentities),
    }));
    return computePrincipalIsSoleRecipient(tagged);
  }

  if (skillName === 'signal-send') {
    const recipient = parseSignalSendRecipient(input);
    if (recipient === null) return false;
    return isPrincipalSignal(recipient, principalIdentities);
  }

  return false;
}
