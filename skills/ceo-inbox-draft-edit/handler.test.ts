import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeoInboxDraftEditHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function buildCtx(input: Record<string, unknown>): SkillContext {
  return {
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
  } as unknown as SkillContext;
}

// Raw Nylas draft as returned by PUT /drafts/{id}.
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

describe('CeoInboxDraftEditHandler (#1000)', () => {
  let handler: CeoInboxDraftEditHandler;
  let mockFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handler = new CeoInboxDraftEditHandler();
    mockFetch = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  it('updates to/subject/body and returns the updated draft (round-trip)', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(draftResponse()), { status: 200 }));

    const ctx = buildCtx({
      draft_id: 'draft-1',
      to: ['corrected@example.com'],
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

    const sent = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(typeof sent.body).toBe('string');
    expect(sent.body as string).toContain('Updated body');
    expect(sent.body as string).toContain('<'); // HTML, not raw markdown
  });

  it('sends only the fields the caller provided (subject-only update)', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(draftResponse()), { status: 200 }));

    const ctx = buildCtx({ draft_id: 'draft-1', subject: 'New subject only' });
    await handler.execute(ctx);

    const sent = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent).toHaveProperty('subject', 'New subject only');
    // No to/cc/body keys — omitted fields must not blank out the draft.
    expect(sent).not.toHaveProperty('to');
    expect(sent).not.toHaveProperty('cc');
    expect(sent).not.toHaveProperty('body');
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

  it('rejects an invalid recipient email', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', to: ['not-an-email'] });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not-an-email') });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed cc value (number) instead of silently clearing CC', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', cc: 123 });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a cc array containing non-string entries', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', cc: ['ok@example.com', 5] });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a to array containing non-string entries (no silent drop)', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', to: ['ok@example.com', 5] });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a non-string subject even when another field is valid (no silent skip)', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', to: ['ok@example.com'], subject: 123 });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a non-string body even when another field is valid', async () => {
    const ctx = buildCtx({ draft_id: 'draft-1', to: ['ok@example.com'], body: 123 });
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

  it('clears cc when an explicit empty array is provided', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(draftResponse({ cc: [] })), { status: 200 }));

    const ctx = buildCtx({ draft_id: 'draft-1', cc: [] });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const sent = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent).toHaveProperty('cc');
    expect(sent.cc).toEqual([]);
  });

  it('returns a structured error when the Nylas API call fails', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 404 }));
    const ctx = buildCtx({ draft_id: 'missing', subject: 'x' });
    const result = await handler.execute(ctx);
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
  });
});
