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
  };
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
 */
export function convertNylasMessage(msg: NylasMessage): ConvertedEmail {
  // Use ?? 'unknown' so an empty from array doesn't throw
  const fromEmail = msg.from[0]?.email ?? 'unknown';

  // Thread ID groups related emails into a single conversation in the bus
  const conversationId = `email:${msg.threadId}`;

  // htmlToText returns '' for an empty/falsy body, so also check snippet
  const bodyText = msg.body ? htmlToText(msg.body) : '';
  const content = bodyText || msg.snippet || '(empty email)';

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
    },
  };
}
