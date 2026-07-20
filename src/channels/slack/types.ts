// src/channels/slack/types.ts
// Wire types for Slack Events API payloads we care about (Socket Mode).

/** Minimal Slack message event fields used by the converter. */
export interface SlackMessageEvent {
  type: 'message';
  user?: string;
  text?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  /** Present on message events: 'im' | 'channel' | 'group' | 'mpim' | … */
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
  /** True when Slack marks the message as from a bot user. */
  bot_profile?: unknown;
}

/** app_mention event payload. */
export interface SlackAppMentionEvent {
  type: 'app_mention';
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

/** reaction_added event payload (emoji → intent is NOT decided here). */
export interface SlackReactionAddedEvent {
  type: 'reaction_added';
  user: string;
  reaction: string;
  item_user?: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
  event_ts?: string;
}

export type SlackInboundEvent =
  | SlackMessageEvent
  | SlackAppMentionEvent
  | SlackReactionAddedEvent;

export type SlackInboundKind = 'dm' | 'mention' | 'thread' | 'reaction';

export interface SlackAuthIdentity {
  /** Bot user id (U…) — used to ignore own messages. */
  botUserId: string;
  /** Team / workspace id when available. */
  teamId?: string;
  /** Human-readable bot/user name from auth.test (not used as @handle). */
  botName?: string;
}

export interface SlackPostMessageParams {
  channel: string;
  text: string;
  threadTs?: string;
}

export interface SlackPostMessageResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

export interface SlackUserInfo {
  id: string;
  displayName: string;
}
