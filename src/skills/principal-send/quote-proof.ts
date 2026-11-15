// quote-proof.ts — what in an autonomous principal-mailbox reply's quote the thread already
// showed its recipients (#2474 PR 2, design D2), plus the small pure helpers the gateway's
// autonomous path uses to name a draft and its reply target.
//
// Security: the draft body is model-written, so a quote marker in it proves nothing. An injected
// drafter could put a marker above personal data, or hide data inside a genuine quote in places
// text extraction drops (comments, attributes, styles). So a quote's detected item is exempt from
// review only when the thread itself proves the recipients already had that value.
//
// "Had" means received (#2474 final fixes A2, security review M3): an inbound message's To/Cc
// are its sender's claim, so receivedBy counts only what the mailbox can vouch for, plus the To/Cc
// of a verified sender at tier known or above (#2589, vouchedCopies).

import sanitizeHtml from 'sanitize-html';
import type { NylasMessage } from '../../channels/email/nylas-client.js';
import { parseSenderVerified } from '../../channels/email/message-converter.js';
import { htmlToText } from '../../channels/email/html-to-text.js';
import type { DetectedPii } from '../../dispatch/pii-redactor.js';
import { receivedBy } from './autonomous-limits.js';

/** A non-draft message on the thread, as the quote proof compares it. */
export interface ThreadMessageProof {
  /** comparableText of the message body. */
  text: string;
  /** Who demonstrably received the message, lowercased (receivedBy). */
  receivedBy: ReadonlySet<string>;
}

/**
 * Every HTML entity in already-extracted text, decoded (#2474 final fixes addendum R2). htmlToText
 * decodes six, while a real reply quote went through sanitize-html, which decodes them all, so an
 * Outlook `&#8217;` or `&eacute;` left the two sides different. The same decoder here: `<` is
 * escaped first so the text is never read as markup, and sanitize-html's own re-escaping is undone.
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return sanitizeHtml(text.replace(/</g, '&lt;'), { allowedTags: [], allowedAttributes: {}, nonTextTags: [] })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** HTML as text for comparing a quote with a thread message: entities decoded, whitespace collapsed, lowercased. */
export function comparableText(html: string | undefined | null): string {
  return decodeEntities(htmlToText(html)).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A thread message as the quote proof needs it. `knownSenders` (#2589): the verified, known senders
 * whose To/Cc count as received (receivedBy); absent, no inbound To/Cc counts.
 */
export function threadMessageProof(
  msg: NylasMessage,
  principalAddresses: readonly string[],
  knownSenders?: ReadonlySet<string>,
  /** Never vouched in as receivers, as for membership: Curia's own mailboxes (#2589). */
  unvouchable?: ReadonlySet<string>,
): ThreadMessageProof {
  return { text: comparableText(msg.body), receivedBy: receivedBy(msg, principalAddresses, knownSenders, unvouchable) };
}

/**
 * The thread message a quote reproduces, or null (fail closed): one whose text contains the
 * quote's visible text (from its first <blockquote>) and that every one of `audience` (this
 * send's non-principal recipients) received. No <blockquote>, an empty quote or no audience is
 * null.
 */
function quoteSource(quote: string, thread: readonly ThreadMessageProof[], audience: readonly string[]): ThreadMessageProof | null {
  const bodyAt = quote.search(/<blockquote\b/i);
  if (bodyAt < 0 || audience.length === 0) return null;
  const quoted = comparableText(quote.slice(bodyAt));
  if (!quoted) return null;
  const recipients = audience.map((a) => a.trim().toLowerCase());
  return thread.find((m) => m.text.includes(quoted) && recipients.every((r) => m.receivedBy.has(r))) ?? null;
}

/**
 * Why a reply's quote fails the proof (#2590), so the refusal can say which:
 *  - `not-in-thread`: no thread message holds the quoted text (or there is no quoted body, or no
 *    audience to prove it for). The quote may carry text from elsewhere.
 *  - `not-received`: a thread message holds the text, but `missing` (lowercased) never received
 *    it. Where several messages hold the text, the one missing the fewest is named.
 */
export type QuoteProblem = { kind: 'not-in-thread' } | { kind: 'not-received'; missing: string[] };

/**
 * What is wrong with a reply's quote, or null when it shows only what a thread message every
 * recipient received said (#2474 final fixes A10, security review B4). The same rule as
 * quoteSource, so it never passes a quote quoteSource refuses; it only adds the reason.
 */
export function quoteProblem(quote: string, thread: readonly ThreadMessageProof[], audience: readonly string[]): QuoteProblem | null {
  if (quoteSource(quote, thread, audience)) return null;
  const bodyAt = quote.search(/<blockquote\b/i);
  const quoted = bodyAt < 0 ? '' : comparableText(quote.slice(bodyAt));
  const recipients = audience.map((a) => a.trim().toLowerCase());
  // No quoted body or no audience: nothing to name, so keep the general reason (fail closed).
  if (!quoted || recipients.length === 0) return { kind: 'not-in-thread' };
  let missing: string[] | null = null;
  for (const m of thread) {
    if (!m.text.includes(quoted)) continue;
    const absent = recipients.filter((r) => !m.receivedBy.has(r));
    if (missing === null || absent.length < missing.length) missing = absent;
  }
  // quoteSource found no source, so a text match always leaves someone missing here.
  return missing === null || missing.length === 0 ? { kind: 'not-in-thread' } : { kind: 'not-received', missing };
}

/**
 * Whether a reply's quote shows only what a thread message every recipient received said
 * (#2474 final fixes A10, security review B4). A model-written quote block holding anything
 * else (a figure from memory, another thread's text) could read to the judge as "already on the
 * thread"; the gateway holds such a reply before the review. quoteProblem says why it fails.
 */
export function quoteMatchesThread(quote: string, thread: readonly ThreadMessageProof[], audience: readonly string[]): boolean {
  return quoteProblem(quote, thread, audience) === null;
}

/**
 * The quote's detected items the review must still rule on, as field `quote`. An item is exempt
 * only when all of these hold (fail closed otherwise):
 *  (a) a non-draft thread message contains the quote's visible text (from its first <blockquote>);
 *  (b) every one of this send's non-principal recipients received that same message (receivedBy):
 *      being on the thread is not being on the quoted message;
 *  (c) the item's own value is in that message's text, or is the address of someone who received
 *      it (the quote header names them). Data hidden where text extraction does not look (a
 *      comment, an attribute) fails this, since the detector reads the raw HTML.
 */
export function quoteItemsToReview(
  items: readonly DetectedPii[],
  quote: string,
  thread: readonly ThreadMessageProof[],
  audience: readonly string[],
): DetectedPii[] {
  if (items.length === 0) return [];
  const source = quoteSource(quote, thread, audience);
  if (!source) return [...items];
  return items.filter((i) => {
    const value = comparableText(i.matched);
    return !(value && (source.text.includes(value) || source.receivedBy.has(value)));
  });
}

/**
 * How a digest item names a principal-mailbox draft (#2474, design D9): `"<subject>" to <names>`,
 * each non-principal recipient by display name, else address.
 */
export function mailboxDraftLabel(draft: NylasMessage, isPrincipal: (email: string) => boolean): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of [...draft.to, ...draft.cc, ...draft.bcc]) {
    const email = r.email.trim().toLowerCase();
    if (!email || seen.has(email) || isPrincipal(email)) continue;
    seen.add(email);
    names.push(r.name?.trim() || r.email.trim());
  }
  return `"${draft.subject}"${names.length > 0 ? ` to ${names.join(', ')}` : ''}`;
}

/**
 * The thread as band review's `off-thread` evidence (#2474, design D10): the messages every one
 * of `audience` (this send's non-principal recipients) received (receivedBy), as their text with
 * when each was sent. A message that left any recipient out isn't on the thread for this send: a
 * side reply to one person shows the others nothing, and an inbound header's Cc is no proof of
 * receipt (final fixes A2). No audience, or no such message, is an empty thread (fail closed: new
 * information then holds). The review redacts, orders and bounds them.
 */
export function threadTextSeenByAll(
  thread: readonly NylasMessage[],
  audience: readonly string[],
  principalAddresses: readonly string[],
  /** #2589: the verified, known senders whose To/Cc count as received; absent, none do. */
  knownSenders?: ReadonlySet<string>,
  /** Never vouched in as receivers, as for membership: Curia's own mailboxes (#2589). */
  unvouchable?: ReadonlySet<string>,
): Array<{ at?: string; text: string }> {
  const recipients = audience.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0);
  if (recipients.length === 0) return [];
  return thread
    .filter((m) => {
      const got = receivedBy(m, principalAddresses, knownSenders, unvouchable);
      return recipients.every((r) => got.has(r));
    })
    .map((m) => ({
      ...(Number.isFinite(m.date) ? { at: new Date(m.date * 1000).toISOString() } : {}),
      text: htmlToText(m.body),
    }));
}

/**
 * The message an autonomous reply answers, as band review's origin (#2474, design D2). The sender
 * counts as verified only when its own headers say so (fail closed).
 */
export function replyOrigin(target: NylasMessage): { content: string; at?: string; senderVerified: boolean } {
  return {
    content: htmlToText(target.body),
    ...(Number.isFinite(target.date) ? { at: new Date(target.date * 1000).toISOString() } : {}),
    senderVerified: parseSenderVerified(target.headers),
  };
}
