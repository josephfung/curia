// handler.test.ts — unit tests for email-list skill.

import { describe, it, expect, vi } from 'vitest';
import { EmailListHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';
import type { NylasMessage } from '../../src/channels/email/nylas-client.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<NylasMessage>): NylasMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    subject: 'Test Subject',
    from: [{ email: 'sender@example.com', name: 'Sender' }],
    to: [{ email: 'curia@example.com', name: 'Curia' }],
    cc: [],
    bcc: [],
    body: '<p>Hello</p>',
    snippet: 'Hello preview',
    date: 1711900800,
    unread: true,
    folders: ['INBOX'],
    attachments: [],
    ...overrides,
  };
}

function makeMockGateway(messages: NylasMessage[] = [makeMessage()]) {
  return {
    listEmailMessages: vi.fn().mockResolvedValue(messages),
  } as unknown as SkillContext['outboundGateway'];
}

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: {},
    secret: () => { throw new Error('no secret in test'); },
    log: createSilentLogger(),
    outboundGateway: makeMockGateway(),
    taskMetadata: {},
    taskEventId: undefined,
    ...overrides,
  } as SkillContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailListHandler — missing capabilities', () => {
  it('returns error when outboundGateway is missing', async () => {
    const handler = new EmailListHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: undefined }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('outboundGateway');
  });
});

describe('EmailListHandler — attachment metadata', () => {
  it('returns attachmentCount: 0 and hasAttachments: false when no attachments', async () => {
    const msg = makeMessage({ attachments: [] });
    const handler = new EmailListHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: makeMockGateway([msg]) }));

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    const messages = data.messages as Array<Record<string, unknown>>;
    expect(messages[0]!.attachmentCount).toBe(0);
    expect(messages[0]!.hasAttachments).toBe(false);
  });

  it('returns attachmentCount: 2 and hasAttachments: true when 2 attachments present', async () => {
    const msg = makeMessage({
      attachments: [
        { id: 'att-1', filename: 'report.pdf', contentType: 'application/pdf', size: 1024 },
        { id: 'att-2', filename: 'photo.jpg', contentType: 'image/jpeg', size: 2048 },
      ],
    });
    const handler = new EmailListHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: makeMockGateway([msg]) }));

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    const messages = data.messages as Array<Record<string, unknown>>;
    expect(messages[0]!.attachmentCount).toBe(2);
    expect(messages[0]!.hasAttachments).toBe(true);
  });

  it('returns count matching the number of messages', async () => {
    const msgs = [makeMessage({ id: 'msg-1' }), makeMessage({ id: 'msg-2' })];
    const handler = new EmailListHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: makeMockGateway(msgs) }));

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.count).toBe(2);
  });
});

describe('EmailListHandler — standard message fields', () => {
  it('includes standard summary fields in each message', async () => {
    const handler = new EmailListHandler();
    const result = await handler.execute(makeCtx());

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    const messages = data.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({
      id: 'msg-1',
      threadId: 'thread-1',
      subject: 'Test Subject',
      snippet: 'Hello preview',
      unread: true,
      folders: ['INBOX'],
    });
  });
});

describe('EmailListHandler — unread_only with search', () => {
  it('embeds is:unread into the search string when both search and unread_only are provided', async () => {
    const gateway = makeMockGateway();
    const handler = new EmailListHandler();
    await handler.execute(makeCtx({
      outboundGateway: gateway,
      input: { search: 'to:security@example.com', unread_only: true },
    }));
    const opts = (gateway!.listEmailMessages as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // unread_only should be embedded in the search string, not passed as a separate filter
    expect(opts.searchQueryNative).toBe('to:security@example.com is:unread');
    expect(opts.unread).toBeUndefined();
  });

  it('does not add is:unread when unread_only is false', async () => {
    const gateway = makeMockGateway();
    const handler = new EmailListHandler();
    await handler.execute(makeCtx({
      outboundGateway: gateway,
      input: { search: 'to:security@example.com', unread_only: false },
    }));
    const opts = (gateway!.listEmailMessages as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(opts.searchQueryNative).toBe('to:security@example.com');
    expect(opts.unread).toBeUndefined();
  });

  it('uses native unread filter (not search string) when search is not set', async () => {
    const gateway = makeMockGateway();
    const handler = new EmailListHandler();
    await handler.execute(makeCtx({
      outboundGateway: gateway,
      input: { unread_only: true },
    }));
    const opts = (gateway!.listEmailMessages as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(opts.unread).toBe(true);
    expect(opts.searchQueryNative).toBeUndefined();
  });
});

describe('EmailListHandler — error handling', () => {
  it('returns error when gateway throws', async () => {
    const gateway = {
      listEmailMessages: vi.fn().mockRejectedValue(new Error('API failure')),
    } as unknown as SkillContext['outboundGateway'];
    const handler = new EmailListHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: gateway }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Failed to list messages');
  });
});
