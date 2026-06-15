import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxReadHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function buildCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret(key: string): string {
      switch (key) {
        case 'nylas_api_key': return 'test-api-key';
        case 'ceo_nylas_grant_id': return 'test-grant-id';
        default: throw new Error(`unknown secret: ${key}`);
      }
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as SkillContext;
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe('CeoInboxReadHandler', () => {
  let handler: CeoInboxReadHandler;
  let mockFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handler = new CeoInboxReadHandler();
    mockFetch = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  describe('message path', () => {
    it('reads a message by message_id and returns plain + HTML body', async () => {
      mockFetch.mockResolvedValue(jsonResponse({
        id: 'm1',
        thread_id: 't1',
        from: [{ email: 'alice@example.com', name: 'Alice' }],
        to: [{ email: 'ceo@example.com' }],
        cc: [],
        subject: 'Hello',
        body: '<p>Hi there</p>',
        date: 1_700_000_000,
        folders: ['INBOX'],
        attachments: [],
      }));

      const result = await handler.execute(buildCtx({ message_id: 'm1' }));

      expect(result.success).toBe(true);
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data.id).toBe('m1');
      expect(data.body_plain).toContain('Hi there');
      expect(data.body_html).toBe('<p>Hi there</p>');
      // hit /messages, not /drafts
      const url = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(url.pathname.endsWith('/messages/m1')).toBe(true);
    });
  });

  describe('draft path (#1000)', () => {
    const RAW_DRAFT = {
      id: 'd1',
      thread_id: 't9',
      subject: 'Quarterly update',
      to: [{ email: 'alice@example.com', name: 'Alice' }],
      cc: [{ email: 'bob@example.com' }],
      bcc: [{ email: 'carol@example.com' }],
      body: '<p>Draft body</p>',
      snippet: 'Draft body',
      date: 1_700_000_500,
    };

    it('reads a draft by draft_id via GET /drafts/{id}', async () => {
      mockFetch.mockResolvedValue(jsonResponse(RAW_DRAFT));

      const result = await handler.execute(buildCtx({ draft_id: 'd1' }));

      expect(result.success).toBe(true);
      const url = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(url.pathname.endsWith('/drafts/d1')).toBe(true);
      expect(url.pathname).not.toContain('/messages');
    });

    it('returns the full draft content with recipients, bcc, and both body forms', async () => {
      mockFetch.mockResolvedValue(jsonResponse(RAW_DRAFT));

      const result = await handler.execute(buildCtx({ draft_id: 'd1' }));

      const data = (result as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({
        id: 'd1',
        threadId: 't9',
        subject: 'Quarterly update',
        to: [{ name: 'Alice', email: 'alice@example.com' }],
        cc: [{ name: undefined, email: 'bob@example.com' }],
        bcc: [{ name: undefined, email: 'carol@example.com' }],
        body_html: '<p>Draft body</p>',
        is_draft: true,
        date: 1_700_000_500,
      });
      expect(data.body_plain).toContain('Draft body');
    });

    it('returns a structured error when the draft fetch fails', async () => {
      mockFetch.mockResolvedValue(new Response('not found', { status: 404 }));

      const result = await handler.execute(buildCtx({ draft_id: 'missing' }));

      expect(result).toMatchObject({ success: false, error: expect.any(String) });
    });
  });

  describe('validation', () => {
    it('errors when neither message_id nor draft_id is provided', async () => {
      const result = await handler.execute(buildCtx({}));
      expect(result).toMatchObject({ success: false, error: expect.any(String) });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('errors when both message_id and draft_id are provided', async () => {
      const result = await handler.execute(buildCtx({ message_id: 'm1', draft_id: 'd1' }));
      expect(result).toMatchObject({ success: false, error: expect.any(String) });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
