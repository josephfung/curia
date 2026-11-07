// own-text.ts — what in a principal-mailbox draft is the draft's own text (#2474, design D2).
//
// PII detection on a principal-mailbox send rules on the draft's own words. The quoted message
// below a reply is someone else's (its signature phone numbers would hold almost every "Got it"),
// so its details are ruled apart, as field `quote`, and only when someone on the send was not on
// the quoted message (final review S2). The principal's own address or phone is not a disclosure
// on a principal-directed send. The content filter still sees the whole body.

import type { DetectedPii } from '../../dispatch/pii-redactor.js';
import { REPLY_QUOTE_HTML_OPEN } from '../_shared/reply-quote.js';

/**
 * The opening tag of any element whose class list holds the token `gmail_quote`: Gmail now writes
 * `<div class="gmail_quote gmail_quote_container">`, not only `class="gmail_quote"` (#2474 PR 2).
 * `gmail_quote_container` alone is a different token and does not match. Every run stops at `<`
 * or `>`, so a match attempt never leaves its tag: unbounded runs made the scan quadratic on
 * hostile HTML (seconds at a few hundred KB).
 */
const GMAIL_QUOTE_OPEN = /<[a-z][a-z0-9]*\b[^<>]*?\bclass\s*=\s*(["'])(?:[^"'<>]*\s)?gmail_quote(?=[\s"'])[^"'<>]*\1/i;

/** Splits at the earliest REPLY_QUOTE_HTML_OPEN or Gmail quote element; quote is '' when neither occurs. */
export function splitReplyQuote(html: string): { own: string; quote: string } {
  const at = [html.indexOf(REPLY_QUOTE_HTML_OPEN), html.search(GMAIL_QUOTE_OPEN)].filter((i) => i >= 0);
  if (at.length === 0) return { own: html, quote: '' };
  const cut = Math.min(...at);
  return { own: html.slice(0, cut), quote: html.slice(cut) };
}

const EMAIL_PATTERN = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const HEADER_LINE = /<strong>(?:From|To|Cc):<\/strong>/i;

/**
 * Who the quoted message was between, read from the quote's own header (#2474 final review S2):
 * the From, To and Cc lines of the quote Curia builds, or the sender in a Gmail attribution line.
 * Lowercased, once each. The quoted body is never read. Null when no header names anyone: the
 * caller then reviews the quote's details (fail closed).
 *
 * The header is text in the draft, not the replied-to message's own record, so it is a claim:
 * a model-written body could carry a quote marker and a header of its choosing.
 */
export function quoteHeaderParticipants(quote: string): string[] | null {
  let header = '';
  if (quote.startsWith(REPLY_QUOTE_HTML_OPEN)) {
    // The attribution block closes with its first </div>; only its From/To/Cc lines count.
    const end = quote.indexOf('</div>');
    const block = end >= 0 ? quote.slice(0, end) : quote;
    header = block.split(/<\/p>/i).filter((line) => HEADER_LINE.test(line)).join(' ');
  } else if (quote.search(GMAIL_QUOTE_OPEN) === 0) {
    // Gmail's attribution ("On …, Dana <dana@…> wrote:") comes before the first <blockquote>.
    const end = quote.search(/<blockquote/i);
    if (end >= 0) header = quote.slice(0, end);
  }
  const emails = [...new Set((header.match(EMAIL_PATTERN) ?? []).map((e) => e.toLowerCase()))];
  return emails.length > 0 ? emails : null;
}

/** Shortest digit run treated as a phone number when comparing identities. */
const MIN_PHONE_DIGITS = 10;

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * The same phone number: equal digits, or one is the other with a country code in front
 * ("(416) 555-0100" against "+14165550100"). Both must be phone-length.
 */
function samePhone(a: string, b: string): boolean {
  if (a.length < MIN_PHONE_DIGITS || b.length < MIN_PHONE_DIGITS) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.endsWith(short);
}

/** Drops detected items whose matched text is one of `identities` (emails lowercased, phones compared by digits). */
export function dropOwnIdentityItems(items: readonly DetectedPii[], identities: readonly string[]): DetectedPii[] {
  const emails = new Set(identities.filter((i) => i.includes('@')).map((i) => i.trim().toLowerCase()));
  const phones = identities.filter((i) => !i.includes('@')).map(digits).filter((d) => d.length >= MIN_PHONE_DIGITS);
  return items.filter((item) => {
    if (item.matched.includes('@')) return !emails.has(item.matched.trim().toLowerCase());
    const d = digits(item.matched);
    return !phones.some((p) => samePhone(p, d));
  });
}
