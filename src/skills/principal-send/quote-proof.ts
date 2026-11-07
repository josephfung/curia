// quote-proof.ts — what in an autonomous principal-mailbox reply's quote the thread already
// showed its recipients (#2474 PR 2, design D2), plus the small pure helpers the gateway's
// autonomous path uses to name a draft and its reply target.
//
// Security: the draft body is model-written, so a quote marker in it proves nothing. An injected
// drafter could put a marker above personal data, or hide data inside a genuine quote in places
// text extraction drops (comments, attributes, styles). So a quote's detected item is exempt from
// review only when the thread itself proves the recipients already had that value.

import type { NylasMessage } from '../../channels/email/nylas-client.js';
import { parseSenderVerified } from '../../channels/email/message-converter.js';
import { htmlToText } from '../../channels/email/html-to-text.js';
import type { DetectedPii } from '../../dispatch/pii-redactor.js';

/** A non-draft message on the thread, as the quote proof compares it. */
export interface ThreadMessageProof {
  /** comparableText of the message body. */
  text: string;
  /** From, To and Cc of the message, lowercased. */
  participants: ReadonlySet<string>;
}

/** HTML as text for comparing a quote with a thread message: whitespace collapsed, lowercased. */
export function comparableText(html: string | undefined | null): string {
  return htmlToText(html).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A thread message as the quote proof needs it. */
export function threadMessageProof(msg: NylasMessage): ThreadMessageProof {
  return {
    text: comparableText(msg.body),
    participants: new Set([...msg.from, ...msg.to, ...msg.cc].map((p) => p.email.trim().toLowerCase())),
  };
}

/**
 * The quote's detected items the review must still rule on, as field `quote`. An item is exempt
 * only when all of these hold (fail closed otherwise):
 *  (a) a non-draft thread message contains the quote's visible text (from its first <blockquote>);
 *  (b) that same message had every one of this send's non-principal recipients on it (From/To/Cc):
 *      being on the thread is not being on the quoted message;
 *  (c) the item's own value is in that message's text, or is one of its participants' addresses
 *      (the quote header names them). Data hidden where text extraction does not look (a comment,
 *      an attribute) fails this, since the detector reads the raw HTML.
 */
export function quoteItemsToReview(
  items: readonly DetectedPii[],
  quote: string,
  thread: readonly ThreadMessageProof[],
  audience: readonly string[],
): DetectedPii[] {
  if (items.length === 0) return [];
  const bodyAt = quote.search(/<blockquote\b/i);
  if (bodyAt < 0 || audience.length === 0) return [...items];
  const quoted = comparableText(quote.slice(bodyAt));
  if (!quoted) return [...items];
  const recipients = audience.map((a) => a.trim().toLowerCase());
  const source = thread.find((m) => m.text.includes(quoted) && recipients.every((r) => m.participants.has(r)));
  if (!source) return [...items];
  return items.filter((i) => {
    const value = comparableText(i.matched);
    return !(value && (source.text.includes(value) || source.participants.has(value)));
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
