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
import { stubPrincipalMailboxes, twoMailboxes } from '../../../_shared/principal-mailboxes-test-helpers.js';

let fixture: DraftRecipientFixture;

function buildCtx(
  input: Record<string, unknown>,
  sources: IdentifierSources = sourcesWith(),
  principalMailboxes: ToolContext['principalMailboxes'] = stubPrincipalMailboxes({}),
): ToolContext {
  return {
    toolName: 'ceo-inbox-draft-edit',
    toolVersion: '0.3.0',
    input,
    timezone: 'America/Toronto',
    principalMailboxes,
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

/** Any GET or PUT answers with a fresh copy of the sample draft. */
function serveEverything(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(draftResponse()), { status: 200 }));
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
    serveEverything();

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

    // Verify it hit PUT /drafts/{id} (after locating the draft with a GET)
    const call = mockFetch.mock.calls.find((c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'PUT')!;
    const url = new URL(call[0] as string);
    const init = call[1] as RequestInit;
    expect(url.pathname.endsWith('/drafts/draft-1')).toBe(true);
    expect(init.method).toBe('PUT');
  });

  it('converts the markdown body to HTML before sending', async () => {
    serveEverything();

    const ctx = buildCtx({ draft_id: 'draft-1', body: 'Updated body' });
    await handler.execute(ctx);

    const sent = putPayload(mockFetch);
    expect(typeof sent.body).toBe('string');
    expect(sent.body as string).toContain('Updated body');
    expect(sent.body as string).toContain('<'); // HTML, not raw markdown
  });

  it('sends only the fields the caller provided (subject-only update)', async () => {
    serveEverything();

    const ctx = buildCtx({ draft_id: 'draft-1', subject: 'New subject only' });
    await handler.execute(ctx);

    const sent = putPayload(mockFetch);
    expect(sent).toHaveProperty('subject', 'New subject only');
    // No to/cc/body keys — omitted fields must not blank out the draft.
    expect(sent).not.toHaveProperty('to');
    expect(sent).not.toHaveProperty('cc');
    expect(sent).not.toHaveProperty('body');
    // A subject-only edit reads the draft only to find its mailbox (one GET), then one PUT.
    expect(mockFetch.mock.calls.map((c: unknown[]) => (c[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET', 'PUT']);
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

  // #2593: the draft is found (the locating GET succeeds, as a stale read did in prod), then the
  // write fails. Each status must reach the agent as its ErrorType, or a missing draft reads as a
  // generic failure and the agent retries it.
  describe('a failed update is classified by its Nylas status (#2593)', () => {
    /** GETs answer with the draft; the PUT answers with `status`. */
    function failPut(status: number): void {
      mockFetch.mockImplementation(async (_url: unknown, init?: RequestInit) =>
        init?.method === 'PUT'
          ? new Response('{"error":{"message":"nope"}}', { status })
          : new Response(JSON.stringify(draftResponse()), { status: 200 }),
      );
    }

    it('a 404 is NOT_FOUND, says not to retry with this ID, and logs the status', async () => {
      failPut(404);
      const ctx = buildCtx({ draft_id: 'draft-1', subject: 'x' });
      const result = await handler.execute(ctx);
      expect(result).toMatchObject({ success: false, errorType: 'NOT_FOUND' });
      const error = (result as { error: string }).error;
      expect(error).toContain('"draft-1"');
      expect(error).toContain('Do not retry with this ID');
      expect(ctx.log.error).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, draftId: 'draft-1' }), expect.any(String));
    });

    it('a 429 is RATE_LIMIT', async () => {
      failPut(429);
      // A near deadline makes the client fail fast instead of backing off for seconds.
      const ctx = { ...buildCtx({ draft_id: 'draft-1', subject: 'x' }), deadline: Date.now() + 200 } as ToolContext;
      const result = await handler.execute(ctx);
      expect(result).toMatchObject({ success: false, errorType: 'RATE_LIMIT' });
    });

    it('a 500 is PROVIDER_ERROR', async () => {
      failPut(500);
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', subject: 'x' }));
      expect(result).toMatchObject({ success: false, errorType: 'PROVIDER_ERROR' });
      expect((result as { error: string }).error).not.toContain('Do not retry');
    });

    it('any other status still carries an errorType', async () => {
      failPut(400);
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', subject: 'x' }));
      expect(result).toMatchObject({ success: false, errorType: 'VALIDATION_ERROR' });
    });

    it('a network failure (no status) is PROVIDER_ERROR', async () => {
      mockFetch.mockImplementation(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'PUT') throw new TypeError('fetch failed');
        return new Response(JSON.stringify(draftResponse()), { status: 200 });
      });
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', subject: 'x' }));
      expect(result).toMatchObject({ success: false, errorType: 'PROVIDER_ERROR' });
    });

    it('a 404 reading the draft for a recipient edit is NOT_FOUND too', async () => {
      // First GET (locating the draft) succeeds; the second (reading its recipients) is a 404.
      let gets = 0;
      mockFetch.mockImplementation(async () => {
        gets += 1;
        return gets === 1
          ? new Response(JSON.stringify(draftResponse()), { status: 200 })
          : new Response('{"error":{"message":"not found"}}', { status: 404 });
      });
      const result = await handler.execute(buildCtx({ draft_id: 'draft-1', add_to: [fixture.aliceId] }));
      expect(result).toMatchObject({ success: false, errorType: 'NOT_FOUND' });
      expect((result as { error: string }).error).toContain('Do not retry with this ID');
    });

    it('passes on the errorType when the draft is not found in a named mailbox', async () => {
      mockFetch.mockResolvedValue(new Response('{"error":{"message":"not found"}}', { status: 404 }));
      const result = await handler.execute(buildCtx({ draft_id: 'missing', subject: 'x', mailbox: 'work' }, sourcesWith(), twoMailboxes()));
      expect(result).toMatchObject({ success: false, errorType: 'NOT_FOUND' });
    });
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
      expect(error).toContain('No such draft');
    });
  });

  // Two mailboxes: `work` (default, grant-work) and `personal` (grant-personal) (#2475).
  describe('moving a draft between mailboxes', () => {
    interface Call { grant: string; method: string; path: string; body?: Record<string, unknown> }
    let calls: Call[];
    let store: Record<string, Record<string, Record<string, unknown>>>;
    let failCreate: boolean;
    let failDelete: boolean;
    let deleteStatus: number;

    const SOURCE = {
      id: 'src-1', thread_id: 'thread-1', reply_to_message_id: 'm1', subject: 'Audit follow-up',
      to: [{ name: 'Alice Archer', email: 'alice@example.com' }], cc: [{ email: 'cc@example.com' }], bcc: [],
      body: '<p>Original body</p>', snippet: 'Original body', date: 1_700_000_000,
    };

    function serveNylas(): void {
      mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const u = new URL(String(url));
        const grant = /\/grants\/([^/]+)/.exec(u.pathname)![1]!;
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = u.pathname.replace(/^.*\/grants\/[^/]+/, '');
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        calls.push({ grant, method, path, ...(body ? { body } : {}) });
        const drafts = store[grant] ?? {};
        const id = decodeURIComponent(path.split('/')[2] ?? '');
        const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
        if (method === 'POST') {
          if (failCreate) return new Response('boom', { status: 500 });
          const created = { id: 'new-1', thread_id: '', ...body };
          drafts['new-1'] = created;
          store[grant] = drafts;
          return json(created);
        }
        if (method === 'DELETE') {
          if (failDelete) return new Response('boom', { status: deleteStatus });
          delete drafts[id];
          return json({});
        }
        const found = drafts[id];
        if (!found) return new Response('{"error":{"message":"not found"}}', { status: 404 });
        if (method === 'PUT') {
          const updated = { ...found, ...body };
          drafts[id] = updated;
          return json(updated);
        }
        return json(found);
      });
    }

    const twoCtx = (input: Record<string, unknown>) => buildCtx(input, sourcesWith(), twoMailboxes());
    const methods = () => calls.map((c) => `${c.method} ${c.grant}`);

    beforeEach(() => {
      calls = [];
      failCreate = false;
      failDelete = false;
      deleteStatus = 500;
      store = { 'grant-work': { 'src-1': { ...SOURCE } }, 'grant-personal': {} };
      serveNylas();
    });

    it('moves and deletes the original only after create succeeds', async () => {
      const result = await handler.execute(twoCtx({ draft_id: 'src-1', move_to_mailbox: 'personal' }));

      expect(result.success).toBe(true);
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({
        draft_id: 'new-1',
        mailbox: 'personal',
        mailbox_label: 'Personal',
        moved_from: { mailbox: 'work', draft_id: 'src-1' },
        new_thread: true,
      });
      expect(String(data.note)).toContain('memory-store');
      expect(String(data.note).match(/\./g)).toHaveLength(1);
      expect(data).not.toHaveProperty('warning');
      // The create in the target comes before the delete in the source.
      const order = methods();
      expect(order.indexOf('POST grant-personal')).toBeGreaterThan(-1);
      expect(order.indexOf('DELETE grant-work')).toBeGreaterThan(order.indexOf('POST grant-personal'));
      const created = calls.find((c) => c.method === 'POST')!;
      expect(created.body).toMatchObject({
        subject: 'Audit follow-up',
        body: '<p>Original body</p>',
        to: [{ name: 'Alice Archer', email: 'alice@example.com' }],
        cc: [{ email: 'cc@example.com' }],
      });
      expect(store['grant-work']).not.toHaveProperty('src-1');
    });

    it('failed create leaves the original', async () => {
      failCreate = true;
      const result = await handler.execute(twoCtx({ draft_id: 'src-1', move_to_mailbox: 'personal' }));

      expect(result.success).toBe(false);
      expect(methods()).not.toContain('DELETE grant-work');
      expect(store['grant-work']).toHaveProperty('src-1');
    });

    it('a failed delete after a successful create is a success with a warning', async () => {
      failDelete = true;
      const result = await handler.execute(twoCtx({ draft_id: 'src-1', move_to_mailbox: 'personal' }));

      expect(result.success).toBe(true);
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({ draft_id: 'new-1', mailbox: 'personal', moved_from: { mailbox: 'work', draft_id: 'src-1' } });
      expect(String(data.warning)).toContain('original');
      expect(String(data.warning)).toContain('Work');
      expect(store['grant-work']).toHaveProperty('src-1');
    });

    it('a 404 deleting the original reads as deleted: no warning (SF11)', async () => {
      failDelete = true;
      deleteStatus = 404;
      const result = await handler.execute(twoCtx({ draft_id: 'src-1', move_to_mailbox: 'personal' }));
      expect(result.success).toBe(true);
      expect((result as { data: Record<string, unknown> }).data).not.toHaveProperty('warning');
    });

    it('refuses before creating anything when the call is nearly out of time or cancelled (SF11, S3)', async () => {
      const short = { ...twoCtx({ draft_id: 'src-1', move_to_mailbox: 'personal' }), deadline: Date.now() + 1_000 } as ToolContext;
      const result = await handler.execute(short);
      expect(result).toMatchObject({ success: false, error: expect.stringContaining("isn't enough time") });
      expect(methods().filter((m) => m.startsWith('POST') || m.startsWith('DELETE'))).toEqual([]);
      const aborted = new AbortController();
      aborted.abort();
      const cancelled = { ...twoCtx({ draft_id: 'src-1', move_to_mailbox: 'personal' }), signal: aborted.signal } as ToolContext;
      expect((await handler.execute(cancelled)).success).toBe(false);
      expect(store['grant-work']).toHaveProperty('src-1');
    });

    it('refuses a move to the mailbox the draft is already in and changes nothing', async () => {
      const result = await handler.execute(twoCtx({ draft_id: 'src-1', move_to_mailbox: 'work' }));

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('already in') });
      expect(methods()).not.toContain('POST grant-work');
      expect(methods().filter((m) => m.startsWith('DELETE') || m.startsWith('POST'))).toEqual([]);
    });

    it('refuses an unknown or removed target mailbox', async () => {
      const result = await handler.execute(twoCtx({ draft_id: 'src-1', move_to_mailbox: 'nope' }));

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('nope') });
      expect(methods().filter((m) => m.startsWith('DELETE') || m.startsWith('POST'))).toEqual([]);
    });

    it('applies the other edits of the call to the new draft', async () => {
      const result = await handler.execute(twoCtx({
        draft_id: 'src-1', move_to_mailbox: 'personal', subject: 'Taxes', body: 'New text', remove: ['cc@example.com'],
      }));

      expect(result.success).toBe(true);
      const created = calls.find((c) => c.method === 'POST')!;
      expect(created.body).toMatchObject({ subject: 'Taxes', to: [{ name: 'Alice Archer', email: 'alice@example.com' }] });
      expect(String(created.body!.body)).toContain('New text');
      expect(created.body).not.toHaveProperty('cc');
      // The original is not edited; it is deleted.
      expect(methods()).not.toContain('PUT grant-work');
    });

    it('refuses to move a draft with attachments rather than dropping them', async () => {
      store['grant-work']!['src-1'] = { ...SOURCE, attachments: [{ id: 'a1', filename: 'f.pdf', content_type: 'application/pdf', size: 10 }] };
      const result = await handler.execute(twoCtx({ draft_id: 'src-1', move_to_mailbox: 'personal' }));

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('attachment') });
      expect(methods().filter((m) => m.startsWith('DELETE') || m.startsWith('POST'))).toEqual([]);
    });

    it('a draft that is not a reply is not a reply (new_thread false, though Gmail gives it a thread id)', async () => {
      store['grant-work']!['src-1'] = { ...SOURCE, reply_to_message_id: '' };
      const result = await handler.execute(twoCtx({ draft_id: 'src-1', move_to_mailbox: 'personal' }));

      expect((result as { data: Record<string, unknown> }).data).toMatchObject({ new_thread: false });
    });

    it('edits a draft that exists only in the non-default mailbox, and says which mailbox', async () => {
      store['grant-work'] = {};
      store['grant-personal'] = { 'src-1': { ...SOURCE } };
      const result = await handler.execute(twoCtx({ draft_id: 'src-1', subject: 'Fixed' }));

      expect(result.success).toBe(true);
      expect((result as { data: Record<string, unknown> }).data).toMatchObject({ draft_id: 'src-1', mailbox: 'personal', subject: 'Fixed' });
      expect(methods()).toContain('PUT grant-personal');
      expect(methods()).not.toContain('PUT grant-work');
    });
  });
});
