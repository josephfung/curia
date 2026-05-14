// handler.test.ts — unit tests for email-download-attachment skill.

import { describe, it, expect, vi } from 'vitest';
import { EmailDownloadAttachmentHandler } from './handler.js';
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
    attachments: [
      { id: 'att-1', filename: 'report.pdf', contentType: 'application/pdf', size: 4096 },
    ],
    ...overrides,
  };
}

interface GatewayOverrides {
  getEmailMessage?: ReturnType<typeof vi.fn>;
  downloadEmailAttachment?: ReturnType<typeof vi.fn>;
}

function makeMockGateway(overrides?: GatewayOverrides) {
  return {
    getEmailMessage: overrides?.getEmailMessage
      ?? vi.fn().mockResolvedValue(makeMessage()),
    downloadEmailAttachment: overrides?.downloadEmailAttachment
      ?? vi.fn().mockResolvedValue(Buffer.from('PDF content here')),
  } as unknown as SkillContext['outboundGateway'];
}

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: { attachment_id: 'att-1', message_id: 'msg-1' },
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

describe('EmailDownloadAttachmentHandler — validation', () => {
  it('returns error when outboundGateway is missing', async () => {
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: undefined }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('outboundGateway');
  });

  it('returns error when attachment_id is missing', async () => {
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({ input: { message_id: 'msg-1' } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('attachment_id');
  });

  it('returns error when attachment_id is empty string', async () => {
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({ input: { attachment_id: '  ', message_id: 'msg-1' } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('attachment_id');
  });

  it('returns error when message_id is missing', async () => {
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({ input: { attachment_id: 'att-1' } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('message_id');
  });

  it('returns error when message_id is empty string', async () => {
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({ input: { attachment_id: 'att-1', message_id: '  ' } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('message_id');
  });
});

describe('EmailDownloadAttachmentHandler — attachment verification', () => {
  it('returns error when attachment ID is not found on the message', async () => {
    // Message has att-1; we request att-9 which does not exist.
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({
      input: { attachment_id: 'att-9', message_id: 'msg-1' },
    }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('att-9');
    expect((result as { error: string }).error).toContain('msg-1');
  });

  it('returns error when attachment size exceeds 10 MB limit', async () => {
    const oversizedMsg = makeMessage({
      attachments: [{
        id: 'att-big',
        filename: 'huge.zip',
        contentType: 'application/zip',
        // 11 MB — above the 10 MB limit
        size: 11 * 1024 * 1024,
      }],
    });
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({
      input: { attachment_id: 'att-big', message_id: 'msg-1' },
      outboundGateway: makeMockGateway({ getEmailMessage: vi.fn().mockResolvedValue(oversizedMsg) }),
    }));
    expect(result.success).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('11.0 MB');
    expect(error).toContain('10 MB');
  });

  it('returns error when getEmailMessage throws', async () => {
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({
      outboundGateway: makeMockGateway({
        getEmailMessage: vi.fn().mockRejectedValue(new Error('Message not found')),
      }),
    }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Failed to fetch message');
  });
});

describe('EmailDownloadAttachmentHandler — successful download', () => {
  it('returns base64 content, filename, content_type, and size on success', async () => {
    const content = Buffer.from('Hello PDF');
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({
      outboundGateway: makeMockGateway({
        downloadEmailAttachment: vi.fn().mockResolvedValue(content),
      }),
    }));

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.content_base64).toBe(content.toString('base64'));
    expect(data.filename).toBe('report.pdf');
    expect(data.content_type).toBe('application/pdf');
    expect(data.size).toBe(content.length);
  });

  it('returns error when downloadEmailAttachment throws', async () => {
    const handler = new EmailDownloadAttachmentHandler();
    const result = await handler.execute(makeCtx({
      outboundGateway: makeMockGateway({
        downloadEmailAttachment: vi.fn().mockRejectedValue(new Error('Download failed')),
      }),
    }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Failed to download attachment');
  });

  it('passes accountId to gateway methods when account is provided', async () => {
    const gateway = makeMockGateway();
    const handler = new EmailDownloadAttachmentHandler();
    await handler.execute(makeCtx({
      input: { attachment_id: 'att-1', message_id: 'msg-1', account: 'personal' },
      outboundGateway: gateway,
    }));
    expect(gateway!.getEmailMessage).toHaveBeenCalledWith('msg-1', 'personal');
    expect(gateway!.downloadEmailAttachment).toHaveBeenCalledWith('att-1', 'msg-1', 'personal');
  });

  it('passes undefined accountId when account is not provided', async () => {
    const gateway = makeMockGateway();
    const handler = new EmailDownloadAttachmentHandler();
    await handler.execute(makeCtx({ outboundGateway: gateway }));
    expect(gateway!.getEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
    expect(gateway!.downloadEmailAttachment).toHaveBeenCalledWith('att-1', 'msg-1', undefined);
  });
});
