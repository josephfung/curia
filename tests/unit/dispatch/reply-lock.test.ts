import { describe, it, expect } from 'vitest';
import {
  replyLockConversationMatch,
  replyLockEmailRecipients,
  replyLockRecipientMatches,
  replyLockRecipients,
} from '../../../src/dispatch/reply-lock.js';

describe('reply-lock recipients (#1860)', () => {
  it('reads email to and signal delivered_to', () => {
    expect(replyLockRecipients('email-send', { to: 'A@Example.com, ops@example.com' })).toEqual([
      'a@example.com',
      'ops@example.com',
    ]);
    expect(replyLockRecipients('signal-send', { delivered_to: '+15551212', channel: 'signal' })).toEqual(['+15551212']);
    expect(replyLockRecipients('sms-send', { delivered_to: '+15550000' })).toEqual(['+15550000']);
    expect(replyLockRecipients('slack-send', { delivered_to: 'U123' })).toEqual(['u123']);
  });

  it('returns null when a locking skill omits the recipient', () => {
    expect(replyLockRecipients('email-reply', { message_id: 'm1' })).toBeNull();
    expect(replyLockRecipients('signal-send', { channel: 'signal' })).toBeNull();
  });

  it('keeps correspondence elevation on email addresses only', () => {
    expect(replyLockEmailRecipients('email-send', ['a@example.com'])).toEqual(['a@example.com']);
    expect(replyLockEmailRecipients('signal-send', ['+15551212'])).toEqual([]);
  });

  it('matches the inbound sender or another verified identity', () => {
    expect(replyLockRecipientMatches('ceo@example.com', ['ceo@example.com'])).toBe(true);
    expect(replyLockRecipientMatches('ceo@example.com', ['+15551212'])).toBe(false);
    expect(replyLockRecipientMatches('ceo@example.com', ['+15551212'], ['+15551212'])).toBe(true);
    expect(replyLockRecipientMatches('ceo@example.com', ['+1999'], ['+15551212'])).toBe(false);
  });

  it('matches a specialist send via the originating conversation', () => {
    expect(replyLockConversationMatch('signal:+15551212', 'delegate-abc', 'signal:+15551212')).toBe(true);
    expect(replyLockConversationMatch('signal:+15551212', 'delegate-abc', undefined)).toBe(false);
    expect(replyLockConversationMatch('signal:+15551212', 'signal:+15551212', undefined)).toBe(true);
  });
});
