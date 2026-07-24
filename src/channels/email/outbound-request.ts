// Email outbound send request — owned by the email channel package.
//
// Part of the OutboundSendRequest discriminated union re-exported from
// outbound-gateway.ts (public API). Channel-owned so recipient projection
// (PrincipalChannelRules.extractRecipients) can live next to the wire shape
// without inverting the skills → channels layer dependency (ADR-035).

import type { OutboundAttachmentInput } from '../../skills/_shared/read-attachments.js';

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
}

/** Type guard for email outbound requests. */
export function isEmailSendRequest(request: unknown): request is EmailSendRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  return r['channel'] === 'email' && typeof r['to'] === 'string' && typeof r['body'] === 'string';
}
