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
    /**
     * Curia's role in this email's recipient fields.
     * - 'to': Curia was directly addressed as a primary recipient
     * - 'cc': Curia was copied; someone else is the primary recipient
     * - 'bcc': Curia was blind-copied — not currently detectable from MIME headers
     *          alone, so this value is never set by the converter today.
     *
     * @TODO: BCC detection requires a provider-level signal (e.g. Nylas injecting a
     *        dedicated header when the grant email appears only in the BCC envelope).
     *        Until that signal is available, emails where Curia appears in neither To
     *        nor CC (i.e. genuine BCC) are indistinguishable from direct sends and
     *        default to 'to'. Track in a GitHub issue.
     */
    curiaRole: 'to' | 'cc' | 'bcc';
    /**
     * Email addresses from the To field, excluding Curia's own address.
     * Populated only when selfEmail is provided to convertNylasMessage.
     * Empty array when selfEmail is unknown, or when Curia is the only To recipient.
     * If Curia appears in To alongside other recipients, those other To addresses
     * are retained.
     */
    primaryRecipientEmails: string[];
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
 * Determine Curia's role in the email (To vs CC) and collect the primary recipients.
 *
 * Case-insensitive comparison — email addresses are case-insensitive per RFC 5321.
 *
 * Returns 'to' as the fail-safe default when selfEmail is absent or not found in
 * either To or CC (e.g. genuine BCC, which is not currently detectable).
 */
function resolveCuriaRole(
  toList: Array<{ email: string }>,
  ccList: Array<{ email: string }>,
  selfEmail: string,
): { curiaRole: 'to' | 'cc' | 'bcc'; primaryRecipientEmails: string[] } {
  const self = selfEmail.toLowerCase();

  const inTo = toList.some((p) => p.email.toLowerCase() === self);
  if (inTo) {
    // Curia is a primary recipient — other To addresses (if any) are also primary.
    const primaryRecipientEmails = toList
      .map((p) => p.email)
      .filter((e) => e.toLowerCase() !== self);
    return { curiaRole: 'to', primaryRecipientEmails };
  }

  const inCc = ccList.some((p) => p.email.toLowerCase() === self);
  if (inCc) {
    // Curia was copied — the To addresses are the true primary recipients.
    const primaryRecipientEmails = toList.map((p) => p.email);
    return { curiaRole: 'cc', primaryRecipientEmails };
  }

  // selfEmail not found in To or CC — likely BCC, which MIME headers don't expose.
  // Default to 'to' (fail-safe: treat as a direct message rather than silently
  // misclassifying). BCC detection requires provider-level support; see @TODO above.
  return { curiaRole: 'to', primaryRecipientEmails: [] };
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
 * - curiaRole and primaryRecipientEmails are derived from selfEmail when provided,
 *   allowing the dispatcher to surface whether Curia was directly addressed or CC'd.
 *
 * @param msg - The Nylas message to convert.
 * @param selfEmail - Curia's own email address for this account. When provided,
 *   the converter determines whether Curia appears in the To or CC field and
 *   populates curiaRole and primaryRecipientEmails accordingly. When omitted,
 *   curiaRole defaults to 'to' and primaryRecipientEmails is empty.
 */
export function convertNylasMessage(msg: NylasMessage, selfEmail?: string): ConvertedEmail {
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

  // Determine Curia's role in this email (To vs CC) when selfEmail is known.
  // Defaults to 'to' / empty primary recipients when selfEmail is not provided.
  const { curiaRole, primaryRecipientEmails } = selfEmail
    ? resolveCuriaRole(msg.to, msg.cc, selfEmail)
    : { curiaRole: 'to' as const, primaryRecipientEmails: [] };

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
      curiaRole,
      primaryRecipientEmails,
    },
  };
}
