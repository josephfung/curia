// src/channels/slack/message-converter.ts
//
// Converts Slack Events API payloads into a normalized inbound shape for the
// SlackAdapter. Returns null for noise: bots, subtypes (except audio file_share),
// edits, empty text with no audio file, and channel messages outside an active Curia thread.

import type {
  SlackInboundEvent,
  SlackMessageEvent,
  SlackAppMentionEvent,
  SlackReactionAddedEvent,
  SlackInboundKind,
  SlackFile,
} from './types.js';
import { decodeSlackText } from './slack-entities.js';
import { findFirstSlackAudioFile } from '../inbound-voice-note.js';

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
    eventType: 'message' | 'app_mention' | 'thread_reply';
    /** Dedup key: channel + ts — absorbs Slack redelivery-on-missed-ack. */
    dedupeKey: string;
    files?: SlackFile[];
  };
}

export interface ConvertedSlackReaction {
  conversationId: string;
  channelId: 'slack';
  senderId: string;
  emoji: string;
  targetMessageId: string;
  metadata: {
    slackChannel: string;
    itemUser?: string;
    /** Dedup key: channel + item.ts + user + reaction */
    dedupeKey: string;
  };
}

/**
 * Build reversible conversation ids (ADR-025 / ADR-033):
 *   DM (no thread):     slack:D<conversationId>
 *   DM (in thread):     slack:D<conversationId>:<thread_ts>
 *   Channel thread:     slack:C<channelId>:<thread_ts>
 */
export function buildSlackConversationId(
  slackChannel: string,
  threadTs: string | undefined,
  isDm: boolean,
): string {
  if (isDm) {
    // Key DM threads when present so follow-ups stay in the same conversation.
    if (threadTs) return `slack:${slackChannel}:${threadTs}`;
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

  // DM: slack:D…  or slack:D…:<thread_ts>
  // Channel: slack:C…:<thread_ts>  — thread_ts itself contains a '.' not extra ':'
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

/** Active-thread key used by the adapter for in-thread continuation. */
export function slackThreadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

function hasSlackAudio(files: SlackFile[] | undefined): boolean {
  return !!findFirstSlackAudioFile(files);
}

function isIgnorableMessage(event: SlackMessageEvent): boolean {
  // Bot messages / automation — never treat as human inbound.
  if (event.bot_id || event.bot_profile) return true;
  // Subtypes: message_changed, message_deleted, channel_join, bot_message, etc.
  // file_share is accepted only when it carries audio (voice notes, #1600) —
  // a PDF/screenshot upload with a caption must not become inbound.
  if (event.subtype && !(event.subtype === 'file_share' && hasSlackAudio(event.files))) return true;
  return false;
}

function copyFiles(files: SlackFile[] | undefined): SlackFile[] | undefined {
  return files?.length ? files : undefined;
}

/**
 * Convert a Slack message / mention / thread-reply event to a normalized inbound message.
 *
 * @param botUserId — this app's bot user id from auth.test; own messages ignored by id.
 * @param kind — 'dm' | 'mention' | 'thread'
 * @param activeThreadKeys — for kind='thread', only deliver if thread_ts is active.
 */
export function convertSlackEvent(
  event: SlackInboundEvent,
  botUserId: string | undefined,
  kind: Exclude<SlackInboundKind, 'reaction'>,
  activeThreadKeys?: { has(key: string): boolean },
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
    if (!rawContent && !hasSlackAudio(msg.files)) return null;
    const content = rawContent ? decodeSlackText(rawContent) : '';

    const conversationId = buildSlackConversationId(msg.channel, msg.thread_ts, true);
    return {
      conversationId,
      channelId: 'slack',
      senderId: msg.user,
      content,
      metadata: {
        slackTs: msg.ts,
        slackChannel: msg.channel,
        threadTs: msg.thread_ts,
        isDm: true,
        eventType: 'message',
        dedupeKey: `${msg.channel}:${msg.ts}`,
        files: copyFiles(msg.files),
      },
    };
  }

  if (kind === 'thread') {
    const msg = event as SlackMessageEvent;
    if (msg.type !== 'message') return null;
    if (isIgnorableMessage(msg)) return null;
    if (!msg.user || (botUserId && msg.user === botUserId)) return null;

    // Channel / private-channel thread replies only (DMs use the dm path).
    const isChannel =
      msg.channel?.startsWith('C') ||
      msg.channel?.startsWith('G') ||
      msg.channel_type === 'channel' ||
      msg.channel_type === 'group';
    if (!isChannel) return null;

    const threadTs = msg.thread_ts;
    if (!threadTs) return null;
    if (!activeThreadKeys?.has(slackThreadKey(msg.channel, threadTs))) return null;

    // Skip messages that are themselves @mentions of the bot — those arrive
    // again as app_mention and are handled on the mention path (dedupe absorbs
    // any double delivery of the same ts).
    if (botUserId && msg.text?.includes(`<@${botUserId}>`)) return null;

    const rawContent = msg.text?.trim() ?? '';
    if (!rawContent && !hasSlackAudio(msg.files)) return null;
    const content = rawContent ? decodeSlackText(rawContent) : '';

    const conversationId = buildSlackConversationId(msg.channel, threadTs, false);
    return {
      conversationId,
      channelId: 'slack',
      senderId: msg.user,
      content,
      metadata: {
        slackTs: msg.ts,
        slackChannel: msg.channel,
        threadTs,
        isDm: false,
        eventType: 'thread_reply',
        dedupeKey: `${msg.channel}:${msg.ts}`,
        files: copyFiles(msg.files),
      },
    };
  }

  // app_mention
  const mention = event as SlackAppMentionEvent;
  if (mention.type !== 'app_mention') return null;
  if (mention.bot_id) return null;
  if (!mention.user || (botUserId && mention.user === botUserId)) return null;

  const rawContent = mention.text.trim();
  if (!rawContent && !hasSlackAudio(mention.files)) return null;
  const content = rawContent ? decodeSlackText(rawContent, { botUserId }) : '';

  // Reply in the existing thread, or start a thread on this mention.
  const threadTs = mention.thread_ts ?? mention.ts;
  const conversationId = buildSlackConversationId(mention.channel, threadTs, false);

  return {
    conversationId,
    channelId: 'slack',
    senderId: mention.user,
    content,
    metadata: {
      slackTs: mention.ts,
      slackChannel: mention.channel,
      threadTs,
      isDm: false,
      eventType: 'app_mention',
      dedupeKey: `${mention.channel}:${mention.ts}`,
      files: copyFiles(mention.files),
    },
  };
}

/**
 * Normalize reaction_added into a channel-agnostic reaction shape.
 * Emoji→intent mapping lives in dispatch/approval — not here.
 */
export function convertSlackReaction(
  event: SlackInboundEvent,
  botUserId: string | undefined,
): ConvertedSlackReaction | null {
  const reaction = event as SlackReactionAddedEvent;
  if (reaction.type !== 'reaction_added') return null;
  if (!reaction.user || (botUserId && reaction.user === botUserId)) return null;
  if (!reaction.reaction?.trim()) return null;
  if (!reaction.item || reaction.item.type !== 'message') return null;
  if (!reaction.item.channel || !reaction.item.ts) return null;

  const channel = reaction.item.channel;
  const targetTs = reaction.item.ts;
  const isDm = channel.startsWith('D');
  // Best-effort conversation key: for channel reactions we use the reacted
  // message's ts (may be a thread reply, not the thread root). Approval
  // correlation (#1479) must key on targetMessageId → outbound.delivered.messageId,
  // not conversationId.
  const conversationId = buildSlackConversationId(channel, isDm ? undefined : targetTs, isDm);

  return {
    conversationId,
    channelId: 'slack',
    senderId: reaction.user,
    emoji: reaction.reaction.replace(/^:|:$/g, ''),
    targetMessageId: targetTs,
    metadata: {
      slackChannel: channel,
      itemUser: reaction.item_user,
      dedupeKey: `${channel}:${targetTs}:${reaction.user}:${reaction.reaction}`,
    },
  };
}
