// sms-adapter.ts — SMS channel adapter (Telnyx Messaging).
//
// Inbound: signed webhook → normalize → ensureChannelContact → inbound.message.
// Outbound: outbound.message (channelId sms) → OutboundGateway.
// Carrier STOP is enforced by Telnyx (error 40300); natural-language opt-out
// flows to the agent as ordinary inbound and is recorded as a contact KG fact.

import type { EventBus } from '../../bus/bus.js';
import type { Logger } from '../../logger.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { OutboundGateway } from '../../skills/outbound-gateway.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import { createInboundMessage } from '../../bus/events.js';
import { sanitizeOutput } from '../../skills/sanitize.js';
import type { Channel } from '../channel.js';
import { BoundedTtlMap } from '../slack/bounded-ttl-map.js';
import type { SmsClient } from './sms-client.js';
import type { SmsWebhookBridge, SmsWebhookHeaders, SmsWebhookResult } from './webhook-bridge.js';
import type { TelnyxWebhookEnvelope } from './types.js';
import { convertTelnyxWebhook, parseSmsConversationId } from './message-converter.js';
import { TelnyxSignatureError, verifyTelnyxSignature } from './verify-signature.js';

export interface SmsAdapterConfig {
  bus: EventBus;
  logger: Logger;
  client: SmsClient;
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  webhookBridge: SmsWebhookBridge;
}

export class SmsAdapter implements Channel {
  readonly name = 'sms';
  readonly isToggleable = true;
  private readonly config: SmsAdapterConfig;
  private readonly log: Logger;
  /** Telnyx may redeliver; dedupe by webhook event id (same TTL/size as Slack). */
  private readonly seenEventIds = new BoundedTtlMap<true>(10 * 60 * 1000, 2_000);

  constructor(config: SmsAdapterConfig) {
    this.config = config;
    this.log = config.logger.child({ component: 'sms-adapter' });
  }

  async start(): Promise<void> {
    const { bus, webhookBridge } = this.config;

    bus.subscribe('outbound.message', 'channel', async (event) => {
      const outbound = event as OutboundMessageEvent;
      if (outbound.payload.channelId !== 'sms') return;
      try {
        await this.handleOutbound(outbound);
      } catch (err) {
        this.log.error(
          { err, conversationId: outbound.payload.conversationId },
          'Failed to send SMS response',
        );
      }
    });

    webhookBridge.setHandler((rawBody, headers) => this.handleWebhook(rawBody, headers));
    this.log.info('SMS adapter started — Telnyx webhook handler installed');
  }

  async stop(): Promise<void> {
    this.config.webhookBridge.setHandler(null);
    this.seenEventIds.clear();
    this.log.info('SMS adapter stopped');
  }

  // ---------------------------------------------------------------------------
  // Webhook entry (called from HTTP route via bridge)
  // ---------------------------------------------------------------------------

  async handleWebhook(rawBody: Buffer, headers: SmsWebhookHeaders): Promise<SmsWebhookResult> {
    try {
      verifyTelnyxSignature(
        rawBody,
        headers.signature,
        headers.timestamp,
        this.config.client.webhookPublicKey,
      );
    } catch (err) {
      if (err instanceof TelnyxSignatureError) {
        this.log.warn({ err: err.message }, 'Telnyx SMS webhook signature rejected');
        return { status: 401, body: { error: 'Invalid signature' } };
      }
      throw err;
    }

    let envelope: TelnyxWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as TelnyxWebhookEnvelope;
    } catch (err) {
      // Signature already verified above, so a malformed body signals a Telnyx
      // format drift worth a trace — not silent.
      this.log.warn({ err }, 'Telnyx SMS webhook body was not valid JSON');
      return { status: 400, body: { error: 'Invalid JSON' } };
    }

    // Ack quickly for non-inbound events (delivery receipts, etc.).
    if (envelope.data?.event_type && envelope.data.event_type !== 'message.received') {
      return { status: 200, body: { ok: true } };
    }

    // Telnyx wants 2xx within ~2s; convert + publish is light. Still catch errors.
    try {
      await this.handleInboundEnvelope(envelope);
    } catch (err) {
      this.log.error({ err }, 'SMS adapter: unexpected error handling inbound webhook');
      // Still 200 so Telnyx does not hammer retries on our bugs after accept.
      return { status: 200, body: { ok: true } };
    }

    return { status: 200, body: { ok: true } };
  }

  // ---------------------------------------------------------------------------
  // Private: inbound
  // ---------------------------------------------------------------------------

  private async handleInboundEnvelope(envelope: TelnyxWebhookEnvelope): Promise<void> {
    const eventId = envelope.data?.id;
    if (eventId && this.seenEventIds.has(eventId)) {
      this.log.debug({ eventId }, 'SMS adapter: duplicate webhook event ignored');
      return;
    }
    if (eventId) this.seenEventIds.set(eventId, true);

    const converted = convertTelnyxWebhook(envelope);
    if (!converted) {
      this.log.debug('SMS adapter: ignoring non-publishable webhook payload');
      return;
    }

    try {
      const { created } = await this.config.contactService.ensureChannelContact({
        channel: 'sms',
        channelIdentifier: converted.senderId,
        source: 'sms_participant',
        displayName: converted.senderId,
        fallbackDisplayName: converted.senderId,
        tier: 'unknown',
      });
      if (created) {
        this.log.info(
          { phoneSuffix: converted.senderId.slice(-4) },
          'Auto-created contact from SMS sender',
        );
      }
    } catch (err) {
      this.log.warn(
        { err, phoneSuffix: converted.senderId.slice(-4) },
        'Failed to resolve/auto-create SMS contact',
      );
    }

    const inbound = createInboundMessage({
      conversationId: converted.conversationId,
      channelId: 'sms',
      senderId: converted.senderId,
      content: sanitizeOutput(converted.content, { maxLength: 10_000 }),
      metadata: converted.metadata as unknown as Record<string, unknown>,
    });

    await this.config.bus.publish('channel', inbound);
    this.log.info(
      { conversationId: converted.conversationId, phoneSuffix: converted.senderId.slice(-4) },
      'SMS received and published to bus',
    );
  }

  // ---------------------------------------------------------------------------
  // Private: outbound
  // ---------------------------------------------------------------------------

  private async handleOutbound(outbound: OutboundMessageEvent): Promise<void> {
    const conversationId = outbound.payload.conversationId;
    const recipient = parseSmsConversationId(conversationId);
    if (!recipient) {
      this.log.warn({ conversationId }, 'SMS adapter: conversation ID not in sms:<E.164> format');
      return;
    }

    const result = await this.config.outboundGateway.send(
      {
        channel: 'sms',
        recipient,
        message: outbound.payload.content,
      },
      {
        taskEventId: outbound.payload.taskEventId,
        conversationId,
        parentEventId: outbound.id,
      },
    );

    if (result.success) {
      this.log.info({ conversationId }, 'SMS reply sent via gateway');
    } else {
      this.log.warn({ conversationId, reason: result.blockedReason }, 'SMS reply blocked by gateway');
    }
  }
}
