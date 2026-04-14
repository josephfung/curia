import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMessages } = vi.hoisted(() => {
  const mockMessages = { list: vi.fn(), find: vi.fn(), send: vi.fn(), update: vi.fn() };
  return { mockMessages };
});

vi.mock('nylas', () => {
  class MockNylas {
    messages = mockMessages;
    drafts = { create: vi.fn() };
  }
  return { default: MockNylas };
});

import { NylasClient } from '../../../../src/channels/email/nylas-client.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function emptyListResponse(items: unknown[] = []) {
  return { data: items, requestId: 'req-1', nextCursor: undefined };
}

describe('NylasClient.listMessages — folder/search filters', () => {
  let client: NylasClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NylasClient('api-key', 'grant-id', logger);
    mockMessages.list.mockResolvedValue(emptyListResponse());
  });

  it('passes folders to Nylas as queryParams.in', async () => {
    await client.listMessages({ folders: ['INBOX', 'IMPORTANT'] });
    expect(mockMessages.list).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: expect.objectContaining({ in: ['INBOX', 'IMPORTANT'] }) }),
    );
  });

  it('passes from to Nylas as queryParams.from array', async () => {
    await client.listMessages({ from: 'sender@example.com' });
    expect(mockMessages.list).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: expect.objectContaining({ from: ['sender@example.com'] }) }),
    );
  });

  it('passes subject to Nylas queryParams', async () => {
    await client.listMessages({ subject: 'Meeting follow-up' });
    expect(mockMessages.list).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: expect.objectContaining({ subject: 'Meeting follow-up' }) }),
    );
  });

  it('passes searchQueryNative to Nylas queryParams', async () => {
    await client.listMessages({ searchQueryNative: 'in:inbox is:unread' });
    expect(mockMessages.list).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: expect.objectContaining({ searchQueryNative: 'in:inbox is:unread' }) }),
    );
  });

  it('omits new params from queryParams when not provided', async () => {
    await client.listMessages({ unread: true });
    const callArg = mockMessages.list.mock.calls[0]![0] as { queryParams: Record<string, unknown> };
    expect(callArg.queryParams).not.toHaveProperty('in');
    expect(callArg.queryParams).not.toHaveProperty('from');
    expect(callArg.queryParams).not.toHaveProperty('subject');
    expect(callArg.queryParams).not.toHaveProperty('searchQueryNative');
  });
});
