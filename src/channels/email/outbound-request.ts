// Email outbound send request — owned by the email channel package.
//
// Part of the OutboundSendRequest discriminated union re-exported from
// outbound-gateway.ts (public API). Channel-owned so recipient projection
// (PrincipalChannelRules.extractRecipients) can live next to the wire shape
// without inverting the skills → channels layer dependency (ADR-035).

import type { OutboundAttachmentInput } from '../../skills/_shared/read-attachments.js';

/**
 * Provenance for a contact this send creates (#2071).
 *
 * `email_participant` is auto-verified. Callers pass it only when To was copied
 * from a message header that is not an owned mailbox and that passed SPF, DKIM,
 * and DMARC. `outbound_recipient` is not auto-verified. Absent means that default.
 */
export type EmailRecipientSource = 'outbound_recipient' | 'email_participant';

export interface EmailSendRequest {
  channel: 'email';
  /** Which named account should send this message (e.g. "curia", "joseph").
   *  Used by the gateway to select the right NylasClient from its map.
   *  Defaults to the first configured account when absent. */
  accountId?: string;
  /** Recipient email address */
  to: string;
  subject?: string;
  body: string;
  cc?: string[];
  /** When set, Nylas threads the outbound message as a reply */
  replyToMessageId?: string;
  /** Pre-formed HTML fragment appended verbatim after markdownToHtml(body, { wrap: true }).
   *  Used for the quoted original message block: the quote is already sanitized
   *  HTML and must remain outside the generated-body wrapper. */
  htmlQuote?: string;
  /** File attachments to include. Each entry must have a file:// URL pointing
   *  to a temp file (from email-download-attachment or similar). The gateway
   *  reads the files from disk before passing them to Nylas. */
  attachments?: OutboundAttachmentInput[];
  /**
   * Provenance for a contact this send creates. Not a wire field: dispatch copies
   * named provider fields only, so Nylas never receives it. Stored on the queued
   * payload so a flush keeps the same provenance (#2071). Set by `send()` from
   * its options; a value already on the request is ignored.
   */
  recipientSource?: EmailRecipientSource;
  /**
   * From display name, used only for the duplicate check when `recipientSource`
   * is `email_participant`. Not sent to the provider.
   */
  recipientDisplayName?: string;
}

/** Type guard for email outbound requests. */
export function isEmailSendRequest(request: unknown): request is EmailSendRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return r['channel'] === 'email' && typeof r['to'] === 'string' && typeof r['body'] === 'string';
}
