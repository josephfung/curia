import { describe, it, expect } from 'vitest';
import {
  convertSlackEvent,
  convertSlackReaction,
  buildSlackConversationId,
  parseSlackConversationId,
  slackThreadKey,
} from '../../../../src/channels/slack/message-converter.js';
import type {
  SlackAppMentionEvent,
  SlackMessageEvent,
  SlackReactionAddedEvent,
} from '../../../../src/channels/slack/types.js';

const BOT = 'U_BOT';

function makeDm(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: 'message',
    user: 'U_ALICE',
    text: 'Hello there',
    channel: 'D123',
    ts: '1710000000.000100',
    channel_type: 'im',
    ...overrides,
  };
}

function makeMention(overrides: Partial<SlackAppMentionEvent> = {}): SlackAppMentionEvent {
  return {
    type: 'app_mention',
    user: 'U_ALICE',
    text: '<@U_BOT> schedule a sync',
    channel: 'C999',
    ts: '1710000000.000200',
    ...overrides,
  };
}

describe('buildSlackConversationId / parseSlackConversationId', () => {
  it('builds and parses DM ids', () => {
    const id = buildSlackConversationId('D123', undefined, true);
    expect(id).toBe('slack:D123');
    expect(parseSlackConversationId(id)).toEqual({ channel: 'D123', isDm: true });
  });

  it('keys DM threads when thread_ts is present', () => {
    const id = buildSlackConversationId('D123', '1710000000.000050', true);
    expect(id).toBe('slack:D123:1710000000.000050');
    expect(parseSlackConversationId(id)).toEqual({
      channel: 'D123',
      threadTs: '1710000000.000050',
      isDm: true,
    });
  });

  it('builds and parses channel thread ids', () => {
    const id = buildSlackConversationId('C999', '1710000000.000200', false);
    expect(id).toBe('slack:C999:1710000000.000200');
    expect(parseSlackConversationId(id)).toEqual({
      channel: 'C999',
      threadTs: '1710000000.000200',
      isDm: false,
    });
  });

  it('returns null for non-slack ids', () => {
    expect(parseSlackConversationId('signal:+1')).toBeNull();
  });
});

describe('convertSlackEvent', () => {
  it('converts a DM message', () => {
    const result = convertSlackEvent(makeDm(), BOT, 'dm');
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe('slack:D123');
    expect(result!.senderId).toBe('U_ALICE');
    expect(result!.content).toBe('Hello there');
    expect(result!.metadata.isDm).toBe(true);
    expect(result!.metadata.eventType).toBe('message');
  });

  it('keys threaded DMs', () => {
    const result = convertSlackEvent(
      makeDm({ thread_ts: '1710000000.000050', text: 'follow-up' }),
      BOT,
      'dm',
    );
    expect(result!.conversationId).toBe('slack:D123:1710000000.000050');
  });

  it('converts an app_mention, starts a thread on ts, and strips bot mention', () => {
    const result = convertSlackEvent(makeMention(), BOT, 'mention');
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe('slack:C999:1710000000.000200');
    expect(result!.metadata.threadTs).toBe('1710000000.000200');
    expect(result!.metadata.isDm).toBe(false);
    expect(result!.content).toBe('schedule a sync');
  });

  it('uses existing thread_ts for mentions inside a thread', () => {
    const result = convertSlackEvent(
      makeMention({ thread_ts: '1710000000.000050', ts: '1710000000.000300' }),
      BOT,
      'mention',
    );
    expect(result!.conversationId).toBe('slack:C999:1710000000.000050');
    expect(result!.metadata.threadTs).toBe('1710000000.000050');
  });

  it('delivers channel thread replies only when the thread is active', () => {
    const active = new Set([slackThreadKey('C999', '1710000000.000050')]);
    const result = convertSlackEvent(
      {
        type: 'message',
        user: 'U_ALICE',
        text: 'and make it 4pm',
        channel: 'C999',
        ts: '1710000000.000400',
        thread_ts: '1710000000.000050',
        channel_type: 'channel',
      },
      BOT,
      'thread',
      active,
    );
    expect(result).not.toBeNull();
    expect(result!.metadata.eventType).toBe('thread_reply');
    expect(result!.conversationId).toBe('slack:C999:1710000000.000050');
  });

  it('ignores channel thread replies outside active threads', () => {
    expect(
      convertSlackEvent(
        {
          type: 'message',
          user: 'U_ALICE',
          text: 'noise',
          channel: 'C999',
          ts: '1710000000.000400',
          thread_ts: '1710000000.000050',
          channel_type: 'channel',
        },
        BOT,
        'thread',
        new Set(),
      ),
    ).toBeNull();
  });

  it('ignores bot messages', () => {
    expect(convertSlackEvent(makeDm({ bot_id: 'B1' }), BOT, 'dm')).toBeNull();
  });

  it('ignores own bot user id', () => {
    expect(convertSlackEvent(makeDm({ user: BOT }), BOT, 'dm')).toBeNull();
  });

  it('ignores message subtypes', () => {
    expect(convertSlackEvent(makeDm({ subtype: 'message_changed' }), BOT, 'dm')).toBeNull();
  });

  it('ignores non-IM channel messages on the dm path', () => {
    expect(
      convertSlackEvent(makeDm({ channel: 'C999', channel_type: 'channel' }), BOT, 'dm'),
    ).toBeNull();
  });

  it('ignores empty text', () => {
    expect(convertSlackEvent(makeDm({ text: '   ' }), BOT, 'dm')).toBeNull();
  });

  it('decodes Slack entities in content', () => {
    const result = convertSlackEvent(
      makeDm({ text: 'see <https://example.com|docs> &amp; <@U9|bob>' }),
      BOT,
      'dm',
    );
    expect(result!.content).toBe('see docs & @bob');
  });
});

describe('convertSlackReaction', () => {
  it('normalizes reaction_added without mapping intent', () => {
    const event: SlackReactionAddedEvent = {
      type: 'reaction_added',
      user: 'U_ALICE',
      reaction: 'thumbsup',
      item: { type: 'message', channel: 'C999', ts: '1710000000.000200' },
    };
    const result = convertSlackReaction(event, BOT);
    expect(result).toEqual(
      expect.objectContaining({
        senderId: 'U_ALICE',
        emoji: 'thumbsup',
        targetMessageId: '1710000000.000200',
        channelId: 'slack',
      }),
    );
  });

  it('ignores reactions from the bot', () => {
    expect(
      convertSlackReaction(
        {
          type: 'reaction_added',
          user: BOT,
          reaction: '+1',
          item: { type: 'message', channel: 'D1', ts: '1.1' },
        },
        BOT,
      ),
    ).toBeNull();
  });
});
