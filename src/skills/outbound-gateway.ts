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

import type { NylasClient, NylasMessage, ListMessagesOptions, SendEmailOptions } from '../channels/email/nylas-client.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { OutboundContentFilter } from '../dispatch/outbound-filter.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';

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
    // Step 2: Content filter (added in Task 2)
    // ------------------------------------------------------------------

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
