// sms-adapter.ts — SMS channel adapter (Telnyx Messaging).
//
// Inbound: signed webhook → normalize → ensureChannelContact → inbound.message.
// Outbound: outbound.message (channelId sms) → OutboundGateway.
// A2P: STOP/START/HELP handled before agent publish; STOP persists in sms_opt_outs.

import type { EventBus } from '../../bus/bus.js';
import type { Logger } from '../../logger.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { OutboundGateway } from '../../skills/outbound-gateway.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import { createInboundMessage } from '../../bus/events.js';
import { sanitizeOutput } from '../../skills/sanitize.js';
import type { Channel } from '../channel.js';
import type { SmsClient } from './sms-client.js';
import type { SmsOptOutStore } from './sms-opt-out.js';
import type { SmsWebhookBridge, SmsWebhookHeaders, SmsWebhookResult } from './webhook-bridge.js';
import type { TelnyxWebhookEnvelope } from './types.js';
import {
  classifySmsKeyword,
  convertTelnyxWebhook,
  parseSmsConversationId,
} from './message-converter.js';
import { TelnyxSignatureError, verifyTelnyxSignature } from './verify-signature.js';

const STOP_CONFIRMATION =
  'You have been unsubscribed and will no longer receive SMS from this number. Reply START to resume.';
const START_CONFIRMATION =
  'You have been resubscribed and may receive SMS from this number again. Reply STOP to opt out.';
const HELP_REPLY =
  'Curia office SMS. Msg & data rates may apply. Reply STOP to opt out, START to resume, HELP for help.';

export interface SmsAdapterConfig {
  bus: EventBus;
  logger: Logger;
  client: SmsClient;
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  optOutStore: SmsOptOutStore;
  webhookBridge: SmsWebhookBridge;
}

export class SmsAdapter implements Channel {
  readonly name = 'sms';
  readonly isToggleable = true;
  private readonly config: SmsAdapterConfig;
  private readonly log: Logger;
  private readonly seenEventIds = new Map<string, number>();
  private static readonly DEDUPE_TTL_MS = 10 * 60 * 1000;
  private static readonly DEDUPE_MAX = 2_000;

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
    } catch {
      return { status: 400, body: { error: 'Invalid JSON' } };
    }

    // Ack quickly for non-inbound events (delivery receipts, etc.).
    if (envelope.data?.event_type && envelope.data.event_type !== 'message.received') {
      return { status: 200, body: { ok: true } };
    }

    // Process inbound asynchronously after we've validated — but Telnyx wants
    // 2xx within ~2s. Keyword handling + publish are light; still catch errors.
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
    if (eventId && this.isDuplicate(eventId)) {
      this.log.debug({ eventId }, 'SMS adapter: duplicate webhook event ignored');
      return;
    }

    const payloadText = envelope.data?.payload?.text ?? '';
    const keyword = classifySmsKeyword(payloadText);
    const fromRaw = envelope.data?.payload?.from?.phone_number;
    const peer = fromRaw?.trim();

    if (keyword && peer) {
      await this.handleKeyword(keyword, peer);
      return;
    }

    const converted = convertTelnyxWebhook(envelope);
    if (!converted) {
      this.log.debug('SMS adapter: ignoring non-publishable webhook payload');
      return;
    }

    // Refuse to engage when the peer previously opted out (except START, handled above).
    try {
      if (await this.config.optOutStore.isOptedOut(converted.senderId)) {
        this.log.info(
          { phoneSuffix: converted.senderId.slice(-4) },
          'SMS adapter: dropping inbound from opted-out number',
        );
        return;
      }
    } catch (err) {
      this.log.warn({ err }, 'SMS adapter: opt-out lookup failed — continuing fail-open for inbound');
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

  private async handleKeyword(
    keyword: 'stop' | 'start' | 'help',
    peerRaw: string,
  ): Promise<void> {
    // Keyword messages may arrive without surviving convertTelnyxWebhook if empty —
    // but STOP etc. always have text. Normalize lightly.
    const peer = peerRaw.startsWith('+') ? peerRaw : peerRaw;
    if (!/^\+[1-9]\d{6,14}$/.test(peer)) {
      this.log.warn('SMS adapter: keyword from non-E.164 peer — ignored');
      return;
    }

    if (keyword === 'stop') {
      try {
        await this.config.optOutStore.recordOptOut(peer);
      } catch (err) {
        this.log.error({ err }, 'SMS adapter: failed to persist STOP opt-out');
      }
      await this.sendComplianceSms(peer, STOP_CONFIRMATION);
      return;
    }

    if (keyword === 'start') {
      try {
        await this.config.optOutStore.clearOptOut(peer);
      } catch (err) {
        this.log.error({ err }, 'SMS adapter: failed to clear opt-out on START');
      }
      await this.sendComplianceSms(peer, START_CONFIRMATION);
      return;
    }

    await this.sendComplianceSms(peer, HELP_REPLY);
  }

  /** Compliance auto-reply — bypasses OutboundGateway / autonomy (carrier requirement). */
  private async sendComplianceSms(to: string, text: string): Promise<void> {
    try {
      await this.config.client.sendSms({
        to,
        from: this.config.client.fromNumber,
        text,
      });
    } catch (err) {
      this.log.warn({ err, phoneSuffix: to.slice(-4) }, 'SMS adapter: compliance auto-reply failed');
    }
  }

  private isDuplicate(eventId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of this.seenEventIds) {
      if (now - ts > SmsAdapter.DEDUPE_TTL_MS) this.seenEventIds.delete(id);
    }
    if (this.seenEventIds.has(eventId)) return true;
    this.seenEventIds.set(eventId, now);
    if (this.seenEventIds.size > SmsAdapter.DEDUPE_MAX) {
      const oldest = this.seenEventIds.keys().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
    return false;
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
