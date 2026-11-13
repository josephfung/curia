import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxDraftReplyHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { Logger } from '../../../../src/logger.js';
import { readFile, realpath } from 'node:fs/promises';
import { mailboxView, stubPrincipalMailboxes, twoMailboxes } from '../../../_shared/principal-mailboxes-test-helpers.js';
import { DraftProvenance } from '../../../../src/skills/principal-send/draft-provenance.js';
import type { AuditLogRow } from '../../../../src/audit/audit-log-repo.js';
import pino from 'pino';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
}));

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockRealpath = realpath as ReturnType<typeof vi.fn>;

// Helper to build a minimal mock ToolContext
function buildCtx(overrides: Partial<{
  reply_to_message_id: string;
  body: string;
  attachments: unknown;
}>= {}): ToolContext {
  const input: Record<string, unknown> = {
    reply_to_message_id: overrides.reply_to_message_id ?? 'msg-001',
    body: overrides.body ?? 'Thanks for reaching out.',
  };
  if ('attachments' in overrides) input.attachments = overrides.attachments;

  return {
    toolName: 'ceo-inbox-draft-reply',
    toolVersion: '0.3.0',
    input,
    timezone: 'America/Toronto',
    // The handlers read credentials from principalMailboxes, never from secrets.
    secret: (key: string): string => { throw new Error(`unexpected secret read: ${key}`); },
    principalMailboxes: stubPrincipalMailboxes({}),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as ToolContext;
}

// Helper to build a Nylas API message response
function buildNylasMessage(opts: {
  from: Array<{ email: string; name?: string }>;
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  folders?: string[];
}) {
  return {
    data: {
      id: 'msg-001',
      thread_id: 'thread-001',
      subject: 'Test Subject',
      from: opts.from,
      to: opts.to,
      cc: opts.cc ?? [],
      bcc: [],
      body: '<p>Hello</p>',
      snippet: 'Hello',
      date: 1700000000,
      unread: false,
      folders: opts.folders ?? ['INBOX'],
      labels: [],
    },
  };
}

// Standard draft response
const DRAFT_RESPONSE = {
  data: {
    id: 'draft-1',
    subject: 'Re: Test Subject',
    to: [{ email: 'alice@external.com', name: 'Alice' }],
    cc: [],
  },
};

describe('CeoInboxDraftReplyHandler', () => {
  let handler: CeoInboxDraftReplyHandler;
  let mockFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handler = new CeoInboxDraftReplyHandler();
    mockFetch = vi.spyOn(globalThis, 'fetch');
    mockReadFile.mockReset();
    mockRealpath.mockReset();
    // Default: realpath is identity (no symlinks to resolve).
    mockRealpath.mockImplementation(async (p: string) => p);
    // readAttachmentFiles reads CURIA_TEMPFILE_DIR lazily; stub so file:///tmp/... passes the boundary check.
    vi.stubEnv('CURIA_TEMPFILE_DIR', '/tmp');
  });

  afterEach(() => {
    mockFetch.mockRestore();
    vi.unstubAllEnvs();
  });

  it('Case 1: Happy path — reply-all with correct to and cc', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com', name: 'Alice' }],
      to: [{ email: 'bob@example.com' }],
      cc: [{ email: 'charlie@example.com' }],
    });

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes('/drafts')) {
        return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);

    // Verify the draft creation call
    const draftCall = mockFetch.mock.calls.find(
      (call: Parameters<typeof fetch>) =>
        String(call[0]).includes('/drafts') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(draftCall).toBeDefined();

    const draftBody = JSON.parse(draftCall![1]!.body as string);

    // To should be the original sender
    expect(draftBody.to).toEqual([{ email: 'alice@external.com', name: 'Alice' }]);

    // Subject should be "Re: " + original subject
    expect(draftBody.subject).toBe('Re: Test Subject');

    // CC should contain bob and charlie, but NOT ceo@example.com
    const ccEmails = draftBody.cc.map((p: { email: string }) => p.email.toLowerCase());
    expect(ccEmails).toContain('bob@example.com');
    expect(ccEmails).toContain('charlie@example.com');
    expect(ccEmails).not.toContain('ceo@example.com');

    // Body should be HTML: reply text converted from markdown + HTML quoted original
    expect(draftBody.body).toContain('Thanks for reaching out.');
    // HTML blockquote attribution
    expect(draftBody.body).toContain('<strong>From:</strong>');
    expect(draftBody.body).toContain('alice@external.com');
  });

  it('Case 2: CEO in To of original — filtered from reply CC', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com' }],
      to: [{ email: 'ceo@example.com' }],
      cc: [{ email: 'bob@example.com' }],
    });

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes('/drafts')) {
        return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);

    const draftCall = mockFetch.mock.calls.find(
      (call: Parameters<typeof fetch>) =>
        String(call[0]).includes('/drafts') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(draftCall).toBeDefined();

    const draftBody = JSON.parse(draftCall![1]!.body as string);

    // CC must NOT include ceo@example.com
    const ccEmails = (draftBody.cc ?? []).map((p: { email: string }) => p.email.toLowerCase());
    expect(ccEmails).not.toContain('ceo@example.com');

    // CC must include bob@example.com
    expect(ccEmails).toContain('bob@example.com');
  });

  it('Case 3: Duplicate address in both To and CC — deduped', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com' }],
      to: [{ email: 'bob@example.com' }],
      cc: [{ email: 'bob@example.com' }],
    });

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes('/drafts')) {
        return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);

    const draftCall = mockFetch.mock.calls.find(
      (call: Parameters<typeof fetch>) =>
        String(call[0]).includes('/drafts') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(draftCall).toBeDefined();

    const draftBody = JSON.parse(draftCall![1]!.body as string);

    // bob@example.com should appear exactly once in CC
    const ccEmails = (draftBody.cc ?? []).map((p: { email: string }) => p.email.toLowerCase());
    const bobCount = ccEmails.filter((e: string) => e === 'bob@example.com').length;
    expect(bobCount).toBe(1);
  });

  it('Case 4: No CC in original — original To recipients appear in reply CC', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com' }],
      to: [{ email: 'bob@example.com' }],
      cc: [],
    });

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes('/drafts')) {
        return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);

    const draftCall = mockFetch.mock.calls.find(
      (call: Parameters<typeof fetch>) =>
        String(call[0]).includes('/drafts') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(draftCall).toBeDefined();

    const draftBody = JSON.parse(draftCall![1]!.body as string);

    // The handler computes cc = [bob@example.com] (original to minus sender, minus self).
    // bob is in original.to but is not the sender and not the CEO, so cc has one entry.
    // Actually: to has bob, cc is empty. Combined = [bob]. bob is not sender, not self → cc = [bob].
    // So the createDraftReply is called with cc: [{email: 'bob@example.com'}].
    // The nylas-client only includes cc in payload if cc.length > 0, so cc should be present here.
    const ccEmails = (draftBody.cc ?? []).map((p: { email: string }) => p.email.toLowerCase());
    expect(ccEmails).toContain('bob@example.com');
  });

  it('Case 5: Subject already has Re: prefix — not doubled', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com' }],
      to: [{ email: 'ceo@example.com' }],
      cc: [],
    });
    // Override the subject to already have "Re: "
    messageResponse.data.subject = 'Re: Checking Account & Credit Card';

    const draftResponse = {
      data: {
        id: 'draft-2',
        subject: 'Re: Checking Account & Credit Card',
        to: [{ email: 'alice@external.com' }],
        cc: [],
      },
    };

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes('/drafts')) {
        return new Response(JSON.stringify(draftResponse), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);

    const draftCall = mockFetch.mock.calls.find(
      (call: Parameters<typeof fetch>) =>
        String(call[0]).includes('/drafts') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(draftCall).toBeDefined();

    const draftBody = JSON.parse(draftCall![1]!.body as string);

    // Must NOT double the "Re: " prefix
    expect(draftBody.subject).toBe('Re: Checking Account & Credit Card');
  });

  it('Case 6: getMessage fails — returns { success: false }', async () => {
    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response('Not Found', { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeTruthy();
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('Case 7: Unknown mailbox address — returns { success: false }', async () => {
    // The message is located first (one GET); no draft may be created or listed when the address is unknown.
    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes('/drafts')) throw new Error('drafts must not be touched when the mailbox address is empty');
      return new Response(JSON.stringify(buildNylasMessage({ from: [{ email: 'alice@external.com' }], to: [] })), { status: 200 });
    });

    // Build a ctx whose default mailbox has an empty address
    const ctx: ToolContext = {
      toolName: 'ceo-inbox-draft-reply',
      toolVersion: '0.3.0',
      input: {
        reply_to_message_id: 'msg-001',
        body: 'Thanks for reaching out.',
      },
      secret: (key: string): string => { throw new Error(`unexpected secret read: ${key}`); },
      // The mailbox exists but its address is not known (the deferred single-mailbox fallback).
      principalMailboxes: stubPrincipalMailboxes({ mailboxes: [mailboxView('work', 'Work', '', true)] }),
      // Partial logger mock; cast through unknown to the real Logger type.
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as Logger,
    };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      // Error message must reference the misconfiguration so it is diagnosable
      const lower = result.error.toLowerCase();
      expect(
        lower.includes('configuration error'),
      ).toBe(true);
    }

    // Only the locate probe ran: nothing was listed or created.
    expect(mockFetch.mock.calls.every((c: Parameters<typeof fetch>) => !String(c[0]).includes('/drafts'))).toBe(true);
  });

  it('Case 8: Quote includes HTML-stripped original body', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com', name: 'Alice' }],
      to: [{ email: 'ceo@example.com' }],
      cc: [],
    });
    // Override body with rich HTML
    messageResponse.data.body = '<p>Hello <b>world</b></p>';

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes('/drafts')) {
        return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx({ body: 'Thanks - see [details](https://example.com/details).' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    const draftCall = mockFetch.mock.calls.find(
      (call: Parameters<typeof fetch>) =>
        String(call[0]).includes('/drafts') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(draftCall).toBeDefined();

    const draftBody = JSON.parse(draftCall![1]!.body as string);

    // HTML mode: original body HTML is preserved inside the blockquote, not stripped
    // The original `<p>Hello <b>world</b></p>` survives sanitization intact.
    expect(draftBody.body).toContain('Hello');
    expect(draftBody.body).toContain('<b>world</b>');
    expect(draftBody.body).toContain('<blockquote');
    // Reply text (converted from markdown by markdownToHtml) precedes the HTML quote block
    expect(draftBody.body).toContain('<a href="https://example.com/details"');
    expect(draftBody.body).toContain('>details</a>');
    expect(draftBody.body.indexOf('<a href="https://example.com/details"')).toBeLessThan(
      draftBody.body.indexOf('<blockquote'),
    );
  });

  it('Case 9: Empty from — returns { success: false } with error-level log', async () => {
    // Message exists but has no sender (from: [])
    const messageResponse = buildNylasMessage({
      from: [],
      to: [{ email: 'ceo@example.com' }],
      cc: [],
    });

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      // Draft creation must NOT be called — throw if it is
      throw new Error(`Unexpected fetch (draft must not be created): ${urlStr}`);
    });

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('no sender address');
    }

    // An error-level log must have been emitted
    expect(ctx.log.error).toHaveBeenCalled();

    // The drafts endpoint must NOT have been called
    const draftCall = mockFetch.mock.calls.find(
      (call: Parameters<typeof fetch>) =>
        String(call[0]).includes('/drafts') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(draftCall).toBeUndefined();
  });

  describe('attachments', () => {
    it('uses multipart FormData when attachments are provided', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('pdf content'));

      const messageResponse = buildNylasMessage({
        from: [{ email: 'alice@external.com', name: 'Alice' }],
        to: [{ email: 'ceo@example.com' }],
        cc: [],
      });

      mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes('/messages/msg-001')) {
          return new Response(JSON.stringify(messageResponse), { status: 200 });
        }
        if (urlStr.includes('/drafts') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('/drafts')) {
          return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${urlStr}`);
      });

      const ctx = buildCtx({
        attachments: [
          { file_url: 'file:///tmp/report.pdf', filename: 'report.pdf', content_type: 'application/pdf' },
        ],
      });
      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const draftCall = mockFetch.mock.calls.find(
        (call: Parameters<typeof fetch>) =>
        String(call[0]).includes('/drafts') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
      );
      expect(draftCall).toBeDefined();
      // Body must be FormData (not a JSON string) when attachments are present
      expect((draftCall![1] as RequestInit).body).toBeInstanceOf(FormData);
    });

    it('uses plain JSON when no attachments are provided', async () => {
      const messageResponse = buildNylasMessage({
        from: [{ email: 'alice@external.com' }],
        to: [{ email: 'ceo@example.com' }],
        cc: [],
      });

      mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes('/messages/msg-001')) {
          return new Response(JSON.stringify(messageResponse), { status: 200 });
        }
        if (urlStr.includes('/drafts') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('/drafts')) {
          return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${urlStr}`);
      });

      const ctx = buildCtx();
      await handler.execute(ctx);

      const draftCall = mockFetch.mock.calls.find(
        (call: Parameters<typeof fetch>) =>
        String(call[0]).includes('/drafts') &&
        ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
      );
      expect(draftCall).toBeDefined();
      // Without attachments, body is a JSON string (not FormData)
      expect(typeof (draftCall![1] as RequestInit).body).toBe('string');
    });

    it('returns error when attachments input is malformed', async () => {
      const ctx = buildCtx({ attachments: 'not-an-array' });
      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('array');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns error when attachment file cannot be read', async () => {
      // readAttachmentFiles is called before getMessage, so no fetch is issued
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

      const ctx = buildCtx({
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

  it('voice-learning capture failure does not block draft creation (#1421)', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com', name: 'Alice' }],
      to: [{ email: 'bob@example.com' }],
    });
    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes('/drafts')) {
        return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const ctx = buildCtx();
    ctx.workingDocs = {
      read: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(new Error('okf unavailable')),
      update: vi.fn(),
    } as unknown as NonNullable<ToolContext['workingDocs']>;

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: { draft_id: string } }).data.draft_id).toBe('draft-1');
    // The voice snapshot is now fire-and-forget so it can't add latency to draft creation;
    // its failure is logged asynchronously after the handler returns. Wait for that log.
    await vi.waitFor(() => expect(ctx.log.error).toHaveBeenCalled());
  });

  it('returns the existing draft when called twice for the same message (#2035)', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com', name: 'Alice' }],
      to: [{ email: 'ceo@example.com' }],
    });
    const drafts: Array<Record<string, unknown>> = [];
    let creates = 0;

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && method === 'GET') {
        return new Response(JSON.stringify({ data: drafts }), { status: 200 });
      }
      if (urlStr.includes('/drafts') && method === 'POST') {
        creates += 1;
        const created = {
          id: 'draft-1',
          thread_id: 'thread-001',
          subject: 'Re: Test Subject',
          to: [{ email: 'alice@external.com', name: 'Alice' }],
          cc: [],
          snippet: 'Thanks for reaching out.',
          date: 1_700_000_000,
        };
        drafts.push(created);
        return new Response(JSON.stringify({ data: created }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    const first = await handler.execute(buildCtx());
    const second = await handler.execute(buildCtx({ body: 'A second, different reply.' }));

    expect(creates).toBe(1);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    const firstData = first.data as { draft_id: string; already_exists: boolean };
    const secondData = second.data as { draft_id: string; already_exists: boolean };
    expect(firstData.draft_id).toBe('draft-1');
    expect(firstData.already_exists).toBe(false);
    // #2474 final fixes A5: the created draft's result names the message it answers, which an
    // autonomous send binds to (DraftProvenance.curiaWritesInTask reads it from the audit row).
    expect(first.data).toMatchObject({ reply_to_message_id: 'msg-001' });
    expect(secondData).toMatchObject({
      draft_id: 'draft-1',
      already_exists: true,
      snippet: 'Thanks for reaching out.',
      date: 1_700_000_000,
    });
  });

  it('refuses to draft a reply to Spam or Trash however many times it is called (#2035)', async () => {
    for (const folder of ['SPAM', 'trash']) {
      const messageResponse = buildNylasMessage({
        from: [{ email: 'phish@evil.test', name: 'Bank' }],
        to: [{ email: 'ceo@example.com' }],
        folders: [folder],
      });
      let creates = 0;

      mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const urlStr = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (urlStr.includes('/messages/msg-001')) {
          return new Response(JSON.stringify(messageResponse), { status: 200 });
        }
        if (urlStr.includes('/drafts') && method === 'POST') {
          creates += 1;
          return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
      });

      const ctx = buildCtx();
      const first = await handler.execute(ctx);
      const second = await handler.execute(buildCtx({ body: 'A second attempt.' }));

      expect(creates).toBe(0);
      expect(first).toMatchObject({ success: false, error: 'Message is in Spam or Trash; not drafting a reply' });
      expect(second).toMatchObject({ success: false, error: 'Message is in Spam or Trash; not drafting a reply' });
      expect(ctx.log.warn).toHaveBeenCalled();
    }
  });

  it('still creates a draft when the only existing draft is on another thread', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com', name: 'Alice' }],
      to: [{ email: 'ceo@example.com' }],
    });
    let creates = 0;

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && method === 'GET') {
        return new Response(JSON.stringify({
          data: [{
            id: 'draft-other',
            thread_id: 'thread-other',
            subject: 'Re: Something else',
            to: [{ email: 'bob@example.com' }],
            cc: [],
            snippet: '',
            date: 1,
          }],
        }), { status: 200 });
      }
      if (urlStr.includes('/drafts') && method === 'POST') {
        creates += 1;
        return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    const result = await handler.execute(buildCtx());

    expect(creates).toBe(1);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { already_exists: boolean }).already_exists).toBe(false);
  });

  it('refuses to create a draft when the existing-draft scan is truncated (#2035)', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com', name: 'Alice' }],
      to: [{ email: 'ceo@example.com' }],
    });
    let creates = 0;
    let draftPages = 0;

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const urlStr = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }
      if (urlStr.includes('/drafts') && method === 'GET') {
        draftPages += 1;
        // A full page plus a cursor, none of them this thread. 25 pages of 20
        // is the 500-draft ceiling, so the scan reports truncated.
        const data = Array.from({ length: 20 }, (_, i) => ({
          id: `draft-${draftPages}-${i}`,
          thread_id: 'thread-other',
          subject: 'Other',
          to: [{ email: 'bob@example.com' }],
          cc: [],
          snippet: '',
          date: 1,
        }));
        return new Response(JSON.stringify({ data, next_cursor: 'more' }), { status: 200 });
      }
      if (urlStr.includes('/drafts') && method === 'POST') {
        creates += 1;
        return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    });

    const ctx = buildCtx();
    const result = await handler.execute(ctx);

    expect(creates).toBe(0);
    expect(draftPages).toBe(25);
    expect(result).toMatchObject({
      success: false,
      error: 'Unable to determine whether this thread already has a draft; draft scan incomplete',
    });
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  describe('mailbox selection (#2475)', () => {
    function twoBoxFetch(holder: 'work' | 'personal') {
      const posts: Array<{ grant: string; body: { cc: Array<{ email: string }> } }> = [];
      mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const u = new URL(String(url));
        const grant = /\/grants\/([^/]+)/.exec(u.pathname)![1]!;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (u.pathname.includes('/messages/')) {
          if (grant !== `grant-${holder}`) return new Response('{}', { status: 404 });
          return new Response(JSON.stringify(buildNylasMessage({
            from: [{ email: 'alice@external.com' }],
            to: [{ email: 'ceo@work.example.com' }, { email: 'ceo@personal.example.com' }],
            cc: [{ email: 'dana@example.org' }],
          })), { status: 200 });
        }
        if (u.pathname.endsWith('/drafts') && method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
        if (u.pathname.endsWith('/drafts') && method === 'POST') {
          posts.push({ grant, body: JSON.parse(init!.body as string) });
          return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${method} ${u.pathname}`);
      });
      return posts;
    }

    it('drafts in the mailbox the message is in', async () => {
      const posts = twoBoxFetch('personal');
      const ctx = buildCtx();
      (ctx as { principalMailboxes: unknown }).principalMailboxes = twoMailboxes();
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.grant).toBe('grant-personal');
    });

    it('reply-all excludes both principal addresses', async () => {
      const posts = twoBoxFetch('work');
      const ctx = buildCtx();
      (ctx as { principalMailboxes: unknown }).principalMailboxes = twoMailboxes();
      await handler.execute(ctx);
      expect(posts[0]!.body.cc.map((p) => p.email)).toEqual(['dana@example.org']);
    });

    it('result carries mailbox and mailbox_label', async () => {
      twoBoxFetch('personal');
      const ctx = buildCtx();
      (ctx as { principalMailboxes: unknown }).principalMailboxes = twoMailboxes();
      const result = await handler.execute(ctx);
      expect(result).toMatchObject({
        success: true,
        data: { mailbox: 'personal', mailbox_label: 'Personal', reply_to_message_id: 'msg-001' },
      });
    });
  });

  describe('reply from the copy the sender addressed (#2475)', () => {
    const MSG_ID = 'abc123@mail.example.net';

    // The triaged copy (msg-001) is in `held`. The other mailbox's copy is msg-other, found by the
    // Message-ID search unless `search` says otherwise.
    function setup(opts: {
      held: 'work' | 'personal';
      to: string[];
      cc?: string[];
      search?: 'hit' | 'empty' | 'error';
      mailboxInput?: string;
      from?: string;
      /** The other mailbox's copy. */
      copy?: { from?: string; folders?: string[]; messageId?: string; fromList?: string[] };
      /** Folders the search hit reports (default INBOX). */
      hitFolders?: string[];
      /** Message-ID header on the triaged copy (default MSG_ID). */
      originalMessageId?: string;
      hits?: string[];
      /** The triaged mailbox already holds a draft on the message's thread (SF-M3). */
      givenDraft?: boolean;
    }) {
      const posts: Array<{ grant: string; body: { reply_to_message_id?: string } }> = [];
      const searches: Array<{ grant: string; q: string | null }> = [];
      const mailboxes = [
        mailboxView('work', 'Work', 'ceo@work.example.com', true),
        mailboxView('personal', 'Personal', 'ceo@personal.example.com'),
      ];
      const gatewayGets: string[] = [];
      const ctx = buildCtx();
      (ctx.input as Record<string, unknown>).mailbox = opts.mailboxInput;
      if (opts.mailboxInput === undefined) delete (ctx.input as Record<string, unknown>).mailbox;
      (ctx as { principalMailboxes: unknown }).principalMailboxes = stubPrincipalMailboxes({
        mailboxes,
        grantId: (id) => `grant-${id}`,
        gatewayClients: {
          work: { getMessage: async () => { gatewayGets.push('work'); return { headers: [{ name: 'Message-ID', value: `<${opts.held === 'work' ? (opts.originalMessageId ?? MSG_ID) : (opts.copy?.messageId ?? MSG_ID)}>` }] }; } },
          personal: { getMessage: async () => { gatewayGets.push('personal'); return { headers: [{ name: 'Message-ID', value: `<${opts.held === 'personal' ? (opts.originalMessageId ?? MSG_ID) : (opts.copy?.messageId ?? MSG_ID)}>` }] }; } },
        },
      });
      mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const u = new URL(String(url));
        const grant = /\/grants\/([^/]+)/.exec(u.pathname)![1]!;
        const method = (init?.method ?? 'GET').toUpperCase();
        const heldGrant = `grant-${opts.held}`;
        if (u.pathname.endsWith('/messages') && u.searchParams.has('search_query_native')) {
          searches.push({ grant, q: u.searchParams.get('search_query_native') });
          if (opts.search === 'error') return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 400 });
          const ids = opts.search === 'empty' ? [] : (opts.hits ?? ['msg-other']);
          const data = ids.map((id) => ({ id, thread_id: 'thread-other', subject: 'Test Subject', from: [{ email: 'alice@external.com' }], to: [], cc: [], folders: opts.hitFolders ?? ['INBOX'] }));
          return new Response(JSON.stringify({ data }), { status: 200 });
        }
        if (u.pathname.includes('/messages/')) {
          const id = u.pathname.split('/').pop();
          if ((id === 'msg-001') !== (grant === heldGrant)) return new Response('{}', { status: 404 });
          const isOriginal = id === 'msg-001';
          const m = buildNylasMessage({
            from: !isOriginal && opts.copy?.fromList
              ? opts.copy.fromList.map((email) => ({ email }))
              : [{ email: isOriginal ? (opts.from ?? 'alice@external.com') : (opts.copy?.from ?? opts.from ?? 'alice@external.com') }],
            to: opts.to.map((email) => ({ email })),
            cc: (opts.cc ?? []).map((email) => ({ email })),
            ...(!isOriginal && opts.copy?.folders ? { folders: opts.copy.folders } : {}),
          });
          m.data.id = id!;
          return new Response(JSON.stringify(m), { status: 200 });
        }
        if (u.pathname.endsWith('/drafts') && method === 'GET') {
          const data = opts.givenDraft && grant === heldGrant ? [{ id: 'draft-earlier', thread_id: 'thread-001', subject: 'Re: Test Subject', to: [], cc: [], snippet: 'Earlier', date: 1 }] : [];
          return new Response(JSON.stringify({ data }), { status: 200 });
        }
        if (u.pathname.endsWith('/drafts') && method === 'POST') {
          posts.push({ grant, body: JSON.parse(init!.body as string) });
          return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${method} ${u.pathname}`);
      });
      return { ctx, posts, searches, gatewayGets };
    }

    it('drafts on the copy in the mailbox named first in To', async () => {
      const { ctx, posts, searches } = setup({ held: 'personal', to: ['ceo@work.example.com'], cc: ['ceo@personal.example.com'] });
      const result = await handler.execute(ctx);
      expect(searches).toEqual([{ grant: 'grant-work', q: `rfc822msgid:${MSG_ID}` }]);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.grant).toBe('grant-work');
      expect(posts[0]!.body.reply_to_message_id).toBe('msg-other');
      expect(result).toMatchObject({
        success: true,
        data: { mailbox: 'work', mailbox_label: 'Work', reply_to_message_id: 'msg-other' },
      });
      expect((result as { data: Record<string, unknown> }).data.reply_mailbox_fallback).toBeUndefined();
    });

    it('falls back to the triaged mailbox and says so', async () => {
      for (const search of ['empty', 'error'] as const) {
        const { ctx, posts } = setup({ held: 'personal', to: ['CEO@work.example.com'], cc: ['ceo@personal.example.com'], search });
        const result = await handler.execute(ctx);
        expect(posts[posts.length - 1]!.grant).toBe('grant-personal');
        expect(result).toMatchObject({
          success: true,
          data: { mailbox: 'personal', mailbox_label: 'Personal', reply_mailbox_fallback: true },
        });
        expect(typeof (result as { data: Record<string, unknown> }).data.reply_mailbox_note).toBe('string');
        mockFetch.mockReset();
      }
    });

    const addressedBoth = { held: 'personal' as const, to: ['ceo@work.example.com'], cc: ['ceo@personal.example.com'] };
    async function expectFallback(opts: Parameters<typeof setup>[0], note?: RegExp) {
      const { ctx, posts } = setup(opts);
      const result = await handler.execute(ctx);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.grant).toBe(`grant-${opts.held}`);
      expect(result).toMatchObject({ success: true, data: { mailbox: opts.held, reply_mailbox_fallback: true } });
      if (note) expect((result as { data: { reply_mailbox_note: string } }).data.reply_mailbox_note).toMatch(note);
    }

    it('a draft already in the triaged mailbox answers a redirected retry; no second draft (SF-M3)', async () => {
      const { ctx, posts } = setup({ ...addressedBoth, givenDraft: true });
      const result = await handler.execute(ctx);
      expect(posts).toHaveLength(0);
      expect(result).toMatchObject({ success: true, data: { draft_id: 'draft-earlier', already_exists: true } });
    });

    it('falls back, never throws, when the mailbox registry cannot be read (SF-M2)', async () => {
      const { ctx, posts } = setup(addressedBoth);
      const pm = (ctx as unknown as { principalMailboxes: { principalEmailAddresses: () => Promise<string[]> } }).principalMailboxes;
      let calls = 0;
      pm.principalEmailAddresses = async () => { calls += 1; if (calls === 1) throw new Error('db down'); return []; };
      const result = await handler.execute(ctx);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.grant).toBe('grant-personal');
      expect(result).toMatchObject({ success: true, data: { reply_mailbox_fallback: true, reply_mailbox_note: expect.stringContaining('registry') } });
    });

    it('does not redirect on a Message-ID with no bracketed id, as triage does not dedupe it (BR-M9)', async () => {
      await expectFallback({ ...addressedBoth, originalMessageId: 'not-an-id>junk<' }, /no Message-ID/);
    });

    it('does not redirect to a copy from a different sender (forged)', async () => {
      await expectFallback({ ...addressedBoth, copy: { from: 'mallory@evil.example.org' } });
    });
    it('does not redirect to a Sent-folder hit', async () => {
      await expectFallback({ ...addressedBoth, copy: { folders: ['SENT'] } });
    });
    it('does not redirect to a Draft hit', async () => {
      await expectFallback({ ...addressedBoth, copy: { folders: ['DRAFT'] } });
    });
    it('does not redirect when the copy carries a different Message-ID', async () => {
      await expectFallback({ ...addressedBoth, copy: { messageId: 'other@mail.example.net' } });
    });
    it('does not redirect when two candidates match', async () => {
      await expectFallback({ ...addressedBoth, hits: ['msg-other', 'msg-other2'] });
    });
    it('does not search with an invalid Message-ID', async () => {
      const { ctx, searches, posts } = setup({ ...addressedBoth, originalMessageId: 'a"b:in:anywhere' });
      const result = await handler.execute(ctx);
      expect(searches).toHaveLength(0);
      expect(posts[0]!.grant).toBe('grant-personal');
      expect(result).toMatchObject({ success: true, data: { reply_mailbox_fallback: true } });
    });
    it('skips a search hit already in an excluded folder without fetching it (P10)', async () => {
      const { ctx, posts, gatewayGets } = setup({ ...addressedBoth, hitFolders: ['SENT'] });
      const result = await handler.execute(ctx);
      expect(posts[0]!.grant).toBe('grant-personal');
      expect(result).toMatchObject({ success: true, data: { reply_mailbox_fallback: true } });
      // Only the triaged copy's own headers were read; the Sent hit was never opened.
      expect(gatewayGets).toEqual(['personal']);
    });
    it('does not redirect to a copy with no From (P10)', async () => {
      await expectFallback({ ...addressedBoth, copy: { fromList: [] } }, /not found/);
    });
    it('compares senders as a set: a repeated From still matches (P10)', async () => {
      const { ctx, posts } = setup({ ...addressedBoth, copy: { fromList: ['alice@external.com', 'ALICE@external.com'] } });
      await handler.execute(ctx);
      expect(posts[0]!.grant).toBe('grant-work');
    });
    it.each(['a{b}@x.example', 'a|b@x.example', 'a*b@x.example', 'a?b@x.example', "a'b@x.example", 'a~b@x.example', 'a^b@x.example', 'a`b@x.example'])(
      'does not search with a Message-ID holding a query-widening character: %s (P10)',
      async (id) => {
        const { ctx, searches } = setup({ ...addressedBoth, originalMessageId: id });
        expect(await handler.execute(ctx)).toMatchObject({ success: true, data: { reply_mailbox_fallback: true } });
        expect(searches).toHaveLength(0);
      },
    );
    it('distinguishes not found from search failed in the note', async () => {
      await expectFallback({ ...addressedBoth, search: 'empty' }, /not found/);
      mockFetch.mockReset();
      await expectFallback({ ...addressedBoth, search: 'error' }, /search failed|unsupported/);
    });
    it('never redirects mail the principal sent from the other account', async () => {
      const { ctx, searches, posts, gatewayGets } = setup({ ...addressedBoth, from: 'CEO@work.example.com' });
      const result = await handler.execute(ctx);
      expect(searches).toHaveLength(0);
      expect(gatewayGets).toHaveLength(0);
      expect(posts[0]!.grant).toBe('grant-personal');
      expect((result as { data: Record<string, unknown> }).data.reply_mailbox_fallback).toBeUndefined();
    });
    it('the redirected draft cc excludes both mailbox addresses', async () => {
      const { ctx, posts } = setup({ ...addressedBoth, to: ['ceo@work.example.com', 'ceo@personal.example.com'], cc: ['dana@example.org'] });
      const result = await handler.execute(ctx);
      expect(result).toMatchObject({ success: true, data: { mailbox: 'work' } });
      expect((posts[0]!.body as { cc: Array<{ email: string }> }).cc.map((p) => p.email)).toEqual(['dana@example.org']);
    });

    it('keeps an explicit mailbox without searching', async () => {
      const { ctx, posts, searches, gatewayGets } = setup({ held: 'personal', to: ['ceo@work.example.com'], mailboxInput: 'personal' });
      const result = await handler.execute(ctx);
      expect(searches).toHaveLength(0);
      expect(gatewayGets).toHaveLength(0);
      expect(posts[0]!.grant).toBe('grant-personal');
      expect(result).toMatchObject({ success: true, data: { mailbox: 'personal' } });
    });

    it('makes no extra calls when the message is already in the addressed mailbox', async () => {
      const { ctx, searches, gatewayGets } = setup({ held: 'work', to: ['ceo@work.example.com'], cc: ['ceo@personal.example.com'] });
      await handler.execute(ctx);
      expect(searches).toHaveLength(0);
      expect(gatewayGets).toHaveLength(0);
    });

    it('makes no extra calls on a single-mailbox install', async () => {
      const gatewayGets: string[] = [];
      const searches: string[] = [];
      const ctx = buildCtx();
      mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const u = new URL(String(url));
        const method = (init?.method ?? 'GET').toUpperCase();
        if (u.searchParams.has('search_query_native')) searches.push(String(url));
        if (u.pathname.includes('/messages/')) {
          return new Response(JSON.stringify(buildNylasMessage({ from: [{ email: 'alice@external.com' }], to: [{ email: 'ceo@example.com' }] })), { status: 200 });
        }
        if (u.pathname.endsWith('/drafts') && method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 });
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(searches).toHaveLength(0);
      expect(gatewayGets).toHaveLength(0);
    });

    it('the redirected draft reads as Curia\'s: provenance keys on the drafted mailbox', async () => {
      const { ctx } = setup({ held: 'personal', to: ['ceo@work.example.com'], cc: ['ceo@personal.example.com'] });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const row = {
        id: 'r1', timestamp: new Date(Date.now() - 1000), eventType: 'tool.result', sourceLayer: 'execution', sourceId: 'ceo-inbox',
        conversationId: null, taskId: null, parentEventId: null,
        payload: { toolName: 'ceo-inbox-draft-reply', result },
        action: null, outcome: null, targetType: 'skill', targetId: 'ceo-inbox-draft-reply',
        initiatorType: null, initiatorId: null, entryHash: null,
      } as unknown as AuditLogRow;
      const repo = { findToolResults: vi.fn().mockResolvedValue([row]), findToolResultsForTasks: vi.fn().mockResolvedValue([]) };
      const prov = new DraftProvenance(repo, pino({ level: 'silent' }), () => new Date(), async () => 'work');
      const created = await prov.createdByCuria([{ mailbox: 'work', draftId: 'draft-1' }, { mailbox: 'personal', draftId: 'draft-1' }]);
      expect(created).toEqual(new Set(['work:draft-1']));
    });
  });
});
