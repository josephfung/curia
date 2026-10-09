import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxDraftComposeHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { IdentifierSources } from '../../../../src/contacts/identifier-provenance.js';
import {
  recipientContext,
  seedDraftRecipients,
  sourcesWith,
  type DraftRecipientFixture,
} from '../../../_shared/ceo-draft-recipients-test-helpers.js';
import { readFile, realpath } from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
}));
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockRealpath = realpath as ReturnType<typeof vi.fn>;

let fixture: DraftRecipientFixture;

function buildCtx(input?: Record<string, unknown>, sources: IdentifierSources = sourcesWith()): ToolContext {
  return {
    toolName: 'ceo-inbox-draft-compose',
    toolVersion: '0.4.0',
    input: input ?? {
      to: [fixture.aliceId],
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
    ...recipientContext(fixture, sources),
  } as unknown as ToolContext;
}

const DRAFT_RESPONSE = {
  data: {
    id: 'draft-compose-1',
    subject: 'Hello from CEO',
    to: [{ name: 'Alice Archer', email: 'alice@example.com' }],
    cc: [],
  },
};

/** The JSON payload of the first Nylas call. */
function sentPayload(mockFetch: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const [, init] = mockFetch.mock.calls[0]!;
  return JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
}

describe('CeoInboxDraftComposeHandler', () => {
  let handler: CeoInboxDraftComposeHandler;
  let mockFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fixture = await seedDraftRecipients();
    handler = new CeoInboxDraftComposeHandler();
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

    const body = sentPayload(mockFetch);
    expect(body.reply_to_message_id).toBeUndefined();
    expect(body.subject).toBe('Hello from CEO');
  });

  it('Case 5: No To recipient — returns { success: false }', async () => {
    const ctx = buildCtx({ to: [], to_addresses: [], subject: 'Hello', body: 'Hi.' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('to_addresses');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Case 6: Missing subject — returns { success: false }', async () => {
    const ctx = buildCtx({ to: [fixture.aliceId], subject: '', body: 'Hi.' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('subject');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Case 7: Missing body — returns { success: false }', async () => {
    const ctx = buildCtx({ to: [fixture.aliceId], subject: 'Hello', body: '' });
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

  it('Case 9: Body converted from markdown to HTML with clickable links', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
    );

    const ctx = buildCtx({
      to: [fixture.aliceId],
      subject: 'Hello',
      body: '**Bold text** and [profile](https://example.com/profile)',
    });
    await handler.execute(ctx);

    const body = sentPayload(mockFetch);
    // markdownToHtml should produce HTML tags from the markdown input
    expect(body.body).toContain('<strong>Bold text</strong>');
    expect(body.body).toContain('<a href="https://example.com/profile"');
    expect(body.body).toContain('>profile</a>');
  });

  it('Case 10: No CC field in payload when cc is empty', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
    );

    const ctx = buildCtx({
      to: [fixture.aliceId],
      subject: 'Hello',
      body: 'Hi.',
    });
    await handler.execute(ctx);

    // cc should be absent when not provided (not an empty array)
    expect(sentPayload(mockFetch).cc).toBeUndefined();
  });

  it('Case 11: Body exceeds max length — returns { success: false }', async () => {
    const ctx = buildCtx({
      to: [fixture.aliceId],
      subject: 'Hello',
      body: 'x'.repeat(50_001),
    });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('50000');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Case 13: Missing secret throws — returns { success: false } without calling Nylas', async () => {
    const ctx: ToolContext = {
      ...buildCtx(),
      secret(key: string): string {
        throw new Error(`secret '${key}' is not configured`);
      },
    } as unknown as ToolContext;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('configured');
    // No Nylas call should have been made
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Recipients by reference, raw addresses by provenance (#2053, ADR-047).
  describe('recipients', () => {
    function ok(): void {
      mockFetch.mockResolvedValue(new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }));
    }

    function refused(result: Awaited<ReturnType<CeoInboxDraftComposeHandler['execute']>>): string {
      expect(result.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
      return (result as { error: string }).error;
    }

    it('saves a referenced contact with their display name', async () => {
      ok();
      const result = await handler.execute(buildCtx({ to: [fixture.aliceId], subject: 'Hello', body: 'Hi.' }));

      expect(result.success).toBe(true);
      expect(sentPayload(mockFetch).to).toEqual([{ name: 'Alice Archer', email: 'alice@example.com' }]);
    });

    it('resolves cc references and the principal alias; a contact with two addresses gets the primary', async () => {
      ok();
      const result = await handler.execute(buildCtx({
        to: [fixture.sanjayId],
        cc: ['principal', fixture.aliceId],
        subject: 'Hello',
        body: 'Hi.',
      }));

      expect(result.success).toBe(true);
      const payload = sentPayload(mockFetch);
      expect(payload.to).toEqual([{ name: 'Sanjay Rao', email: 'sanjay@work.example' }]);
      expect(payload.cc).toEqual([
        { name: 'Pat Principal', email: 'pat@home.example' },
        { name: 'Alice Archer', email: 'alice@example.com' },
      ]);
    });

    it('refuses a reference that matches no contact, and saves nothing', async () => {
      const error = refused(await handler.execute(buildCtx({
        to: ['4fdfd02a-1466-46ca-b37b-13bb564fe3f0'], subject: 'Hello', body: 'Hi.',
      })));
      expect(error).toContain('No contact has ID');
      expect(error).toContain('No draft was saved.');
      // Points at the raw path for someone with no verified email on file.
      expect(error).toContain('to_addresses');
    });

    it("refuses a sourced raw address that belongs to a blocked contact", async () => {
      const error = refused(await handler.execute(buildCtx({
        to_addresses: ['blake@example.com'], subject: 'Hello', body: 'Hi.',
      }, sourcesWith('blake@example.com'))));
      expect(error).toContain('blocked contact');
      expect(error).not.toContain('blake@example.com');
    });

    it('refuses a raw address when the blocked-contact check cannot run', async () => {
      const ctx = buildCtx({ to_addresses: ['jordan@quillfeather.example'], subject: 'Hello', body: 'Hi.' }, sourcesWith('jordan@quillfeather.example'));
      vi.spyOn(fixture.contacts, 'resolveByChannelIdentity').mockRejectedValue(new Error('db down'));
      const error = refused(await handler.execute(ctx));
      expect(error).toContain('could not be checked');
    });

    it('refuses a blocked contact, and saves nothing', async () => {
      const error = refused(await handler.execute(buildCtx({
        to: [fixture.aliceId], cc: [fixture.blockedId], subject: 'Hello', body: 'Hi.',
      })));
      expect(error).toContain('blocked');
    });

    it('refuses a contact with no verified email, and never echoes the unverified address', async () => {
      const error = refused(await handler.execute(buildCtx({
        to: [fixture.unverifiedId], subject: 'Hello', body: 'Hi.',
      })));
      expect(error).toContain('no verified, active email address');
      expect(error).not.toContain('uma@example.com');
    });

    it('refuses an address in to and points at to_addresses', async () => {
      const error = refused(await handler.execute(buildCtx({
        to: ['alice@example.com'], subject: 'Hello', body: 'Hi.',
      })));
      expect(error).toContain('to_addresses');
      expect(error).not.toContain('alice@example.com');
    });

    it('accepts a raw address that has a source, including a mailing list, with no display name', async () => {
      ok();
      const sources = sourcesWith('Jordan@Quillfeather.example', 'board-list@groups.example');
      const result = await handler.execute(buildCtx({
        to_addresses: ['jordan@quillfeather.example'],
        cc_addresses: ['board-list@groups.example'],
        subject: 'Hello',
        body: 'Hi.',
      }, sources));

      expect(result.success).toBe(true);
      const payload = sentPayload(mockFetch);
      expect(payload.to).toEqual([{ email: 'jordan@quillfeather.example' }]);
      expect(payload.cc).toEqual([{ email: 'board-list@groups.example' }]);
    });

    it('refuses a raw address with no source — a typo of a sourced one — and saves nothing', async () => {
      const sources = sourcesWith('jordan@quillfeather.example');
      const error = refused(await handler.execute(buildCtx({
        to_addresses: ['jordan@quilfeather.example'], subject: 'Hello', body: 'Hi.',
      }, sources)));
      expect(error).toContain('to_addresses entry 1');
      expect(error).toContain('No draft was saved.');
      expect(error).not.toContain('quilfeather');
    });

    it('refuses the whole draft when one of several raw addresses has no source', async () => {
      const sources = sourcesWith('jordan@quillfeather.example');
      const error = refused(await handler.execute(buildCtx({
        to: [fixture.aliceId],
        to_addresses: ['jordan@quillfeather.example'],
        cc_addresses: ['invented@nowhere.example'],
        subject: 'Hello',
        body: 'Hi.',
      }, sources)));
      expect(error).toContain('cc_addresses entry 1');
    });

    it('refuses a raw address when the call has no sources at all', async () => {
      const ctx = buildCtx({ to_addresses: ['jordan@quillfeather.example'], subject: 'Hello', body: 'Hi.' });
      delete (ctx as { identifierSources?: unknown }).identifierSources;
      refused(await handler.execute(ctx));
    });

    it('refuses a contact reference in to_addresses', async () => {
      const error = refused(await handler.execute(buildCtx({
        to_addresses: [fixture.aliceId], subject: 'Hello', body: 'Hi.',
      })));
      expect(error).toContain('a contact ID goes in to');
    });

    it('keeps one entry for a recipient named twice, and drops a Cc that is already on To', async () => {
      ok();
      const sources = sourcesWith('alice@example.com');
      const result = await handler.execute(buildCtx({
        to: [fixture.aliceId],
        to_addresses: ['alice@example.com'],
        cc: [fixture.aliceId],
        subject: 'Hello',
        body: 'Hi.',
      }, sources));

      expect(result.success).toBe(true);
      const payload = sentPayload(mockFetch);
      expect(payload.to).toEqual([{ name: 'Alice Archer', email: 'alice@example.com' }]);
      expect(payload.cc).toBeUndefined();
    });

    it('refuses a malformed recipient input rather than dropping it', async () => {
      const error = refused(await handler.execute(buildCtx({
        to: [fixture.aliceId], cc: [123], subject: 'Hello', body: 'Hi.',
      })));
      expect(error).toContain('cc must be');
    });

    it('refuses more than 25 recipients', async () => {
      const error = refused(await handler.execute(buildCtx({
        to: Array.from({ length: 26 }, () => fixture.aliceId), subject: 'Hello', body: 'Hi.',
      })));
      expect(error).toContain('Too many recipients');
    });
  });

  describe('attachments', () => {
    it('uses multipart FormData when attachments are provided', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('pdf content'));
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
      );

      const ctx = buildCtx({
        to: [fixture.aliceId],
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
        to: [fixture.aliceId],
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
        to: [fixture.aliceId],
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

    it('returns error when more than 10 attachments are provided', async () => {
      const ctx = buildCtx({
        to: [fixture.aliceId],
        subject: 'Hello',
        body: 'Hi',
        attachments: Array.from({ length: 11 }, (_, i) => ({
          file_url: `file:///tmp/file${i}.pdf`,
          filename: `file${i}.pdf`,
          content_type: 'application/pdf',
        })),
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('Attachment error');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns error when attachments exceed the 20 MB total size limit', async () => {
      // Two 11 MB buffers = 22 MB > 20 MB limit
      mockReadFile.mockResolvedValue(Buffer.alloc(11 * 1024 * 1024));
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(DRAFT_RESPONSE), { status: 200 }),
      );

      const ctx = buildCtx({
        to: [fixture.aliceId],
        subject: 'Hello',
        body: 'Hi',
        attachments: [
          { file_url: 'file:///tmp/a.pdf', filename: 'a.pdf', content_type: 'application/pdf' },
          { file_url: 'file:///tmp/b.pdf', filename: 'b.pdf', content_type: 'application/pdf' },
        ],
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('Attachment error');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
