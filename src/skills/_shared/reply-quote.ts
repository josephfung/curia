// reply-quote.ts — shared utility for building a quoted original message block
// appended to reply emails. Used by:
//   - ceo-inbox-draft-reply, email-draft-save, email-reply, email-send skill handlers
//   - EmailAdapter.sendOutboundReply for natural agent-response replies
//
// Lives under src/ (not skills/) so the channel adapter — which is bound to
// rootDir=src — can import it. Skill handlers reach into src/ for shared
// utilities (same pattern they use for SkillContext / SkillHandler types).

import { DateTime } from 'luxon';
import sanitizeHtml from 'sanitize-html';
import { htmlToText } from '../../channels/email/html-to-text.js';

/**
 * Minimal message shape required to build a reply quote block.
 * Both NylasMessageFull (CEO client) and NylasMessage (core client)
 * satisfy this interface structurally — no explicit coupling needed.
 */
export interface QuoteableMessage {
  from: Array<{ name?: string; email: string }>;
  to: Array<{ name?: string; email: string }>;
  date: number;    // Unix epoch seconds
  subject: string;
  body: string | undefined | null;  // HTML — will be stripped to plain text; undefined/null treated as empty
}

export interface BuildReplyQuoteOptions {
  /** Output format. 'plain' (default): plain-text block for legacy / LLM context.
   *  'html': HTML <blockquote> with sanitized original body, for outbound email via Nylas. */
  format?: 'plain' | 'html';
}

// ---------------------------------------------------------------------------
// Plain-text helpers
// ---------------------------------------------------------------------------

/**
 * Format a participant as "Name <email>" when a display name is present,
 * or bare "email" when it is not.
 */
function formatParticipant(p: { name?: string; email: string }): string {
  return p.name ? `${p.name} <${p.email}>` : p.email;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/**
 * Escape text for safe embedding in an HTML text node or attribute value.
 * Used for attribution header values we generate ourselves (date, subject, names).
 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a participant for HTML output: "Name &lt;email&gt;" or bare "email".
 * Both name and email are HTML-escaped.
 */
function formatParticipantHtml(p: { name?: string; email: string }): string {
  return p.name
    ? `${esc(p.name)} &lt;${esc(p.email)}&gt;`
    : esc(p.email);
}

// Sanitization config for quoted email bodies.
// allowedTags covers all structural / inline / table elements that appear in real
// email HTML. nonTextTags ensures <script>/<style>/<head> content is removed entirely
// (not just the tags). transformTags strips Outlook/IE-specific CSS from style attributes.
const QUOTE_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    // Block / sectioning
    'address', 'article', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt',
    'figcaption', 'figure', 'footer', 'header', 'hr', 'li', 'main', 'nav',
    'ol', 'p', 'pre', 'section', 'summary', 'ul',
    // Headings
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // Inline text semantics
    'abbr', 'b', 'br', 'cite', 'code', 'del', 'dfn', 'em', 'i', 'ins', 'kbd',
    'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'var',
    // Links and images
    'a', 'img',
    // Table elements (common in email HTML)
    'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  ],
  allowedAttributes: {
    '*': ['class', 'dir', 'lang', 'style'],
    'a': ['href', 'title', 'name'],
    'blockquote': ['cite'],
    'col': ['span', 'width'],
    'colgroup': ['span', 'width'],
    'img': ['alt', 'height', 'src', 'title', 'width'],
    'ol': ['reversed', 'start', 'type'],
    'q': ['cite'],
    'table': ['align', 'border', 'cellpadding', 'cellspacing', 'width'],
    'td': ['abbr', 'align', 'colspan', 'rowspan', 'valign', 'width'],
    'th': ['abbr', 'align', 'colspan', 'rowspan', 'scope', 'valign', 'width'],
    'ul': ['type'],
  },
  // Only http/https/mailto in href/src; cid/data additionally allowed on <img> for
  // inline attachments. This strips javascript: URLs.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'cid', 'data'],
  },
  // Strip content entirely for raw-text/dangerous elements — not just the tags.
  // This prevents <style> CSS text and <script> code from appearing as plain text
  // in the sanitized output.
  nonTextTags: ['script', 'style', 'head', 'noscript', 'template', 'xml'],
  // Remove Outlook/IE-specific CSS attack patterns from style attributes:
  //   behavior: triggers ActiveX / VML behaviours in old IE and Outlook
  //   expression(): executes JavaScript in the old IE CSS engine
  transformTags: {
    '*': (tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag => {
      const style = attribs['style'];
      const newAttribs: sanitizeHtml.Attributes = style
        ? {
            ...attribs,
            style: style
              .replace(/\bexpression\s*\([^)]*\)/gi, '')
              .replace(/\bbehavior\s*:[^;]*/gi, ''),
          }
        : attribs;
      return { tagName, attribs: newAttribs };
    },
  },
};

function sanitizeQuoteBody(html: string): string {
  return sanitizeHtml(html, QUOTE_SANITIZE_OPTIONS);
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Build a formatted quote block from the original message, suitable for
 * appending below the reply body.
 *
 * Plain mode (default): returns a string starting with \n\n for plain-text
 * emails or legacy use. HTML mode: returns an HTML fragment (attribution
 * headers + sanitized <blockquote>) starting with \n\n, ready to be
 * appended to the HTML body of an outbound Nylas email.
 *
 * @param message   The original message to quote
 * @param timezone  IANA timezone name (e.g. "America/Toronto"); falls back to UTC
 * @param options   format: 'plain' (default) | 'html'
 */
export function buildReplyQuote(
  message: QuoteableMessage,
  timezone?: string,
  options?: BuildReplyQuoteOptions,
): string {
  const format = options?.format ?? 'plain';

  const preferredZone = timezone ?? 'UTC';
  const dtPreferred = DateTime.fromSeconds(message.date, { zone: preferredZone });
  // If the timezone string is invalid/unsupported, Luxon creates an invalid DateTime
  // without throwing. Fall back to UTC so the date is still rendered correctly.
  // If the date itself is invalid (e.g. NaN from Nylas), the UTC DateTime will also
  // be invalid — the isValid check below then produces the 'Unknown date' sentinel.
  const dt = dtPreferred.isValid
    ? dtPreferred
    : DateTime.fromSeconds(message.date, { zone: 'UTC' });
  const dateLine = dt.isValid
    ? dt.toFormat('yyyy-MM-dd, h:mm a ZZZZ')
    : 'Unknown date';

  if (format === 'html') {
    const fromLine = message.from.map(formatParticipantHtml).join(', ');
    const toLine = message.to.map(formatParticipantHtml).join(', ');
    const safeBody = sanitizeQuoteBody(message.body ?? '');

    const parts = [
      '',
      '',
      '<div style="margin-top:1em;padding-top:0.75em;border-top:1px solid #cccccc;font-size:0.9em;color:#555555;">',
      `  <p style="margin:0 0 0.25em 0;"><strong>From:</strong> ${fromLine}</p>`,
      `  <p style="margin:0 0 0.25em 0;"><strong>Date:</strong> ${esc(dateLine)}</p>`,
      `  <p style="margin:0 0 0.25em 0;"><strong>To:</strong> ${toLine}</p>`,
      `  <p style="margin:0 0 0.75em 0;"><strong>Subject:</strong> ${esc(message.subject)}</p>`,
      '</div>',
    ];

    if (safeBody) {
      parts.push(
        '<blockquote style="margin:0;padding:0 0 0 1em;border-left:3px solid #cccccc;color:#333333;">',
        safeBody,
        '</blockquote>',
      );
    }

    return parts.join('\n');
  }

  // Plain-text mode (default) — original behaviour
  const fromLine = message.from.map(formatParticipant).join(', ');
  const toLine = message.to.map(formatParticipant).join(', ');
  const plainBody = htmlToText(message.body);

  const lines = [
    '',
    '',
    '---------- Original Message ----------',
    `From: ${fromLine}`,
    `Date: ${dateLine}`,
    `To: ${toLine}`,
    `Subject: ${message.subject}`,
  ];

  if (plainBody) {
    lines.push('', plainBody);
  }

  return lines.join('\n');
}
