import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { CeoInboxArchiveHandler } from './handler.js';
import { ExecutionLayer } from '../../../../src/skills/execution.js';
import { ToolRegistry } from '../../../../src/skills/registry.js';
import { sanitizeObjectOutput } from '../../../../src/skills/sanitize.js';
import type { ToolContext, ToolManifest } from '../../../../src/skills/types.js';
import { stubPrincipalMailboxes, twoMailboxFixture } from '../../../_shared/principal-mailboxes-test-helpers.js';

const logger = pino({ level: 'silent' });

function buildCtx(input: Record<string, unknown>, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    input,
    principalMailboxes: stubPrincipalMailboxes({}),
    log: logger,
    ...extra,
  } as unknown as ToolContext;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? { data } : { error: data }), { status });
}

/** The locate probe: one GET of the message in the mailbox that holds it. */
function probe(): Response {
  return jsonResponse({ id: 'm1', folders: [] });
}

/** The fetch calls made, as "METHOD /path". */
function calls(spy: MockInstance<typeof fetch>): string[] {
  return spy.mock.calls.map(([url, init]) => {
    const method = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return `${method} ${new URL(String(url)).pathname.replace(/^.*\/grants\/[^/]+/, '')}`;
  });
}

describe('CeoInboxArchiveHandler', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('archives by writing the folders back without INBOX', async () => {
    fetchSpy
      .mockResolvedValueOnce(probe())
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX', 'Label_3'] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['Label_3'] }));

    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: '19a2b3c4d5e6f708' }));

    expect(result.success).toBe(true);
    expect(calls(fetchSpy)).toEqual(['GET /messages/19a2b3c4d5e6f708', 'GET /messages/19a2b3c4d5e6f708', 'PUT /messages/19a2b3c4d5e6f708']);
    const putBody = JSON.parse(String((fetchSpy.mock.calls[2]![1] as RequestInit).body));
    expect(putBody).toEqual({ folders: ['Label_3'] });
  });

  it('does not send SENT back when archiving a message the principal sent (#2426)', async () => {
    fetchSpy
      .mockResolvedValueOnce(probe())
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX', 'SENT', 'Label_3'] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['SENT', 'Label_3'] }));

    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: '19a2b3c4d5e6f708' }));

    expect(result.success).toBe(true);
    const putBody = JSON.parse(String((fetchSpy.mock.calls[2]![1] as RequestInit).body));
    expect(putBody).toEqual({ folders: ['Label_3'] });
  });

  // The spot-check pool (#2159) reads these so a triage sample is gradable; the message is
  // already fetched, so they cost no extra call.
  it('returns the subject and sender of the message it archived', async () => {
    fetchSpy
      .mockResolvedValueOnce(probe())
      .mockResolvedValueOnce(jsonResponse({
        id: 'm1', folders: ['INBOX'], subject: 'Statement ready',
        from: [{ name: 'Billing', email: 'billing@example.com' }],
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: [] }));

    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: '19a2b3c4d5e6f708' }));

    expect(result).toEqual({
      success: true,
      data: { message_id: '19a2b3c4d5e6f708', subject: 'Statement ready', from: 'Billing (billing@example.com)', mailbox: 'work', mailbox_label: 'Work' },
    });
  });

  // Every skill result goes through sanitizeObjectOutput, which strips "<...>" as a tag. The
  // sender is rendered "Name (email)" so the address survives to the agent and the digest.
  it('reports a sender whose address survives the output sanitizer', async () => {
    fetchSpy
      .mockResolvedValueOnce(probe())
      .mockResolvedValueOnce(jsonResponse({
        id: 'm1', folders: ['INBOX'], subject: 'Statement ready',
        from: [{ name: 'Billing', email: 'billing@example.com' }],
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: [] }));

    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: '19a2b3c4d5e6f708' }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sanitized = sanitizeObjectOutput(result.data) as Record<string, unknown>;
    expect(sanitized['from']).toContain('billing@example.com');
  });

  // already_archived marks the no-op, so the spot-check pool does not ask the principal to
  // grade an action that changed nothing (#2159).
  it('returns the subject and sender, marked already_archived, when the message was already archived', async () => {
    fetchSpy.mockResolvedValueOnce(probe()).mockResolvedValueOnce(jsonResponse({
      id: 'm1', folders: ['Label_3'], subject: 'Statement ready',
      from: [{ email: 'billing@example.com' }],
    }));

    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: '19a2b3c4d5e6f708' }));

    expect(result).toEqual({
      success: true,
      data: { message_id: '19a2b3c4d5e6f708', subject: 'Statement ready', from: 'billing@example.com', already_archived: true, mailbox: 'work', mailbox_label: 'Work' },
    });
    expect(calls(fetchSpy)).toEqual(['GET /messages/19a2b3c4d5e6f708', 'GET /messages/19a2b3c4d5e6f708']);
  });

  it('omits a subject or sender the message does not have', async () => {
    fetchSpy
      .mockResolvedValueOnce(probe())
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: [] }));

    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: '19a2b3c4d5e6f708' }));

    expect(result).toEqual({ success: true, data: { message_id: '19a2b3c4d5e6f708', mailbox: 'work', mailbox_label: 'Work' } });
  });

  // The two malformed IDs from the prod audit_log behind #2083.
  it.each([
    ['9b359f65-placeholder', /placeholder text/],
    ['1a102a493eca2fc54', /17 hex digits/],
  ])('rejects %s before any Nylas call', async (messageId, problem) => {
    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: messageId }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorType).toBe('VALIDATION_ERROR');
    expect(result.error).toMatch(problem);
    expect(result.error).toContain('Do not retry');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a 404 as message not found, not a bare failure', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ type: 'not_found_error' }, 404));

    const result = await new CeoInboxArchiveHandler().execute(buildCtx({ message_id: '19a2b3c4d5e6f708' }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorType).toBe('NOT_FOUND');
    expect(result.error).toMatch(/Message not found.*Do not retry with this ID/);
  });

  it('sends no PUT when the read returns after the call was aborted', async () => {
    const abort = new AbortController();
    // A fetch that ignores the signal: the read still comes back, late.
    fetchSpy.mockImplementationOnce(async () => {
      abort.abort();
      return jsonResponse({ id: 'm1', folders: ['INBOX'] });
    });

    const result = await new CeoInboxArchiveHandler().execute(
      buildCtx({ message_id: '19a2b3c4d5e6f708' }, { signal: abort.signal }),
    );

    expect(result.success).toBe(false);
    expect(calls(fetchSpy)).toEqual(['GET /messages/19a2b3c4d5e6f708']);
  });

  it('sends no PUT after the execution layer times the call out', async () => {
        const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, 'tool.json'), 'utf8'),
    ) as ToolManifest;
    const registry = new ToolRegistry();
    registry.register({ ...manifest, timeout: 50 }, new CeoInboxArchiveHandler());
    const execution = new ExecutionLayer(registry, logger, { principalMailboxes: stubPrincipalMailboxes({}) });

    // A slow read, like the 10–15 s Nylas bursts in prod. It honours the abort
    // signal the way a real fetch does.
    fetchSpy.mockImplementation((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        const timer = setTimeout(() => {
          const isPut = (init as RequestInit | undefined)?.method === 'PUT';
          resolve(jsonResponse({ id: 'm1', folders: isPut ? [] : ['INBOX'] }));
        }, 200);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    );

    const result = await execution.invoke('ceo-inbox-archive', { message_id: '19a2b3c4d5e6f708' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('timed out');

    // Give the abandoned handler time to finish what it would have done.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls(fetchSpy)).toEqual(['GET /messages/19a2b3c4d5e6f708']);
  });
});

describe('CeoInboxArchiveHandler mailbox selection (#2475)', () => {
  afterEach(() => vi.restoreAllMocks());

  function run(holders: Array<'work' | 'personal'>, extra: Record<string, unknown> = {}) {
    const f = twoMailboxFixture(holders);
    vi.spyOn(globalThis, 'fetch').mockImplementation(f.fetchStub as typeof fetch);
    const ctx = {
      input: { message_id: 'x1', ...extra }, principalMailboxes: f.principalMailboxes,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ToolContext;
    return { f, result: new CeoInboxArchiveHandler().execute(ctx) };
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
