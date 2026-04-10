import { htmlToText } from './html-to-text.js';
import type { NylasMessage } from './nylas-client.js';

// ---------------------------------------------------------------------------
// Output types — represent the normalized shape fed into the message bus
// createInboundMessage() event. EmailParticipant is also used by the contact
// system to upsert participant records from inbound emails.
// ---------------------------------------------------------------------------

export interface EmailParticipant {
  email: string;
  name?: string;
  role: 'from' | 'to' | 'cc';
}

export interface ConvertedEmail {
  conversationId: string;
  channelId: 'email';
  /** The sender's email address, used as the bus senderId */
  senderId: string;
  /** Plain-text body with subject prepended for LLM context */
  content: string;
  metadata: {
    subject: string;
    nylasMessageId: string;
    nylasThreadId: string;
    participants: EmailParticipant[];
    receivedAt: Date;
    /**
     * True if SPF, DKIM, and DMARC all passed in the provider's Authentication-Results
     * header. False if any check failed or the headers were absent.
     * Defense-in-depth: email From headers are trivially spoofable; this surfaces
     * provider-level validation results so the Coordinator can apply extra skepticism
     * to messages that failed sender verification.
     */
    senderVerified: boolean;
  };
}

/**
 * Parse the Authentication-Results header (RFC 7601) and return true only if
 * SPF, DKIM, and DMARC all carry a "pass" result.
 *
 * Returns false when:
 * - headers are absent (listMessages was not called with fields: 'include_headers')
 * - the Authentication-Results header is missing (provider didn't include it)
 * - any of SPF, DKIM, or DMARC are absent from the header
 * - any of SPF, DKIM, or DMARC report a non-pass result (fail, softfail, neutral, etc.)
 *
 * Fails closed: absent information is treated as unverified, not as verified.
 */
export function parseSenderVerified(headers?: Array<{ name: string; value: string }>): boolean {
  if (!headers || headers.length === 0) return false;

  // RFC 7601 allows multiple Authentication-Results headers — each MTA in the relay chain
  // may add one. Collect ALL of them rather than stopping at the first (find()), since an
  // attacker who controls an intermediate relay could prepend a forged header before the
  // legitimate provider's header. Header names are case-insensitive (RFC 7601 §2.2).
  const authHeaders = headers.filter((h) => h.name.toLowerCase() === 'authentication-results');
  if (authHeaders.length === 0) return false;

  // Return true if ANY Authentication-Results header shows all three mechanisms passing.
  // The final receiving MTA (Gmail, Outlook) prepends its header, making it appear first
  // in the list; checking all headers with some() ensures we find it regardless of ordering.
  //
  // Match each mechanism as `mechname=pass`. \b after "pass" guards against hypothetical
  // future tokens like "spf=passthrough", though RFC 7601 result tokens don't include any.
  return authHeaders.some((h) => {
    const v = h.value;
    return /\bspf=pass\b/i.test(v) && /\bdkim=pass\b/i.test(v) && /\bdmarc=pass\b/i.test(v);
  });
}

/**
 * Convert a Nylas message to a Curia inbound message shape.
 *
 * Decisions made here:
 * - conversationId uses the thread ID so all emails in a thread share the
 *   same working memory scope in the agent layer.
 * - Content is plain-text extracted from HTML (better for LLMs than raw HTML).
 * - Subject is prepended so agents always see it regardless of how the body
 *   was formatted.
 * - All participants (from/to/cc) are surfaced so the contact system can
 *   upsert or update relationship records in one pass.
 * - senderVerified is derived from the Authentication-Results header (if present).
 */
export function convertNylasMessage(msg: NylasMessage): ConvertedEmail {
  // Use ?? 'unknown' so an empty from array doesn't throw
  const fromEmail = msg.from[0]?.email ?? 'unknown';

  // Thread ID groups related emails into a single conversation in the bus
  const conversationId = `email:${msg.threadId}`;

  // htmlToText returns '' for an empty/falsy body, so also check snippet
  const bodyText = msg.body ? htmlToText(msg.body) : '';

  // Cap email body at 50KB of text to prevent context stuffing and excessive token usage.
  // Emails larger than this are truncated with a note.
  const MAX_BODY_LENGTH = 50_000;
  let content = bodyText || msg.snippet || '(empty email)';
  if (content.length > MAX_BODY_LENGTH) {
    content = content.slice(0, MAX_BODY_LENGTH) + '\n\n[Email truncated — original was ' + content.length + ' characters]';
  }

  // Prepend subject so the LLM always has full context even in isolated chunks
  const formattedContent = `Subject: ${msg.subject}\n\n${content}`;

  // Collect participants in declaration order: from → to → cc
  // BCC is intentionally omitted — we don't expose hidden recipients downstream
  const participants: EmailParticipant[] = [
    ...msg.from.map((p) => ({ email: p.email, name: p.name, role: 'from' as const })),
    ...msg.to.map((p) => ({ email: p.email, name: p.name, role: 'to' as const })),
    ...msg.cc.map((p) => ({ email: p.email, name: p.name, role: 'cc' as const })),
  ];

  return {
    conversationId,
    channelId: 'email',
    senderId: fromEmail,
    content: formattedContent,
    metadata: {
      subject: msg.subject,
      nylasMessageId: msg.id,
      nylasThreadId: msg.threadId,
      participants,
      // Nylas stores timestamps as Unix seconds; Date expects milliseconds
      receivedAt: new Date(msg.date * 1000),
      senderVerified: parseSenderVerified(msg.headers),
    },
  };
}
