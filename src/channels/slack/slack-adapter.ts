// src/channels/slack/slack-adapter.ts
//
// Slack channel adapter — Socket Mode inbound (DMs + @mentions), contact
// auto-create, outbound replies via OutboundGateway. See ADR-033.

import type { EventBus } from '../../bus/bus.js';
import type { Logger } from '../../logger.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { OutboundGateway } from '../../skills/outbound-gateway.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import { createInboundMessage } from '../../bus/events.js';
import { sanitizeOutput } from '../../skills/sanitize.js';
import type { Channel } from '../channel.js';
import { SlackClient } from './slack-client.js';
import { convertSlackEvent, parseSlackConversationId } from './message-converter.js';
import { isSlackChannelAllowed } from './channel-allowlist.js';
import type { SlackInboundEvent } from './types.js';

export interface SlackAdapterConfig {
  bus: EventBus;
  logger: Logger;
  client: SlackClient;
  outboundGateway: OutboundGateway | undefined;
  contactService: ContactService;
  /** Optional allowlist of Slack channel ids (C…) for @mentions. Empty = all. */
  allowedChannelIds?: string[];
}

export class SlackAdapter implements Channel {
  readonly name = 'slack';
  readonly isToggleable = true;
  private readonly config: SlackAdapterConfig;
  private readonly log: Logger;
  private readonly boundHandleEvent: (event: SlackInboundEvent, kind: 'dm' | 'mention') => void;
  /** Short-lived dedupe of channel:ts so overlapping message + app_mention don't double-publish. */
  private readonly recentDedupeKeys = new Map<string, number>();
  private static readonly DEDUPE_TTL_MS = 60_000;

  constructor(config: SlackAdapterConfig) {
    this.config = config;
    this.log = config.logger.child({ component: 'slack-adapter' });
    this.boundHandleEvent = (event, kind) => {
      void this.handleInbound(event, kind).catch((err: unknown) => {
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
    this.log.info('Slack adapter stopped');
  }

  private async handleInbound(event: SlackInboundEvent, kind: 'dm' | 'mention'): Promise<void> {
    const botUserId = this.config.client.getBotIdentity()?.botUserId;
    const converted = convertSlackEvent(event, botUserId, kind);
    if (!converted) {
      this.log.debug({ kind }, 'Slack adapter: ignoring non-actionable event');
      return;
    }

    if (kind === 'mention') {
      const allowed = isSlackChannelAllowed(
        converted.metadata.slackChannel,
        this.config.allowedChannelIds,
      );
      if (!allowed) {
        this.log.debug(
          { channel: converted.metadata.slackChannel },
          'Slack adapter: @mention dropped — channel not on allowlist',
        );
        return;
      }
    }

    // Dedupe overlapping message + app_mention (same channel+ts).
    if (this.isDuplicate(converted.metadata.dedupeKey)) {
      this.log.debug(
        { dedupeKey: converted.metadata.dedupeKey },
        'Slack adapter: duplicate event suppressed',
      );
      return;
    }

    const { conversationId, senderId, content, metadata } = converted;

    try {
      const existing = await this.config.contactService.resolveByChannelIdentity('slack', senderId);
      if (!existing) {
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
      }
    } catch (err) {
      this.log.warn({ err, senderId }, 'Failed to resolve/auto-create Slack contact');
    }

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

    const result = await outboundGateway.send(
      {
        channel: 'slack',
        slackChannelId: parsed.channel,
        threadTs: parsed.threadTs,
        message: outbound.payload.content,
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
    const now = Date.now();
    // Prune expired entries opportunistically.
    for (const [key, ts] of this.recentDedupeKeys) {
      if (now - ts > SlackAdapter.DEDUPE_TTL_MS) this.recentDedupeKeys.delete(key);
    }
    if (this.recentDedupeKeys.has(dedupeKey)) return true;
    this.recentDedupeKeys.set(dedupeKey, now);
    return false;
  }
}
