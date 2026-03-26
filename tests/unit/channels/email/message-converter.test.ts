import { describe, it, expect } from 'vitest';
import { convertNylasMessage } from '../../../../src/channels/email/message-converter.js';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';

// ---------------------------------------------------------------------------
// Test fixture factory — produces a fully-populated NylasMessage; individual
// tests override only the fields they care about.
// ---------------------------------------------------------------------------

function mockMessage(overrides?: Partial<NylasMessage>): NylasMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    subject: 'Test Subject',
    from: [{ email: 'sender@example.com', name: 'Sender' }],
    to: [{ email: 'nathan@curia.com', name: 'Nathan Curia' }],
    cc: [],
    bcc: [],
    body: '<p>Hello world</p>',
    snippet: 'Hello world',
    date: 1711900800, // 2024-03-31T12:00:00Z
    unread: true,
    folders: ['inbox'],
    ...overrides,
  };
}

describe('convertNylasMessage', () => {
  it('sets conversationId from thread ID with "email:" prefix', () => {
    const result = convertNylasMessage(mockMessage({ threadId: 'thread-abc' }));
    expect(result.conversationId).toBe('email:thread-abc');
  });

  it('sets channelId to "email"', () => {
    const result = convertNylasMessage(mockMessage());
    expect(result.channelId).toBe('email');
  });

  it('sets senderId to the first from address', () => {
    const result = convertNylasMessage(mockMessage({
      from: [{ email: 'alice@example.com', name: 'Alice' }],
    }));
    expect(result.senderId).toBe('alice@example.com');
  });

  it('falls back to "unknown" when from array is empty', () => {
    const result = convertNylasMessage(mockMessage({ from: [] }));
    expect(result.senderId).toBe('unknown');
  });

  it('converts HTML body to plain text via htmlToText', () => {
    const result = convertNylasMessage(mockMessage({ body: '<p>Hello world</p>' }));
    // htmlToText should strip the <p> tags
    expect(result.content).toContain('Hello world');
    expect(result.content).not.toContain('<p>');
  });

  it('falls back to snippet when body is empty string', () => {
    const result = convertNylasMessage(mockMessage({
      body: '',
      snippet: 'Preview text here',
    }));
    expect(result.content).toContain('Preview text here');
  });

  it('falls back to "(empty email)" when both body and snippet are empty', () => {
    const result = convertNylasMessage(mockMessage({ body: '', snippet: '' }));
    expect(result.content).toContain('(empty email)');
  });

  it('prepends "Subject: <subject>" to the content', () => {
    const result = convertNylasMessage(mockMessage({ subject: 'My Subject' }));
    expect(result.content).toMatch(/^Subject: My Subject\n\n/);
  });

  it('stores the correct subject in metadata', () => {
    const result = convertNylasMessage(mockMessage({ subject: 'Quarterly Review' }));
    expect(result.metadata.subject).toBe('Quarterly Review');
  });

  it('stores nylasMessageId in metadata', () => {
    const result = convertNylasMessage(mockMessage({ id: 'msg-xyz-123' }));
    expect(result.metadata.nylasMessageId).toBe('msg-xyz-123');
  });

  it('stores nylasThreadId in metadata', () => {
    const result = convertNylasMessage(mockMessage({ threadId: 'thread-xyz' }));
    expect(result.metadata.nylasThreadId).toBe('thread-xyz');
  });

  it('converts unix timestamp to a Date in receivedAt', () => {
    // 1711900800 = 2024-03-31T12:00:00.000Z
    const result = convertNylasMessage(mockMessage({ date: 1711900800 }));
    expect(result.metadata.receivedAt).toBeInstanceOf(Date);
    expect(result.metadata.receivedAt.getTime()).toBe(1711900800 * 1000);
  });

  it('extracts all from participants with role "from"', () => {
    const result = convertNylasMessage(mockMessage({
      from: [{ email: 'sender@example.com', name: 'Sender' }],
    }));
    const fromParticipants = result.metadata.participants.filter(p => p.role === 'from');
    expect(fromParticipants).toHaveLength(1);
    expect(fromParticipants[0]).toMatchObject({
      email: 'sender@example.com',
      name: 'Sender',
      role: 'from',
    });
  });

  it('extracts all to participants with role "to"', () => {
    const result = convertNylasMessage(mockMessage({
      to: [
        { email: 'alice@curia.com', name: 'Alice' },
        { email: 'bob@curia.com', name: 'Bob' },
      ],
    }));
    const toParticipants = result.metadata.participants.filter(p => p.role === 'to');
    expect(toParticipants).toHaveLength(2);
    expect(toParticipants[0]).toMatchObject({ email: 'alice@curia.com', role: 'to' });
    expect(toParticipants[1]).toMatchObject({ email: 'bob@curia.com', role: 'to' });
  });

  it('extracts cc participants with role "cc"', () => {
    const result = convertNylasMessage(mockMessage({
      cc: [{ email: 'cc@example.com', name: 'CC Person' }],
    }));
    const ccParticipants = result.metadata.participants.filter(p => p.role === 'cc');
    expect(ccParticipants).toHaveLength(1);
    expect(ccParticipants[0]).toMatchObject({
      email: 'cc@example.com',
      name: 'CC Person',
      role: 'cc',
    });
  });

  it('handles messages with no CC (empty cc array)', () => {
    const result = convertNylasMessage(mockMessage({ cc: [] }));
    const ccParticipants = result.metadata.participants.filter(p => p.role === 'cc');
    expect(ccParticipants).toHaveLength(0);
  });

  it('includes all participant types together in the right order', () => {
    const result = convertNylasMessage(mockMessage({
      from: [{ email: 'sender@example.com', name: 'Sender' }],
      to: [{ email: 'to@example.com', name: 'To' }],
      cc: [{ email: 'cc@example.com', name: 'CC' }],
    }));
    // from comes first, then to, then cc
    expect(result.metadata.participants[0].role).toBe('from');
    expect(result.metadata.participants[1].role).toBe('to');
    expect(result.metadata.participants[2].role).toBe('cc');
    expect(result.metadata.participants).toHaveLength(3);
  });

  it('handles participants without a name (name is optional)', () => {
    const result = convertNylasMessage(mockMessage({
      from: [{ email: 'noreply@example.com' }],
    }));
    const fromParticipant = result.metadata.participants.find(p => p.role === 'from');
    expect(fromParticipant?.email).toBe('noreply@example.com');
    // name may be undefined — that's acceptable
    expect(fromParticipant?.name).toBeUndefined();
  });
});
