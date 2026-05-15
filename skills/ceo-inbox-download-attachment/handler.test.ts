import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxDownloadAttachmentHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function buildCtx(overrides: Partial<{
  attachment_id: string;
  message_id: string;
}> = {}): SkillContext {
  const input: Record<string, unknown> = {};
  if ('attachment_id' in overrides) input.attachment_id = overrides.attachment_id;
  if ('message_id' in overrides) input.message_id = overrides.message_id;

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
  };
}

const MSG_ID = 'msg-abc';
const ATT_ID = 'att-xyz';
const FILENAME = 'invoice.pdf';
const CONTENT_TYPE = 'application/pdf';

/** Build a Nylas API message response containing the given attachments. */
function buildMessageResponse(attachments: Array<{
  id: string;
  filename?: string;
  content_type: string;
  size?: number;
  is_inline?: boolean;
  content_disposition?: string;
}>) {
  return {
    data: {
      id: MSG_ID,
      thread_id: 'thread-001',
      subject: 'Invoice attached',
      from: [{ email: 'vendor@example.com', name: 'Vendor' }],
      to: [{ email: 'ceo@example.com' }],
      cc: [],
      bcc: [],
      body: '<p>Please find the invoice attached.</p>',
      snippet: 'Please find the invoice attached.',
      date: 1_700_000_000,
      unread: true,
      folders: ['INBOX'],
      labels: [],
      attachments,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CeoInboxDownloadAttachmentHandler', () => {
  let handler: CeoInboxDownloadAttachmentHandler;
  let mockFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handler = new CeoInboxDownloadAttachmentHandler();
    mockFetch = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  // ── 1. Missing attachment_id ─────────────────────────────────────────────

  it('returns error when attachment_id is missing', async () => {
    const ctx = buildCtx({ message_id: MSG_ID });
    // fetch should never be called for a validation error
    mockFetch.mockImplementation(async () => {
      throw new Error('fetch should not be called');
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/attachment_id/i);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── 2. Missing message_id ────────────────────────────────────────────────

  it('returns error when message_id is missing', async () => {
    const ctx = buildCtx({ attachment_id: ATT_ID });
    mockFetch.mockImplementation(async () => {
      throw new Error('fetch should not be called');
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/message_id/i);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── 3. getMessage() throws ───────────────────────────────────────────────

  it('returns error when getMessage() throws (Nylas API error)', async () => {
    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes(`/messages/${MSG_ID}`)) {
        return new Response('Server Error', { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx({ attachment_id: ATT_ID, message_id: MSG_ID });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  // ── 4. Attachment ID not found on message ────────────────────────────────

  it('returns error when attachment ID is not found on the message', async () => {
    const messageResponse = buildMessageResponse([
      // A different attachment — the requested ATT_ID is absent
      { id: 'att-other', filename: 'other.pdf', content_type: 'application/pdf', size: 1000 },
    ]);

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes(`/messages/${MSG_ID}`)) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx({ attachment_id: ATT_ID, message_id: MSG_ID });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      // Error should mention the attachment and/or message IDs
      expect(result.error).toContain(ATT_ID);
    }
    // The download endpoint should never be called
    expect(mockFetch.mock.calls.every((c) => !String(c[0]).includes('/attachments/'))).toBe(true);
  });

  // ── 5. Declared size exceeds 10 MB ──────────────────────────────────────

  it('returns error when declared size exceeds 10 MB (pre-download guard)', async () => {
    const ELEVEN_MB = 11 * 1024 * 1024;
    const messageResponse = buildMessageResponse([
      { id: ATT_ID, filename: FILENAME, content_type: CONTENT_TYPE, size: ELEVEN_MB },
    ]);

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes(`/messages/${MSG_ID}`)) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx({ attachment_id: ATT_ID, message_id: MSG_ID });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/10 MB/);
      expect(result.error).toContain(FILENAME);
    }
    // Download endpoint must never be called
    expect(mockFetch.mock.calls.every((c) => !String(c[0]).includes('/attachments/'))).toBe(true);
  });

  // ── 6. Actual download size exceeds 10 MB (declared size was 0) ─────────

  it('returns error when actual downloaded size exceeds 10 MB (post-download guard)', async () => {
    // Declared size is 0 (missing), bypassing the pre-download check
    const messageResponse = buildMessageResponse([
      { id: ATT_ID, filename: FILENAME, content_type: CONTENT_TYPE, size: 0 },
    ]);

    // The download returns 11 MB of data despite the declared size being 0
    const ELEVEN_MB = 11 * 1024 * 1024;
    const largeBody = Buffer.alloc(ELEVEN_MB, 0x41); // 11 MB of 'A'

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes(`/messages/${MSG_ID}`)) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes(`/attachments/${ATT_ID}/download`)) {
        return new Response(largeBody, { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx({ attachment_id: ATT_ID, message_id: MSG_ID });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/actual size/i);
      expect(result.error).toMatch(/10 MB/);
      expect(result.error).toContain(FILENAME);
    }
  });

  // ── 7. downloadAttachment() throws ──────────────────────────────────────

  it('returns error with detail when downloadAttachment() throws', async () => {
    const messageResponse = buildMessageResponse([
      { id: ATT_ID, filename: FILENAME, content_type: CONTENT_TYPE, size: 1024 },
    ]);

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes(`/messages/${MSG_ID}`)) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes(`/attachments/${ATT_ID}/download`)) {
        // Simulate a 403 from the attachment download endpoint
        return new Response('Forbidden', { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx({ attachment_id: ATT_ID, message_id: MSG_ID });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      // Error must include the filename so the caller knows which file failed
      expect(result.error).toContain(FILENAME);
      // Error must include some detail about what went wrong (not a bare generic message)
      expect(result.error.length).toBeGreaterThan(`Failed to download attachment "${FILENAME}": `.length);
    }
  });

  // ── 8. Happy path — base64 content returned ─────────────────────────────

  it('returns base64 content on success with correct metadata fields', async () => {
    const fileBytes = Buffer.from('Hello PDF content');
    const messageResponse = buildMessageResponse([
      { id: ATT_ID, filename: FILENAME, content_type: CONTENT_TYPE, size: fileBytes.length },
    ]);

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes(`/messages/${MSG_ID}`)) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes(`/attachments/${ATT_ID}/download`)) {
        return new Response(fileBytes, { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx({ attachment_id: ATT_ID, message_id: MSG_ID });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        content_base64: string;
        filename: string;
        content_type: string;
        size: number;
      };
      // Verify all expected fields are present
      expect(data.filename).toBe(FILENAME);
      expect(data.content_type).toBe(CONTENT_TYPE);
      expect(data.size).toBe(fileBytes.length);
      // Verify base64 round-trips to the original bytes
      const decoded = Buffer.from(data.content_base64, 'base64');
      expect(decoded.equals(fileBytes)).toBe(true);
    }
  });
});
