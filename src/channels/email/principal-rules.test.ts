import { describe, it, expect, vi } from 'vitest';
import { emailPrincipalRules, resolveEmailReplyRecipients } from './principal-rules.js';
import type { EmailSendRequest } from './outbound-request.js';

describe('emailPrincipalRules.extractRecipients', () => {
  it('projects to + cc as principal-eligible', () => {
    const request: EmailSendRequest = {
      channel: 'email',
      to: 'ceo@example.com',
      body: 'hi',
      cc: ['other@example.com', ''],
    };
    expect(emailPrincipalRules.extractRecipients(request)).toEqual([
      { identifier: 'ceo@example.com', principalEligible: true },
      { identifier: 'other@example.com', principalEligible: true },
    ]);
  });

  it('returns null for a non-email request shape (fail closed)', () => {
    expect(emailPrincipalRules.extractRecipients({
      channel: 'signal',
      recipient: '+15551234567',
      message: 'hi',
    })).toBeNull();
  });

  it('returns null when cc is a string rather than an array (fail closed)', () => {
    // A string cc would otherwise spread into char-sized "recipients".
    expect(emailPrincipalRules.extractRecipients({
      channel: 'email',
      to: 'ceo@example.com',
      body: 'hi',
      cc: 'other@example.com',
    })).toBeNull();
  });

  it('returns null when cc is a non-iterable value (fail closed)', () => {
    // A non-array/non-iterable cc would otherwise throw at the spread.
    expect(emailPrincipalRules.extractRecipients({
      channel: 'email',
      to: 'ceo@example.com',
      body: 'hi',
      cc: 42,
    })).toBeNull();
  });

  it('returns null when cc is an array containing non-strings (fail closed)', () => {
    expect(emailPrincipalRules.extractRecipients({
      channel: 'email',
      to: 'ceo@example.com',
      body: 'hi',
      cc: ['ok@example.com', 123],
    })).toBeNull();
  });
});

describe('resolveEmailReplyRecipients', () => {
  const thread = {
    from: [{ email: 'alice@example.com' }],
    to: [{ email: 'curia@example.com' }, { email: 'bob@example.com' }],
    cc: [{ email: 'carol@example.com' }],
  };

  it('reply-all derives To plus remaining participants', async () => {
    const fetchMessage = vi.fn().mockResolvedValue(thread);
    await expect(resolveEmailReplyRecipients(
      { reply_to_message_id: 'msg-1', body: 'hi' },
      { fetchMessage, selfEmails: ['curia@example.com'] },
    )).resolves.toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
    expect(fetchMessage).toHaveBeenCalledWith('msg-1');
  });

  it('sender-only (cc === "") returns just the original from', async () => {
    const fetchMessage = vi.fn().mockResolvedValue(thread);
    await expect(resolveEmailReplyRecipients(
      { reply_to_message_id: 'msg-1', body: 'hi', cc: '' },
      { fetchMessage, selfEmails: ['curia@example.com'] },
    )).resolves.toEqual(['alice@example.com']);
  });

  it('fails closed when reply_to_message_id is missing', async () => {
    const fetchMessage = vi.fn();
    await expect(resolveEmailReplyRecipients(
      { body: 'hi' },
      { fetchMessage },
    )).resolves.toBeNull();
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it('fails closed when fetchMessage throws', async () => {
    const fetchMessage = vi.fn().mockRejectedValue(new Error('nylas 404'));
    await expect(resolveEmailReplyRecipients(
      { reply_to_message_id: 'missing', body: 'hi' },
      { fetchMessage },
    )).rejects.toThrow(/nylas 404/);
  });

  it('fails closed when unmodeled to is present', async () => {
    const fetchMessage = vi.fn();
    await expect(resolveEmailReplyRecipients(
      { reply_to_message_id: 'msg-1', body: 'hi', to: 'other@example.com' },
      { fetchMessage },
    )).resolves.toBeNull();
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it('fails closed when fetchMessage is not provided', async () => {
    await expect(resolveEmailReplyRecipients(
      { reply_to_message_id: 'msg-1', body: 'hi' },
      {},
    )).resolves.toBeNull();
  });

  it('reply-all excludes every owned mailbox', async () => {
    const fetchMessage = vi.fn().mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [{ email: 'ops@example.com' }, { email: 'bob@example.com' }],
      cc: [{ email: 'curia@example.com' }],
    });
    await expect(resolveEmailReplyRecipients(
      { reply_to_message_id: 'msg-1', body: 'hi' },
      { fetchMessage, selfEmails: ['curia@example.com', 'ops@example.com'] },
    )).resolves.toEqual(['alice@example.com', 'bob@example.com']);
  });
});
