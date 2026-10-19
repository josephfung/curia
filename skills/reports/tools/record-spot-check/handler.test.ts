import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { ActionLogRepo } from '../../../../src/autonomy/action-log-repo.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import type { SpotCheckSet } from '../../../../src/reports/spot-check-store.js';
import { createSilentLogger } from '../../../../src/logger.js';

// The store has its own unit tests, and the resolver/matcher theirs; here the store is stubbed so
// the handler's guard, validation and writes are what is tested. The real resolver and matcher run.
const store = vi.hoisted(() => ({
  findByEmailThread: vi.fn<(threadId: string) => Promise<SpotCheckSet | null>>(),
  findLatestDelivered: vi.fn<(withinMs: number) => Promise<SpotCheckSet | null>>(),
}));
vi.mock('../../../../src/reports/spot-check-store.js', () => ({
  SpotCheckStore: class {
    findByEmailThread(threadId: string) { return store.findByEmailThread(threadId); }
    findLatestDelivered(withinMs: number) { return store.findLatestDelivered(withinMs); }
  },
}));

const { RecordSpotCheckHandler } = await import('./handler.js');

const SET: SpotCheckSet = {
  id: 'set-1',
  createdAt: '2026-10-19T07:00:00.000Z',
  conversationId: 'scheduler:job1:run1',
  items: [
    { n: 1, actionLogId: 101, summary: 'Replied to Dana about the Thursday slot.' },
    { n: 2, actionLogId: 102, summary: 'Archived an email from Sam.' },
    { n: 3, actionLogId: 103, summary: 'Declined a vendor call from Priya.' },
  ],
  deliveries: [{ channel: 'email', messageId: 'm1', threadId: 'th1', at: '2026-10-19T07:05:00.000Z' }],
};

const PRINCIPAL = { originator: { systemRole: 'principal' } };

/**
 * The dispatcher's trusted stamp of the pairs the principal typed (F2). By default a test's
 * principal typed exactly the numbers and verdicts its input asks to record; the F2 tests
 * pass their own taskMetadata to make the two differ.
 */
function typedFor(input: Record<string, unknown>): Array<{ n: unknown; verdict: unknown }> {
  const raw = input['verdicts'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({ n: e['n'], verdict: e['verdict'] }));
}

function makeCtx(over: Partial<ToolContext> = {}) {
  const recordPrincipalVerdict = vi.fn<(id: number, good: boolean, reason: string | null) => Promise<boolean>>()
    .mockResolvedValue(true);
  const log = createSilentLogger();
  const warn = vi.spyOn(log, 'warn');
  const error = vi.spyOn(log, 'error');
  const input = over.input ?? { verdicts: [{ n: 2, verdict: 'bad', reason: 'that was a renewal notice' }] };
  const ctx = {
    input,
    secret: () => { throw new Error('no secrets'); },
    log,
    channelId: 'email',
    conversationId: 'email:th1',
    liveTurn: true,
    taskMetadata: { ...PRINCIPAL, spotCheckVerdicts: typedFor(input) },
    actionLogRepo: { recordPrincipalVerdict } as unknown as ActionLogRepo,
    entityMemory: { findEntities: vi.fn(), getFacts: vi.fn(), storeFact: vi.fn() } as unknown as EntityMemory,
    ...over,
  } as unknown as ToolContext;
  return { ctx, recordPrincipalVerdict, warn, error };
}

beforeEach(() => {
  store.findByEmailThread.mockReset().mockResolvedValue(SET);
  store.findLatestDelivered.mockReset().mockResolvedValue(null);
});

describe('RecordSpotCheckHandler', () => {
  it("records the principal's verdict against the digest on the reply's thread", async () => {
    const { ctx, recordPrincipalVerdict } = makeCtx();

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(store.findByEmailThread).toHaveBeenCalledWith('th1');
    expect(recordPrincipalVerdict).toHaveBeenCalledTimes(1);
    expect(recordPrincipalVerdict).toHaveBeenCalledWith(102, false, 'that was a renewal notice');
    // Numbers and summaries only: the action-log id is never returned.
    expect(result).toEqual({
      success: true,
      data: { recorded: [{ n: 2, summary: 'Archived an email from Sam.', verdict: 'bad' }], skipped: [] },
    });
  });

  it('records several verdicts, a good one with no reason as null', async () => {
    const { ctx, recordPrincipalVerdict } = makeCtx({
      input: { verdicts: [{ n: 1, verdict: 'good' }, { n: 3, verdict: 'good', reason: '  fine  ' }] },
    });

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(recordPrincipalVerdict.mock.calls).toEqual([[101, true, null], [103, true, 'fine']]);
    expect(result.success).toBe(true);
  });

  // Review Focus 1: "2 good" inside a third party's email must not grade anything.
  it.each([
    ['a non-principal turn', { taskMetadata: { originator: { systemRole: 'contact' } } }],
    ['principal lineage without a live turn', { liveTurn: undefined }],
    ['no task metadata', { taskMetadata: undefined }],
    // Defence in depth: a woken principal-lineage task keeps its principal originator above the
    // ladder threshold, so if liveTurn ever leaked onto a wake it could grade its own actions.
    ['a woken task even with liveTurn and a principal originator', {
      liveTurn: true,
      taskMetadata: { ...PRINCIPAL, wakeContext: { derived: false, reason: 'heartbeat' } },
    }],
  ] as const)('refuses %s and writes nothing', async (_label, over) => {
    const { ctx, recordPrincipalVerdict } = makeCtx(over as Partial<ToolContext>);

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(result).toEqual({ success: false, error: "record-spot-check only records the principal's own reply" });
    expect(recordPrincipalVerdict).not.toHaveBeenCalled();
    expect(store.findByEmailThread).not.toHaveBeenCalled();
    expect(store.findLatestDelivered).not.toHaveBeenCalled();
  });

  // F2: prompt injection in quoted or forwarded mail, or in a tool result, could steer the
  // coordinator into grading during the principal's own live turn. Only the pairs the
  // principal typed, stamped by the dispatcher into trusted metadata, may be recorded.
  describe('only the numbers and verdicts the principal typed (F2)', () => {
    const TYPED_ONLY =
      'record-spot-check only records the numbers and verdicts the principal typed in this message. Nothing was recorded.';

    it.each([
      ['a verdict the principal did not type', [{ n: 2, verdict: 'good' }]],
      ['a number the principal did not type', [{ n: 3, verdict: 'bad' }]],
      ['an empty stamp', []],
      ['a malformed stamp', 'two bad'],
    ] as const)('refuses %s and writes nothing', async (_label, typed) => {
      const { ctx, recordPrincipalVerdict } = makeCtx({
        input: { verdicts: [{ n: 2, verdict: 'bad' }] },
        taskMetadata: { ...PRINCIPAL, spotCheckVerdicts: typed },
      });

      const result = await new RecordSpotCheckHandler().execute(ctx);

      expect(result).toEqual({ success: false, error: TYPED_ONLY });
      expect(recordPrincipalVerdict).not.toHaveBeenCalled();
      expect(store.findByEmailThread).not.toHaveBeenCalled();
    });

    it('refuses when the stamp is absent and writes nothing', async () => {
      const { ctx, recordPrincipalVerdict } = makeCtx({ taskMetadata: PRINCIPAL });

      const result = await new RecordSpotCheckHandler().execute(ctx);

      expect(result).toEqual({ success: false, error: TYPED_ONLY });
      expect(recordPrincipalVerdict).not.toHaveBeenCalled();
    });

    it('refuses the whole call when one of several verdicts was not typed', async () => {
      const { ctx, recordPrincipalVerdict } = makeCtx({
        input: { verdicts: [{ n: 1, verdict: 'good' }, { n: 2, verdict: 'bad' }] },
        taskMetadata: { ...PRINCIPAL, spotCheckVerdicts: [{ n: 2, verdict: 'bad' }] },
      });

      const result = await new RecordSpotCheckHandler().execute(ctx);

      expect(result).toEqual({ success: false, error: TYPED_ONLY });
      expect(recordPrincipalVerdict).not.toHaveBeenCalled();
    });

    it('records when every verdict was typed; the reason is not constrained', async () => {
      const { ctx, recordPrincipalVerdict } = makeCtx({
        input: { verdicts: [{ n: 2, verdict: 'bad', reason: 'it was a renewal notice, not a request' }] },
        taskMetadata: {
          ...PRINCIPAL,
          spotCheckVerdicts: [{ n: 1, verdict: 'good' }, { n: 2, verdict: 'bad' }],
        },
      });

      const result = await new RecordSpotCheckHandler().execute(ctx);

      expect(result.success).toBe(true);
      expect(recordPrincipalVerdict).toHaveBeenCalledWith(102, false, 'it was a renewal notice, not a request');
    });
  });

  it('writes nothing when one number is unknown, and lists the valid numbers', async () => {
    const { ctx, recordPrincipalVerdict } = makeCtx({
      input: { verdicts: [{ n: 2, verdict: 'bad' }, { n: 5, verdict: 'good' }] },
    });

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('1. Replied to Dana about the Thursday slot.');
    expect(recordPrincipalVerdict).not.toHaveBeenCalled();
  });

  it('writes nothing and asks the coordinator to check with the principal when no digest matches', async () => {
    store.findByEmailThread.mockResolvedValue(null);
    const { ctx, recordPrincipalVerdict } = makeCtx();

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Ask the principal which action they mean');
    expect(recordPrincipalVerdict).not.toHaveBeenCalled();
  });

  it.each([
    ['no verdicts field', {}],
    ['verdicts not an array', { verdicts: 'two bad' }],
    ['an empty array', { verdicts: [] }],
    ['a non-object entry', { verdicts: ['2 bad'] }],
    ['n zero', { verdicts: [{ n: 0, verdict: 'good' }] }],
    ['n negative', { verdicts: [{ n: -1, verdict: 'good' }] }],
    ['n fractional', { verdicts: [{ n: 1.5, verdict: 'good' }] }],
    ['n a string', { verdicts: [{ n: '2', verdict: 'good' }] }],
    ['an unknown verdict', { verdicts: [{ n: 2, verdict: 'ok' }] }],
    ['a non-string reason', { verdicts: [{ n: 2, verdict: 'bad', reason: 42 }] }],
    ['a reason over 500 characters', { verdicts: [{ n: 2, verdict: 'bad', reason: 'x'.repeat(501) }] }],
  ])('rejects malformed input (%s) and writes nothing', async (_label, input) => {
    const { ctx, recordPrincipalVerdict } = makeCtx({ input });

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(recordPrincipalVerdict).not.toHaveBeenCalled();
    expect(store.findByEmailThread).not.toHaveBeenCalled();
  });

  it('accepts a 500 character reason once trimmed', async () => {
    const reason = 'x'.repeat(500);
    const { ctx, recordPrincipalVerdict } = makeCtx({ input: { verdicts: [{ n: 2, verdict: 'bad', reason: `  ${reason}  ` }] } });

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(recordPrincipalVerdict).toHaveBeenCalledWith(102, false, reason);
  });

  // F5: a number whose row is gone or no longer a pool row is reported back as skipped, so the
  // coordinator can tell the principal rather than claim it was noted.
  it('reports a number as skipped when its row is no longer a pool row', async () => {
    const { ctx, recordPrincipalVerdict, warn } = makeCtx({
      input: { verdicts: [{ n: 1, verdict: 'good' }, { n: 2, verdict: 'bad' }] },
    });
    recordPrincipalVerdict.mockImplementation(async (id) => id !== 101);

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(result).toEqual({
      success: true,
      data: {
        recorded: [{ n: 2, summary: 'Archived an email from Sam.', verdict: 'bad' }],
        skipped: [{ n: 1, reason: 'not a gradable action any more' }],
      },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ n: 1, actionLogId: 101, setId: 'set-1' }),
      expect.any(String),
    );
  });

  it('fails with "Nothing was recorded" when every number is skipped', async () => {
    const { ctx, recordPrincipalVerdict } = makeCtx({
      input: { verdicts: [{ n: 1, verdict: 'good' }, { n: 2, verdict: 'bad' }] },
    });
    recordPrincipalVerdict.mockResolvedValue(false);

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(result.success).toBe(false);
    const message = (result as { error: string }).error;
    expect(message).toMatch(/^Nothing was recorded: /);
    expect(message).toContain('1 and 2');
    expect(message).toContain('not a gradable action any more');
  });

  // F4: the writes are independent UPDATEs, so a throw on one leaves the earlier ones
  // committed. The result must say which numbers landed and which did not.
  it('names the recorded and the failed numbers when a later write throws', async () => {
    const { ctx, recordPrincipalVerdict, error } = makeCtx({
      input: { verdicts: [{ n: 1, verdict: 'good' }, { n: 2, verdict: 'bad' }] },
    });
    recordPrincipalVerdict.mockImplementation(async (id) => {
      if (id === 102) throw new Error('connection reset');
      return true;
    });

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(recordPrincipalVerdict).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    const message = (result as { error: string }).error;
    expect(message).toContain('Recorded: 1.');
    expect(message).toContain('Failed: 2 (connection reset).');
    expect(message).toContain('Resending the failed numbers is safe');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ setId: 'set-1', recorded: [1], failed: [{ n: 2, error: 'connection reset' }] }),
      expect.any(String),
    );
  });

  it('still writes the later verdicts when an earlier write throws, and names them all', async () => {
    const { ctx, recordPrincipalVerdict } = makeCtx({
      input: { verdicts: [{ n: 1, verdict: 'good' }, { n: 2, verdict: 'bad' }, { n: 3, verdict: 'good' }] },
    });
    recordPrincipalVerdict.mockImplementation(async (id) => {
      if (id === 101) throw new Error('timeout');
      return id !== 103;
    });

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(recordPrincipalVerdict).toHaveBeenCalledTimes(3);
    const message = (result as { error: string }).error;
    expect(result.success).toBe(false);
    expect(message).toContain('Recorded: 2.');
    expect(message).toContain('Failed: 1 (timeout).');
    expect(message).toContain('Skipped: 3 (not a gradable action any more).');
  });

  it('returns success false instead of throwing when the store read fails', async () => {
    store.findByEmailThread.mockRejectedValue(new Error('db down'));
    const { ctx, recordPrincipalVerdict } = makeCtx();

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('db down');
    expect(recordPrincipalVerdict).not.toHaveBeenCalled();
  });

  it.each([
    ['actionLogRepo', /actionLogRepo/],
    ['entityMemory', /entityMemory/],
  ] as const)('fails without %s', async (field, message) => {
    const { ctx } = makeCtx({ [field]: undefined });

    const result = await new RecordSpotCheckHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(message);
  });
});
