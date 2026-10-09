// The gateway's email mutation paths over a real NylasClient, with only the SDK
// mocked (#2083): folder paging and caching, 404 wording, and the call budget.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMessages, mockFolders } = vi.hoisted(() => ({
  mockMessages: { list: vi.fn(), find: vi.fn(), send: vi.fn(), update: vi.fn() },
  mockFolders: { list: vi.fn(), create: vi.fn() },
}));

vi.mock('nylas', () => {
  class MockNylas {
    messages = mockMessages;
    drafts = { create: vi.fn() };
    folders = mockFolders;
  }
  return { default: MockNylas };
});

import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { NylasClient } from '../../../src/channels/email/nylas-client.js';
import { createLogger } from '../../../src/logger.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';

const logger = createLogger('error');

function makeGateway(): OutboundGateway {
  return new OutboundGateway({
    nylasClients: new Map([['curia', new NylasClient('key', 'grant-1', logger)]]),
    contactService: { resolveByChannelIdentity: vi.fn() } as unknown as ContactService,
    contentFilter: { check: vi.fn() } as unknown as OutboundContentFilter,
    bus: { publish: vi.fn(), subscribe: vi.fn() } as unknown as EventBus,
    principalIdentities: [],
    logger,
  });
}

function message(folders: string[]) {
  return { data: { id: 'msg-1', folders, date: 1744000000 } };
}

// The SDK's NylasApiError carries the HTTP status as statusCode.
function sdkError(statusCode: number): Error {
  return Object.assign(new Error(`Nylas API ${statusCode}`), { statusCode });
}

describe('OutboundGateway.labelEmailMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Page 1 holds system folders; the label lives on page 2.
    mockFolders.list.mockImplementation(async (params: { queryParams?: { pageToken?: string } }) =>
      params.queryParams?.pageToken === 'page-2'
        ? { data: [{ id: 'Label_7', name: 'Receipts' }] }
        : { data: [{ id: 'INBOX', name: 'INBOX' }, { id: 'SENT', name: 'SENT' }], nextCursor: 'page-2' },
    );
    mockMessages.find.mockResolvedValue(message(['INBOX']));
    mockMessages.update.mockResolvedValue(message(['INBOX', 'Label_7']));
  });

  it('resolves a label on page 2 without creating a duplicate', async () => {
    const result = await makeGateway().labelEmailMessage('msg-1', ['Receipts']);

    expect(result).toMatchObject({ success: true, created: [] });
    expect(mockFolders.create).not.toHaveBeenCalled();
    expect(mockMessages.update).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: { folders: ['INBOX', 'Label_7'] } }),
    );
  });

  it('lists folders once for two label calls within the cache window', async () => {
    const gateway = makeGateway();
    await gateway.labelEmailMessage('msg-1', ['Receipts']);
    await gateway.labelEmailMessage('msg-2', ['Receipts']);

    // Two pages for the first call, none for the second.
    expect(mockFolders.list).toHaveBeenCalledTimes(2);
  });

  it('lists again after creating a label', async () => {
    mockFolders.create.mockResolvedValue({ data: { id: 'Label_9', name: 'New' } });
    const gateway = makeGateway();
    await gateway.labelEmailMessage('msg-1', ['New']);
    await gateway.labelEmailMessage('msg-1', ['Receipts']);

    expect(mockFolders.list).toHaveBeenCalledTimes(4);
  });

  it('tells the agent not to retry an ID Nylas does not have', async () => {
    mockMessages.find.mockRejectedValue(sdkError(404));

    const result = await makeGateway().labelEmailMessage('msg-1', ['Receipts']);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('NOT_FOUND');
    expect(result.error).toMatch(/Message not found.*Do not retry with this ID/);
  });

  it('does not blame the message for a 404 from the folder listing', async () => {
    mockFolders.list.mockRejectedValue(sdkError(404));

    const result = await makeGateway().labelEmailMessage('msg-1', ['Receipts']);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Label operation failed: Nylas API 404');
    expect(result.error).not.toMatch(/Message not found/);
  });

  it('caps each SDK request at the time the tool call has left', async () => {
    await makeGateway().labelEmailMessage('msg-1', ['Receipts'], undefined, { deadline: Date.now() + 5_000 });

    const timeout = mockMessages.update.mock.calls[0]![0].overrides.timeout as number;
    expect(timeout).toBeGreaterThan(4_000);
    expect(timeout).toBeLessThanOrEqual(5_000);
  });

  it('sends no write once the tool call has timed out', async () => {
    const abort = new AbortController();
    // The read comes back after the timeout fired.
    mockMessages.find.mockImplementation(async () => {
      abort.abort();
      return message(['INBOX']);
    });

    const result = await makeGateway().labelEmailMessage('msg-1', ['Receipts'], undefined, { signal: abort.signal });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled because the tool call timed out/);
    expect(mockMessages.update).not.toHaveBeenCalled();
  });
});

describe('OutboundGateway.archiveEmailMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a 404 as message not found instead of a bare failure', async () => {
    mockMessages.find.mockRejectedValue(sdkError(404));

    const result = await makeGateway().archiveEmailMessage('msg-1');

    expect(result).toMatchObject({ success: false, errorType: 'NOT_FOUND' });
    expect(result.error).toMatch(/Do not retry with this ID/);
  });

  it('sends no write once the tool call has timed out', async () => {
    const abort = new AbortController();
    mockMessages.find.mockImplementation(async () => {
      abort.abort();
      return message(['INBOX']);
    });

    const result = await makeGateway().archiveEmailMessage('msg-1', undefined, { signal: abort.signal });

    expect(result.success).toBe(false);
    expect(mockMessages.update).not.toHaveBeenCalled();
  });
});
