import { describe, it, expect } from 'vitest';
import {
  convertSlackEvent,
  buildSlackConversationId,
  parseSlackConversationId,
} from '../../../../src/channels/slack/message-converter.js';
import type { SlackAppMentionEvent, SlackMessageEvent } from '../../../../src/channels/slack/types.js';

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

  it('converts an app_mention and starts a thread on ts', () => {
    const result = convertSlackEvent(makeMention(), BOT, 'mention');
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe('slack:C999:1710000000.000200');
    expect(result!.metadata.threadTs).toBe('1710000000.000200');
    expect(result!.metadata.isDm).toBe(false);
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

  it('trims content', () => {
    const result = convertSlackEvent(makeDm({ text: '  hi  ' }), BOT, 'dm');
    expect(result!.content).toBe('hi');
  });
});
