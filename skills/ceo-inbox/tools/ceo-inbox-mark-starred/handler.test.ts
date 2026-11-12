// handler.test.ts — unit tests for ceo-inbox-mark-starred skill.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CeoInboxMarkStarredHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';
import { stubPrincipalMailboxes, twoMailboxFixture } from '../../../_shared/principal-mailboxes-test-helpers.js';

function makeCtx(overrides?: Partial<ToolContext> & { input?: Record<string, unknown> }): ToolContext {
  return {
    input: { message_id: 'msg-123' },
    principalMailboxes: stubPrincipalMailboxes({}),
    log: createSilentLogger(),
    taskMetadata: {},
    taskEventId: undefined,
    ...overrides,
  } as unknown as ToolContext;
}

/** The locate probe: one GET of the message in the mailbox that holds it. */
function probe(): Response {
  return new Response(JSON.stringify({ data: { id: 'msg-123' } }), { status: 200 });
}

describe('CeoInboxMarkStarredHandler', () => {
  // Guarantees spy cleanup even when a test assertion throws before mockRestore()
  afterEach(() => vi.restoreAllMocks());

  it('returns error when message_id is missing', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const result = await handler.execute(makeCtx({ input: {} }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('message_id');
  });

  it('calls markAsStarred with starred=true by default and returns success', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(probe()).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'msg-123', unread: false, starred: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      message_id: 'msg-123',
      starred: true,
      mailbox: 'work',
      mailbox_label: 'Work',
    });

    fetchSpy.mockRestore();
  });

  it('returns error when the Nylas API call fails', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(probe()).mockRejectedValueOnce(
      new Error('Network failure'),
    );

    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Failed to mark message as starred');

    fetchSpy.mockRestore();
  });

  it('passes starred=false when explicitly set to false', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(probe()).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'msg-123', starred: false } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await handler.execute(makeCtx({ input: { message_id: 'msg-123', starred: false } }));
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      message_id: 'msg-123',
      starred: false,
      mailbox: 'work',
      mailbox_label: 'Work',
    });

    // Verify the PUT body contained starred: false
    const body = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
    expect(body.starred).toBe(false);

    fetchSpy.mockRestore();
  });

  it('accepts starred="false" (string) and unstarred the message', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(probe()).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'msg-123', starred: false } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await handler.execute(makeCtx({ input: { message_id: 'msg-123', starred: 'false' } }));
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      message_id: 'msg-123',
      starred: false,
      mailbox: 'work',
      mailbox_label: 'Work',
    });

    const body = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
    expect(body.starred).toBe(false);
  });

  it('accepts starred="true" (string) and stars the message', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(probe()).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'msg-123', starred: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await handler.execute(makeCtx({ input: { message_id: 'msg-123', starred: 'true' } }));
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      message_id: 'msg-123',
      starred: true,
      mailbox: 'work',
      mailbox_label: 'Work',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2); // the locate probe, then the PUT
  });

  it('returns error for non-boolean starred value', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const result = await handler.execute(makeCtx({ input: { message_id: 'msg-123', starred: 42 } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('starred must be a boolean');
  });
});

describe('CeoInboxMarkStarredHandler mailbox selection (#2475)', () => {
  afterEach(() => vi.restoreAllMocks());

  function run(holders: Array<'work' | 'personal'>, extra: Record<string, unknown> = {}) {
    const f = twoMailboxFixture(holders);
    vi.spyOn(globalThis, 'fetch').mockImplementation(f.fetchStub as typeof fetch);
    const ctx = {
      input: { message_id: 'x1', ...extra }, principalMailboxes: f.principalMailboxes,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ToolContext;
    return { f, result: new CeoInboxMarkStarredHandler().execute(ctx) };
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
