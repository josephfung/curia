// src/channels/slack/message-converter.ts
//
// Converts Slack Events API payloads into a normalized inbound shape for the
// SlackAdapter. Returns null for noise: bots, subtypes, reactions, edits,
// non-mention channel messages, empty text.

import type { SlackInboundEvent, SlackMessageEvent, SlackAppMentionEvent } from './types.js';

export interface ConvertedSlackMessage {
  conversationId: string;
  channelId: 'slack';
  /** Slack user id (U…) */
  senderId: string;
  content: string;
  metadata: {
    slackTs: string;
    slackChannel: string;
    threadTs?: string;
    isDm: boolean;
    eventType: 'message' | 'app_mention';
    /** Dedup key: channel + ts — Slack can deliver overlapping message + app_mention. */
    dedupeKey: string;
  };
}

/**
 * Build reversible conversation ids (ADR-025 / ADR-033):
 *   DM:            slack:D<conversationId>
 *   Channel thread: slack:C<channelId>:<thread_ts>
 */
export function buildSlackConversationId(
  slackChannel: string,
  threadTs: string | undefined,
  isDm: boolean,
): string {
  if (isDm) {
    return `slack:${slackChannel}`;
  }
  // Prefer existing thread; otherwise start a thread on the mention's ts.
  const thread = threadTs ?? '';
  if (!thread) {
    // Caller should always pass a ts for channel messages; defensive fallback.
    return `slack:${slackChannel}`;
  }
  return `slack:${slackChannel}:${thread}`;
}

/**
 * Parse a reversible slack: conversation id back into postMessage targets.
 * Returns null if the id is not a valid slack: key.
 */
export function parseSlackConversationId(conversationId: string): {
  channel: string;
  threadTs?: string;
  isDm: boolean;
} | null {
  if (!conversationId.startsWith('slack:')) return null;
  const rest = conversationId.slice('slack:'.length);
  if (!rest) return null;

  // DM: slack:D…  (no second colon segment for thread)
  // Channel: slack:C…:<thread_ts>  — thread_ts itself contains a '.' not extra ':'
  // Channel ids are C… / G… / D…; thread_ts looks like "1710000000.000100"
  const firstColon = rest.indexOf(':');
  if (firstColon === -1) {
    const isDm = rest.startsWith('D');
    return { channel: rest, isDm };
  }

  const channel = rest.slice(0, firstColon);
  const threadTs = rest.slice(firstColon + 1);
  if (!channel || !threadTs) return null;
  return { channel, threadTs, isDm: channel.startsWith('D') };
}

function isIgnorableMessage(event: SlackMessageEvent): boolean {
  // Bot messages / automation — never treat as human inbound.
  if (event.bot_id || event.bot_profile) return true;
  // Subtypes: message_changed, message_deleted, channel_join, bot_message, etc.
  // Only plain user messages (no subtype) are accepted for DMs.
  if (event.subtype) return true;
  return false;
}

/**
 * Convert a Slack event to a normalized inbound message.
 *
 * @param botUserId — this app's bot user id from auth.test; own messages ignored by id.
 * @param kind — 'dm' for message.im / IM channel messages; 'mention' for app_mention.
 */
export function convertSlackEvent(
  event: SlackInboundEvent,
  botUserId: string | undefined,
  kind: 'dm' | 'mention',
): ConvertedSlackMessage | null {
  if (kind === 'dm') {
    const msg = event as SlackMessageEvent;
    if (msg.type !== 'message') return null;
    if (isIgnorableMessage(msg)) return null;

    // Only process IM (DM) channel types for the message path.
    const channelType = msg.channel_type;
    const isDmChannel = msg.channel?.startsWith('D') || channelType === 'im';
    if (!isDmChannel) return null;

    if (!msg.user || (botUserId && msg.user === botUserId)) return null;

    const rawContent = msg.text?.trim() ?? '';
    if (!rawContent) return null;

    const conversationId = buildSlackConversationId(msg.channel, msg.thread_ts, true);
    return {
      conversationId,
      channelId: 'slack',
      senderId: msg.user,
      content: rawContent,
      metadata: {
        slackTs: msg.ts,
        slackChannel: msg.channel,
        threadTs: msg.thread_ts,
        isDm: true,
        eventType: 'message',
        dedupeKey: `${msg.channel}:${msg.ts}`,
      },
    };
  }

  // app_mention
  const mention = event as SlackAppMentionEvent;
  if (mention.type !== 'app_mention') return null;
  if (mention.bot_id) return null;
  if (!mention.user || (botUserId && mention.user === botUserId)) return null;

  const rawContent = mention.text?.trim() ?? '';
  if (!rawContent) return null;

  // Reply in the existing thread, or start a thread on this mention.
  const threadTs = mention.thread_ts ?? mention.ts;
  const conversationId = buildSlackConversationId(mention.channel, threadTs, false);

  return {
    conversationId,
    channelId: 'slack',
    senderId: mention.user,
    content: rawContent,
    metadata: {
      slackTs: mention.ts,
      slackChannel: mention.channel,
      threadTs,
      isDm: false,
      eventType: 'app_mention',
      dedupeKey: `${mention.channel}:${mention.ts}`,
    },
  };
}
