import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxDraftEditHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { IdentifierSources } from '../../../../src/contacts/identifier-provenance.js';
import {
  recipientContext,
  seedDraftRecipients,
  sourcesWith,
  type DraftRecipientFixture,
} from '../../../_shared/ceo-draft-recipients-test-helpers.js';

let fixture: DraftRecipientFixture;

function buildCtx(input: Record<string, unknown>, sources: IdentifierSources = sourcesWith()): ToolContext {
  return {
    toolName: 'ceo-inbox-draft-edit',
    toolVersion: '0.3.0',
    input,
    timezone: 'America/Toronto',
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
    ...recipientContext(fixture, sources),
  } as unknown as ToolContext;
}

// Raw Nylas draft as returned by GET or PUT /drafts/{id}.
function draftResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'draft-1',
      thread_id: 't1',
      subject: 'Corrected subject',
      to: [{ email: 'corrected@example.com' }],
      cc: [],
      bcc: [],
      body: '<p>Updated body</p>',
      snippet: 'Updated body',
      date: 1_700_000_000,
      ...overrides,
    },
  };
}

/** The JSON body of the PUT that updated the draft. */
function putPayload(mockFetch: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const put = mockFetch.mock.calls.find((call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'PUT');
  expect(put).toBeDefined();
  return JSON.parse((put![1] as RequestInit).body as string) as Record<string, unknown>;
}

describe('CeoInboxDraftEditHandler (#1000)', () => {
  let handler: CeoInboxDraftEditHandler;
  let mockFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fixture = await seedDraftRecipients();
    handler = new CeoInboxDraftEditHandler();
    mockFetch = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  it('updates subject/body and returns the updated draft (round-trip)', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(draftResponse()), { status: 200 }));

    const ctx = buildCtx({
      draft_id: 'draft-1',
      subject: 'Corrected subject',
      body: 'Updated body',
    });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      draft_id: 'draft-1',
      subject: 'Corrected subject',
      to: [{ name: undefined, email: 'corrected@example.com' }],
    });

    // Verify it hit PUT /drafts/{id}
    const call = mockFetch.mock.calls[0]!;
    const url = new URL(call[0] as string);
    const init = call[1] as RequestInit;
    expect(url.pathname.endsWith('/drafts/draft-1')).toBe(true);
    expect(init.method).toBe('PUT');
  });

  it('converts the markdown body to HTML before sending', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(draftResponse()), { status: 200 }));

    const ctx = buildCtx({ draft_id: 'draft-1', body: 'Updated body' });
    await handler.execute(ctx);

    const sent = putPayload(mockFetch);
    expect(typeof sent.body).toBe('string');
    expect(sent.body as string).toContain('Updated body');
    expect(sent.body as string).toContain('<'); // HTML, not raw markdown
  });

  it('sends only the fields the caller provided (subject-only update)', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(draftResponse()), { status: 200 }));

    const ctx = buildCtx({ draft_id: 'draft-1', subject: 'New subject only' });
    await handler.execute(ctx);

    const sent = putPayload(mockFetch);
    expect(sent).toHaveProperty('subject', 'New subject only');
    // No to/cc/body keys — omitted fields must not blank out the draft.
    expect(sent).not.toHaveProperty('to');
    expect(sent).not.toHaveProperty('cc');
    expect(sent).not.toHaveProperty('body');
    // A subject-only edit does not read the draft first.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects when draft_id is missing', async () => {
    const ctx = buildCtx({ subject: 'x' });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects when no updatable field is provided', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1' });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed recipient value (number) instead of ignoring it', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', add_cc: 123 });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('add_cc') });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a recipient array containing non-string entries (no silent drop)', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', remove: ['ok@example.com', 5] });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('remove') });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a non-string subject even when another field is valid (no silent skip)', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', add_to: [fixture.aliceId], subject: 123 });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a non-string body even when another field is valid', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', add_to: [fixture.aliceId], body: 123 });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only subject instead of silently clearing it', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', subject: '   ' });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only body', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', body: '   ' });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns a structured error when the Nylas API call fails', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 404 }));
    const ctx = buildCtx({ draft_id: 'missing', subject: 'x' });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
  });

  // One recipient at a time (#2053, ADR-047). The draft as stored is read first; the
  // PUT carries the full new lists, so everyone not named keeps their entry.
  describe('recipients', () => {
    const STORED = {
      to: [
        { name: 'Alice Archer', email: 'alice@example.com' },
        { name: 'Jordan Avery', email: 'Jordan@Quillfeather.example' },
      ],
      cc: [{ name: 'Board List', email: 'board-list@groups.example' }],
    };

    /** GET returns the stored draft; PUT echoes what was sent. */
    function serveDraft(stored: Record<string, unknown> = STORED): void {
      mockFetch.mockImplementation(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const sent = JSON.parse(init.body as string) as Record<string, unknown>;
          return new Response(JSON.stringify(draftResponse({ ...stored, ...sent })), { status: 200 });
        }
        return new Response(JSON.stringify(draftResponse(stored)), { status: 200 });
      });
    }

    function refusedUnchanged(result: Awaited<ReturnType<CeoInboxDraftEditHandler['execute']>>): string {
      expect(result.success).toBe(false);
      const put = mockFetch.mock.calls.find((call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put).toBeUndefined();
      return (result as { error: string }).error;
    }

    it('adds one contact by reference and leaves everyone else, names included, as stored', async () => {
      serveDraft();
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', add_cc: [fixture.sanjayId] }));

      expect(result.success).toBe(true);
      const sent = putPayload(mockFetch);
      expect(sent.to).toEqual(STORED.to);
      expect(sent.cc).toEqual([...STORED.cc, { name: 'Sanjay Rao', email: 'sanjay@work.example' }]);
    });

    it('removes one recipient by the address on the draft, ignoring case, and keeps the rest', async () => {
      serveDraft();
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', remove: ['jordan@quillfeather.example'] }));

      expect(result.success).toBe(true);
      const sent = putPayload(mockFetch);
      expect(sent.to).toEqual([STORED.to[0]]);
      expect(sent.cc).toEqual(STORED.cc);
    });

    it('removes a contact by reference, matching any of their email addresses', async () => {
      serveDraft({ to: [{ email: 'sanjay@home.example' }, STORED.to[0]], cc: [] });
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', remove: [fixture.sanjayId] }));

      expect(result.success).toBe(true);
      expect(putPayload(mockFetch).to).toEqual([STORED.to[0]]);
    });

    it('refuses to remove an address that is not on the draft — a typo fails closed', async () => {
      serveDraft();
      const error = refusedUnchanged(await handler.execute(buildCtx({
        draft_id: 'draft-1', remove: ['jordan@quilfeather.example'],
      })));
      expect(error).toContain('remove entry 1 is not on this draft');
    });

    it('swaps a wrong recipient for the right contact in one call', async () => {
      serveDraft();
      const result = await handler.execute(buildCtx({
        draft_id: 'draft-1', remove: ['jordan@quillfeather.example'], add_to: [fixture.sanjayId],
      }));

      expect(result.success).toBe(true);
      expect(putPayload(mockFetch).to).toEqual([STORED.to[0], { name: 'Sanjay Rao', email: 'sanjay@work.example' }]);
    });

    it('accepts a raw address that has a source, with no display name', async () => {
      serveDraft();
      const result = await handler.execute(buildCtx(
        { draft_id: 'draft-1', add_cc_addresses: ['Sam.Patel@lakeshorecap.example'] },
        sourcesWith('sam.patel@lakeshorecap.example'),
      ));

      expect(result.success).toBe(true);
      expect(putPayload(mockFetch).cc).toEqual([...STORED.cc, { email: 'sam.patel@lakeshorecap.example' }]);
    });

    it('refuses a raw address with no source and that is not on the draft', async () => {
      serveDraft();
      const error = refusedUnchanged(await handler.execute(buildCtx({
        draft_id: 'draft-1', add_to_addresses: ['invented@nowhere.example'],
      })));
      expect(error).toContain('add_to_addresses entry 1');
      expect(error).toContain('The draft was not changed.');
    });

    it('moves a recipient already on the draft to the other line without a source, keeping their name', async () => {
      serveDraft();
      const result = await handler.execute(buildCtx({
        draft_id: 'draft-1', add_to_addresses: ['board-list@groups.example'],
      }));

      expect(result.success).toBe(true);
      const sent = putPayload(mockFetch);
      expect(sent.to).toEqual([...STORED.to, STORED.cc[0]]);
      expect(sent.cc).toEqual([]);
    });

    it("refuses to move a blocked contact's address that is already on the draft", async () => {
      serveDraft({ to: [STORED.to[0]], cc: [{ email: 'blake@example.com' }] });
      const error = refusedUnchanged(await handler.execute(buildCtx({
        draft_id: 'draft-1', add_to_addresses: ['blake@example.com'],
      })));
      expect(error).toContain('blocked contact');
    });

    it('moves a To recipient to Cc by reference', async () => {
      serveDraft();
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', add_cc: [fixture.aliceId] }));

      expect(result.success).toBe(true);
      const sent = putPayload(mockFetch);
      expect(sent.to).toEqual([STORED.to[1]]);
      expect(sent.cc).toEqual([...STORED.cc, { name: 'Alice Archer', email: 'alice@example.com' }]);
    });

    it('refuses a blocked contact, an unknown contact ID and an address in add_to', async () => {
      serveDraft();
      expect(refusedUnchanged(await handler.execute(buildCtx({ draft_id: 'draft-1', add_to: [fixture.blockedId] }))))
        .toContain('blocked');
      expect(refusedUnchanged(await handler.execute(buildCtx({
        draft_id: 'draft-1', add_to: ['4fdfd02a-1466-46ca-b37b-13bb564fe3f0'],
      })))).toContain('No contact has ID');
      expect(refusedUnchanged(await handler.execute(buildCtx({
        draft_id: 'draft-1', add_to: ['sanjay@work.example'],
      })))).toContain('add_to_addresses');
    });

    it('refuses an edit that would leave no To recipient', async () => {
      serveDraft();
      const error = refusedUnchanged(await handler.execute(buildCtx({
        draft_id: 'draft-1', remove: ['alice@example.com', 'jordan@quillfeather.example'],
      })));
      expect(error).toContain('no To recipient');
    });

    it('refuses the same recipient removed and added', async () => {
      serveDraft();
      const error = refusedUnchanged(await handler.execute(buildCtx({
        draft_id: 'draft-1', remove: [fixture.aliceId], add_cc: [fixture.aliceId],
      })));
      expect(error).toContain('both removed and added');
    });

    it('refuses the retired whole-list to and cc inputs, a blank one included', async () => {
      serveDraft();
      const error = refusedUnchanged(await handler.execute(buildCtx({ draft_id: 'draft-1', to: ['alice@example.com'] })));
      expect(error).toContain('to is no longer accepted');
      // `cc: []` once meant "clear the CC line"; it must not succeed as a no-op.
      expect(refusedUnchanged(await handler.execute(buildCtx({ draft_id: 'draft-1', cc: [], subject: 'New' }))))
        .toContain('cc is no longer accepted');
      expect(refusedUnchanged(await handler.execute(buildCtx({ draft_id: 'draft-1', cc: '', subject: 'New' }))))
        .toContain('cc is no longer accepted');
    });

    it('moves a contact who is on the other line under another of their addresses, keeping that entry', async () => {
      serveDraft({ to: [STORED.to[0], { email: 'sanjay@home.example' }], cc: [] });
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', add_cc: [fixture.sanjayId] }));

      expect(result.success).toBe(true);
      const sent = putPayload(mockFetch);
      expect(sent.to).toEqual([STORED.to[0]]);
      expect(sent.cc).toEqual([{ email: 'sanjay@home.example' }]);
    });

    it('does not add a contact already on the line under another of their addresses', async () => {
      serveDraft({ to: [STORED.to[0], { email: 'sanjay@home.example' }], cc: [] });
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', add_to: [fixture.sanjayId] }));

      expect(result.success).toBe(true);
      expect(putPayload(mockFetch).to).toEqual([STORED.to[0], { email: 'sanjay@home.example' }]);
    });

    it('changes the Cc of a draft that has no To yet', async () => {
      serveDraft({ to: [], cc: [] });
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', add_cc: [fixture.aliceId] }));

      expect(result.success).toBe(true);
      const sent = putPayload(mockFetch);
      expect(sent.to).toEqual([]);
      expect(sent.cc).toEqual([{ name: 'Alice Archer', email: 'alice@example.com' }]);
    });

    it('returns an error and changes nothing when the draft cannot be read', async () => {
      mockFetch.mockResolvedValue(new Response('nope', { status: 404 }));
      const error = refusedUnchanged(await handler.execute(buildCtx({ draft_id: 'missing', add_to: [fixture.aliceId] })));
      expect(error).toContain('Failed to read the draft');
    });
  });
});
