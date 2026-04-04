// src/channels/email/email-adapter.ts
//
// Email channel adapter — polls Nylas for new inbound emails, publishes them
// to the bus as inbound.message events, auto-creates contacts from participants,
// and sends outbound replies when the coordinator responds to an email thread.

import type { EventBus } from '../../bus/bus.js';
import type { Logger } from '../../logger.js';
import type { OutboundGateway } from '../../skills/outbound-gateway.js';
import type { ContactService } from '../../contacts/contact-service.js';
import { convertNylasMessage } from './message-converter.js';
import { createInboundMessage, type OutboundMessageEvent } from '../../bus/events.js';
import { sanitizeOutput } from '../../skills/sanitize.js';

export interface EmailAdapterConfig {
  bus: EventBus;
  logger: Logger;
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  pollingIntervalMs: number;
  /** Curia's own email address — used to filter out self-sent messages */
  selfEmail: string;
}

export class EmailAdapter {
  private config: EmailAdapterConfig;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastSeenTimestamp: number = 0;
  private processing = false;

  constructor(config: EmailAdapterConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const { bus, logger, pollingIntervalMs } = this.config;

    // Subscribe to outbound messages for the email channel.
    // When the coordinator responds to an email-triggered conversation, the dispatcher
    // creates an outbound.message with channelId 'email'. The adapter sends this as
    // a reply to the original email thread via Nylas.
    bus.subscribe('outbound.message', 'channel', async (event) => {
      const outbound = event as OutboundMessageEvent;
      if (outbound.payload.channelId !== 'email') return;

      try {
        await this.sendOutboundReply(outbound);
      } catch (err) {
        logger.error({ err, conversationId: outbound.payload.conversationId },
          'Failed to send email response');
      }
    });

    // Initialize last-seen timestamp to now so we only process new emails
    this.lastSeenTimestamp = Math.floor(Date.now() / 1000);

    // Start polling
    this.pollTimer = setInterval(() => void this.poll(), pollingIntervalMs);
    logger.info({ pollingIntervalMs }, 'Email adapter started — polling Nylas');

    // Do an initial poll immediately
    void this.poll();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.config.logger.info('Email adapter stopped');
  }

  private async poll(): Promise<void> {
    // Guard against overlapping polls — if a previous poll is still running
    // (e.g. slow Nylas response or many messages to process), skip this cycle.
    if (this.processing) return;
    this.processing = true;

    // Separate try/catch for the Nylas API call so a transient network error
    // doesn't silently drop already-fetched messages.
    let messages;
    try {
      messages = await this.config.outboundGateway.listEmailMessages({
        receivedAfter: this.lastSeenTimestamp,
        unread: true,
        limit: 25,
      });
    } catch (err) {
      this.config.logger.error({ err }, 'Email polling failed — will retry');
      this.processing = false;
      return;
    }

    try {
      for (const msg of messages) {
        // Advance the high-water mark BEFORE processing so a permanently broken
        // message (e.g. malformed payload) is never retried on the next poll cycle.
        // +1 ensures the next poll's receivedAfter excludes this exact timestamp
        // (Nylas timestamps are Unix seconds integers).
        if (msg.date >= this.lastSeenTimestamp) {
          this.lastSeenTimestamp = msg.date + 1;
        }

        // Skip emails sent by Curia (self) — we only want inbound messages
        // from external senders, not our own outgoing replies.
        // Case-insensitive to guard against inconsistent casing from mail servers.
        const fromEmail = msg.from[0]?.email;
        if (fromEmail?.toLowerCase() === this.config.selfEmail.toLowerCase()) continue;

        try {
          const converted = convertNylasMessage(msg);

          // Auto-create contacts from participants before publishing the inbound event,
          // so the contact resolver in the dispatch layer can find them immediately.
          await this.extractParticipants(converted.metadata.participants);

          // Sanitize email content to mitigate prompt injection from external senders.
          // This strips known injection patterns (system/instruction/prompt tags) before
          // the content reaches the LLM's context window.
          const sanitizedContent = sanitizeOutput(converted.content, {
            // Use a large limit here — body truncation already happened in the converter.
            // We pass maxLength large enough to never double-truncate; the converter's
            // 50KB cap + subject prefix keeps us well under this ceiling.
            maxLength: 60_000,
          });

          // Publish inbound message to the bus
          const event = createInboundMessage({
            conversationId: converted.conversationId,
            channelId: converted.channelId,
            senderId: converted.senderId,
            content: sanitizedContent,
            metadata: converted.metadata as unknown as Record<string, unknown>,
          });
          await this.config.bus.publish('channel', event);

          this.config.logger.info(
            { from: fromEmail, subject: msg.subject, threadId: msg.threadId },
            'Email received and published to bus',
          );
        } catch (err) {
          // Log and skip — the high-water mark was already advanced above,
          // so this message will not be retried on the next poll cycle.
          this.config.logger.error(
            { err, messageId: msg.id, threadId: msg.threadId, from: fromEmail },
            'Failed to process inbound email — skipping message',
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Send the coordinator's response as an email reply in the original thread.
   * The conversationId encodes the thread (email:{threadId}), so we look up the
   * most recent inbound message in that thread and reply to it.
   */
  private async sendOutboundReply(outbound: OutboundMessageEvent): Promise<void> {
    const { outboundGateway, logger } = this.config;
    const conversationId = outbound.payload.conversationId;

    if (!conversationId.startsWith('email:')) {
      logger.warn({ conversationId }, 'Cannot send email reply — conversation ID not in email format');
      return;
    }
    const threadId = conversationId.slice('email:'.length);

    try {
      // Find the original message in this thread so we can reply to it.
      // Pass threadId directly to Nylas so the API filters server-side —
      // much cheaper than fetching 50 messages and scanning locally.
      const messages = await outboundGateway.listEmailMessages({ limit: 1, threadId });
      const threadMessage = messages[0];
      if (!threadMessage) {
        logger.warn({ threadId }, 'Cannot find message to reply to in thread');
        return;
      }

      const fromEmail = threadMessage.from[0]?.email;
      if (!fromEmail) {
        logger.warn({ threadId, messageId: threadMessage.id }, 'Cannot reply — original message has no from address');
        return;
      }

      // Strip any existing "Re:" prefix before prepending our own to avoid
      // "Re: Re: Re: ..." chains when replying to already-replied threads.
      const baseSubject = threadMessage.subject.replace(/^Re:\s*/i, '');

      // Route through the gateway so the blocked-contact check and content filter
      // run on every outbound reply, not just those originating from skills.
      const result = await outboundGateway.send({
        channel: 'email',
        to: fromEmail,
        subject: `Re: ${baseSubject}`,
        body: outbound.payload.content,
        replyToMessageId: threadMessage.id,
      });

      if (result.success) {
        logger.info({ to: fromEmail, threadId }, 'Email reply sent via gateway');
      } else {
        logger.warn({ to: fromEmail, threadId, reason: result.blockedReason }, 'Email reply blocked by gateway');
      }
    } catch (err) {
      logger.error({ err, threadId }, 'Failed to send email reply');
    }
  }

  /**
   * Auto-create contacts from email participants (From/To/CC).
   * Uses source 'email_participant' which is auto-verified per spec.
   * Skips participants that already have a contact record, and skips
   * our own email address (selfEmail) to avoid self-contact creation.
   */
  private async extractParticipants(
    participants: Array<{ email: string; name?: string; role: string }>,
  ): Promise<void> {
    const { contactService, logger, selfEmail } = this.config;

    for (const p of participants) {
      // Don't create a contact for ourselves — case-insensitive to guard against
      // inconsistent casing from mail servers (e.g. "User@Example.com" vs "user@example.com").
      if (p.email.toLowerCase() === selfEmail.toLowerCase()) continue;

      try {
        // Check if this email is already linked to a contact
        const existing = await contactService.resolveByChannelIdentity('email', p.email);
        if (existing) continue;

        // Create a new contact and link the email identity to it.
        // Display name sanitization happens inside createContact() (see issue #39).
        // We pass the email as fallbackDisplayName so that if the participant name
        // sanitizes to empty (e.g., pure injection text), the email is used instead.
        const contact = await contactService.createContact({
          displayName: p.name || p.email,
          fallbackDisplayName: p.email,
          source: 'email_participant',
          status: 'provisional',
        });
        await contactService.linkIdentity({
          contactId: contact.id,
          channel: 'email',
          channelIdentifier: p.email,
          source: 'email_participant',
        });

        logger.info({ email: p.email, name: p.name }, 'Auto-created contact from email participant');
      } catch (err) {
        // Warn rather than error — participant auto-creation is best-effort.
        // The inbound message will still be published even if contact creation fails.
        logger.warn({ err, email: p.email }, 'Failed to auto-create contact from email participant');
      }
    }
  }
}
