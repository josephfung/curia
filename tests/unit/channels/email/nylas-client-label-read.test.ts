import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMessages, mockFolders } = vi.hoisted(() => {
  const mockMessages = {
    list: vi.fn(),
    find: vi.fn(),
    send: vi.fn(),
    update: vi.fn(),
  };
  const mockFolders = {
    list: vi.fn(),
    create: vi.fn(),
  };
  return { mockMessages, mockFolders };
});

vi.mock('nylas', () => {
  class MockNylas {
    messages = mockMessages;
    drafts = { create: vi.fn() };
    folders = mockFolders;
  }
  return { default: MockNylas };
});

import { NylasClient } from '../../../../src/channels/email/nylas-client.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function mockMsg(overrides: { folders?: string[]; unread?: boolean } = {}) {
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
    unread: overrides.unread ?? true,
    starred: false,
    folders: overrides.folders ?? ['INBOX'],
    headers: undefined,
  };
}

describe('NylasClient.markAsRead', () => {
  let client: NylasClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NylasClient('test-api-key', 'test-grant-id', logger);
  });

  it('calls messages.update with unread: false', async () => {
    mockMessages.update.mockResolvedValue({ data: mockMsg({ unread: false }) });

    await client.markAsRead('msg-1');

    expect(mockMessages.update).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      messageId: 'msg-1',
      requestBody: { unread: false },
    });
  });

  it('throws if the Nylas update call fails', async () => {
    mockMessages.update.mockRejectedValue(new Error('Nylas API 500'));

    await expect(client.markAsRead('msg-1')).rejects.toThrow('Nylas API 500');
  });
});

describe('NylasClient.listFolders', () => {
  let client: NylasClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NylasClient('test-api-key', 'test-grant-id', logger);
  });

  it('returns normalized folder objects', async () => {
    mockFolders.list.mockResolvedValue({
      data: [
        { id: 'folder-1', name: 'INBOX', object: 'folder', grantId: 'test-grant-id' },
        { id: 'folder-2', name: 'SECURITY', object: 'folder', grantId: 'test-grant-id' },
      ],
    });

    const folders = await client.listFolders();

    expect(folders).toEqual([
      { id: 'folder-1', name: 'INBOX' },
      { id: 'folder-2', name: 'SECURITY' },
    ]);
    expect(mockFolders.list).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
    });
  });

  it('throws if the Nylas API call fails', async () => {
    mockFolders.list.mockRejectedValue(new Error('Nylas API 403'));

    await expect(client.listFolders()).rejects.toThrow('Nylas API 403');
  });
});

describe('NylasClient.createFolder', () => {
  let client: NylasClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NylasClient('test-api-key', 'test-grant-id', logger);
  });

  it('creates a folder and returns the normalized result', async () => {
    mockFolders.create.mockResolvedValue({
      data: { id: 'folder-new', name: 'SECURITY', object: 'folder', grantId: 'test-grant-id' },
    });

    const folder = await client.createFolder('SECURITY');

    expect(folder).toEqual({ id: 'folder-new', name: 'SECURITY' });
    expect(mockFolders.create).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      requestBody: { name: 'SECURITY' },
    });
  });

  it('throws if the Nylas API call fails', async () => {
    mockFolders.create.mockRejectedValue(new Error('Nylas API 409'));

    await expect(client.createFolder('DUPLICATE')).rejects.toThrow('Nylas API 409');
  });
});

describe('NylasClient.updateMessageFolders', () => {
  let client: NylasClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NylasClient('test-api-key', 'test-grant-id', logger);
  });

  it('updates the message folder list and returns normalized message', async () => {
    const updatedFolders = ['INBOX', 'folder-security'];
    mockMessages.update.mockResolvedValue({ data: mockMsg({ folders: updatedFolders }) });

    const result = await client.updateMessageFolders('msg-1', updatedFolders);

    expect(result.folders).toEqual(updatedFolders);
    expect(mockMessages.update).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      messageId: 'msg-1',
      requestBody: { folders: updatedFolders },
    });
  });

  it('throws if the Nylas update call fails', async () => {
    mockMessages.update.mockRejectedValue(new Error('Nylas API 500'));

    await expect(client.updateMessageFolders('msg-1', ['INBOX'])).rejects.toThrow('Nylas API 500');
  });
});
