// handler.test.ts — unit tests for email-get-thread skill.

import { describe, it, expect, vi } from 'vitest';
import { EmailGetThreadHandler, THREAD_MESSAGE_LIMIT } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';
import { UnknownEmailAccountError } from '../../../../src/skills/outbound-gateway.js';

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
    snippet: 'Hello',
    date: 1711900800,
    unread: false,
    folders: ['INBOX'],
    attachments: [],
    ...overrides,
  };
}

function makeMockGateway(listEmailMessages: ReturnType<typeof vi.fn>) {
  return { listEmailMessages } as unknown as ToolContext['outboundGateway'];
}

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    input: { thread_id: 'thread-1' },
    secret: () => { throw new Error('no secret in test'); },
    log: createSilentLogger(),
    outboundGateway: makeMockGateway(vi.fn().mockResolvedValue([makeMessage()])),
    taskMetadata: {},
    taskEventId: undefined,
    ...overrides,
  } as ToolContext;
}

type ThreadData = {
  threadId: string;
  messages: Array<Record<string, unknown>>;
  count: number;
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailGetThreadHandler — missing capabilities / inputs', () => {
  it('returns error when outboundGateway is missing', async () => {
    const result = await new EmailGetThreadHandler().execute(makeCtx({ outboundGateway: undefined }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('outboundGateway');
  });

  it.each([
    ['missing', {}],
    ['blank', { thread_id: '   ' }],
    ['non-string', { thread_id: 42 }],
  ])('returns error when thread_id is %s', async (_label, input) => {
    const list = vi.fn();
    const result = await new EmailGetThreadHandler().execute(
      makeCtx({ input, outboundGateway: makeMockGateway(list) }),
    );
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('thread_id');
    expect(list).not.toHaveBeenCalled();
  });

  it('does not throw when input is not an object', async () => {
    const result = await new EmailGetThreadHandler().execute(
      makeCtx({ input: null as unknown as Record<string, unknown> }),
    );
    expect(result.success).toBe(false);
  });
});

describe('EmailGetThreadHandler — successful fetch', () => {
  it('lists by thread id with the thread cap and returns every message with its body', async () => {
    const list = vi.fn().mockResolvedValue([
      makeMessage({ id: 'msg-2', body: '<p>Second</p>', date: 1711900900 }),
      makeMessage({ id: 'msg-1', body: '<p>First</p>', date: 1711900800 }),
    ]);
    const result = await new EmailGetThreadHandler().execute(
      makeCtx({ input: { thread_id: ' thread-1 ' }, outboundGateway: makeMockGateway(list) }),
    );

    expect(result.success).toBe(true);
    // The thread id is trimmed, and only threadId + limit are sent. A folder or
    // unread filter would hide part of the thread.
    expect(list).toHaveBeenCalledWith({ threadId: 'thread-1', limit: THREAD_MESSAGE_LIMIT }, undefined);

    const data = (result as { data: ThreadData }).data;
    expect(data.threadId).toBe('thread-1');
    expect(data.count).toBe(2);
    expect(data.truncated).toBe(false);
    expect(data.messages.map((m) => m['body'])).toEqual(['<p>First</p>', '<p>Second</p>']);
  });

  it('returns messages oldest-first, since Nylas lists newest-first', async () => {
    const list = vi.fn().mockResolvedValue([
      makeMessage({ id: 'msg-3', date: 300 }),
      makeMessage({ id: 'msg-1', date: 100 }),
      makeMessage({ id: 'msg-2', date: 200 }),
    ]);
    const result = await new EmailGetThreadHandler().execute(makeCtx({ outboundGateway: makeMockGateway(list) }));
    const data = (result as { data: ThreadData }).data;
    expect(data.messages.map((m) => m['id'])).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('returns the same per-message fields as email-get', async () => {
    const msg = makeMessage({
      cc: [{ email: 'cc@example.com' }],
      unread: true,
      attachments: [{ id: 'att-1', filename: 'report.pdf', contentType: 'application/pdf', size: 4096 }],
    });
    const result = await new EmailGetThreadHandler().execute(
      makeCtx({ outboundGateway: makeMockGateway(vi.fn().mockResolvedValue([msg])) }),
    );
    const data = (result as { data: ThreadData }).data;
    expect(data.messages[0]).toEqual({
      id: msg.id,
      threadId: msg.threadId,
      subject: msg.subject,
      from: msg.from,
      to: msg.to,
      cc: msg.cc,
      body: msg.body,
      date: msg.date,
      unread: msg.unread,
      folders: msg.folders,
      attachments: msg.attachments,
    });
  });

  it('flags truncated when the thread fills the cap, so dropped older messages are not silent', async () => {
    const full = Array.from({ length: THREAD_MESSAGE_LIMIT }, (_, i) =>
      makeMessage({ id: `msg-${i}`, date: THREAD_MESSAGE_LIMIT - i }),
    );
    const result = await new EmailGetThreadHandler().execute(
      makeCtx({ outboundGateway: makeMockGateway(vi.fn().mockResolvedValue(full)) }),
    );
    const data = (result as { data: ThreadData }).data;
    expect(data.count).toBe(THREAD_MESSAGE_LIMIT);
    expect(data.truncated).toBe(true);
  });
});

describe('EmailGetThreadHandler — account routing', () => {
  it('passes a trimmed account to the gateway', async () => {
    const list = vi.fn().mockResolvedValue([makeMessage()]);
    await new EmailGetThreadHandler().execute(
      makeCtx({ input: { thread_id: 'thread-1', account: ' ceo ' }, outboundGateway: makeMockGateway(list) }),
    );
    expect(list).toHaveBeenCalledWith(expect.anything(), 'ceo');
  });

  it('treats a blank account as the primary mailbox', async () => {
    const list = vi.fn().mockResolvedValue([makeMessage()]);
    await new EmailGetThreadHandler().execute(
      makeCtx({ input: { thread_id: 'thread-1', account: '  ' }, outboundGateway: makeMockGateway(list) }),
    );
    expect(list).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('surfaces an unknown account by name and lists the configured ones', async () => {
    const list = vi.fn().mockRejectedValue(new UnknownEmailAccountError('typo', ['curia', 'ceo']));
    const result = await new EmailGetThreadHandler().execute(
      makeCtx({ input: { thread_id: 'thread-1', account: 'typo' }, outboundGateway: makeMockGateway(list) }),
    );
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toBe("unknown account 'typo'; available: [curia, ceo]");
  });
});

describe('EmailGetThreadHandler — failures', () => {
  it('returns an error, not an empty success, when the thread has no messages', async () => {
    // An empty success reads as "the thread is empty", and agents loop on silent
    // empties. A wrong id or wrong mailbox is the realistic cause, so say that.
    const result = await new EmailGetThreadHandler().execute(
      makeCtx({ outboundGateway: makeMockGateway(vi.fn().mockResolvedValue([])) }),
    );
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('thread-1');
    expect((result as { error: string }).error).toContain('account');
  });

  it('returns a generic error when the gateway throws', async () => {
    const result = await new EmailGetThreadHandler().execute(
      makeCtx({ outboundGateway: makeMockGateway(vi.fn().mockRejectedValue(new Error('Nylas 500'))) }),
    );
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toBe('Failed to fetch thread');
  });
});
