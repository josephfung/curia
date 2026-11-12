import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxDownloadAttachmentHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { Logger } from '../../../../src/logger.js';
import {
  DMARC_REAL_ATTACHMENT_ID,
  DMARC_CORRUPTED_ATTACHMENT_ID,
  DMARC_FILENAME,
} from '../../../_shared/__fixtures__/resolve-attachment.js';
import { stubPrincipalMailboxes, twoMailboxFixture } from '../../../_shared/principal-mailboxes-test-helpers.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function buildCtx(overrides: Partial<{
  attachment_id: string;
  message_id: string;
  filename: string;
}> = {}): ToolContext {
  const input: Record<string, unknown> = {};
  if ('attachment_id' in overrides) input.attachment_id = overrides.attachment_id;
  if ('message_id' in overrides) input.message_id = overrides.message_id;
  if ('filename' in overrides) input.filename = overrides.filename;

  return {
    toolName: 'ceo-inbox-download-attachment',
    toolVersion: '0.1.0',
    input,
    // The handlers read credentials from principalMailboxes, never from secrets.
    secret: (key: string): string => { throw new Error(`unexpected secret read: ${key}`); },
    principalMailboxes: stubPrincipalMailboxes({}),
    // Partial logger mock; cast through unknown to the real Logger type.
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
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

  // ── 1. Missing attachment_id and filename ────────────────────────────────

  it('returns error when both attachment_id and filename are missing', async () => {
    const ctx = buildCtx({ message_id: MSG_ID });
    // fetch should never be called for a validation error
    mockFetch.mockImplementation(async () => {
      throw new Error('fetch should not be called');
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/attachment_id or filename/i);
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
    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
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

  // ── 4. Attachment ID not found on multi-attachment message ───────────────

  it('returns error listing attachments when ID misses on a multi-attachment message', async () => {
    const messageResponse = buildMessageResponse([
      { id: 'att-other', filename: 'other.pdf', content_type: 'application/pdf', size: 1000 },
      { id: 'att-third', filename: 'third.pdf', content_type: 'application/pdf', size: 2000 },
    ]);

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
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
      expect(result.error).toContain(ATT_ID);
      expect(result.error).toContain('other.pdf');
      expect(result.error).toContain('third.pdf');
      expect(result.error).toContain('att-other');
    }
    // The download endpoint should never be called
    expect(mockFetch.mock.calls.every((c: Parameters<typeof fetch>) => !String(c[0]).includes('/attachments/'))).toBe(true);
  });

  // ── 5. Declared size exceeds 10 MB ──────────────────────────────────────

  it('returns error when declared size exceeds 10 MB (pre-download guard)', async () => {
    const ELEVEN_MB = 11 * 1024 * 1024;
    const messageResponse = buildMessageResponse([
      { id: ATT_ID, filename: FILENAME, content_type: CONTENT_TYPE, size: ELEVEN_MB },
    ]);

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
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
    expect(mockFetch.mock.calls.every((c: Parameters<typeof fetch>) => !String(c[0]).includes('/attachments/'))).toBe(true);
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

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
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

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
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

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
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
        resolved_by: string;
      };
      // Verify all expected fields are present
      expect(data.filename).toBe(FILENAME);
      expect(data.content_type).toBe(CONTENT_TYPE);
      expect(data.size).toBe(fileBytes.length);
      expect(data.resolved_by).toBe('id');
      // Verify base64 round-trips to the original bytes
      const decoded = Buffer.from(data.content_base64, 'base64');
      expect(decoded.equals(fileBytes)).toBe(true);
    }
  });

  // ── 9. Corrupted ID + sole attachment (2026-10-24 incident fixture) ─────

  it('downloads via sole_attachment when the ID is the 2026-10-24 corrupted fixture', async () => {
    const fileBytes = Buffer.from('PK\x03\x04dmarc');
    const messageResponse = buildMessageResponse([
      {
        id: DMARC_REAL_ATTACHMENT_ID,
        filename: DMARC_FILENAME,
        content_type: 'application/zip; name="' + DMARC_FILENAME + '"',
        size: fileBytes.length,
      },
    ]);

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const urlStr = String(url);
      if (urlStr.includes(`/messages/${MSG_ID}`)) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes(`/attachments/${encodeURIComponent(DMARC_REAL_ATTACHMENT_ID)}/download`)) {
        return new Response(fileBytes, { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx({ attachment_id: DMARC_CORRUPTED_ATTACHMENT_ID, message_id: MSG_ID });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { resolved_by: string; filename: string };
      expect(data.resolved_by).toBe('sole_attachment');
      expect(data.filename).toBe(DMARC_FILENAME);
    }
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  // ── 10. Filename match on multi-attachment message ───────────────────────

  it('downloads via filename when ID is wrong on a multi-attachment message', async () => {
    const fileBytes = Buffer.from('wanted-pdf');
    const messageResponse = buildMessageResponse([
      { id: 'att-a', filename: FILENAME, content_type: CONTENT_TYPE, size: fileBytes.length },
      { id: 'att-b', filename: 'other.pdf', content_type: CONTENT_TYPE, size: 50 },
    ]);

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const urlStr = String(url);
      if (urlStr.includes(`/messages/${MSG_ID}`)) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/attachments/att-a/download')) {
        return new Response(fileBytes, { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx({
      attachment_id: 'wrong-id',
      filename: FILENAME,
      message_id: MSG_ID,
    });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { resolved_by: string; filename: string; content_base64: string };
      expect(data.resolved_by).toBe('filename');
      expect(data.filename).toBe(FILENAME);
      expect(Buffer.from(data.content_base64, 'base64').equals(fileBytes)).toBe(true);
    }
    expect(ctx.log.warn).toHaveBeenCalled();
  });
});

describe('CeoInboxDownloadAttachmentHandler mailbox selection (#2475)', () => {
  afterEach(() => vi.restoreAllMocks());

  function run(holders: Array<'work' | 'personal'>, extra: Record<string, unknown> = {}) {
    const f = twoMailboxFixture(holders);
    vi.spyOn(globalThis, 'fetch').mockImplementation(f.fetchStub as typeof fetch);
    const ctx = {
      input: { message_id: 'x1', filename: 'f.txt', ...extra }, principalMailboxes: f.principalMailboxes,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ToolContext;
    return { f, result: new CeoInboxDownloadAttachmentHandler().execute(ctx) };
  }

  it('acts in the mailbox holding the message', async () => {
    const { f, result } = run(['personal']);
    expect((await result).success).toBe(true);
    expect(f.calls.some((c) => c.grant === 'grant-personal')).toBe(true);
    expect(f.calls.filter((c) => c.method !== 'GET').every((c) => c.grant === 'grant-personal')).toBe(true);
  });

  it('returns mailbox and mailbox_label', async () => {
    const { result } = run(['personal']);
    const r = await result;
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ mailbox: 'personal', mailbox_label: 'Personal' });
  });

  it('missing mailbox never defaults: the default mailbox does not hold it, so the other one acts', async () => {
    const { f, result } = run(['personal']);
    await result;
    expect(f.calls.filter((c) => c.method !== 'GET').every((c) => c.grant !== 'grant-work')).toBe(true);
  });

  it('an explicit mailbox that does not hold the message is a miss, not a fallback', async () => {
    const { f, result } = run(['personal'], { mailbox: 'work' });
    expect((await result).success).toBe(false);
    expect(f.calls.every((c) => c.grant === 'grant-work')).toBe(true);
  });

  it('an unknown mailbox id is an error and nothing is fetched', async () => {
    const { f, result } = run(['work'], { mailbox: 'nope' });
    const r = await result;
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('nope');
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a message found in more than one mailbox', async () => {
    const { f, result } = run(['work', 'personal']);
    const r = await result;
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('more than one mailbox');
    expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});
