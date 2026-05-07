// src/channels/email/email-adapter.ts
//
// Email channel adapter — polls Nylas for new inbound emails, publishes them
// to the bus as inbound.message events, auto-creates contacts from participants,
// and sends outbound replies when the coordinator responds to an email thread.
//
// Multi-account: one EmailAdapter instance is constructed per configured email account.
// Each instance owns a single Nylas grant.

import type { EventBus } from '../../bus/bus.js';
import type { Logger } from '../../logger.js';
import type { OutboundGateway, EmailSendRequest } from '../../skills/outbound-gateway.js';
import type { ContactService } from '../../contacts/contact-service.js';
// OutboundPolicy removed — all channel accounts now send directly (autonomy-gated)
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
  bus: EventBus;
  logger: Logger;
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  pollingIntervalMs: number;
  /** This account's own email address — used to filter out self-sent messages */
  selfEmail: string;
  /**
   * Additional sender addresses to suppress, beyond selfEmail.
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

  /** Sliding-window counter for the per-hour rate limit. */
  private hourlyContactCount = 0;
  /** Start of the current hourly window (epoch ms). Zero means the window hasn't started yet. */
  private hourlyWindowStart = 0;

  /** Epoch-ms timestamp of the last rate-limit notification per limit type, for dedup. */
  private lastNotifiedPerMessage = 0;
  private lastNotifiedPerHour = 0;

  constructor(config: EmailAdapterConfig) {
    this.config = config;
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
        // isSystemNotification bypasses the autonomy gate so the CEO still receives
        // alerts (e.g. approval_requested) even when the score is below the send
        // threshold — the notification must not be silenced by the gate it's reporting.
        // skipNotificationOnBlock prevents infinite recursion if the content filter
        // crashes and blocks this notification delivery itself.
        logger.info(
          { notificationType: notification.payload.notificationType, channel: 'email' },
          'EmailAdapter: delivering system notification with autonomy gate bypass',
        );
        const result = await this.config.outboundGateway.send(
          {
            channel: 'email',
            to: notification.payload.ceoEmail,
            subject: notification.payload.subject,
            body: notification.payload.body,
          },
          { skipNotificationOnBlock: true, isSystemNotification: true },
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

          // Auto-create contacts from participants before publishing the inbound
          // event, so the contact resolver in the dispatch layer can find them.
          await this.extractParticipants(
            converted.metadata.participants,
            converted.metadata.subject,
            converted.senderId,
          );

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
          const event = createInboundMessage({
            conversationId: converted.conversationId,
            channelId: converted.channelId,
            accountId: this.config.accountId,
            senderId: converted.senderId,
            content: sanitizedContent,
            metadata: {
              ...(converted.metadata as unknown as Record<string, unknown>),
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
   * Send the coordinator's response as an email reply in the original thread.
   * The conversationId encodes the thread (email:{threadId}), so we look up the
   * most recent inbound message in that thread and reply to it.
   * Sends via OutboundGateway (autonomy gate applied at gateway level).
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

      await this.dispatchByPolicy(sendRequest, {
        taskEventId: outbound.payload.taskEventId,
        conversationId: outbound.payload.conversationId,
      });
    } catch (err) {
      logger.error({ err, threadId }, 'Failed to send email reply');
    }
  }

  /**
   * Send the reply through the gateway (autonomy gate + blocked-contact +
   * content filter all run inside gateway.send). If the gateway returns
   * gated (autonomy blocked), fall back to creating a draft and linking
   * the action_log row so the CEO can approve-and-send from the digest.
   */
  private async dispatchByPolicy(
    sendRequest: EmailSendRequest,
    context: { taskEventId?: string; conversationId?: string },
  ): Promise<void> {
    const { outboundGateway, logger, accountId } = this.config;

    // Send through gateway, handle gated fallback.
    // Pass reExecRecipe so the gateway knows how to re-execute this send on CEO approval:
    //   skillName: 'send-draft' — the registered skill approve-action will invoke
    //   partialPayload: { account } — the draft's account; draft_id is filled in by
    //                                 linkGatedAction() after the draft is created below
    //   description: human-readable label for the pending_approval row + notification
    const recipientLabel = sendRequest.to;
    const subjectLabel = sendRequest.subject;
    const result = await outboundGateway.send(sendRequest, {
      taskEventId: context.taskEventId,
      conversationId: context.conversationId,
      reExecRecipe: {
        skillName: 'send-draft',
        partialPayload: { account: accountId },
        description: `Draft reply to ${recipientLabel}${subjectLabel ? ` — "${subjectLabel}"` : ''}. Use send-draft to approve.`,
      },
    });

    if (result.success) return;

    if (result.gated) {
      // Gateway blocked the send — create draft as fallback.
      // Guard createEmailDraft explicitly: if it throws, we must not propagate to the
      // outer sendOutboundReply catch, which would log "Failed to send email reply" even
      // though the gateway gate is working correctly and no send was attempted.
      let draftResult: Awaited<ReturnType<typeof outboundGateway.createEmailDraft>> | undefined;
      try {
        draftResult = await outboundGateway.createEmailDraft(sendRequest);
      } catch (err) {
        logger.error(
          { err, accountId, actionRef: result.actionRef },
          'email-adapter: unexpected error creating gated fallback draft — draft not created',
        );
        return;
      }

      if (draftResult && draftResult.success && draftResult.draftId) {
        if (result.actionRef) {
          // linkGatedAction is internally guarded (no-throw), so no outer try/catch needed here.
          // Pass context.taskEventId so linkPayload can scope the update to this specific task,
          // preventing short_ref collisions across tasks from smearing draft_id onto the wrong row.
          // Only draft_id needs linking — account was already stored in reExecRecipe.partialPayload
          // at gate time, so the merged payload matches send-draft's expected inputs exactly.
          await outboundGateway.linkGatedAction(result.actionRef, context.taskEventId, {
            draft_id: draftResult.draftId,
          });
        } else {
          // actionRef is absent either because taskEventId was not passed, or because
          // the action_log insert failed (gateway logs the DB error separately).
          // In either case the draft is created but won't appear in the pending-actions-digest.
          logger.warn(
            { accountId, draftId: draftResult.draftId },
            'email-adapter: gated fallback draft created but no actionRef available — draft will not appear in pending-actions-digest (taskEventId absent or action_log insert failed)',
          );
        }
        // Log inside the success branch only — if the draft failed, we already logged
        // the error below and logging "draft created" would be misleading.
        logger.info(
          { accountId, draftId: draftResult.draftId, actionRef: result.actionRef },
          'email-adapter: send gated — fallback draft created',
        );
      } else if (draftResult && !draftResult.success) {
        logger.error(
          { accountId, actionRef: result.actionRef, reason: draftResult.blockedReason },
          'email-adapter: gated fallback draft creation failed — send blocked, no draft created',
        );
      }
      return;
    }

    // Non-gated failure (blocked contact, content filter, etc.) — already logged by gateway
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

    // Reset (or lazily start) the hourly window if it has expired.
    // hourlyWindowStart = 0 means the window hasn't opened yet — treat it as always-expired
    // so the window anchors to the first actual contact creation, not process startup.
    const now = Date.now();
    if (now - this.hourlyWindowStart >= 3_600_000) {
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

    // Send a deduplicated CEO notification for each rate limit type that was hit.
    // Both caps can fire simultaneously (e.g. per-hour was already at limit when the email
    // arrived and per-message is also reached), so notify for each independently so that
    // the dedup timestamps are updated correctly.
    if (skippedThisMessage > 0) {
      if (hitPerHourCap) {
        await this.notifyRateLimitHit('per_hour', skippedThisMessage, emailSubject, emailSender);
      }
      if (hitPerMessageCap) {
        await this.notifyRateLimitHit('per_message', skippedThisMessage, emailSubject, emailSender);
      }
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
      // Commit the dedup timestamp only after a successful send — if the send fails we
      // allow a retry on the next limit hit rather than silencing the CEO for an hour.
      if (limitType === 'per_message') {
        this.lastNotifiedPerMessage = now;
      } else {
        this.lastNotifiedPerHour = now;
      }
    } catch (err) {
      // Non-fatal — the rate limit is already enforced, this is just a notification.
      // The timestamp was NOT committed, so the next limit hit will attempt to notify again.
      logger.warn({ err, limitType, skippedCount }, 'Failed to send contact rate-limit notification — will retry on next limit hit');
    }
  }
}
