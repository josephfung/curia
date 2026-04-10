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
import { checkGroupMemberTrust } from './group-trust.js';
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
  /** Curia's E.164 phone number — the Signal account that receives messages */
  phoneNumber: string;
  /**
   * CEO's email address for group hold notifications.
   * When a group message is held because of unverified members, Curia sends the
   * CEO an email listing the unknown phone numbers.
   * If absent or empty, holds are logged at error but no email is sent.
   */
  ceoEmail?: string;
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
    // Step 0: Group trust check
    // ------------------------------------------------------------------
    // Before engaging with any group conversation, verify every member's
    // phone number is a known, verified contact. A single unknown or blocked
    // member causes the message to be held or dropped.
    // This runs before contact resolution so we don't create a contact for the
    // sender of an untrusted group message.
    if (metadata.isGroup && metadata.groupId) {
      const shouldProceed = await this.handleGroupTrustCheck(metadata.groupId);
      if (!shouldProceed) return;
    }

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
      // The outbound.message bus event is only emitted by the dispatcher for
      // inbound-Signal-triggered responses — same reasoning as the email adapter.
      triggerSource: 'user-initiated',
    });

    if (result.success) {
      this.log.info({ conversationId, recipient, groupId }, 'Signal reply sent via gateway');
    } else {
      this.log.warn({ conversationId, reason: result.blockedReason }, 'Signal reply blocked by gateway');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: group trust
  // ---------------------------------------------------------------------------

  /**
   * Runs the group trust check for an inbound group message.
   * Returns true if the group is trusted and processing should continue.
   * Returns false if the message was held or dropped — caller must return early.
   */
  private async handleGroupTrustCheck(groupId: string): Promise<boolean> {
    // Fetch group membership from signal-cli. Fail-closed: if listGroups throws
    // (e.g. socket error, signal-cli restart), treat the group as untrusted so
    // we never accidentally engage with an unverified group.
    let memberPhones: string[];
    try {
      const groups = await this.config.rpcClient.listGroups();
      const group = groups.find((g) => g.id === groupId);
      if (!group) {
        this.log.warn({ groupId }, 'Signal adapter: group not found in listGroups — treating as untrusted (fail-closed)');
        return false;
      }
      // Exclude Curia's own number — it would resolve to Curia's own contact and
      // skew the trust check. Only external member phones are meaningful here.
      memberPhones = group.members
        .map((m) => m.number)
        .filter((phone): phone is string => !!phone && phone !== this.config.phoneNumber);
    } catch (err) {
      this.log.warn({ err, groupId }, 'Signal adapter: listGroups failed — treating group as untrusted (fail-closed)');
      return false;
    }

    let trust: Awaited<ReturnType<typeof checkGroupMemberTrust>>;
    try {
      trust = await checkGroupMemberTrust(memberPhones, this.config.contactService);
    } catch (err) {
      this.log.warn({ err, groupId }, 'Signal adapter: checkGroupMemberTrust failed — treating group as untrusted (fail-closed)');
      return false;
    }

    if (trust.blockedMembers.length > 0) {
      // Silent drop — never acknowledge to blocked contacts that Curia is active
      // or monitoring the group. No email notification.
      this.log.debug(
        { groupId, blockedCount: trust.blockedMembers.length },
        'Signal adapter: group message dropped — blocked member in group',
      );
      return false;
    }

    if (trust.unknownMembers.length > 0) {
      // Auto-create provisional contacts for unknown members so the CEO can
      // identify them using the contact skills. Same pattern as unknown 1:1 senders.
      for (const phone of trust.unknownMembers) {
        try {
          const contact = await this.config.contactService.createContact({
            displayName: phone,
            fallbackDisplayName: phone,
            source: 'signal_participant',
            status: 'provisional',
          });
          await this.config.contactService.linkIdentity({
            contactId: contact.id,
            channel: 'signal',
            channelIdentifier: phone,
            source: 'signal_participant',
          });
        } catch (err) {
          // Best-effort — continue with remaining members even if one fails
          this.log.warn({ err, phone }, 'Signal adapter: failed to auto-create contact for unknown group member');
        }
      }

      try {
        await this.notifyCeoGroupHeld(groupId, trust.unknownMembers);
      } catch (err) {
        // notifyCeoGroupHeld has its own internal try-catch for the send call,
        // but any error before that point would escape without this guard.
        this.log.error({ err, groupId }, 'Signal adapter: unexpected error in notifyCeoGroupHeld');
      }

      this.log.info(
        { groupId, unknownCount: trust.unknownMembers.length },
        'Signal adapter: group message held — unknown members, CEO notified via email',
      );
      return false;
    }

    return true; // all members verified — proceed
  }

  /**
   * Send the CEO an email notification when a group message is held due to
   * unverified members. Uses the outbound gateway so the email goes through
   * the normal content filter pipeline.
   *
   * The CLI is not assumed to be monitored, so email is the reliable async
   * channel for this notification.
   */
  private async notifyCeoGroupHeld(groupId: string, unknownPhones: string[]): Promise<void> {
    const { outboundGateway, ceoEmail } = this.config;

    if (!outboundGateway || !ceoEmail) {
      this.log.error(
        { groupId, hasGateway: !!outboundGateway, hasCeoEmail: !!ceoEmail },
        'Signal adapter: cannot notify CEO of held group message — outbound gateway or ceoEmail not configured',
      );
      return;
    }

    const memberList = unknownPhones.map((p) => `• ${p} — no verified contact`).join('\n');
    const body = [
      'A Signal group message was received but held because the following group members have not yet been verified:',
      '',
      memberList,
      '',
      'Once you have verified these contacts, you can ask me to send a message to the group and I will re-check membership before engaging.',
      '',
      `Group ID (for reference): ${groupId}`,
    ].join('\n');

    try {
      await outboundGateway.send({
        channel: 'email',
        to: ceoEmail,
        subject: 'Signal group message held — member verification needed',
        body,
        // System-generated notification with a hardcoded template — classify as
        // routine so it is subject to the same contact-data-leak policy as
        // automated messages (the body contains no third-party emails, but the
        // conservative classification is correct semantically).
        triggerSource: 'routine',
      });
    } catch (err) {
      // Non-fatal — the message is still held. Log at error so it's visible in alerting.
      this.log.error({ err, groupId }, 'Signal adapter: failed to send CEO group-held notification via email');
    }
  }
}
