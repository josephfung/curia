import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted() runs before module imports (same phase as vi.mock factories),
// so these mock objects can be referenced both in the vi.mock factory below
// AND in the test body. This is the correct pattern for sharing mock state
// across the hoisting boundary.
const { mockMessages, mockDrafts } = vi.hoisted(() => {
  const mockMessages = {
    list: vi.fn(),
    find: vi.fn(),
    send: vi.fn(),
    update: vi.fn(),
  };
  const mockDrafts = { create: vi.fn() };
  return { mockMessages, mockDrafts };
});

// Mock the nylas module BEFORE importing NylasClient (vitest hoists vi.mock).
// NylasClient casts the default import as a constructor, so `default` must be
// a class. The MockNylas instance exposes the hoisted mock objects above.
vi.mock('nylas', () => {
  class MockNylas {
    messages = mockMessages;
    drafts = mockDrafts;
  }
  return { default: MockNylas };
});

import { NylasClient } from '../../../../src/channels/email/nylas-client.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

/** Minimal NylasSdkMessage-like object for mocking Nylas responses. */
function mockMsg(overrides: { folders?: string[] } = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    subject: 'Test subject',
    from: [{ name: 'Sender', email: 'sender@example.com' }],
    to: [{ email: 'ceo@example.com' }],
    cc: [],
    bcc: [],
    body: 'Body text',
    snippet: 'Body text',
    date: 1744000000,
    unread: true,
    starred: false,
    folders: overrides.folders ?? ['INBOX', 'IMPORTANT'],
    headers: undefined,
  };
}

describe('NylasClient.archiveMessage', () => {
  let client: NylasClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NylasClient('test-api-key', 'test-grant-id', logger);
  });

  it('fetches the message then updates folders with INBOX removed', async () => {
    mockMessages.find.mockResolvedValue({ data: mockMsg({ folders: ['INBOX', 'IMPORTANT'] }) });
    mockMessages.update.mockResolvedValue({ data: mockMsg({ folders: ['IMPORTANT'] }) });

    await client.archiveMessage('msg-1');

    expect(mockMessages.find).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      messageId: 'msg-1',
    });
    expect(mockMessages.update).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      messageId: 'msg-1',
      requestBody: { folders: ['IMPORTANT'] },
    });
  });

  it('archives a message that is only in INBOX (resulting in empty folder list)', async () => {
    mockMessages.find.mockResolvedValue({ data: mockMsg({ folders: ['INBOX'] }) });
    mockMessages.update.mockResolvedValue({ data: mockMsg({ folders: [] }) });

    await client.archiveMessage('msg-1');

    expect(mockMessages.update).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      messageId: 'msg-1',
      requestBody: { folders: [] },
    });
  });

  it('preserves case of non-INBOX folder labels', async () => {
    mockMessages.find.mockResolvedValue({ data: mockMsg({ folders: ['INBOX', 'Label_123', 'STARRED'] }) });
    mockMessages.update.mockResolvedValue({ data: mockMsg({ folders: ['Label_123', 'STARRED'] }) });

    await client.archiveMessage('msg-1');

    expect(mockMessages.update).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { folders: ['Label_123', 'STARRED'] },
      }),
    );
  });

  it('throws if the Nylas find call fails (no update attempted)', async () => {
    mockMessages.find.mockRejectedValue(new Error('Nylas API 404'));

    await expect(client.archiveMessage('msg-1')).rejects.toThrow('Nylas API 404');
    expect(mockMessages.update).not.toHaveBeenCalled();
  });

  it('throws if the Nylas update call fails', async () => {
    mockMessages.find.mockResolvedValue({ data: mockMsg() });
    mockMessages.update.mockRejectedValue(new Error('Nylas API 500'));

    await expect(client.archiveMessage('msg-1')).rejects.toThrow('Nylas API 500');
  });

  it('handles a message with no folders field gracefully (treats as already archived)', async () => {
    // Some Nylas providers/draft objects return messages without a folders field.
    // normalizeMessage defaults to [] in that case, so archiveMessage resolves
    // cleanly with an empty update (no INBOX to remove).
    const msgWithNoFolders = { ...mockMsg(), folders: undefined };
    mockMessages.find.mockResolvedValue({ data: msgWithNoFolders });
    mockMessages.update.mockResolvedValue({ data: mockMsg({ folders: [] }) });

    await expect(client.archiveMessage('msg-1')).resolves.toBeUndefined();
    expect(mockMessages.update).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      messageId: 'msg-1',
      requestBody: { folders: [] },
    });
  });
});
