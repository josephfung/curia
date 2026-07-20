// src/channels/slack/slack-client.ts
//
// Thin wrapper over @slack/web-api + @slack/socket-mode.
// Mirrors SignalRpcClient's EventEmitter lifecycle: connect() starts in the
// background with reconnect; disconnect() is idempotent teardown.

import { EventEmitter } from 'node:events';
import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import type { Logger } from '../../logger.js';
import type {
  SlackAuthIdentity,
  SlackInboundEvent,
  SlackInboundKind,
  SlackMessageEvent,
  SlackPostMessageParams,
  SlackPostMessageResult,
  SlackUserInfo,
} from './types.js';

export interface SlackClientConfig {
  botToken: string;
  appToken: string;
  logger: Logger;
}

export interface SlackClientEvents {
  connected: [];
  disconnected: [];
  /** kind distinguishes DM / mention / thread reply / reaction for the converter. */
  event: [event: SlackInboundEvent, kind: SlackInboundKind];
}

export class SlackClient extends EventEmitter {
  private readonly web: WebClient;
  private readonly socket: SocketModeClient;
  private readonly log: Logger;
  private stopping = false;
  private identity: SlackAuthIdentity | undefined;
  private started = false;

  constructor(config: SlackClientConfig) {
    super();
    this.log = config.logger.child({ component: 'slack-client' });
    this.web = new WebClient(config.botToken);
    this.socket = new SocketModeClient({ appToken: config.appToken });
  }

  /** Resolved after successful auth.test during start. */
  getBotIdentity(): SlackAuthIdentity | undefined {
    return this.identity;
  }

  /**
   * Start Socket Mode. Resolves after auth.test + socket start attempt begins.
   * Does not block boot on a live Slack connection — Socket Mode reconnects
   * internally; we surface connected/disconnected for operators.
   */
  async connect(): Promise<void> {
    this.stopping = false;
    if (this.started) return;

    try {
      const auth = await this.web.auth.test();
      const botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
      if (!botUserId) {
        throw new Error('auth.test did not return user_id — check bot token');
      }
      this.identity = {
        botUserId,
        teamId: typeof auth.team_id === 'string' ? auth.team_id : undefined,
        botName: typeof auth.user === 'string' ? auth.user : undefined,
      };
      this.log.info(
        { botUserId: this.identity.botUserId, botName: this.identity.botName, teamId: this.identity.teamId },
        'Slack auth.test succeeded',
      );
    } catch (err) {
      this.log.error({ err }, 'Slack auth.test failed — Socket Mode will still attempt to connect');
    }

    this.socket.on('connected', () => {
      this.log.info('Slack Socket Mode connected');
      this.emit('connected');
    });
    this.socket.on('disconnected', () => {
      if (this.stopping) return;
      this.log.warn('Slack Socket Mode disconnected — client will reconnect');
      this.emit('disconnected');
    });

    // message events: DMs (im) and channel/group traffic (for active-thread replies).
    this.socket.on('message', async ({ event, ack }) => {
      try {
        await ack();
      } catch (err) {
        this.log.warn({ err }, 'Slack Socket Mode ack failed for message event');
      }
      if (this.stopping) return;
      if (!event || typeof event !== 'object') return;
      const payload = event as SlackMessageEvent;
      if (payload.type !== 'message') return;

      const isDm =
        payload.channel?.startsWith('D') ||
        payload.channel_type === 'im';
      this.emit('event', payload, isDm ? 'dm' : 'thread');
    });

    // Channel @mentions.
    this.socket.on('app_mention', async ({ event, ack }) => {
      try {
        await ack();
      } catch (err) {
        this.log.warn({ err }, 'Slack Socket Mode ack failed for app_mention event');
      }
      if (this.stopping) return;
      if (!event || typeof event !== 'object') return;
      const payload = event as SlackInboundEvent;
      if (payload.type !== 'app_mention') return;
      this.emit('event', payload, 'mention');
    });

    // Reactions — normalized to inbound.reaction; emoji→intent is dispatch-side.
    this.socket.on('reaction_added', async ({ event, ack }) => {
      try {
        await ack();
      } catch (err) {
        this.log.warn({ err }, 'Slack Socket Mode ack failed for reaction_added event');
      }
      if (this.stopping) return;
      if (!event || typeof event !== 'object') return;
      const payload = event as SlackInboundEvent;
      if (payload.type !== 'reaction_added') return;
      this.emit('event', payload, 'reaction');
    });

    this.started = true;
    // start() reconnects with backoff internally — do not await forever on boot.
    void this.socket.start().catch((err: unknown) => {
      if (this.stopping) return;
      this.log.error({ err }, 'Slack Socket Mode start failed');
    });
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    if (!this.started) return;
    try {
      await this.socket.disconnect();
    } catch (err) {
      this.log.warn({ err }, 'Slack Socket Mode disconnect error');
    }
    this.started = false;
    this.log.info('Slack client disconnected');
  }

  async postMessage(params: SlackPostMessageParams): Promise<SlackPostMessageResult> {
    try {
      const result = await this.web.chat.postMessage({
        channel: params.channel,
        text: params.text,
        thread_ts: params.threadTs,
        // Avoid unfurling links into noisy previews in executive threads.
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'unknown_error' };
      }
      return {
        ok: true,
        ts: typeof result.ts === 'string' ? result.ts : undefined,
        channel: typeof result.channel === 'string' ? result.channel : params.channel,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ err }, 'Slack chat.postMessage failed');
      return { ok: false, error: message };
    }
  }

  async lookupUser(userId: string): Promise<SlackUserInfo | null> {
    try {
      const result = await this.web.users.info({ user: userId });
      if (!result.ok || !result.user) return null;
      const user = result.user;
      const profile = user.profile;
      const displayName =
        profile?.display_name?.trim() ||
        profile?.real_name?.trim() ||
        user.real_name?.trim() ||
        user.name?.trim() ||
        userId;
      return { id: userId, displayName };
    } catch (err) {
      this.log.warn({ err, userId }, 'Slack users.info failed');
      return null;
    }
  }
}
