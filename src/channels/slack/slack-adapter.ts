// src/channels/slack/slack-adapter.ts
//
// Slack channel adapter — Socket Mode inbound (DMs, @mentions, active-thread
// replies, reactions), contact auto-create, outbound via OutboundGateway.
// See ADR-033. Trust rides sender U… → contact tier, never conversation id.

import type { EventBus } from '../../bus/bus.js';
import type { Logger } from '../../logger.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { OutboundGateway } from '../../skills/outbound-gateway.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import { createInboundMessage, createInboundReaction } from '../../bus/events.js';
import { sanitizeOutput } from '../../skills/sanitize.js';
import type { Channel } from '../channel.js';
import { SlackClient } from './slack-client.js';
import {
  convertSlackEvent,
  convertSlackReaction,
  parseSlackConversationId,
  slackThreadKey,
} from './message-converter.js';
import { isSlackChannelAllowed } from './channel-allowlist.js';
import type { SlackInboundEvent, SlackInboundKind } from './types.js';
import { BoundedTtlMap } from './bounded-ttl-map.js';

export interface SlackAdapterConfig {
  bus: EventBus;
  logger: Logger;
  client: SlackClient;
  outboundGateway: OutboundGateway | undefined;
  contactService: ContactService;
  /** Optional allowlist of Slack channel ids (C…) for @mentions / thread replies. */
  allowedChannelIds?: string[];
}

export class SlackAdapter implements Channel {
  readonly name = 'slack';
  readonly isToggleable = true;
  private readonly config: SlackAdapterConfig;
  private readonly log: Logger;
  private readonly boundHandleEvent: (event: SlackInboundEvent, kind: SlackInboundKind) => void;
  /**
   * Short-lived dedupe of Slack event keys. Process-local only — cleared on
   * stop() and lost on restart/reconnect. Absorbs Slack redelivery-on-missed-ack
   * (and mention vs thread double-delivery of the same ts). TTL + size-capped
   * (same primitive as activeThreads / dmPeerByChannel) so a reaction/message
   * burst inside the TTL window can't grow it without bound.
   */
  private static readonly DEDUPE_TTL_MS = 60_000;
  private static readonly DEDUPE_MAX = 2_000;
  private readonly recentDedupeKeys = new BoundedTtlMap<true>(
    SlackAdapter.DEDUPE_TTL_MS,
    SlackAdapter.DEDUPE_MAX,
  );
  /** Active channel threads (`channel:thread_ts`) — TTL + size-capped. */
  private static readonly ACTIVE_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly ACTIVE_THREAD_MAX = 500;
  private readonly activeThreads = new BoundedTtlMap<true>(
    SlackAdapter.ACTIVE_THREAD_TTL_MS,
    SlackAdapter.ACTIVE_THREAD_MAX,
  );
  /** DM conversation id (D…) → peer Slack user id (U…), learned on inbound. */
  private static readonly DM_PEER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly DM_PEER_MAX = 1_000;
  private readonly dmPeerByChannel = new BoundedTtlMap<string>(
    SlackAdapter.DM_PEER_TTL_MS,
    SlackAdapter.DM_PEER_MAX,
  );

  constructor(config: SlackAdapterConfig) {
    this.config = config;
    this.log = config.logger.child({ component: 'slack-adapter' });
    this.boundHandleEvent = (event, kind) => {
      void this.handleEvent(event, kind).catch((err: unknown) => {
        this.log.error({ err }, 'Slack adapter: unexpected error in inbound handler');
      });
    };
  }

  async start(): Promise<void> {
    const { bus, client } = this.config;

    bus.subscribe('outbound.message', 'channel', async (event) => {
      const outbound = event as OutboundMessageEvent;
      if (outbound.payload.channelId !== 'slack') return;
      try {
        await this.handleOutbound(outbound);
      } catch (err) {
        this.log.error(
          { err, conversationId: outbound.payload.conversationId },
          'Failed to send Slack response',
        );
      }
    });

    client.on('event', this.boundHandleEvent);
    await client.connect();

    const identity = client.getBotIdentity();
    this.log.info(
      { botUserId: identity?.botUserId, botName: identity?.botName },
      'Slack adapter started — Socket Mode connecting',
    );
  }

  async stop(): Promise<void> {
    this.config.client.off('event', this.boundHandleEvent);
    await this.config.client.disconnect();
    this.recentDedupeKeys.clear();
    this.activeThreads.clear();
    this.dmPeerByChannel.clear();
    this.log.info('Slack adapter stopped');
  }

  private async handleEvent(event: SlackInboundEvent, kind: SlackInboundKind): Promise<void> {
    if (kind === 'reaction') {
      await this.handleReaction(event);
      return;
    }
    await this.handleInbound(event, kind);
  }

  private async handleInbound(
    event: SlackInboundEvent,
    kind: Exclude<SlackInboundKind, 'reaction'>,
  ): Promise<void> {
    const botUserId = this.config.client.getBotIdentity()?.botUserId;
    const converted = convertSlackEvent(event, botUserId, kind, this.activeThreads);
    if (!converted) {
      this.log.debug({ kind }, 'Slack adapter: ignoring non-actionable event');
      return;
    }

    if (kind === 'mention' || kind === 'thread') {
      const allowed = isSlackChannelAllowed(
        converted.metadata.slackChannel,
        this.config.allowedChannelIds,
      );
      if (!allowed) {
        this.log.debug(
          { channel: converted.metadata.slackChannel, kind },
          'Slack adapter: channel traffic dropped — channel not on allowlist',
        );
        return;
      }
    }

    if (this.isDuplicate(converted.metadata.dedupeKey)) {
      this.log.debug(
        { dedupeKey: converted.metadata.dedupeKey },
        'Slack adapter: duplicate event suppressed',
      );
      return;
    }

    const { conversationId, senderId, content, metadata } = converted;

    // Remember DM peer U… so outbound principal checks can resolve D… → U….
    // Ephemeral: lost on restart; reply path prefers dispatcher recipientId (U…).
    if (metadata.isDm) {
      this.dmPeerByChannel.set(metadata.slackChannel, senderId);
    }

    // Activate channel threads on @mention (and keep them active on replies).
    if (metadata.threadTs && !metadata.isDm) {
      this.activeThreads.set(slackThreadKey(metadata.slackChannel, metadata.threadTs), true);
    }

    await this.ensureSlackContact(senderId);

    const sanitizedContent = sanitizeOutput(content, { maxLength: 10_000 });

    const inbound = createInboundMessage({
      conversationId,
      channelId: 'slack',
      senderId,
      content: sanitizedContent,
      metadata: metadata as unknown as Record<string, unknown>,
    });

    await this.config.bus.publish('channel', inbound);

    this.log.info(
      { senderId, conversationId, isDm: metadata.isDm, eventType: metadata.eventType },
      'Slack message received and published to bus',
    );
  }

  private async handleReaction(event: SlackInboundEvent): Promise<void> {
    const botUserId = this.config.client.getBotIdentity()?.botUserId;
    const converted = convertSlackReaction(event, botUserId);
    if (!converted) {
      this.log.debug('Slack adapter: ignoring non-actionable reaction');
      return;
    }

    // Reactions in channels ride the same allowlist as mentions/thread replies;
    // DM reactions (D…) are never filtered, matching handleInbound. Without this
    // a reaction in a non-allowlisted channel would still auto-create a contact
    // and publish inbound.reaction.
    const reactionChannel = converted.metadata.slackChannel;
    if (!reactionChannel.startsWith('D')) {
      const allowed = isSlackChannelAllowed(reactionChannel, this.config.allowedChannelIds);
      if (!allowed) {
        this.log.debug(
          { channel: reactionChannel },
          'Slack adapter: reaction dropped — channel not on allowlist',
        );
        return;
      }
    }

    if (this.isDuplicate(converted.metadata.dedupeKey)) {
      this.log.debug(
        { dedupeKey: converted.metadata.dedupeKey },
        'Slack adapter: duplicate reaction suppressed',
      );
      return;
    }

    if (converted.metadata.slackChannel.startsWith('D')) {
      this.dmPeerByChannel.set(converted.metadata.slackChannel, converted.senderId);
    }

    await this.ensureSlackContact(converted.senderId);

    const inbound = createInboundReaction({
      conversationId: converted.conversationId,
      channelId: 'slack',
      senderId: converted.senderId,
      emoji: converted.emoji,
      targetMessageId: converted.targetMessageId,
      metadata: converted.metadata as unknown as Record<string, unknown>,
    });

    await this.config.bus.publish('channel', inbound);

    this.log.info(
      {
        senderId: converted.senderId,
        emoji: converted.emoji,
        targetMessageId: converted.targetMessageId,
      },
      'Slack reaction received and published to bus',
    );
  }

  private async ensureSlackContact(senderId: string): Promise<void> {
    try {
      const existing = await this.config.contactService.resolveByChannelIdentity('slack', senderId);
      if (existing) return;

      let displayName = senderId;
      const userInfo = await this.config.client.lookupUser(senderId);
      if (userInfo?.displayName) displayName = userInfo.displayName;

      let contact: { id: string } | null = null;
      try {
        contact = await this.config.contactService.createContact({
          displayName,
          fallbackDisplayName: senderId,
          source: 'slack_participant',
          tier: 'unknown',
        });
      } catch (err) {
        this.log.warn({ err, senderId }, 'Failed to create contact for Slack sender');
      }

      if (contact) {
        try {
          await this.config.contactService.linkIdentity({
            contactId: contact.id,
            channel: 'slack',
            channelIdentifier: senderId,
            source: 'slack_participant',
          });
          this.log.info({ senderId, displayName }, 'Auto-created contact from Slack sender');
        } catch (linkErr) {
          const isDuplicate = (linkErr as { code?: string }).code === '23505';
          try {
            await this.config.contactService.deleteContact(contact.id);
          } catch (cleanupErr) {
            this.log.warn(
              { cleanupErr, orphanId: contact.id, senderId },
              'Slack adapter: failed to clean up orphan contact after linkIdentity failure',
            );
          }
          if (!isDuplicate) {
            this.log.warn({ err: linkErr, senderId }, 'Slack adapter: linkIdentity failed');
          }
        }
      }
    } catch (err) {
      this.log.warn({ err, senderId }, 'Failed to resolve/auto-create Slack contact');
    }
  }

  private async handleOutbound(outbound: OutboundMessageEvent): Promise<void> {
    const { outboundGateway } = this.config;
    const conversationId = outbound.payload.conversationId;

    if (!outboundGateway) {
      this.log.error(
        { conversationId },
        'Slack adapter: outbound gateway not available — reply dropped. Check index.ts wiring.',
      );
      return;
    }

    const parsed = parseSlackConversationId(conversationId);
    if (!parsed) {
      this.log.warn({ conversationId }, 'Slack adapter: conversation ID not in slack: format');
      return;
    }

    // Prefer dispatcher-stamped recipientId (always the inbound senderId / U… on
    // reply path). Fall back to the learned DM peer map (ephemeral across restarts).
    const slackUserId =
      outbound.payload.recipientId?.startsWith('U')
        ? outbound.payload.recipientId
        : this.dmPeerByChannel.get(parsed.channel);

    if (parsed.threadTs && !parsed.isDm) {
      this.activeThreads.set(slackThreadKey(parsed.channel, parsed.threadTs), true);
    }

    const result = await outboundGateway.send(
      {
        channel: 'slack',
        slackChannelId: parsed.channel,
        threadTs: parsed.threadTs,
        message: outbound.payload.content,
        slackUserId,
      },
      {
        taskEventId: outbound.payload.taskEventId,
        conversationId: outbound.payload.conversationId,
        parentEventId: outbound.id,
      },
    );

    if (result.success) {
      this.log.info({ conversationId }, 'Slack reply sent via gateway');
    } else {
      this.log.warn({ conversationId, reason: result.blockedReason }, 'Slack reply blocked by gateway');
    }
  }

  private isDuplicate(dedupeKey: string): boolean {
    // BoundedTtlMap prunes expired entries and enforces the size cap internally.
    if (this.recentDedupeKeys.has(dedupeKey)) return true;
    this.recentDedupeKeys.set(dedupeKey, true);
    return false;
  }
}
