// src/channels/email/email-adapter.ts
//
// Email channel adapter — polls Nylas for new inbound emails, publishes them
// to the bus as inbound.message events, auto-creates contacts from participants,
// and sends outbound replies when the coordinator responds to an email thread.
//
// Multi-account: one EmailAdapter instance is constructed per configured email account.
// Each instance owns a single Nylas grant and applies its own outbound policy.

import type { EventBus } from '../../bus/bus.js';
import type { Logger } from '../../logger.js';
import type { OutboundGateway, EmailSendRequest } from '../../skills/outbound-gateway.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { AutonomyService } from '../../autonomy/autonomy-service.js';
import type { OutboundPolicy } from '../../config.js';
import { convertNylasMessage } from './message-converter.js';
import { createInboundMessage, type OutboundMessageEvent, type OutboundNotificationEvent } from '../../bus/events.js';
import { sanitizeOutput } from '../../skills/sanitize.js';

export interface EmailAdapterConfig {
  /**
   * Logical name for this email account (e.g. "curia", "joseph").
   * Stamped onto every inbound.message event as accountId so the dispatcher
   * can route replies back through the same account.
   */
  accountId: string;
  /**
   * How outbound replies from this account are handled.
   *
   * - direct:          send immediately via OutboundGateway (current behavior)
   * - draft_gate:      save as a Nylas draft silently; CEO discovers via end-of-day
   *                    Signal digest and reviews in Gmail (#403, #278)
   * - autonomy_gated:  send only when autonomy score >= autonomyThreshold
   */
  outboundPolicy: OutboundPolicy;
  /** Required when outboundPolicy is 'autonomy_gated'. Minimum score (0–100) to send. */
  autonomyThreshold?: number;
  /** Required when outboundPolicy is 'autonomy_gated'. Queried before each send. */
  autonomyService?: AutonomyService;
  bus: EventBus;
  logger: Logger;
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  pollingIntervalMs: number;
  /** This account's own email address — used to filter out self-sent messages */
  selfEmail: string;
  /**
   * When true, Curia monitors this inbox as an observer rather than acting as
   * the recipient. Inbound emails bypass contact auto-creation and the contact
   * trust flow; the dispatcher receives them with observationMode: true in their
   * metadata and routes them directly to the coordinator for surfacing to the CEO.
   */
  observationMode: boolean;
  /**
   * Additional sender addresses to suppress, beyond selfEmail.
   * Used to exclude Curia's own outbound address from a monitored inbox so that
   * Curia's sent emails don't get re-processed as observations (self-reply loops).
   * Case-insensitive.
   */
  excludedSenderEmails: string[];
  /**
   * CEO's email address — used as the recipient for rate-limit notification emails.
   * When absent, rate-limit notifications are logged but not emailed.
   */
  ceoEmail?: string;
  /**
   * Maximum new contacts to auto-create from a single email's participant list.
   * Existing contacts (already in DB) don't count. Default: 10.
   */
  contactCreationMaxPerMessage: number;
  /**
   * Maximum new contacts to auto-create per hour across all emails for this account.
   * Sliding window resets after 1 hour. Default: 100.
   */
  contactCreationMaxPerHour: number;
}

export class EmailAdapter {
  private config: EmailAdapterConfig;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastSeenTimestamp: number = 0;
  private processing = false;

  // ── Contact auto-creation rate limiting (#36) ──────────────────────────────
  // In-memory counters — reset on process restart, which is fine for anti-flood.
  // @TODO Task 4: Wire these into autoCreateContactsFromParticipants().

  /** Sliding-window counter for the per-hour rate limit. Used in Task 4. */
  private hourlyContactCount!: number;
  /** Sliding-window start timestamp. Used in Task 4. */
  private hourlyWindowStart!: number;

  /** Timestamps of the last rate-limit notification per limit type, for dedup. Used in Task 4. */
  private lastNotifiedPerMessage!: number;
  private lastNotifiedPerHour!: number;

  constructor(config: EmailAdapterConfig) {
    this.config = config;
    // Initialize rate-limit state (used in Task 4).
    this.hourlyContactCount = 0;
    this.hourlyWindowStart = Date.now();
    this.lastNotifiedPerMessage = 0;
    this.lastNotifiedPerHour = 0;
    // Fields are all read by the rate-limit logic in extractParticipants / notifyRateLimitHit.
  }

  async start(): Promise<void> {
    const { bus, logger, pollingIntervalMs } = this.config;

    // Subscribe to outbound messages for this specific email account.
    // When the coordinator responds to an email-triggered conversation, the dispatcher
    // creates an outbound.message with channelId 'email' and the accountId that received
    // the original message. Each adapter instance filters to its own accountId so replies
    // are always sent from the same account that received the inbound message.
    bus.subscribe('outbound.message', 'channel', async (event) => {
      const outbound = event as OutboundMessageEvent;
      if (outbound.payload.channelId !== 'email') return;
      // Only handle events addressed to this account.
      // When accountId is absent (legacy events from before multi-account support),
      // default to 'curia' so the primary account claims the event — consistent with
      // the backward-compat fallback in resolveChannelAccounts().
      const targetAccountId = outbound.payload.accountId ?? 'curia';
      if (targetAccountId !== this.config.accountId) return;

      try {
        await this.sendOutboundReply(outbound);
      } catch (err) {
        logger.error({ err, conversationId: outbound.payload.conversationId },
          'Failed to send email response');
      }
    });

    // Subscribe to system notification events (blocked-content alerts, group-held alerts).
    // outbound.notification events are published by OutboundGateway.sendNotification()
    // and route through the filter pipeline like any other outbound message.
    //
    // Only the primary account ('curia') handles notifications to avoid duplicate sends
    // when multiple email accounts are configured. This matches the accountId fallback
    // convention used in the outbound.message subscription above.
    // TODO: replace hardcoded 'curia' with an isPrimaryAccount config flag once
    // multi-account primary detection is formalized.
    bus.subscribe('outbound.notification', 'channel', async (event) => {
      if (this.config.accountId !== 'curia') return;

      const notification = event as OutboundNotificationEvent;
      try {
        // skipNotificationOnBlock prevents infinite recursion: if the content filter
        // is broken and blocks this notification, the gateway will NOT re-publish
        // outbound.notification, breaking the cycle.
        const result = await this.config.outboundGateway.send(
          {
            channel: 'email',
            to: notification.payload.ceoEmail,
            subject: notification.payload.subject,
            body: notification.payload.body,
          },
          { skipNotificationOnBlock: true },
        );
        if (!result.success) {
          logger.error(
            {
              notificationType: notification.payload.notificationType,
              reason: result.blockedReason,
              blockId: notification.payload.blockId,
              originalChannel: notification.payload.originalChannel,
              ceoEmail: notification.payload.ceoEmail,
            },
            'EmailAdapter: failed to deliver outbound.notification — CEO will NOT receive this alert',
          );
        }
      } catch (err) {
        logger.error(
          {
            err,
            notificationType: notification.payload.notificationType,
            blockId: notification.payload.blockId,
          },
          'EmailAdapter: unexpected error delivering outbound.notification',
        );
      }
    });

    // Initialize last-seen timestamp to now so we only process new emails
    this.lastSeenTimestamp = Math.floor(Date.now() / 1000);

    // Start polling
    this.pollTimer = setInterval(() => void this.poll(), pollingIntervalMs);
    logger.info({ pollingIntervalMs }, 'Email adapter started — polling Nylas');

    // Do an initial poll immediately and await it so callers that await start()
    // can be confident the first poll has completed before they assert results.
    // Subsequent polls run on setInterval (fire-and-forget).
    await this.poll();
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
        // Request raw headers so the converter can extract Authentication-Results
        // and compute senderVerified (SPF/DKIM/DMARC). Without this flag, Nylas
        // omits headers from the response entirely and senderVerified will be false.
        fields: 'include_headers',
      }, this.config.accountId);
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

        // Skip emails sent by this account (self) — we only want inbound messages
        // from external senders, not our own outgoing replies.
        // Case-insensitive to guard against inconsistent casing from mail servers.
        const fromEmail = msg.from[0]?.email;
        if (fromEmail?.toLowerCase() === this.config.selfEmail.toLowerCase()) continue;

        // Skip emails from any additionally-excluded sender addresses (e.g. Curia's
        // outbound address on a monitored inbox, to prevent self-reply loops).
        if (
          fromEmail &&
          this.config.excludedSenderEmails.some(
            (excluded) => excluded.toLowerCase() === fromEmail.toLowerCase(),
          )
        ) {
          this.config.logger.debug(
            { fromEmail, accountId: this.config.accountId },
            'Email skipped — sender is in excludedSenderEmails',
          );
          continue;
        }

        try {
          const converted = convertNylasMessage(msg, this.config.selfEmail);

          if (this.config.observationMode) {
            // Observation mode: Curia monitors this inbox on behalf of the CEO but is
            // not the recipient. Skip contact auto-creation (senders are third parties
            // emailing the CEO, not people initiating contact with Curia). The dispatcher
            // will receive observationMode: true in the metadata and bypass the contact
            // trust flow, routing directly to the coordinator for surfacing to the CEO.
          } else {
            // Standard mode: auto-create contacts from participants before publishing
            // the inbound event, so the contact resolver in the dispatch layer can find
            // them immediately.
            await this.extractParticipants(
              converted.metadata.participants,
              converted.metadata.subject,
              converted.senderId,
            );
          }

          // Sanitize email content to mitigate prompt injection from external senders.
          // This strips known injection patterns (system/instruction/prompt tags) before
          // the content reaches the LLM's context window.
          const sanitizedContent = sanitizeOutput(converted.content, {
            // Use a large limit here — body truncation already happened in the converter.
            // We pass maxLength large enough to never double-truncate; the converter's
            // 50KB cap + subject prefix keeps us well under this ceiling.
            maxLength: 60_000,
          });

          // Publish inbound message to the bus.
          // observationMode is stamped into metadata so the dispatcher can bypass the
          // contact trust flow without needing to know about account configuration.
          const event = createInboundMessage({
            conversationId: converted.conversationId,
            channelId: converted.channelId,
            accountId: this.config.accountId,
            senderId: converted.senderId,
            content: sanitizedContent,
            metadata: {
              ...(converted.metadata as unknown as Record<string, unknown>),
              ...(this.config.observationMode ? { observationMode: true } : {}),
            },
          });
          await this.config.bus.publish('channel', event);

          // Warn when the provider's SPF/DKIM/DMARC checks did not all pass.
          // This is an audit signal — the message is still processed, but the
          // Coordinator's system prompt instructs it to apply extra skepticism.
          if (!converted.metadata.senderVerified) {
            this.config.logger.warn(
              { senderEmail: converted.senderId, messageId: msg.id },
              'Email received with senderVerified: false — SPF/DKIM/DMARC did not all pass or headers were absent',
            );
          }

          this.config.logger.info(
            { senderEmail: converted.senderId, subject: msg.subject, threadId: msg.threadId, senderVerified: converted.metadata.senderVerified },
            'Email received and published to bus',
          );
        } catch (err) {
          // Log and skip — the high-water mark was already advanced above,
          // so this message will not be retried on the next poll cycle.
          this.config.logger.error(
            { err, messageId: msg.id, threadId: msg.threadId, senderEmail: fromEmail },
            'Failed to process inbound email — skipping message',
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Send (or draft) the coordinator's response as an email reply in the original thread.
   * The conversationId encodes the thread (email:{threadId}), so we look up the
   * most recent inbound message in that thread and reply to it.
   *
   * The actual send behaviour is controlled by this account's outboundPolicy:
   *   - direct:         send immediately via OutboundGateway
   *   - draft_gate:     save as Nylas draft silently; CEO discovers via Signal digest (#403, #278)
   *   - autonomy_gated: check autonomy score before sending; hold as draft if below threshold
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
      // Fetch the most recent message in this thread. We use it for two things:
      //   1. The message ID — passed as replyToMessageId so Nylas threads the reply
      //   2. The human's email address to send the reply to
      //
      // Nylas returns messages in most-recent-first order, so messages[0] is the
      // latest. If Curia was the last sender (a prior turn in the conversation),
      // messages[0].from is Curia's own address — we must NOT reply to ourselves.
      // In that case, look at messages[0].to to find the human recipient.
      const messages = await outboundGateway.listEmailMessages({ limit: 1, threadId }, this.config.accountId);
      const threadMessage = messages[0];
      if (!threadMessage) {
        logger.warn({ threadId }, 'Cannot find message to reply to in thread');
        return;
      }

      const latestFromEmail = threadMessage.from[0]?.email;

      // If the latest message was sent BY us, the human's address is in 'to'.
      // Comparing case-insensitively guards against inconsistent casing from mail servers.
      const latestIsOurs = latestFromEmail?.toLowerCase() === this.config.selfEmail.toLowerCase();

      // When the latest message is ours, find the first non-self address in 'to'.
      // to[] can contain multiple recipients (e.g. a thread with a CC'd third party);
      // picking the first non-self address is best-effort for 1:1 conversations.
      // TODO: proper group-email support would need to track the original sender from
      // the inbound message rather than inferring the recipient from the thread.
      const recipientEmail = latestIsOurs
        ? threadMessage.to.find(
            (r) => r.email.toLowerCase() !== this.config.selfEmail.toLowerCase(),
          )?.email
        : latestFromEmail;

      if (!recipientEmail) {
        logger.warn(
          { threadId, messageId: threadMessage.id, latestIsOurs },
          'Cannot reply — could not resolve human recipient from thread',
        );
        return;
      }

      // Guard: if the resolved recipient is still our own address (e.g. a self-addressed
      // thread or malformed to[] list), bail out rather than looping a reply to our own
      // inbox. This would produce a misleading "sent" log with no human ever receiving it.
      if (recipientEmail.toLowerCase() === this.config.selfEmail.toLowerCase()) {
        logger.error(
          { threadId, messageId: threadMessage.id, latestIsOurs },
          'Cannot reply — resolved recipient is selfEmail; thread may be self-addressed or to[] is malformed',
        );
        return;
      }

      // Strip any existing "Re:" prefix before prepending our own to avoid
      // "Re: Re: Re: ..." chains when replying to already-replied threads.
      const baseSubject = threadMessage.subject.replace(/^Re:\s*/i, '');

      const sendRequest = {
        channel: 'email' as const,
        accountId: this.config.accountId,
        to: recipientEmail,
        subject: `Re: ${baseSubject}`,
        body: outbound.payload.content,
        replyToMessageId: threadMessage.id,
      };

      await this.dispatchByPolicy(sendRequest, { threadId, latestIsOurs, to: recipientEmail });
    } catch (err) {
      logger.error({ err, threadId }, 'Failed to send email reply');
    }
  }

  /**
   * Apply this account's outbound policy before dispatching a reply.
   *
   * - direct:         send immediately through the gateway (blocked-contact +
   *                   content filter run inside gateway.send)
   * - draft_gate:     save as a Nylas draft for human review; no notification is
   *                   sent — the CEO discovers drafts via the end-of-day Signal
   *                   digest (#403). Approval + send remain deferred (TODO(#278)).
   * - autonomy_gated: check the current global autonomy score; if it meets the
   *                   configured threshold, send directly; otherwise draft-gate
   */
  private async dispatchByPolicy(
    sendRequest: EmailSendRequest,
    logCtx: Record<string, unknown>,
  ): Promise<void> {
    const { outboundGateway, logger, outboundPolicy, autonomyThreshold, autonomyService } = this.config;

    if (outboundPolicy === 'direct') {
      // Standard path — gateway enforces blocked-contact check + content filter
      const result = await outboundGateway.send(sendRequest);
      if (result.success) {
        logger.info({ ...logCtx, accountId: this.config.accountId }, 'Email reply sent via gateway');
      } else {
        logger.warn({ ...logCtx, accountId: this.config.accountId, reason: result.blockedReason }, 'Email reply blocked by gateway');
      }
      return;
    }

    if (outboundPolicy === 'autonomy_gated') {
      // Check the global autonomy score before committing to a send.
      // autonomyThreshold and autonomyService are guaranteed to be set when
      // outboundPolicy is 'autonomy_gated' — validated at startup via config.ts.
      if (!autonomyService || autonomyThreshold === undefined) {
        logger.error(
          { ...logCtx, accountId: this.config.accountId },
          'autonomy_gated policy requires autonomyService and autonomyThreshold — degrading to draft_gate for this reply',
        );
        // Explicit fall-through to draft_gate below (operator sees error log above).
        // Degrading to draft rather than silently sending or dropping is the safest
        // choice: the reply is preserved for human review despite the misconfiguration.
      } else {
        const autonomyCfg = await autonomyService.getConfig();
        if (autonomyCfg === null) {
          // Autonomy not yet configured (pre-migration environment) — preserve for
          // human review rather than sending autonomously or dropping the reply.
          logger.warn(
            { ...logCtx, accountId: this.config.accountId },
            'Autonomy config not found (pre-migration?) — degrading to draft_gate for this reply',
          );
          // Fall through to draft_gate below
        } else {
          const score = autonomyCfg.score;
          if (score >= autonomyThreshold) {
            const result = await outboundGateway.send(sendRequest);
            if (result.success) {
              logger.info(
                { ...logCtx, accountId: this.config.accountId, autonomyScore: score, threshold: autonomyThreshold },
                'Email reply sent autonomously (autonomy threshold met)',
              );
            } else {
              logger.warn({ ...logCtx, accountId: this.config.accountId, reason: result.blockedReason }, 'Email reply blocked by gateway');
            }
            return;
          }
          logger.info(
            { ...logCtx, accountId: this.config.accountId, autonomyScore: score, threshold: autonomyThreshold },
            'Autonomy score below threshold — saving reply as draft',
          );
          // Score too low: fall through to draft_gate behaviour
        }
      }
    }

    // draft_gate (and autonomy_gated fallback): save as draft for human review.
    // The gateway creates the draft silently — no per-draft email notification is sent.
    // The CEO discovers pending drafts via the end-of-day Signal digest (#403).
    const draftResult = await outboundGateway.createEmailDraft(sendRequest);
    if (draftResult.success) {
      logger.info(
        { ...logCtx, accountId: this.config.accountId, draftId: draftResult.draftId },
        'Email reply saved as draft for CEO review',
      );
    } else if (draftResult.blockedReason === 'Recipient is blocked') {
      // Intentional block — not an infrastructure failure
      logger.warn(
        { ...logCtx, accountId: this.config.accountId, reason: draftResult.blockedReason },
        'Email draft blocked — recipient is on the blocked list',
      );
    } else {
      // Infrastructure failure (Nylas error, contact resolution failure, client not configured).
      // The reply is permanently lost — log at error so operators can investigate.
      logger.error(
        { ...logCtx, accountId: this.config.accountId, reason: draftResult.blockedReason },
        'Email draft creation failed — reply permanently lost',
      );
    }
  }

  /**
   * Auto-create contacts from email participants (From/To/CC).
   * Uses source 'email_participant' which is auto-verified per spec.
   * Skips participants that already have a contact record, and skips
   * our own email address (selfEmail) to avoid self-contact creation.
   *
   * Rate limits (#36):
   *   - Per-message: at most contactCreationMaxPerMessage new contacts per email
   *   - Per-hour:    at most contactCreationMaxPerHour new contacts per sliding window
   * When a limit is hit, remaining participants are skipped and a CEO
   * notification is sent (deduplicated to one per limit type per hour).
   */
  private async extractParticipants(
    participants: Array<{ email: string; name?: string; role: string }>,
    emailSubject: string,
    emailSender: string,
  ): Promise<void> {
    const { contactService, logger, selfEmail, contactCreationMaxPerMessage, contactCreationMaxPerHour } = this.config;

    // Reset the hourly window if it has expired
    const now = Date.now();
    if (now - this.hourlyWindowStart > 3_600_000) {
      this.hourlyContactCount = 0;
      this.hourlyWindowStart = now;
    }

    let createdThisMessage = 0;
    let skippedThisMessage = 0;
    let hitPerMessageCap = false;
    let hitPerHourCap = false;

    for (const p of participants) {
      // Don't create a contact for ourselves — case-insensitive to guard against
      // inconsistent casing from mail servers (e.g. "User@Example.com" vs "user@example.com").
      if (p.email.toLowerCase() === selfEmail.toLowerCase()) continue;

      try {
        // Check if this email is already linked to a contact
        const existing = await contactService.resolveByChannelIdentity('email', p.email);
        if (existing) continue;

        // Check per-message cap (existing contacts don't count — only new creations)
        if (createdThisMessage >= contactCreationMaxPerMessage) {
          skippedThisMessage++;
          if (!hitPerMessageCap) {
            hitPerMessageCap = true;
            logger.warn(
              { email: p.email, cap: contactCreationMaxPerMessage, emailSubject },
              'Contact auto-creation per-message cap reached — skipping remaining participants',
            );
          }
          continue;
        }

        // Check per-hour cap
        if (this.hourlyContactCount >= contactCreationMaxPerHour) {
          skippedThisMessage++;
          if (!hitPerHourCap) {
            hitPerHourCap = true;
            logger.warn(
              { email: p.email, cap: contactCreationMaxPerHour, hourlyCount: this.hourlyContactCount },
              'Contact auto-creation per-hour cap reached — skipping remaining participants',
            );
          }
          continue;
        }

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

        createdThisMessage++;
        this.hourlyContactCount++;
        logger.info({ email: p.email, name: p.name }, 'Auto-created contact from email participant');
      } catch (err) {
        // Warn rather than error — participant auto-creation is best-effort.
        // The inbound message will still be published even if contact creation fails.
        logger.warn({ err, email: p.email }, 'Failed to auto-create contact from email participant');
      }
    }

    // Send a deduplicated CEO notification if any participants were skipped due to rate limits
    if (skippedThisMessage > 0) {
      await this.notifyRateLimitHit(
        hitPerMessageCap ? 'per_message' : 'per_hour',
        skippedThisMessage,
        emailSubject,
        emailSender,
      );
    }
  }

  /**
   * Send a deduplicated CEO notification when contact auto-creation rate limits
   * are hit. At most one notification per limit type per hour to avoid notification
   * spam during a sustained flood.
   */
  private async notifyRateLimitHit(
    limitType: 'per_message' | 'per_hour',
    skippedCount: number,
    emailSubject: string,
    emailSender: string,
  ): Promise<void> {
    const { outboundGateway, logger, ceoEmail } = this.config;
    const now = Date.now();

    // Dedup: skip if we already sent a notification for this limit type within the last hour
    const lastNotified = limitType === 'per_message' ? this.lastNotifiedPerMessage : this.lastNotifiedPerHour;
    if (now - lastNotified < 3_600_000) {
      logger.debug({ limitType, skippedCount }, 'Rate-limit notification suppressed (already sent within the hour)');
      return;
    }

    if (!ceoEmail) {
      logger.warn({ limitType, skippedCount }, 'Contact rate-limit hit but ceoEmail not configured — cannot notify');
      return;
    }

    // Update dedup timestamp before sending — if the send fails, we still won't spam
    if (limitType === 'per_message') {
      this.lastNotifiedPerMessage = now;
    } else {
      this.lastNotifiedPerHour = now;
    }

    const limitLabel = limitType === 'per_message'
      ? `per-message limit (${this.config.contactCreationMaxPerMessage})`
      : `per-hour limit (${this.config.contactCreationMaxPerHour})`;

    try {
      await outboundGateway.sendNotification({
        notificationType: 'contact_rate_limited',
        ceoEmail,
        subject: `Contact auto-creation rate limit reached (${limitLabel})`,
        body: [
          `Contact auto-creation was throttled on the ${this.config.accountId} email account.`,
          '',
          `Limit hit: ${limitLabel}`,
          `Participants skipped: ${skippedCount}`,
          `Triggering email subject: ${emailSubject}`,
          `Triggering email sender: ${emailSender}`,
          '',
          'Skipped participants will be auto-created if they send an email directly.',
          'If this is unexpected, check for spam activity on this account.',
        ].join('\n'),
      });
    } catch (err) {
      // Non-fatal — the rate limit is already enforced, this is just a notification
      logger.warn({ err, limitType, skippedCount }, 'Failed to send contact rate-limit notification');
    }
  }
}
