// own-text.ts — what in a principal-mailbox draft is the draft's own text (#2474, design D2).
//
// PII detection on a principal-mailbox send rules on the draft's own words. The quoted message
// below a reply is someone else's (its signature phone numbers would hold almost every "Got it"),
// so its details are ruled apart, as field `quote`, and only when someone on the send was not on
// the quoted message (final review S2). The principal's own address or phone is not a disclosure
// on a principal-directed send. The content filter still sees the whole body.

import type { DetectedPii } from '../../dispatch/pii-redactor.js';
import { REPLY_QUOTE_HTML_OPEN } from '../_shared/reply-quote.js';

// Elements whose content is raw text: a tag written inside one is not a tag.
const RAW_TEXT_ELEMENTS = new Set([
  'script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes',
]);

// Elements after which the scanner cannot tell how a browser reads the rest, so it stops
// (fail closed): `plaintext` never ends; `noscript` is raw text with scripting on and markup with
// it off (mail clients), and each reading fails open on some input; inside `svg` and `math`,
// CDATA, raw-text elements and HTML integration points (`<svg><title>`) follow other rules.
const UNREADABLE_AFTER = new Set(['plaintext', 'noscript', 'svg', 'math']);

interface StartTag {
  start: number;
  /** Index just past the tag's closing `>` (or the end of the input). */
  end: number;
  name: string;
  /** The first value of each attribute, by lowercased name, as HTML keeps it. */
  attrs: Map<string, string>;
}

/** Reads the start tag that opens at `html[start] === '<'`, skipping quoted attribute values. */
function readStartTag(html: string, start: number): StartTag {
  let i = start + 1;
  const nameMatch = /^[a-z][^\s/>]*/i.exec(html.slice(i));
  const name = (nameMatch?.[0] ?? '').toLowerCase();
  i += name.length;
  const attrs = new Map<string, string>();
  while (i < html.length && html[i] !== '>') {
    if (/[\s/]/.test(html[i]!)) { i++; continue; }
    const attrName = /^[^\s/>=]+/.exec(html.slice(i))?.[0] ?? html[i]!;
    i += attrName.length;
    while (/\s/.test(html[i] ?? '')) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (/\s/.test(html[i] ?? '')) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        const stop = close >= 0 ? close : html.length;
        value = html.slice(i + 1, stop);
        i = stop + 1;
      } else {
        value = /^[^\s>]*/.exec(html.slice(i))?.[0] ?? '';
        i += value.length;
      }
    }
    const key = attrName.toLowerCase();
    if (!attrs.has(key)) attrs.set(key, value);
  }
  return { start, end: Math.min(i + 1, html.length), name, attrs };
}

/**
 * Gmail's quote container: a <div> whose class attribute has the token `gmail_quote`, alone or
 * with others (`gmail_quote gmail_quote_container`). A prefix such as `gmail_quoted`, another
 * attribute (`data-class`), or `class=` text inside another attribute's value is not it.
 */
function isGmailQuoteOpen(tag: StartTag): boolean {
  if (tag.name !== 'div') return false;
  return (tag.attrs.get('class') ?? '').split(/\s+/).includes('gmail_quote');
}

/**
 * Where the earliest reply quote opens: Curia's REPLY_QUOTE_HTML_OPEN or a Gmail quote container,
 * counted only where it is a real start tag. Walks the HTML tag by tag, so text inside an
 * attribute value, a comment or a raw-text element never starts a quote. -1 when none does: the
 * whole body is then the draft's own text, which is reviewed (the fail-closed direction).
 */
function findReplyQuoteOpen(html: string): number {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return -1;
    if (html.startsWith('<!--', lt)) {
      // As browsers read it: '<!-->' and '<!--->' are whole comments, and a comment ends at the
      // first '-->' or '--!>' ('<!--!>' is not one: its dashes are the opener's).
      const dashes = html.indexOf('-->', lt + 2);
      const bang = html.indexOf('--!>', lt + 4);
      if (dashes < 0 && bang < 0) return -1;
      i = bang >= 0 && (dashes < 0 || bang < dashes) ? bang + 4 : dashes + 3;
      continue;
    }
    if (html[lt + 1] === '/' && /[a-z]/i.test(html[lt + 2] ?? '')) {
      // An end tag: browsers read attributes in it too, so a '>' inside a quoted value does
      // not close it. Same quote-aware scan as a start tag, read from the '/'.
      i = readStartTag(html, lt + 1).end;
      continue;
    }
    if (!/[a-z]/i.test(html[lt + 1] ?? '')) {
      // A doctype or bogus comment (`<!`, `<?`, `</` not followed by a letter, and `<![CDATA[`,
      // which runs to ']]>' only in SVG/MathML, where the scan has already stopped): the first '>'
      // closes it whatever the quotes. Any other '<' is a stray character and just advances.
      const gt = html.indexOf('>', lt + 1);
      i = '/!?'.includes(html[lt + 1] ?? 'x') ? (gt < 0 ? html.length : gt + 1) : lt + 1;
      continue;
    }
    if (html.startsWith(REPLY_QUOTE_HTML_OPEN, lt)) return lt;
    const tag = readStartTag(html, lt);
    if (isGmailQuoteOpen(tag)) return lt;
    if (UNREADABLE_AFTER.has(tag.name)) return -1;
    i = tag.end;
    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      // Only `</name` followed by whitespace, '/' or '>' ends it: `</scriptx>` is still text.
      const closer = new RegExp(`</${tag.name}(?=[\\s/>]|$)`, 'ig');
      closer.lastIndex = i;
      const close = closer.exec(html);
      if (!close) return -1;
      // In a script, '<!--' starts escaped states in which a '</script>' may not end it; rather
      // than follow them, treat the rest as unreadable.
      if (tag.name === 'script' && html.slice(i, close.index).includes('<!--')) return -1;
      i = close.index;
    }
  }
  return -1;
}

/** Splits at the earliest REPLY_QUOTE_HTML_OPEN or Gmail quote container; quote is '' when neither occurs. */
export function splitReplyQuote(html: string): { own: string; quote: string } {
  const cut = findReplyQuoteOpen(html);
  if (cut < 0) return { own: html, quote: '' };
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
  } else if (quote.startsWith('<') && isGmailQuoteOpen(readStartTag(quote, 0))) {
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
