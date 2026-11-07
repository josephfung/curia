// autonomous-limits.ts — the code-enforced limits on an autonomous principal-mailbox send (#2474,
// design D4). Pure: the gateway fetches the draft, the thread, the task's draft writes and the
// thread's recent ledger entries, and this rules on them before band review, whatever the score.
// Every limit fails closed: anything unknown refuses, and a refusal leaves the draft as a draft.
// Principal-directed sends never come here.

import type { NylasMessage } from '../../channels/email/nylas-client.js';
import { normalizeForComparison, parseSenderVerified } from '../../channels/email/message-converter.js';
import type { CuriaDraftWrites } from './draft-provenance.js';
import type { PrincipalSendEntry } from './send-ledger.js';

export const AUTONOMOUS_MAX_RECIPIENTS = 5;
export const AUTONOMOUS_THREAD_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Slack between Curia's last write and the draft's provider timestamp, for clock skew. */
export const CURIA_WRITE_SKEW_SEC = 60;

export type AutonomousLimitRefusal =
  | 'not_curia_draft' | 'draft_changed_since_curia' | 'not_a_reply' | 'recipient_not_on_thread'
  | 'too_many_recipients' | 'mailing_list' | 'has_attachments' | 'thread_cooldown';

type Party = { email: string };

function lower(email: string): string {
  return email.trim().toLowerCase();
}

/** A predicate for "is one of the principal's own addresses" (plus-tags and case ignored). */
function principalMatcher(principalAddresses: readonly string[]): (email: string) => boolean {
  const own = new Set(principalAddresses.map(normalizeForComparison));
  return (email) => own.has(normalizeForComparison(email.trim()));
}

function fromPrincipal(msg: NylasMessage, isPrincipal: (email: string) => boolean): boolean {
  return msg.from.length > 0 && msg.from.every((p) => isPrincipal(p.email));
}

/**
 * Who a reply on this thread may go to, lowercased (design D4.3): the principal's addresses, the
 * recipients of messages sent from the principal's address, and the From of inbound messages
 * whose provider authenticated the sender. An inbound message's To/Cc never count: a sender can
 * list anyone there (a forged Cc of the CFO), the same rule as reply-recipient-provenance.ts.
 */
export function allowedThreadMembers(thread: readonly NylasMessage[], principalAddresses: readonly string[]): Set<string> {
  const isPrincipal = principalMatcher(principalAddresses);
  const members = new Set(principalAddresses.map(lower));
  for (const msg of thread) {
    if (fromPrincipal(msg, isPrincipal)) {
      for (const p of [...msg.to, ...msg.cc, ...msg.bcc]) members.add(lower(p.email));
    } else if (parseSenderVerified(msg.headers)) {
      for (const p of msg.from) members.add(lower(p.email));
    }
  }
  return members;
}

function hasListId(msg: NylasMessage): boolean {
  return (msg.headers ?? []).some((h) => h.name.trim().toLowerCase() === 'list-id');
}

/**
 * The first limit the draft breaks, or null when it may go to band review. Order: not created by
 * Curia in this task → changed since → not a reply → mailing list → stranger recipient → too many
 * recipients → attachments → thread cooldown.
 */
export function checkAutonomousLimits(input: {
  draft: NylasMessage;
  /** Non-draft messages on the draft's thread, fetched with headers. */
  thread: readonly NylasMessage[];
  principalAddresses: readonly string[];
  curiaWrites: CuriaDraftWrites;
  /** The thread's autonomous ledger entries inside the cooldown window. */
  recentThreadEntries: readonly PrincipalSendEntry[];
}): { refusal: AutonomousLimitRefusal; detail: string } | null {
  const { draft, thread, principalAddresses, curiaWrites, recentThreadEntries } = input;

  if (!curiaWrites.created) {
    return { refusal: 'not_curia_draft', detail: 'Curia did not create this draft in this task' };
  }
  // draft.date is Unix seconds. No write time means nothing to compare with: refuse (fail closed).
  const lastWriteSec = curiaWrites.lastWriteAt === null ? null : curiaWrites.lastWriteAt.getTime() / 1000;
  if (lastWriteSec === null || draft.date > lastWriteSec + CURIA_WRITE_SKEW_SEC) {
    return { refusal: 'draft_changed_since_curia', detail: 'the draft changed after Curia last wrote it' };
  }
  if (!draft.threadId || thread.length === 0) {
    return { refusal: 'not_a_reply', detail: 'the draft does not reply to a thread with messages' };
  }
  if (thread.some(hasListId)) {
    return { refusal: 'mailing_list', detail: 'the thread carries a List-Id header' };
  }

  const isPrincipal = principalMatcher(principalAddresses);
  const members = allowedThreadMembers(thread, principalAddresses);
  const recipients = [...new Set([...draft.to, ...draft.cc, ...draft.bcc].map((p: Party) => lower(p.email)))];
  const stranger = recipients.find((r) => !isPrincipal(r) && !members.has(r));
  if (stranger !== undefined) {
    return { refusal: 'recipient_not_on_thread', detail: `${stranger} is not on the thread` };
  }
  const others = recipients.filter((r) => !isPrincipal(r));
  if (others.length > AUTONOMOUS_MAX_RECIPIENTS) {
    return { refusal: 'too_many_recipients', detail: `${others.length} recipients; the limit is ${AUTONOMOUS_MAX_RECIPIENTS}` };
  }
  // NylasMessage lists only non-inline files, so a pasted signature image does not count.
  if (draft.attachments.length > 0) {
    return { refusal: 'has_attachments', detail: `the draft has ${draft.attachments.length} attachment(s)` };
  }
  // A `sending` entry is an attempt in flight (or this one); `sent` and `held` start the cooldown.
  const blocking = recentThreadEntries.find((e) => e.outcome === 'sent' || e.outcome === 'held');
  if (blocking !== undefined) {
    return { refusal: 'thread_cooldown', detail: `an autonomous send on this thread was ${blocking.outcome} at ${blocking.at}` };
  }
  return null;
}

/** Latest message on the thread not from a principal address. */
export function replyTarget(thread: readonly NylasMessage[], principalAddresses: readonly string[]): NylasMessage | null {
  const isPrincipal = principalMatcher(principalAddresses);
  let latest: NylasMessage | null = null;
  for (const msg of thread) {
    if (fromPrincipal(msg, isPrincipal)) continue;
    if (latest === null || msg.date >= latest.date) latest = msg;
  }
  return latest;
}
