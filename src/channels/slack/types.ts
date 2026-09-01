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
  /** Hosted files (voice notes, uploads). */
  files?: SlackFile[];
}

/** Hosted Slack file metadata (voice notes use audio mimetypes). */
export interface SlackFile {
  id: string;
  mimetype?: string;
  filetype?: string;
  name?: string;
  title?: string;
  url_private?: string;
  url_private_download?: string;
  /** Byte size when Slack includes it — used to cap voice-note downloads. */
  size?: number;
  subtype?: string;
  media_display_type?: string;
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
  files?: SlackFile[];
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
