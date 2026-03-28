// outbound-gateway.ts — single choke-point for all outbound external communication.
//
// All sends from Curia to the outside world MUST pass through this gateway.
// This ensures consistent enforcement of:
//   1. Blocked contact check (this task)
//   2. Content filter (Task 2 — placeholder below)
//
// Design intent: fail-open on infra errors. If the contact DB is unavailable
// we log a warning and proceed rather than silently blocking legitimate sends.
// The alternative (fail-closed on DB error) would cause Curia to go silent
// whenever the DB hiccups, which is worse than a rare false negative on the
// blocked-contact check.

import { randomUUID } from 'node:crypto';
import type { NylasClient, NylasMessage, ListMessagesOptions, SendEmailOptions } from '../channels/email/nylas-client.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { OutboundContentFilter } from '../dispatch/outbound-filter.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createOutboundBlocked } from '../bus/events.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OutboundSendRequest {
  channel: 'email';
  /** Recipient email address */
  to: string;
  subject?: string;
  body: string;
  cc?: string[];
  /** When set, Nylas threads the outbound message as a reply */
  replyToMessageId?: string;
}

export interface OutboundSendResult {
  success: boolean;
  messageId?: string;
  /** Human-readable reason when success is false */
  blockedReason?: string;
}

export interface OutboundGatewayConfig {
  nylasClient: NylasClient;
  contactService: ContactService;
  contentFilter: OutboundContentFilter;
  bus: EventBus;
  /** CEO's own email — passed to the content filter's allowed-sender list */
  ceoEmail: string;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// OutboundGateway
// ---------------------------------------------------------------------------

export class OutboundGateway {
  private readonly nylasClient: NylasClient;
  private readonly contactService: ContactService;
  private readonly contentFilter: OutboundContentFilter;
  private readonly bus: EventBus;
  private readonly ceoEmail: string;
  private readonly log: Logger;

  constructor(config: OutboundGatewayConfig) {
    this.nylasClient = config.nylasClient;
    this.contactService = config.contactService;
    this.contentFilter = config.contentFilter;
    this.bus = config.bus;
    this.ceoEmail = config.ceoEmail;
    this.log = config.logger.child({ component: 'outbound-gateway' });
  }

  /**
   * Send an outbound message through the gateway pipeline.
   *
   * Pipeline steps:
   *   1. Contact blocked check
   *   2. Content filter (Task 2 — placeholder)
   *   3. Channel dispatch via Nylas
   */
  async send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    // ------------------------------------------------------------------
    // Step 1: Contact blocked check
    // ------------------------------------------------------------------
    // Resolve the recipient to a known contact. If they are explicitly blocked
    // by the CEO, reject immediately without touching Nylas or the content filter.
    //
    // Fail-open on DB errors: an infra failure should not silently prevent
    // sending. We warn so the anomaly is visible in logs/alerting.
    try {
      const contact = await this.contactService.resolveByChannelIdentity(request.channel, request.to);
      if (contact !== null && contact.status === 'blocked') {
        this.log.warn(
          { channel: request.channel, to: request.to, contactId: contact.contactId },
          'outbound-gateway: send blocked — recipient is blocked',
        );
        return { success: false, blockedReason: 'Recipient is blocked' };
      }
    } catch (err) {
      // DB or service error — log at warn and proceed. We don't block outbound
      // sends on contact-check infrastructure failures.
      this.log.warn(
        { err, channel: request.channel, to: request.to },
        'outbound-gateway: contact resolution failed, proceeding without blocked check',
      );
    }

    // ------------------------------------------------------------------
    // Step 2: Content filter
    // ------------------------------------------------------------------
    // Fail-closed: if the filter throws for any reason, treat the message
    // as blocked. A crashing filter is a security anomaly — we'd rather
    // miss a send than let potentially dangerous content through an
    // unchecked pipeline.
    let filterPassed = false;
    let filterFindings: Array<{ rule: string; detail: string }> = [];

    try {
      const filterResult = await this.contentFilter.check({
        content: request.body,
        recipientEmail: request.to,
        conversationId: '',
        channelId: request.channel,
      });
      filterPassed = filterResult.passed;
      filterFindings = filterResult.findings;
    } catch (err) {
      // Filter crash — treat as blocked with a synthetic finding
      this.log.warn(
        { err, channel: request.channel, to: request.to },
        'outbound-gateway: content filter threw — treating as blocked (fail-closed)',
      );
      filterPassed = false;
      filterFindings = [{ rule: 'filter-error', detail: 'Content filter threw an unexpected error' }];
    }

    if (!filterPassed) {
      // Build a human-readable reason from just the rule names (not the full detail
      // which may contain sensitive data fragments that triggered the rule).
      const ruleNames = filterFindings.map((f) => f.rule).join('; ');
      this.log.warn(
        { channel: request.channel, to: request.to, rules: ruleNames },
        'outbound-gateway: outbound message blocked by content filter',
      );

      const blockId = `block_${randomUUID()}`;
      // Full reason string (with detail) goes into the bus event for forensics/audit,
      // NOT into any user-facing or notification surface.
      const fullReason = filterFindings.map((f) => `${f.rule}: ${f.detail}`).join('; ');

      // Publish the blocked event for audit logging and downstream consumers.
      // Wrapped in try-catch — a bus publish failure must never unblock the message;
      // the send is already blocked regardless of whether the audit event lands.
      try {
        await this.bus.publish('dispatch',
          createOutboundBlocked({
            blockId,
            conversationId: '',
            channelId: request.channel,
            content: request.body,
            recipientId: request.to,
            reason: fullReason,
            findings: filterFindings,
            parentEventId: '',
          }),
        );
      } catch (publishErr) {
        this.log.warn(
          { publishErr, blockId },
          'outbound-gateway: failed to publish outbound.blocked event — message is still blocked',
        );
      }

      // Notify the CEO directly via dispatchEmail (bypassing this.send() to avoid
      // infinite recursion — the notification itself doesn't need filtering because
      // it's a hardcoded template with no user-supplied content).
      // dispatchEmail already catches Nylas errors and returns them, so no try-catch needed.
      const notifyResult = await this.dispatchEmail({
        channel: 'email',
        to: this.ceoEmail,
        subject: 'Action needed — blocked outbound reply',
        // Body intentionally contains only the block ID and the intended recipient —
        // no message content, no rule details, no sensitive data.
        body: [
          'An outbound message was blocked by the content filter.',
          '',
          `Block ID: ${blockId}`,
          `Intended recipient: ${request.to}`,
          '',
          'Please review the audit log for details.',
        ].join('\n'),
      });
      if (!notifyResult.success) {
        this.log.error(
          { blockId, ceoEmail: this.ceoEmail, reason: notifyResult.blockedReason },
          'Failed to send CEO notification for blocked outbound content',
        );
      }

      return { success: false, blockedReason: 'Content blocked by filter' };
    }

    // ------------------------------------------------------------------
    // Step 3: Channel dispatch
    // ------------------------------------------------------------------
    return this.dispatchEmail(request);
  }

  /**
   * Fetch a single email message by its Nylas message ID.
   * Read-only — no filtering applied.
   */
  async getEmailMessage(messageId: string): Promise<NylasMessage> {
    return this.nylasClient.getMessage(messageId);
  }

  /**
   * List email messages, optionally filtered by the provided options.
   * Read-only — no filtering applied.
   */
  async listEmailMessages(options?: ListMessagesOptions): Promise<NylasMessage[]> {
    return this.nylasClient.listMessages(options);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a send request to Nylas. Maps our flat request shape into the
   * SendEmailOptions the NylasClient expects.
   */
  private async dispatchEmail(request: OutboundSendRequest): Promise<OutboundSendResult> {
    try {
      const sendOptions: SendEmailOptions = {
        // NylasClient expects an array of { email } objects for addressing
        to: [{ email: request.to }],
        cc: request.cc?.map((email) => ({ email })),
        subject: request.subject ?? '',
        body: request.body,
        replyToMessageId: request.replyToMessageId,
      };

      const sent = await this.nylasClient.sendMessage(sendOptions);

      this.log.info(
        { messageId: sent.id, channel: request.channel, to: request.to },
        'outbound-gateway: message sent successfully',
      );

      return { success: true, messageId: sent.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        { err, channel: request.channel, to: request.to },
        'outbound-gateway: Nylas send failed',
      );
      return { success: false, blockedReason: `Send failed: ${message}` };
    }
  }
}
