import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxDraftReplyHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

// Helper to build a minimal mock SkillContext
function buildCtx(overrides: Partial<{
  reply_to_message_id: string;
  body: string;
}>= {}): SkillContext {
  const input = {
    reply_to_message_id: overrides.reply_to_message_id ?? 'msg-001',
    body: overrides.body ?? 'Thanks for reaching out.',
  };

  return {
    input,
    secret(key: string): string {
      switch (key) {
        case 'nylas_api_key': return 'test-api-key';
        case 'ceo_nylas_grant_id': return 'test-grant-id';
        case 'ceo_self_email': return 'ceo@example.com';
        default: return '';
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

// Helper to build a Nylas API message response
function buildNylasMessage(opts: {
  from: Array<{ email: string; name?: string }>;
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
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
      folders: ['INBOX'],
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
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  it('Case 1: Happy path — reply-all with correct to and cc', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com', name: 'Alice' }],
      to: [{ email: 'bob@example.com' }],
      cc: [{ email: 'charlie@example.com' }],
    });

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
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
      (call) => String(call[0]).includes('/drafts'),
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
  });

  it('Case 2: CEO in To of original — filtered from reply CC', async () => {
    const messageResponse = buildNylasMessage({
      from: [{ email: 'alice@external.com' }],
      to: [{ email: 'ceo@example.com' }],
      cc: [{ email: 'bob@example.com' }],
    });

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
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
      (call) => String(call[0]).includes('/drafts'),
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

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
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
      (call) => String(call[0]).includes('/drafts'),
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

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
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
      (call) => String(call[0]).includes('/drafts'),
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

    mockFetch.mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/messages/msg-001')) {
        return new Response(JSON.stringify(messageResponse), { status: 200 });
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
      (call) => String(call[0]).includes('/drafts'),
    );
    expect(draftCall).toBeDefined();

    const draftBody = JSON.parse(draftCall![1]!.body as string);

    // Must NOT double the "Re: " prefix
    expect(draftBody.subject).toBe('Re: Checking Account & Credit Card');
  });

  it('Case 6: getMessage fails — returns { success: false }', async () => {
    mockFetch.mockImplementation(async (url) => {
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

  it('Case 7: Empty selfEmail secret — returns { success: false }', async () => {
    // Mock fetch to throw if called — confirms no network call is made when the secret is missing
    mockFetch.mockImplementation(async () => {
      throw new Error('fetch should not be called when ceo_self_email is empty');
    });

    // Build a ctx where ceo_self_email returns an empty string
    const ctx: SkillContext = {
      input: {
        reply_to_message_id: 'msg-001',
        body: 'Thanks for reaching out.',
      },
      secret(key: string): string {
        switch (key) {
          case 'nylas_api_key': return 'test-api-key';
          case 'ceo_nylas_grant_id': return 'test-grant-id';
          case 'ceo_self_email': return '';   // deliberately empty
          default: return '';
        }
      },
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      // Error message must reference the misconfigured secret so it is diagnosable
      const lower = result.error.toLowerCase();
      expect(
        lower.includes('ceo_self_email') || lower.includes('configuration error'),
      ).toBe(true);
    }

    // Confirm fetch was never called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Case 8: Empty from — returns { success: false } with error-level log', async () => {
    // Message exists but has no sender (from: [])
    const messageResponse = buildNylasMessage({
      from: [],
      to: [{ email: 'ceo@example.com' }],
      cc: [],
    });

    mockFetch.mockImplementation(async (url) => {
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
      (call) => String(call[0]).includes('/drafts'),
    );
    expect(draftCall).toBeUndefined();
  });
});
