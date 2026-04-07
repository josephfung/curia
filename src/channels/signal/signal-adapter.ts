// src/channels/signal/signal-adapter.ts
//
// Signal channel adapter — receives inbound messages from the signal-cli RPC
// client, publishes them to the bus as inbound.message events, auto-creates
// contacts from new senders, and sends outbound replies when the coordinator
// responds to a Signal conversation.
//
// This adapter mirrors the EmailAdapter pattern. The key differences:
//   - Transport is a Unix socket (signal-cli daemon) instead of HTTP polling
//   - Trust level is 'high' — phone number + E2E encryption (see channel-trust.yaml)
//   - Read receipts are sent back for 1:1 messages from known senders
//   - Group messages don't get read receipts (group receipt semantics are complex)

import type { EventBus } from '../../bus/bus.js';
import type { Logger } from '../../logger.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { OutboundGateway } from '../../skills/outbound-gateway.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import type { SignalEnvelope } from './types.js';
import { SignalRpcClient } from './signal-rpc-client.js';
import { convertSignalEnvelope } from './message-converter.js';
import { createInboundMessage } from '../../bus/events.js';
import { sanitizeOutput } from '../../skills/sanitize.js';

export interface SignalAdapterConfig {
  bus: EventBus;
  logger: Logger;
  rpcClient: SignalRpcClient;
  /**
   * The OutboundGateway is optional here because Signal and email can be
   * configured independently. If the gateway is unavailable (e.g., no Signal
   * send path wired), outbound replies are logged as warnings rather than
   * silently dropped — the coordinator's response still completes, but no
   * message leaves the system.
   *
   * TODO: Once OutboundGateway always has a Signal client when the Signal adapter
   * is active (see index.ts wiring notes), this can be tightened to required.
   * For now, optional matches the EmailAdapter pattern and keeps bootstrap simpler.
   */
  outboundGateway: OutboundGateway | undefined;
  contactService: ContactService;
  /** Nathan's E.164 phone number — the Signal account that receives messages */
  phoneNumber: string;
}

export class SignalAdapter {
  private readonly config: SignalAdapterConfig;
  private readonly log: Logger;
  // Bound handler so we can remove it in stop() without losing the reference.
  // Arrow function captures `this` correctly even after .off() removes it.
  private readonly boundHandleInbound: (envelope: SignalEnvelope) => void;

  constructor(config: SignalAdapterConfig) {
    this.config = config;
    this.log = config.logger.child({ component: 'signal-adapter' });
    // The .catch is required: handleInbound is async and errors inside it (e.g. a
    // bus.publish rejection) would otherwise become an UnhandledPromiseRejection,
    // crashing Node in default configuration. We catch here rather than inside
    // handleInbound because handleInbound already catches expected errors (contact
    // resolution failures) — this outer catch is the backstop for unexpected throws.
    this.boundHandleInbound = (envelope) => {
      void this.handleInbound(envelope).catch((err: unknown) => {
        this.log.error({ err }, 'Signal adapter: unexpected error in inbound handler');
      });
    };
  }

  async start(): Promise<void> {
    const { bus, rpcClient } = this.config;

    // Subscribe to outbound messages for the Signal channel.
    // When the coordinator responds to a Signal-triggered conversation, the
    // dispatcher creates an outbound.message with channelId 'signal'. The adapter
    // routes this back to the sender via the OutboundGateway.
    bus.subscribe('outbound.message', 'channel', async (event) => {
      const outbound = event as OutboundMessageEvent;
      if (outbound.payload.channelId !== 'signal') return;

      try {
        await this.handleOutbound(outbound);
      } catch (err) {
        this.log.error({ err, conversationId: outbound.payload.conversationId },
          'Failed to send Signal response');
      }
    });

    // Register inbound message handler before connecting so no messages are
    // missed during the connect window.
    rpcClient.on('message', this.boundHandleInbound);

    // connect() is synchronous — it starts the connection attempt in the background
    // and returns immediately. If signal-cli is not yet available (Docker startup race),
    // the RPC client's exponential backoff will retry until it connects. The 'connected'
    // event on the RPC client signals when messages will start flowing.
    rpcClient.connect();
    this.log.info('Signal adapter started — connecting to signal-cli socket');
  }

  async stop(): Promise<void> {
    this.config.rpcClient.off('message', this.boundHandleInbound);
    await this.config.rpcClient.disconnect();
    this.log.info('Signal adapter stopped');
  }

  // ---------------------------------------------------------------------------
  // Private: inbound
  // ---------------------------------------------------------------------------

  private async handleInbound(envelope: SignalEnvelope): Promise<void> {
    const converted = convertSignalEnvelope(envelope);
    if (!converted) {
      // Reaction, sync, view-once, empty content, group management — silently ignored.
      // Logged at debug so operators can verify the filter is working without log spam.
      this.log.debug(
        { source: envelope.sourceNumber, hasData: !!envelope.dataMessage },
        'Signal adapter: ignoring non-message envelope',
      );
      return;
    }

    const { conversationId, senderId, content, metadata } = converted;

    // ------------------------------------------------------------------
    // Step 1: Contact resolution and auto-create
    // ------------------------------------------------------------------
    // Try to find an existing contact for this phone number before publishing
    // so the dispatcher's contact resolver can find the record immediately.
    let isKnownSender = false;
    try {
      const existing = await this.config.contactService.resolveByChannelIdentity('signal', senderId);

      if (existing) {
        // Known sender: not provisional and not blocked counts as "known"
        // for read-receipt purposes. The dispatcher enforces hold/block policy.
        isKnownSender = existing.status !== 'provisional' && existing.status !== 'blocked';
      } else {
        // New sender — auto-create a provisional contact.
        // signal_participant is auto-verified (per contact-service.ts) so the phone
        // number identity gets verified:true at creation time, matching email_participant.
        // Display name comes from Signal's profile; phone number is the E.164 fallback.
        const contact = await this.config.contactService.createContact({
          displayName: metadata.sourceName || senderId,
          fallbackDisplayName: senderId,
          source: 'signal_participant',
          status: 'provisional',
        });
        await this.config.contactService.linkIdentity({
          contactId: contact.id,
          channel: 'signal',
          channelIdentifier: senderId,
          source: 'signal_participant',
        });
        this.log.info({ senderId, sourceName: metadata.sourceName }, 'Auto-created contact from Signal sender');
      }
    } catch (err) {
      // Non-fatal: contact creation is best-effort. The inbound message is still
      // published — the dispatcher will handle unknown senders per channel policy.
      // isKnownSender stays false so no read receipt will be sent for this message.
      this.log.warn({ err, senderId }, 'Failed to resolve/auto-create Signal contact');
    }

    // ------------------------------------------------------------------
    // Step 2: Read receipt (1:1 + known sender only)
    // ------------------------------------------------------------------
    // We send read receipts only for 1:1 messages from known (non-provisional,
    // non-blocked) senders. Reasons for each exclusion:
    //   - Group: receipt semantics broadcast to all group members — deferred to a future version
    //   - Provisional: CEO hasn't confirmed this contact yet — don't acknowledge unknown senders
    //   - Blocked: never send receipts back to blocked senders
    if (isKnownSender && !metadata.isGroup) {
      // Fire-and-forget: read receipts are best-effort protocol-level acknowledgements.
      // A failed receipt must never block the inbound publish — the message must reach
      // the coordinator regardless of whether the receipt lands.
      this.config.rpcClient.sendReadReceipt({
        account: this.config.phoneNumber,
        recipient: senderId,
        targetTimestamp: [metadata.signalTimestamp],
        receiptType: 'read',
      }).catch((err: unknown) => {
        this.log.warn({ err, senderId }, 'Failed to send Signal read receipt');
      });
    }

    // ------------------------------------------------------------------
    // Step 3: Sanitize and publish
    // ------------------------------------------------------------------
    // Sanitize content to mitigate prompt injection from external senders.
    // Signal messages are shorter than emails but carry the same injection risk —
    // a malicious sender could craft a message that looks like system instructions.
    const sanitizedContent = sanitizeOutput(content, {
      maxLength: 10_000,
    });

    const event = createInboundMessage({
      conversationId,
      channelId: 'signal',
      senderId,
      content: sanitizedContent,
      metadata: metadata as unknown as Record<string, unknown>,
    });

    await this.config.bus.publish('channel', event);

    this.log.info(
      { senderId, sourceName: metadata.sourceName, isGroup: metadata.isGroup, conversationId },
      'Signal message received and published to bus',
    );
  }

  // ---------------------------------------------------------------------------
  // Private: outbound
  // ---------------------------------------------------------------------------

  private async handleOutbound(outbound: OutboundMessageEvent): Promise<void> {
    const { outboundGateway } = this.config;
    const conversationId = outbound.payload.conversationId;

    if (!outboundGateway) {
      // Should not happen in normal operation — Signal adapter only starts when
      // outboundGateway is available (see index.ts wiring). If this fires, it
      // indicates a wiring bug: the adapter was constructed without a gateway.
      // Logged at error (not warn) because the coordinator's response is silently
      // lost — the CEO sent a message and got no reply.
      // TODO: once the gateway always has a Signal client when this adapter is
      // active, convert this to an explicit assertion.
      this.log.error({ conversationId }, 'Signal adapter: outbound gateway not available — reply dropped. Check index.ts wiring.');
      return;
    }

    if (!conversationId.startsWith('signal:')) {
      this.log.warn({ conversationId }, 'Signal adapter: conversation ID not in signal: format');
      return;
    }

    const conversationTarget = conversationId.slice('signal:'.length);

    // Determine whether this is a 1:1 or group conversation from the conversation ID format.
    // Group IDs are prefixed with 'group=' to distinguish them from E.164 phone numbers.
    let recipient: string | undefined;
    let groupId: string | undefined;

    if (conversationTarget.startsWith('group=')) {
      // Strip the 'group=' prefix to get the raw base64 group ID for the RPC call
      groupId = conversationTarget.slice('group='.length);
    } else {
      // 1:1 conversation — the target is the E.164 phone number
      recipient = conversationTarget;
    }

    const result = await outboundGateway.send({
      channel: 'signal',
      recipient,
      groupId,
      message: outbound.payload.content,
    });

    if (result.success) {
      this.log.info({ conversationId, recipient, groupId }, 'Signal reply sent via gateway');
    } else {
      this.log.warn({ conversationId, reason: result.blockedReason }, 'Signal reply blocked by gateway');
    }
  }
}
