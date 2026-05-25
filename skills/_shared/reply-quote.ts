// reply-quote.ts — shared utility for building a quoted original message block
// appended to reply emails. Used by ceo-inbox-draft-reply, email-draft-save,
// email-reply, and email-send skill handlers.

import { DateTime } from 'luxon';
import { htmlToPlainText } from './ceo-nylas-client.js';

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
  body: string;    // HTML — will be stripped to plain text
}

/**
 * Format a participant as "Name <email>" when a display name is present,
 * or bare "email" when it is not.
 */
function formatParticipant(p: { name?: string; email: string }): string {
  return p.name ? `${p.name} <${p.email}>` : p.email;
}

/**
 * Build a formatted quote block from the original message, suitable for
 * appending below the reply body. Returns a string starting with \n\n
 * to separate the reply from the quote.
 *
 * Output format:
 * ```
 * ---------- Original Message ----------
 * From: Alice Example <alice@example.com>
 * Date: 2026-05-21, 3:42 PM EDT
 * To: joseph@josephfung.ca
 * Subject: Re: Q2 planning
 *
 * [original message body, HTML stripped]
 * ```
 *
 * @param message   The original message to quote
 * @param timezone  IANA timezone name (e.g. "America/Toronto"); falls back to UTC
 */
export function buildReplyQuote(message: QuoteableMessage, timezone?: string): string {
  const fromLine = message.from.map(formatParticipant).join(', ');
  const toLine = message.to.map(formatParticipant).join(', ');

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

  const plainBody = htmlToPlainText(message.body);

  const lines = [
    '',
    '',
    '---------- Original Message ----------',
    `From: ${fromLine}`,
    `Date: ${dateLine}`,
    `To: ${toLine}`,
    `Subject: ${message.subject}`,
  ];

  // Include body section only when there is actual content to show
  if (plainBody) {
    lines.push('', plainBody);
  }

  return lines.join('\n');
}
