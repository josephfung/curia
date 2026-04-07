// outbound-gateway.ts — single choke-point for all outbound external communication.
//
// All sends from Curia to the outside world MUST pass through this gateway.
// This ensures consistent enforcement of:
//   1. Blocked contact check
//   2. Content filter
//
// Design intent: fail-open on infra errors. If the contact DB is unavailable
// we log a warning and proceed rather than silently blocking legitimate sends.
// The alternative (fail-closed on DB error) would cause Curia to go silent
// whenever the DB hiccups, which is worse than a rare false negative on the
// blocked-contact check.
//
// Adding a new channel:
//   1. Add a new variant to OutboundSendRequest (discriminated union by `channel`)
//   2. Add the channel client to OutboundGatewayConfig
//   3. Add a private dispatch<Channel>() method
//   4. Add a branch in send() to call it
//   The blocked-contact check and content filter in send() are channel-agnostic and
//   run for all channels before dispatch.

import { randomUUID } from 'node:crypto';
import type { NylasClient, NylasMessage, ListMessagesOptions, SendEmailOptions } from '../channels/email/nylas-client.js';
import type { SignalRpcClient } from '../channels/signal/signal-rpc-client.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { OutboundContentFilter } from '../dispatch/outbound-filter.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createOutboundBlocked } from '../bus/events.js';
import { markdownToHtml } from '../channels/email/markdown-to-html.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmailSendRequest {
  channel: 'email';
  /** Recipient email address */
  to: string;
  subject?: string;
  body: string;
  cc?: string[];
  /** When set, Nylas threads the outbound message as a reply */
  replyToMessageId?: string;
}

export interface SignalOutboundRequest {
  channel: 'signal';
  /**
   * E.164 phone number for 1:1 sends (e.g. "+14155552671").
   * Mutually exclusive with groupId — set exactly one.
   */
  recipient?: string;
  /**
   * Base64-encoded group V2 ID for group sends.
   * Mutually exclusive with recipient — set exactly one.
   */
  groupId?: string;
  message: string;
}

/**
 * Discriminated union of all supported outbound send requests.
 * Add a new variant here when adding a new channel.
 *
 * Note: OutboundSendRequest is a public API surface — adding a new variant is
 * backwards-compatible, but changing existing field names or types is a breaking
 * change that must be called out in CHANGELOG.md.
 */
export type OutboundSendRequest = EmailSendRequest | SignalOutboundRequest;

// Re-export the old name as an alias so existing callers don't break.
// Previously OutboundSendRequest was a single interface (email-only). Now it's a
// discriminated union. Callers that typed a variable as OutboundSendRequest and
// passed it to send() continue to work unchanged — the union is a superset.
// This alias exists purely for documentation; the type itself is unchanged in
// terms of what email callers already do.
export type { OutboundSendRequest as OutboundEmailSendRequest };

export interface OutboundSendResult {
  success: boolean;
  messageId?: string;
  /** Human-readable reason when success is false */
  blockedReason?: string;
}

export interface OutboundGatewayConfig {
  /**
   * Nylas client for email sends. Optional — gateway can be initialized with
   * only Signal (signalClient) if email is not configured.
   *
   * In production (Nylas + Signal mode), this is always set alongside signalClient.
   * The optional type exists so the gateway can be constructed when only Signal
   * credentials are provided (e.g., integration tests without Nylas API key).
   */
  nylasClient?: NylasClient;

  /**
   * signal-cli RPC client for Signal sends. Optional — gateway can be initialized
   * with only email (nylasClient) if Signal is not configured.
   */
  signalClient?: SignalRpcClient;

  /**
   * Nathan's Signal phone number in E.164 format — used as the `account` param in
   * signal-cli RPC calls. Required when signalClient is provided.
   */
  signalPhoneNumber?: string;

  contactService: ContactService;
  contentFilter: OutboundContentFilter;
  bus: EventBus;

  /**
   * CEO's own email — used as the allowlist entry in the content filter's contact-data-leak
   * rule and as the To address for blocked-content CEO notifications.
   *
   * Required when nylasClient is present (notifications are sent via email).
   * When email is absent (Signal-only), blocked messages are logged and audited
   * but no CEO notification is sent. A future version may add a Signal notification path.
   *
   * TODO: add a Signal-based blocked-content notification path so the CEO is informed
   * even without email configured. For now log.error + audit trail is the fallback.
   */
  ceoEmail?: string;

  logger: Logger;
}

// ---------------------------------------------------------------------------
// OutboundGateway
// ---------------------------------------------------------------------------

export class OutboundGateway {
  private readonly nylasClient?: NylasClient;
  private readonly signalClient?: SignalRpcClient;
  private readonly signalPhoneNumber?: string;
  private readonly contactService: ContactService;
  private readonly contentFilter: OutboundContentFilter;
  private readonly bus: EventBus;
  private readonly ceoEmail: string;
  private readonly log: Logger;

  constructor(config: OutboundGatewayConfig) {
    this.nylasClient = config.nylasClient;
    this.signalClient = config.signalClient;
    this.signalPhoneNumber = config.signalPhoneNumber;
    this.contactService = config.contactService;
    this.contentFilter = config.contentFilter;
    this.bus = config.bus;
    this.ceoEmail = config.ceoEmail ?? '';
    this.log = config.logger.child({ component: 'outbound-gateway' });
  }

  /**
   * Send an outbound message through the gateway pipeline.
   *
   * Pipeline steps (channel-agnostic):
   *   1. Contact blocked check
   *   2. Content filter (fail-closed)
   *   3. Channel dispatch (email → Nylas, signal → signal-cli RPC)
   */
  async send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    // Derive a stable recipient identifier for the blocked-contact check and logging.
    // Email: the To address. Signal: phone number (1:1) or base64 group ID.
    const recipientId = request.channel === 'email'
      ? request.to
      : (request.recipient ?? request.groupId ?? '');

    // The message body field differs between channel types.
    const messageBody = request.channel === 'email' ? request.body : request.message;

    // ------------------------------------------------------------------
    // Step 1: Contact blocked check
    // ------------------------------------------------------------------
    // Resolve the recipient to a known contact. If they are explicitly blocked
    // by the CEO, reject immediately without touching the transport layer or filter.
    //
    // Fail-open on DB errors: an infra failure should not silently prevent
    // sending. We warn so the anomaly is visible in logs/alerting.
    try {
      const contact = await this.contactService.resolveByChannelIdentity(request.channel, recipientId);
      if (contact !== null && contact.status === 'blocked') {
        this.log.warn(
          { channel: request.channel, recipientId, contactId: contact.contactId },
          'outbound-gateway: send blocked — recipient is blocked',
        );
        return { success: false, blockedReason: 'Recipient is blocked' };
      }
    } catch (err) {
      // DB or service error — log at warn and proceed.
      this.log.warn(
        { err, channel: request.channel, recipientId },
        'outbound-gateway: contact resolution failed, proceeding without blocked check',
      );
    }

    // ------------------------------------------------------------------
    // Step 2: Content filter
    // ------------------------------------------------------------------
    // Fail-closed: if the filter throws for any reason, treat the message as blocked.
    // A crashing filter is a security anomaly — better to miss a send than let
    // potentially dangerous content through an unchecked pipeline.
    let filterPassed = false;
    let filterFindings: Array<{ rule: string; detail: string }> = [];

    try {
      const filterResult = await this.contentFilter.check({
        content: messageBody,
        // For Signal sends: passing the phone number/groupId as recipientEmail is intentional.
        // The contact-data-leak rule scans for *email addresses* in the content — a phone
        // number passed here will never match an email pattern, so any leaked email address
        // in the Signal message body is still correctly flagged. The field name is email-centric
        // but the semantics are "the intended recipient identifier".
        recipientEmail: recipientId,
        conversationId: '',
        channelId: request.channel,
      });
      filterPassed = filterResult.passed;
      filterFindings = filterResult.findings;
    } catch (err) {
      // Filter crash — treat as blocked with a synthetic finding
      this.log.warn(
        { err, channel: request.channel, recipientId },
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
        { channel: request.channel, recipientId, rules: ruleNames },
        'outbound-gateway: outbound message blocked by content filter',
      );

      const blockId = `block_${randomUUID()}`;
      // Full reason string (with detail) goes into the bus event for forensics/audit,
      // NOT into any user-facing or notification surface.
      const fullReason = filterFindings.map((f) => `${f.rule}: ${f.detail}`).join('; ');

      // Publish the blocked event for audit logging and downstream consumers.
      try {
        await this.bus.publish('dispatch',
          createOutboundBlocked({
            blockId,
            conversationId: '',
            channelId: request.channel,
            content: messageBody,
            recipientId,
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

      // Notify the CEO about the blocked message via email.
      // We always use the email channel for this notification, even when the blocked
      // message was a Signal send — this avoids a potential Signal → block → Signal
      // notification loop, and email is the canonical out-of-band channel for system alerts.
      //
      // If email is not configured (no nylasClient or no ceoEmail), we log.error and rely
      // on the audit log. A future Signal notification fallback can be added here.
      // TODO: add Signal-based blocked-content notification when email is absent.
      if (this.ceoEmail && this.nylasClient) {
        // dispatchEmail bypasses this.send() to avoid infinite recursion.
        // The notification body is a hardcoded template — no user-supplied content.
        const notifyResult = await this.dispatchEmail({
          channel: 'email',
          to: this.ceoEmail,
          subject: 'Action needed — blocked outbound reply',
          body: [
            'An outbound message was blocked by the content filter.',
            '',
            `Block ID: ${blockId}`,
            `Channel: ${request.channel}`,
            `Intended recipient: ${recipientId}`,
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
      } else {
        this.log.error(
          { blockId, channel: request.channel, recipientId },
          'outbound-gateway: CEO notification skipped — no email client configured. Block recorded in audit log only.',
        );
      }

      return { success: false, blockedReason: 'Content blocked by filter' };
    }

    // ------------------------------------------------------------------
    // Step 3: Channel dispatch
    // ------------------------------------------------------------------
    if (request.channel === 'email') {
      return this.dispatchEmail(request);
    } else {
      return this.dispatchSignal(request);
    }
  }

  /**
   * Fetch a single email message by its Nylas message ID.
   * Read-only — no filtering applied.
   */
  async getEmailMessage(messageId: string): Promise<NylasMessage> {
    if (!this.nylasClient) {
      throw new Error('outbound-gateway: getEmailMessage called but nylasClient is not configured');
    }
    return this.nylasClient.getMessage(messageId);
  }

  /**
   * List email messages, optionally filtered by the provided options.
   * Read-only — no filtering applied.
   */
  async listEmailMessages(options?: ListMessagesOptions): Promise<NylasMessage[]> {
    if (!this.nylasClient) {
      throw new Error('outbound-gateway: listEmailMessages called but nylasClient is not configured');
    }
    return this.nylasClient.listMessages(options);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a send request to Nylas for email delivery.
   * Maps our flat request shape into the SendEmailOptions the NylasClient expects.
   */
  private async dispatchEmail(request: EmailSendRequest): Promise<OutboundSendResult> {
    if (!this.nylasClient) {
      return { success: false, blockedReason: 'Email client not configured' };
    }

    // markdownToHtml is a pure function (no I/O, no realistic throw path).
    // Called outside the Nylas try-catch so that any future regression in the
    // converter is not silently misattributed as "Nylas send failed" in logs.
    const htmlBody = markdownToHtml(request.body);

    try {
      const sendOptions: SendEmailOptions = {
        to: [{ email: request.to }],
        cc: request.cc?.map((email) => ({ email })),
        subject: request.subject ?? '',
        body: htmlBody,
        replyToMessageId: request.replyToMessageId,
      };

      const sent = await this.nylasClient.sendMessage(sendOptions);

      this.log.info(
        { messageId: sent.id, channel: 'email', to: request.to },
        'outbound-gateway: message sent successfully',
      );

      return { success: true, messageId: sent.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        { err, channel: 'email', to: request.to },
        'outbound-gateway: Nylas send failed',
      );
      return { success: false, blockedReason: `Send failed: ${message}` };
    }
  }

  /**
   * Dispatch a send request to signal-cli for Signal delivery.
   * Calls the signal-cli JSON-RPC `send` method via the RPC client.
   */
  private async dispatchSignal(request: SignalOutboundRequest): Promise<OutboundSendResult> {
    if (!this.signalClient) {
      return { success: false, blockedReason: 'Signal client not configured' };
    }

    if (!this.signalPhoneNumber) {
      // Wiring bug in index.ts — signalClient without signalPhoneNumber should never happen.
      this.log.error(
        { channel: 'signal' },
        'outbound-gateway: signalClient is set but signalPhoneNumber is missing — check index.ts wiring',
      );
      return { success: false, blockedReason: 'Signal phone number not configured' };
    }

    if (!request.recipient && !request.groupId) {
      this.log.warn({ channel: 'signal' }, 'outbound-gateway: Signal send has neither recipient nor groupId');
      return { success: false, blockedReason: 'Signal send requires either recipient or groupId' };
    }

    if (request.recipient && request.groupId) {
      // Both set is a caller bug — signal-cli would send to both or error unpredictably.
      // Fail fast with a clear error rather than silently mis-routing.
      this.log.warn(
        { channel: 'signal', recipient: request.recipient, groupId: request.groupId },
        'outbound-gateway: Signal send has both recipient and groupId set — exactly one required',
      );
      return { success: false, blockedReason: 'Signal send must specify exactly one of recipient or groupId, not both' };
    }

    try {
      await this.signalClient.send({
        account: this.signalPhoneNumber,
        // signal-cli takes recipient as an array; single-element for 1:1 sends
        recipient: request.recipient ? [request.recipient] : undefined,
        groupId: request.groupId,
        message: request.message,
      });

      this.log.info(
        { channel: 'signal', recipient: request.recipient, groupId: request.groupId },
        'outbound-gateway: Signal message sent successfully',
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        { err, channel: 'signal', recipient: request.recipient, groupId: request.groupId },
        'outbound-gateway: signal-cli send failed',
      );
      return { success: false, blockedReason: `Send failed: ${message}` };
    }
  }
}
