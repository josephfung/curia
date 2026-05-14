// handler.test.ts — unit tests for email-get skill.

import { describe, it, expect, vi } from 'vitest';
import { EmailGetHandler } from './handler.js';
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
    snippet: 'Hello',
    date: 1711900800,
    unread: false,
    folders: ['INBOX'],
    attachments: [],
    ...overrides,
  };
}

function makeMockGateway(msg: NylasMessage = makeMessage()) {
  return {
    getEmailMessage: vi.fn().mockResolvedValue(msg),
  } as unknown as SkillContext['outboundGateway'];
}

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: { message_id: 'msg-1' },
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

describe('EmailGetHandler — missing capabilities / inputs', () => {
  it('returns error when outboundGateway is missing', async () => {
    const handler = new EmailGetHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: undefined }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('outboundGateway');
  });

  it('returns error when message_id is missing', async () => {
    const handler = new EmailGetHandler();
    const result = await handler.execute(makeCtx({ input: {} }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('message_id');
  });

  it('returns error when message_id is empty string', async () => {
    const handler = new EmailGetHandler();
    const result = await handler.execute(makeCtx({ input: { message_id: '  ' } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('message_id');
  });
});

describe('EmailGetHandler — successful fetch', () => {
  it('returns the full message fields including attachments', async () => {
    const msg = makeMessage({
      attachments: [{ id: 'att-1', filename: 'report.pdf', contentType: 'application/pdf', size: 4096 }],
    });
    const handler = new EmailGetHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: makeMockGateway(msg) }));

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.message).toMatchObject({
      id: 'msg-1',
      threadId: 'thread-1',
      subject: 'Test Subject',
      folders: ['INBOX'],
    });
    const message = data.message as Record<string, unknown>;
    expect(Array.isArray(message.attachments)).toBe(true);
    expect(message.attachments).toHaveLength(1);
    expect((message.attachments as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'att-1',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      size: 4096,
    });
  });

  it('returns empty attachments array when message has no attachments', async () => {
    const handler = new EmailGetHandler();
    const result = await handler.execute(makeCtx());

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    const message = data.message as Record<string, unknown>;
    expect(message.attachments).toEqual([]);
  });

  it('passes accountId to gateway when account is provided', async () => {
    const gateway = makeMockGateway();
    const handler = new EmailGetHandler();
    await handler.execute(makeCtx({
      input: { message_id: 'msg-99', account: 'personal' },
      outboundGateway: gateway,
    }));
    expect(gateway!.getEmailMessage).toHaveBeenCalledWith('msg-99', 'personal');
  });

  it('passes undefined accountId when account is not provided', async () => {
    const gateway = makeMockGateway();
    const handler = new EmailGetHandler();
    await handler.execute(makeCtx({ input: { message_id: 'msg-1' }, outboundGateway: gateway }));
    expect(gateway!.getEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
  });
});

describe('EmailGetHandler — error handling', () => {
  it('returns error when gateway throws', async () => {
    const gateway = {
      getEmailMessage: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as SkillContext['outboundGateway'];
    const handler = new EmailGetHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: gateway }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Failed to fetch message');
  });
});
