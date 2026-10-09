// Whether a reply's To may be recorded as a verified email_participant (#2071).
//
// email-reply and the email adapter both copy an address out of a message
// header. That copy is not enough: the From may be Curia's own mailbox, the
// message may have failed SPF/DKIM/DMARC, or the address may belong to someone
// already on file. Callers that do not meet the bar omit recipientSource, and
// the gateway records an unverified outbound_recipient.

import { parseSenderVerified } from './message-converter.js';

/**
 * Lowercase and strip plus-addressing so an owned mailbox and its aliases compare equal.
 * Mirrors the adapter's self-address comparison.
 */
export function normalizeMailbox(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) return email.toLowerCase();
  const local = email.slice(0, at).replace(/\+.*$/, '');
  return local.toLowerCase() + email.slice(at).toLowerCase();
}

/**
 * `email_participant` when To was copied from a header, is not an owned mailbox,
 * and the receiving provider's Authentication-Results header shows SPF, DKIM,
 * and DMARC all passing. A header the sender added does not count.
 * Otherwise undefined: the caller omits the option and the gateway fails closed.
 */
export function replyRecipientSource(opts: {
  /** False when To was taken from the thread's To list (the latest message is ours). */
  addressFromHeader: boolean;
  recipient: string;
  selfEmails: readonly string[];
  headers?: Array<{ name: string; value: string }>;
}): 'email_participant' | undefined {
  if (!opts.addressFromHeader) return undefined;
  const needle = normalizeMailbox(opts.recipient);
  if (opts.selfEmails.some((email) => normalizeMailbox(email) === needle)) return undefined;
  if (!parseSenderVerified(opts.headers)) return undefined;
  return 'email_participant';
}

/**
 * From display name for the duplicate check. An address, or a blank, is not a name:
 * omitting it limits the check to identifier near-misses.
 */
export function replyDisplayName(name: string | undefined, email: string): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === email.toLowerCase()) return undefined;
  if (trimmed.includes('@') && normalizeMailbox(trimmed) === normalizeMailbox(email)) return undefined;
  return trimmed;
}
