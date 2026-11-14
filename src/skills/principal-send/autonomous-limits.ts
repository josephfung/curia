// autonomous-limits.ts — the code-enforced limits on an autonomous principal-mailbox send (#2474,
// design D4). Pure: the gateway fetches the draft, the thread, the task's draft writes and the
// thread's recent ledger entries, and this rules on them before band review, whatever the score.
// Every limit fails closed: anything unknown refuses, and a refusal leaves the draft as a draft.
// Principal-directed sends never come here.

import type { NylasMessage } from '../../channels/email/nylas-client.js';
import { normalizeForComparison, parseSenderVerified, spfAlignedWithFrom } from '../../channels/email/message-converter.js';
import type { CuriaDraftWrites } from './draft-provenance.js';
import type { PrincipalSendEntry } from './send-ledger.js';

export const AUTONOMOUS_MAX_RECIPIENTS = 5;
export const AUTONOMOUS_THREAD_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * The most autonomous sends in any rolling AUTONOMOUS_DAILY_CAP_WINDOW_MS, across every thread
 * (#2474 final fixes A4, security review M2): the cooldown is per thread, so N senders on N new
 * threads would otherwise get N replies a day from the principal's mailbox.
 */
export const AUTONOMOUS_DAILY_CAP = 10;
export const AUTONOMOUS_DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Slack between Curia's last write and the draft's provider timestamp, for clock skew. */
export const CURIA_WRITE_SKEW_SEC = 60;

export type AutonomousLimitRefusal =
  | 'not_curia_draft' | 'draft_changed_since_curia' | 'not_a_reply' | 'principal_address_recipient' | 'reply_to_principal_address' | 'recipient_not_on_thread'
  | 'too_many_recipients' | 'mailing_list' | 'has_attachments' | 'thread_cooldown' | 'daily_cap';

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
 * The provider filed the message as sent from this mailbox (Gmail's SENT system label). A From
 * header alone is a claim: an inbound message can forge `From: <principal>` plus any To/Cc list.
 */
function inSentFolder(msg: NylasMessage): boolean {
  return msg.folders.some((f) => f.toUpperCase() === 'SENT');
}

/** No sender vouched for: an inbound message's To/Cc then count for nothing (the rule before #2589). */
const NO_KNOWN_SENDERS: ReadonlySet<string> = new Set();

/**
 * Local parts that reach a role, a system or a group rather than one person (#2589 security review
 * M2). A copy to one of these is never vouched for: `all-staff@` is one address under the five-
 * recipient cap but can reach thousands, and the principal's direct copy of list mail may carry no
 * list header. Mirrors contact-service.ts's AUTOMATED_LOCAL_RE and NON_PERSON_LOCAL_RE (not imported:
 * this module stays free of the contacts service), plus group names. A false match only holds.
 */
const NOT_ONE_PERSON_LOCAL_RE = new RegExp(
  '^(?:'
  + 'no[_.-]?reply|noreply|donotreply|do[_.-]not[_.-]?reply|mailer[_.-]?daemon|notifications?|alerts?|newsletters?|updates?|bounces?|bounced|postmaster|automated|auto'
  + '|info|support|hello|help|admin|contact|billing|feedback|news|team|sales|marketing|legal|security|service|services|orders?|invoices?|accounts?|system'
  + '|all|all[_.-]?(?:staff|hands|company|employees|team|users)|everyone|everybody|staff|employees|company|board|directors|execs?|executives|leadership|managers|group|groups|list|lists|members|announce(?:ments)?'
  + ')$',
  'i',
);

function isOnePersonAddress(email: string): boolean {
  const at = email.lastIndexOf('@');
  return at > 0 && !NOT_ONE_PERSON_LOCAL_RE.test(email.slice(0, at));
}

/** How many raw headers of this name the message carries (names are case-insensitive). */
function headerCount(msg: NylasMessage, name: string): number {
  return (msg.headers ?? []).filter((h) => h.name.trim().toLowerCase() === name).length;
}

/**
 * The To/Cc of an inbound message whose sender vouches for them, lowercased (#2589, ADR-062 rule
 * 3). All of these must hold, or it is empty (fail closed):
 *  - not a principal-From message (those are vouched for by SENT, in receivedBy);
 *  - a single From, verified by the provider's own Authentication-Results (SPF, DKIM and DMARC
 *    pass): the list is then the authenticated sender's own claim, not a third party's forgery;
 *  - that From is in `knownSenders`: an active, verified address of a person contact (not an
 *    organization: those reach known on their first inbound) at tier known or above, resolved by
 *    the gateway at send time. A stranger's fresh address, however well
 *    authenticated (`"Jane Smith" <random@gmail.com>`), names no one;
 *  - exactly one From header, and at most one To and one Cc header. A header added after
 *    signing is a second copy, and which one a parser reads is not ours to guess;
 *  - the provider's SPF pass is aligned with the From domain (spfAlignedWithFrom). DMARC passes on
 *    DKIM alone, so without this a DKIM-signed message replayed from an attacker's own server
 *    (SPF passing for the attacker's envelope domain) would verify (#2589 security review H1);
 *  - one of the principal's addresses is on its To or Cc: a message the principal got only as a
 *    Bcc or an envelope recipient, as a replay would be, vouches for no one.
 * Even then, a copy to a role, system or group address, or to one of `unvouchable` (Curia's own
 * mailboxes), is left out: those never become recipients this way.
 * Microsoft 365's default DKIM signature covers neither To nor Cc, so coverage is not required:
 * it would refuse every M365 sender. A replay with edited recipients therefore has to pass aligned
 * SPF, i.e. leave from servers the sender's domain authorizes (an accepted risk, ADR-062).
 */
export function vouchedCopies(
  msg: NylasMessage,
  principalAddresses: readonly string[],
  knownSenders: ReadonlySet<string>,
  unvouchable: ReadonlySet<string> = NO_KNOWN_SENDERS,
): string[] {
  const isPrincipal = principalMatcher(principalAddresses);
  if (fromPrincipal(msg, isPrincipal)) return [];
  if (msg.from.length !== 1 || !parseSenderVerified(msg.headers)) return [];
  const from = lower(msg.from[0]!.email);
  if (!knownSenders.has(from)) return [];
  if (headerCount(msg, 'from') !== 1 || headerCount(msg, 'to') > 1 || headerCount(msg, 'cc') > 1) return [];
  if (!spfAlignedWithFrom(msg.headers, from)) return [];
  const copies = [...msg.to, ...msg.cc].map((p) => lower(p.email)).filter((e) => e.length > 0);
  if (!copies.some(isPrincipal)) return [];
  return [...new Set(copies)].filter((e) => isPrincipal(e) || (isOnePersonAddress(e) && !unvouchable.has(e)));
}

/**
 * Who a reply on this thread may go to, lowercased (design D4.3, #2589): the principal's
 * addresses, the recipients of messages the provider shows the principal sent (From a principal
 * address and in SENT), the From of inbound messages whose provider authenticated the sender,
 * and the To/Cc of the message being answered (the latest outside message) when its sender
 * vouches for them (vouchedCopies). Any other inbound To/Cc never counts: an unverified or
 * unknown sender can list anyone there (a forged Cc of the CFO). Only the answered message's,
 * as reply-all works: someone the sender has since dropped is not brought back.
 */
export function allowedThreadMembers(
  thread: readonly NylasMessage[],
  principalAddresses: readonly string[],
  knownSenders: ReadonlySet<string> = NO_KNOWN_SENDERS,
  /** Lowercased addresses never vouched in (Curia's own mailboxes, #2589 security review M1). */
  unvouchable: ReadonlySet<string> = NO_KNOWN_SENDERS,
): Set<string> {
  const members = new Set(principalAddresses.map(lower));
  // Who demonstrably received a thread message, without any inbound copies (receivedBy).
  for (const msg of thread) for (const address of receivedBy(msg, principalAddresses)) members.add(address);
  const answered = replyTarget(thread, principalAddresses);
  if (answered) for (const address of vouchedCopies(answered, principalAddresses, knownSenders, unvouchable)) members.add(address);
  return members;
}

/**
 * Who demonstrably received a thread message, lowercased (#2474 final fixes A2, security review
 * M3), for the quote proof and the off-thread evidence:
 *  - a message the principal sent (principal From and in SENT): its To/Cc/Bcc;
 *  - an inbound message: its single verified From, plus its To/Cc only when the sender vouches
 *    for them (vouchedCopies, #2589). Otherwise its To/Cc are a claim: a forged `Cc: cfo@…` the
 *    envelope never delivered must not read as the CFO having seen it.
 * The principal always counts (the mailbox holds the message). Anything else, such as an
 * unverified sender or a principal From outside SENT, is received by the principal alone (fail
 * closed). Without `knownSenders`, no inbound To/Cc counts.
 */
export function receivedBy(
  msg: NylasMessage,
  principalAddresses: readonly string[],
  knownSenders: ReadonlySet<string> = NO_KNOWN_SENDERS,
): Set<string> {
  const isPrincipal = principalMatcher(principalAddresses);
  const got = new Set(principalAddresses.map(lower));
  if (fromPrincipal(msg, isPrincipal)) {
    // Fail closed: a principal-From message outside SENT may be spoofed, so it adds no one (its
    // From is the principal, already counted). A provider without a SENT label allows fewer
    // recipients until provider-specific sent detection exists.
    if (inSentFolder(msg)) for (const p of [...msg.to, ...msg.cc, ...msg.bcc]) got.add(lower(p.email));
  } else if (msg.from.length === 1 && parseSenderVerified(msg.headers)) {
    // DMARC aligns one header.from domain, not every mailbox of a multi-mailbox From, so only
    // a single-address From is vouched for (fail closed).
    got.add(lower(msg.from[0]!.email));
    for (const address of vouchedCopies(msg, principalAddresses, knownSenders)) got.add(address);
  }
  return got;
}

/**
 * The people the message being answered newly copied, lowercased (#2589, ADR-062 rule 12): its
 * To/Cc, minus the principal and the sender, whom the principal has not already written to on
 * this thread (an earlier message from a principal address, in SENT). On a thread the principal
 * hasn't answered, that is everyone the sender copied.
 *
 * This feeds a hold signal (band review's high-stakes-copy), not membership, so both sides lean
 * toward asking: the candidates are the raw To/Cc whether or not the sender vouches for them (a
 * forged Cc of the board can only cause a hold, never a send to the board), and only the
 * principal's own replies make someone old news. A sender who copied legal on an earlier message
 * the principal never answered has still escalated since the principal last spoke (security
 * review M3).
 */
export function newlyCopied(
  thread: readonly NylasMessage[],
  principalAddresses: readonly string[],
): string[] {
  const answered = replyTarget(thread, principalAddresses);
  if (!answered) return [];
  const isPrincipal = principalMatcher(principalAddresses);
  const seen = new Set<string>();
  for (const msg of thread) {
    if (!fromPrincipal(msg, isPrincipal) || !inSentFolder(msg) || !(msg.date < answered.date)) continue;
    for (const address of receivedBy(msg, principalAddresses)) seen.add(address);
  }
  const sender = new Set(answered.from.map((p) => lower(p.email)));
  const copies = [...new Set([...answered.to, ...answered.cc].map((p) => lower(p.email)).filter((e) => e.length > 0))];
  return copies.filter((a) => !isPrincipal(a) && !sender.has(a) && !seen.has(a));
}

/**
 * List mail (#2474 final fixes A6, security review M4): a List-Id header, or any header a list
 * server or bulk sender stamps. A list's direct copy can drop List-Id and keep the others, and a
 * reply there reaches everyone on the list.
 */
const LIST_HEADERS = new Set(['list-id', 'list-post', 'list-unsubscribe', 'x-google-group-id', 'mailing-list']);
const LIST_PRECEDENCE = /^(list|bulk|junk)$/i;

function isListMail(msg: NylasMessage): boolean {
  return (msg.headers ?? []).some((h) => {
    const name = h.name.trim().toLowerCase();
    return LIST_HEADERS.has(name) || (name === 'precedence' && LIST_PRECEDENCE.test(h.value.trim()));
  });
}

/** The most conversation ids one ledger entry keeps. */
export const MAX_CONVERSATION_IDS = 50;

/** Message-IDs in a header value: `<a@x> <b@x>` or bare tokens; lowercased, brackets stripped. */
export function messageIdsIn(value: string): string[] {
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
  const ids = bracketed.length > 0 ? bracketed : value.split(/\s+/).map((t) => t.replace(/^<|>$/g, ''));
  return ids.map((i) => i.trim().toLowerCase()).filter((i) => i.length > 0);
}

/**
 * The conversation's Message-IDs (#2475): each thread message's Message-ID, then every References
 * and In-Reply-To value, deduplicated and capped. The same conversation in another inbox shares
 * them, though its thread id differs. Messages fetched without headers add nothing.
 */
export function conversationIdsOf(thread: readonly NylasMessage[]): string[] {
  const own: string[] = [];
  const referenced: string[] = [];
  for (const msg of thread) {
    for (const h of msg.headers ?? []) {
      const name = h.name.trim().toLowerCase();
      if (name === 'message-id') own.push(...messageIdsIn(h.value));
      else if (name === 'references' || name === 'in-reply-to') referenced.push(...messageIdsIn(h.value));
    }
  }
  return [...new Set([...own, ...referenced])].slice(0, MAX_CONVERSATION_IDS);
}

/**
 * The first limit the draft breaks, or null when it may go to band review. Order: not created by
 * Curia in this task → changed since → not a reply → mailing list → another principal address
 * (a recipient, or the mail answered) → stranger recipient → too many
 * recipients → attachments → thread cooldown → daily cap. The last two write no held marker
 * (the gateway's recordAutonomousStop), so they come last: a draft that breaks another limit too
 * still starts its thread's cooldown.
 */
export function checkAutonomousLimits(input: {
  draft: NylasMessage;
  /** Non-draft messages on the draft's thread, fetched with headers. */
  thread: readonly NylasMessage[];
  principalAddresses: readonly string[];
  curiaWrites: CuriaDraftWrites;
  /** The thread's autonomous ledger entries inside the cooldown window. */
  recentThreadEntries: readonly PrincipalSendEntry[];
  /** Autonomous entries in any mailbox that share a Message-ID with this conversation, inside the window (#2475). */
  recentConversationEntries: readonly PrincipalSendEntry[];
  /** The principal's addresses other than the sending mailbox's own (#2475). Empty: one mailbox. */
  otherPrincipalAddresses: readonly string[];
  /**
   * Addresses a recipient may not be (R43). Absent: `otherPrincipalAddresses`. Wider only when
   * the mailbox's own address is unknown and the principal has several.
   */
  offLimitsRecipients?: readonly string[];
  /** Autonomous sends (`sending` or `sent`) on any thread inside the daily cap's window. */
  autonomousSendsInWindow: number;
  /**
   * Lowercased From addresses whose To/Cc a reply may follow (#2589): an active, verified address
   * of a contact at tier known or above, resolved at send time. Absent: none (fail closed).
   */
  knownSenders?: ReadonlySet<string>;
  /** Lowercased addresses a sender's copies never vouch in: Curia's own mailboxes (#2589). */
  unvouchable?: ReadonlySet<string>;
}): { refusal: AutonomousLimitRefusal; detail: string } | null {
  const { draft, thread, principalAddresses, curiaWrites, recentThreadEntries, recentConversationEntries, otherPrincipalAddresses, offLimitsRecipients, autonomousSendsInWindow, knownSenders, unvouchable } = input;

  if (!curiaWrites.created) {
    return { refusal: 'not_curia_draft', detail: 'Curia did not create this draft in this task' };
  }
  // draft.date is Unix seconds. A missing or non-finite draft date or write time leaves nothing
  // to compare, and NaN compares false: refuse unless both are finite (fail closed).
  const lastWriteSec = curiaWrites.lastWriteAt === null ? Number.NaN : curiaWrites.lastWriteAt.getTime() / 1000;
  const draftSec: unknown = draft.date;
  if (typeof draftSec !== 'number' || !Number.isFinite(draftSec) || !Number.isFinite(lastWriteSec)
    || draftSec > lastWriteSec + CURIA_WRITE_SKEW_SEC) {
    return { refusal: 'draft_changed_since_curia', detail: 'the draft changed after Curia last wrote it' };
  }
  if (!draft.threadId || thread.length === 0) {
    return { refusal: 'not_a_reply', detail: 'the draft does not reply to a thread with messages' };
  }
  if (thread.some(isListMail)) {
    return { refusal: 'mailing_list', detail: 'a thread message carries mailing-list headers' };
  }

  // Curia reaches the principal's other addresses only through the digest, never as a reply:
  // not to them, and not to mail they sent (#2475, D6). Before the thread-member checks.
  const isOther = principalMatcher(otherPrincipalAddresses);
  const isOffLimits = principalMatcher(offLimitsRecipients ?? otherPrincipalAddresses);
  const toOther = [...draft.to, ...draft.cc, ...draft.bcc].find((p: Party) => isOffLimits(p.email));
  if (toOther !== undefined) {
    return { refusal: 'principal_address_recipient', detail: 'the draft is addressed to another of the principal\'s email addresses' };
  }
  // The latest message not from this mailbox's own address: when a principal address wrote it, the reply goes to it.
  const isOwn = principalMatcher(principalAddresses.filter((a) => !isOther(a)));
  let latestOutside: NylasMessage | null = null;
  for (const m of thread) {
    if (fromPrincipal(m, isOwn)) continue;
    if (latestOutside === null || m.date >= latestOutside.date) latestOutside = m;
  }
  if (latestOutside !== null && fromPrincipal(latestOutside, isOther)) {
    return { refusal: 'reply_to_principal_address', detail: 'the message answered is from another of the principal\'s email addresses' };
  }

  const isPrincipal = principalMatcher(principalAddresses);
  const members = allowedThreadMembers(thread, principalAddresses, knownSenders, unvouchable);
  const recipients = [...new Set([...draft.to, ...draft.cc, ...draft.bcc].map((p: Party) => lower(p.email)))];
  const stranger = recipients.find((r) => !isPrincipal(r) && !members.has(r));
  if (stranger !== undefined) {
    return { refusal: 'recipient_not_on_thread', detail: `${stranger} is not on the thread` };
  }
  const others = recipients.filter((r) => !isPrincipal(r));
  // A send to no one but the principal is not a reply to the thread; refuse it with the same code.
  if (others.length === 0) {
    return { refusal: 'recipient_not_on_thread', detail: 'no external recipient' };
  }
  if (others.length > AUTONOMOUS_MAX_RECIPIENTS) {
    return { refusal: 'too_many_recipients', detail: `${others.length} recipients; the limit is ${AUTONOMOUS_MAX_RECIPIENTS}` };
  }
  // NylasMessage lists only non-inline files, so a pasted signature image does not count.
  if (draft.attachments.length > 0) {
    return { refusal: 'has_attachments', detail: `the draft has ${draft.attachments.length} attachment(s)` };
  }
  // Every outcome starts the cooldown. `sending` too, failing closed: a send that crashed after
  // dispatch never became `sent` but may have gone out. The gateway checks limits before it
  // writes its own marker, so it never meets its own in-flight entry here.
  const blocking = recentThreadEntries[0] ?? recentConversationEntries[0];
  if (blocking !== undefined) {
    return { refusal: 'thread_cooldown', detail: `an autonomous send on this thread was ${blocking.outcome} at ${blocking.at}` };
  }
  if (autonomousSendsInWindow >= AUTONOMOUS_DAILY_CAP) {
    return { refusal: 'daily_cap', detail: `${autonomousSendsInWindow} autonomous sends in the last day; the limit is ${AUTONOMOUS_DAILY_CAP}` };
  }
  return null;
}

/**
 * The message the draft answers, when it is the thread's latest message not from a principal
 * address (#2474 final fixes A5, security review M2/B6), else null. `replyToMessageId` comes from
 * the draft-reply result that created the draft (DraftProvenance.curiaWritesInTask), so a draft
 * steered onto an older message, or one with no recorded reply target, refuses (fail closed): an
 * injected email cannot fan replies out to other threads' stale messages.
 */
export function repliedToLatest(
  thread: readonly NylasMessage[],
  principalAddresses: readonly string[],
  replyToMessageId: string | null,
): NylasMessage | null {
  if (!replyToMessageId) return null;
  const latest = replyTarget(thread, principalAddresses);
  return latest?.id === replyToMessageId ? latest : null;
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
