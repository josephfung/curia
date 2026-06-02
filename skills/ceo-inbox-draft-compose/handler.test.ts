import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxDraftComposeHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { readFile } from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));
const mockReadFile = readFile as ReturnType<typeof vi.fn>;

function buildCtx(input?: Record<string, unknown>): SkillContext {
  return {
    input: input ?? {
      to: ['alice@example.com'],
      subject: 'Hello from CEO',
      body: 'Hi Alice, wanted to reach out.',
    },
    timezone: 'America/Toronto',
    secret(key: string): string {
      switch (key) {
        case 'nylas_api_key': return 'test-api-key';
        case 'ceo_nylas_grant_id': return 'test-grant-id';
        default: return '';
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

const DRAFT_RESPONSE = {
  data: {
    id: 'draft-compose-1',
    subject: 'Hello from CEO',
    to: [{ email: 'alice@example.com' }],
    cc: [],
  },
};

describe('CeoInboxDraftComposeHandler', () => {
  let handler: CeoInboxDraftComposeHandler;
  let mockFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handler = new CeoInboxDraftComposeHandler();
    mockFetch = vi.spyOn(globalThis, 'fetch');
    mockReadFile.mockReset();
    // readAttachmentFiles reads CURIA_TEMPFILE_DIR lazily; stub so file:///tmp/... passes the boundary check.
    vi.stubEnv('CURIA_TEMPFILE_DIR', '/tmp');
  });

  afterEach(() => {
    mockFetch.mockRestore();
    vi.unstubAllEnvs();
  });

  it('Case 1: Happy path — creates draft and returns draft_id', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
    );

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toMatchObject({
      draft_id: 'draft-compose-1',
      subject: 'Hello from CEO',
    });
  });

  it('Case 2: Draft payload does not include reply_to_message_id', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
    );

    const ctx = buildCtx();
    await handler.execute(ctx);

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reply_to_message_id).toBeUndefined();
    expect(body.to).toEqual([{ email: 'alice@example.com' }]);
    expect(body.subject).toBe('Hello from CEO');
  });

  it('Case 3: Multiple recipients in to array', async () => {
    const multiDraftResponse = {
      data: {
        id: 'draft-compose-2',
        subject: 'Team update',
        to: [
          { email: 'alice@example.com' },
          { email: 'bob@example.com' },
        ],
        cc: [],
      },
    };

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(multiDraftResponse), { status: 200 }),
    );

    const ctx = buildCtx({
      to: ['alice@example.com', 'bob@example.com'],
      subject: 'Team update',
      body: 'Hi team.',
    });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toHaveLength(2);
    expect(body.to).toContainEqual({ email: 'alice@example.com' });
    expect(body.to).toContainEqual({ email: 'bob@example.com' });
  });

  it('Case 4: CC addresses included in payload', async () => {
    const ccDraftResponse = {
      data: {
        id: 'draft-compose-3',
        subject: 'Hello',
        to: [{ email: 'alice@example.com' }],
        cc: [{ email: 'charlie@example.com' }],
      },
    };

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(ccDraftResponse), { status: 200 }),
    );

    const ctx = buildCtx({
      to: ['alice@example.com'],
      cc: ['charlie@example.com'],
      subject: 'Hello',
      body: 'Hi.',
    });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.cc).toEqual([{ email: 'charlie@example.com' }]);
  });

  it('Case 5: Empty to array — returns { success: false }', async () => {
    const ctx = buildCtx({ to: [], subject: 'Hello', body: 'Hi.' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('to');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Case 6: Missing subject — returns { success: false }', async () => {
    const ctx = buildCtx({ to: ['alice@example.com'], subject: '', body: 'Hi.' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('subject');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Case 7: Missing body — returns { success: false }', async () => {
    const ctx = buildCtx({ to: ['alice@example.com'], subject: 'Hello', body: '' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('body');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Case 8: Nylas API error — returns { success: false }', async () => {
    mockFetch.mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toBeTruthy();
  });

  it('Case 9: Body converted from markdown to HTML', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
    );

    const ctx = buildCtx({
      to: ['alice@example.com'],
      subject: 'Hello',
      body: '**Bold text** and _italic_',
    });
    await handler.execute(ctx);

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // markdownToHtml should produce HTML tags from the markdown input
    expect(body.body).toContain('<strong>Bold text</strong>');
  });

  it('Case 10: No CC field in payload when cc is empty', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
    );

    const ctx = buildCtx({
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Hi.',
    });
    await handler.execute(ctx);

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // cc should be absent when not provided (not an empty array)
    expect(body.cc).toBeUndefined();
  });

  it('Case 11: Body exceeds max length — returns { success: false }', async () => {
    const ctx = buildCtx({
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'x'.repeat(50_001),
    });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('50000');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Case 12: Invalid email address in to — returns { success: false }', async () => {
    const ctx = buildCtx({
      to: ['not-an-email'],
      subject: 'Hello',
      body: 'Hi.',
    });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('not-an-email');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Case 13: Missing secret throws — returns { success: false } without calling Nylas', async () => {
    const ctx: SkillContext = {
      ...buildCtx(),
      secret(key: string): string {
        throw new Error(`secret '${key}' is not configured`);
      },
    } as unknown as SkillContext;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('configured');
    // No Nylas call should have been made
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe('attachments', () => {
    it('uses multipart FormData when attachments are provided', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('pdf content'));
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
      );

      const ctx = buildCtx({
        to: ['alice@example.com'],
        subject: 'See attached',
        body: 'Please review.',
        attachments: [
          { file_url: 'file:///tmp/report.pdf', filename: 'report.pdf', content_type: 'application/pdf' },
        ],
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      // The fetch body must be FormData (not a JSON string) when attachments are present
      const [, init] = mockFetch.mock.calls[0]!;
      expect((init as RequestInit).body).toBeInstanceOf(FormData);
    });

    it('uses plain JSON when no attachments are provided', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
      );

      const ctx = buildCtx();
      await handler.execute(ctx);

      const [, init] = mockFetch.mock.calls[0]!;
      // Without attachments, body is a JSON string (not FormData)
      expect(typeof (init as RequestInit).body).toBe('string');
    });

    it('returns error when attachments input is malformed', async () => {
      const ctx = buildCtx({
        to: ['alice@example.com'],
        subject: 'Hello',
        body: 'Hi',
        attachments: 'not-an-array',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('array');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns error when attachment file cannot be read', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

      const ctx = buildCtx({
        to: ['alice@example.com'],
        subject: 'Hello',
        body: 'Hi',
        attachments: [
          { file_url: 'file:///tmp/missing.pdf', filename: 'missing.pdf', content_type: 'application/pdf' },
        ],
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('Attachment error');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
