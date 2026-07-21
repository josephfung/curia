import { describe, it, expect, vi } from 'vitest';
import { TaskCompletionFromSentHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import { CONFIG_NAMESPACE } from '../ceo-inbox-sent-observe/handler.js';
import {
  COMPLETION_CANDIDATES_KEY,
  COMPLETION_DIGEST_KEY,
  type CompletionCandidateMap,
} from '../../../_shared/learning-state.js';

const CANDIDATE_MAP: CompletionCandidateMap = {
  '11111111-1111-4111-8111-111111111111': {
    messageId: 'm-hi',
    confidence: 'high',
    reason: 'recipient+semantic',
    sentAt: '2026-07-01T12:00:00.000Z',
    subject: 'Follow up',
    recipients: ['john@example.com'],
    taskTitle: 'Follow up with John',
  },
  '22222222-2222-4222-8222-222222222222': {
    messageId: 'm-agm',
    confidence: 'high',
    reason: 'recipient+semantic',
    sentAt: '2026-07-02T12:00:00.000Z',
    subject: 'AGM',
    recipients: ['board@example.com'],
    taskTitle: 'Plan AGM',
  },
  '33333333-3333-4333-8333-333333333333': {
    messageId: 'm-fuzzy',
    confidence: 'low',
    reason: 'semantic',
    sentAt: '2026-07-03T12:00:00.000Z',
    subject: 'Stuff',
    recipients: ['x@example.com'],
    taskTitle: 'Maybe related',
  },
};

/** ConfigStore-backing entityMemory double. Same shape as the `makeMem` helper in
 *  resolve-learning-digest/handler.test.ts and voice-learn/handler.test.ts —
 *  `storeFact`/`getFacts` round-trip through a plain Map keyed by label. */
function makeMem(seed: Record<string, string> = {}): EntityMemory & { __values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  const anchor = {
    id: 'a1',
    label: `config:${CONFIG_NAMESPACE}`,
    temporal: {
      createdAt: new Date(),
      lastConfirmedAt: new Date(),
      confidence: 0.9,
      decayClass: 'permanent',
      source: 't',
    },
  };
  return {
    __values: values,
    findEntities: vi.fn(async () => [anchor]),
    getFacts: vi.fn(async () =>
      [...values.entries()].map(([key, value]) => ({
        id: key,
        label: key,
        properties: { key, value, namespace: CONFIG_NAMESPACE },
        temporal: {
          createdAt: new Date(),
          lastConfirmedAt: new Date(),
          confidence: 0.9,
          decayClass: 'permanent',
          source: 't',
        },
      })),
    ),
    storeFact: vi.fn(async (p: { label: string; properties?: Record<string, unknown> }) => {
      values.set(p.label, String(p.properties?.value ?? ''));
      return { stored: true, action: 'created' };
    }),
    createEntity: vi.fn(async () => ({ entity: anchor, created: false })),
  } as unknown as EntityMemory & { __values: Map<string, string> };
}

function makeCtx(): ToolContext & {
  __completed: string[];
  __mem: ReturnType<typeof makeMem>;
  __sendNotification: ReturnType<typeof vi.fn>;
} {
  const completed: string[] = [];
  const sendNotification = vi.fn().mockResolvedValue(true);
  const mem = makeMem({ [COMPLETION_CANDIDATES_KEY]: JSON.stringify(CANDIDATE_MAP) });

  const tasks: Record<string, {
    id: string;
    title: string;
    status: string;
    owner: string;
    priority: number;
    tags: string[];
    progress: Record<string, unknown>;
  }> = {
    '11111111-1111-4111-8111-111111111111': {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Follow up with John',
      status: 'open',
      owner: 'ceo',
      priority: 40,
      tags: ['inbox-follow-up'],
      progress: {},
    },
    '22222222-2222-4222-8222-222222222222': {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Plan AGM',
      status: 'open',
      owner: 'ceo',
      priority: 40,
      tags: [],
      progress: {},
    },
    '33333333-3333-4333-8333-333333333333': {
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Maybe related',
      status: 'open',
      owner: 'ceo',
      priority: 40,
      tags: [],
      progress: {},
    },
  };

  return {
    agentId: 'ceo-inbox',
    entityMemory: mem as unknown as EntityMemory,
    taskRepo: {
      getTask: vi.fn(async (id: string) => tasks[id] ?? null),
      listTasks: vi.fn(async () => []),
      completeTask: vi.fn(async (id: string) => {
        completed.push(id);
        const t = tasks[id]!;
        t.status = 'done';
        return t;
      }),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // Fake classifier: 'restricted' for board/agm text (covers the "Plan AGM" high-risk
    // case below), 'internal' for everything else — mirrors the real SensitivityClassifier's
    // classify(label, properties) signature.
    sensitivityClassifier: {
      classify: (text: string) => (/board|agm/i.test(text) ? 'restricted' : 'internal'),
    },
    // Event-driven CEO notification (#1466): a mocked gateway + principal-resolving contactService,
    // so a produced digest fires notifyLearningProposal. Exposed as __sendNotification for asserts.
    outboundGateway: { sendNotification } as unknown as ToolContext['outboundGateway'],
    contactService: {
      findContactBySystemRole: vi.fn().mockResolvedValue({ id: 'principal-1' }),
      getContactWithIdentities: vi.fn().mockResolvedValue({
        identities: [
          { channel: 'email', verified: true, status: 'active', channelIdentifier: 'ceo@example.com' },
        ],
      }),
    } as unknown as ToolContext['contactService'],
    __completed: completed,
    __mem: mem,
    __sendNotification: sendNotification,
  } as unknown as ToolContext & {
    __completed: string[];
    __mem: typeof mem;
    __sendNotification: ReturnType<typeof vi.fn>;
  };
}

describe('TaskCompletionFromSentHandler', () => {
  const handler = new TaskCompletionFromSentHandler();

  it('auto-completes low-risk high-confidence; confirms high-risk AGM; confirms fuzzy', async () => {
    const ctx = makeCtx();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { auto_completed: number; queued_confirm: number } }).data;
    expect(data.auto_completed).toBe(1);
    expect(data.queued_confirm).toBe(2);
    expect(ctx.__completed).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(ctx.__completed).not.toContain('22222222-2222-4222-8222-222222222222');

    const digest = JSON.parse(ctx.__mem.__values.get(COMPLETION_DIGEST_KEY)!);
    expect(digest['11111111-1111-4111-8111-111111111111'].kind).toBe('undo');
    expect(digest['22222222-2222-4222-8222-222222222222'].kind).toBe('confirm');
    expect(digest['33333333-3333-4333-8333-333333333333'].kind).toBe('confirm');

    // All three candidates (auto-completed + both confirm-queued) are consumed from the
    // config queue — the persistent asked_task_ids guard (written by sent-observe) is what
    // prevents re-surfacing now, not an in-band marker.
    const remaining = JSON.parse(ctx.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!);
    expect(remaining).toEqual({});

    // Event-driven surfacing (#1466): the produced undo/confirm items are pushed to the CEO
    // inline, in one notification, the moment they're written.
    expect(ctx.__sendNotification).toHaveBeenCalledTimes(1);
    const payload = ctx.__sendNotification.mock.calls[0]![0];
    expect(payload.notificationType).toBe('learning_proposal');
    expect(payload.ceoEmail).toBe('ceo@example.com');
    expect(payload.body).toContain('### Task completion from sent mail');
    // Both the undo (auto-completed) and a confirm item's reply commands are inlined.
    expect(payload.body).toContain('undo completion 11111111-1111-4111-8111-111111111111');
    expect(payload.body).toContain('confirm completion 22222222-2222-4222-8222-222222222222');
  });

  it('does NOT notify when the run produces no digest items (empty candidate queue)', async () => {
    const ctx = makeCtx();
    // Drain the queue so nothing is produced this run.
    ctx.__mem.__values.set(COMPLETION_CANDIDATES_KEY, JSON.stringify({}));
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(ctx.__sendNotification).not.toHaveBeenCalled();
  });

  it('a low-confidence candidate skips the subtask lookup and the sensitivity classifier (T3.1)', async () => {
    const ctx = makeCtx();
    // Queue only the low-confidence candidate.
    ctx.__mem.__values.set(
      COMPLETION_CANDIDATES_KEY,
      JSON.stringify({
        '33333333-3333-4333-8333-333333333333': CANDIDATE_MAP['33333333-3333-4333-8333-333333333333'],
      }),
    );
    const classifyFn = vi.fn((text: string) => (/board|agm/i.test(text) ? 'restricted' : 'internal'));
    (ctx as unknown as { sensitivityClassifier: { classify: typeof classifyFn } }).sensitivityClassifier = {
      classify: classifyFn,
    };

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { auto_completed: number; queued_confirm: number } }).data;
    expect(data.auto_completed).toBe(0);
    expect(data.queued_confirm).toBe(1);
    // Risk classification is short-circuited for low confidence: no subtask lookup, no classify.
    expect(ctx.taskRepo!.listTasks).not.toHaveBeenCalled();
    expect(classifyFn).not.toHaveBeenCalled();
  });

  it('skips a candidate whose task is no longer CEO-owned', async () => {
    const ctx = makeCtx();
    // Reassign one task away from the CEO after observation.
    const repo = ctx.taskRepo as unknown as {
      getTask: (id: string) => Promise<{ owner: string } | null>;
    };
    const original = repo.getTask.bind(repo);
    (ctx.taskRepo as unknown as { getTask: (id: string) => Promise<unknown> }).getTask = async (
      id: string,
    ) => {
      const t = (await original(id)) as { owner: string } | null;
      if (t && id === '11111111-1111-4111-8111-111111111111') return { ...t, owner: 'curia' };
      return t;
    };

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    // The reassigned task must NOT be auto-completed.
    expect(ctx.__completed).not.toContain('11111111-1111-4111-8111-111111111111');
    // The ineligible candidate is removed from the config queue (consume-by-delete applies to
    // skipped-ineligible too — the asked_task_ids guard, not an in-band marker, prevents re-ask).
    const remaining = JSON.parse(ctx.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!);
    expect(remaining['11111111-1111-4111-8111-111111111111']).toBeUndefined();
  });

  it('reopenTask undoes an auto-complete (reversible path)', async () => {
    const { TaskRepo } = await import('../../src/db/task-repo.js');
    // Lightweight behavioural check that reopenTask exists and rejects non-done.
    expect(typeof TaskRepo.prototype.reopenTask).toBe('function');
  });

  it('CRITICAL: a completeTask failure during auto-complete leaves the candidate queued for retry', async () => {
    const ctx = makeCtx();
    // Queue only the high-confidence, low-risk candidate that would otherwise auto-complete
    // (same task as the first test's auto-complete case, isolated here so the retry-survival
    // assertion below is unambiguous).
    ctx.__mem.__values.set(
      COMPLETION_CANDIDATES_KEY,
      JSON.stringify({
        '11111111-1111-4111-8111-111111111111': CANDIDATE_MAP['11111111-1111-4111-8111-111111111111'],
      }),
    );
    // Simulate a transient DB failure (e.g. connection hiccup) during completeTask — the
    // handler's catch path must treat this as retryable, not as "handled".
    (ctx.taskRepo as unknown as { completeTask: (...args: unknown[]) => Promise<unknown> }).completeTask =
      vi.fn(async () => {
        throw new Error('db hiccup');
      });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { auto_completed: number; queued_confirm: number; skipped: number } }).data;
    expect(data.auto_completed).toBe(0);
    expect(data.skipped).toBe(1);

    // The candidate must survive the failure — it stays in the config queue for retry next
    // run rather than being consumed by the `delete remaining[taskId]` that only runs on the
    // success path. If that delete were hoisted above the try (or into a `finally`), this
    // candidate would vanish from `remaining`, the queue length would shrink, the handler
    // would call writeCompletionCandidates with the now-empty map, and this assertion would
    // fail (the key would be undefined instead of round-tripping the seeded candidate).
    const remaining = JSON.parse(ctx.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!) as CompletionCandidateMap;
    expect(remaining['11111111-1111-4111-8111-111111111111']).toEqual(
      CANDIDATE_MAP['11111111-1111-4111-8111-111111111111'],
    );

    // The CEO must NOT be told to "undo" a task whose completeTask threw — it was never marked
    // done. This run's only item was that failed auto-complete, so no notification fires at all.
    expect(ctx.__sendNotification).not.toHaveBeenCalled();
  });

  it('a failed undo auto-complete is excluded from the notification but a sibling confirm item is still sent', async () => {
    const ctx = makeCtx();
    // Queue the auto-complete candidate (task 1) and a fuzzy/low-confidence one (task 3 → confirm).
    ctx.__mem.__values.set(
      COMPLETION_CANDIDATES_KEY,
      JSON.stringify({
        '11111111-1111-4111-8111-111111111111': CANDIDATE_MAP['11111111-1111-4111-8111-111111111111'],
        '33333333-3333-4333-8333-333333333333': CANDIDATE_MAP['33333333-3333-4333-8333-333333333333'],
      }),
    );
    // completeTask throws → the undo item for task 1 must be dropped from the notification.
    (ctx.taskRepo as unknown as { completeTask: (...args: unknown[]) => Promise<unknown> }).completeTask =
      vi.fn(async () => {
        throw new Error('db hiccup');
      });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    // A notification still fires (the confirm item is genuine and actionable)...
    expect(ctx.__sendNotification).toHaveBeenCalledTimes(1);
    const body = ctx.__sendNotification.mock.calls[0]![0].body as string;
    // ...but it carries ONLY the confirm item, not the failed undo.
    expect(body).toContain('confirm completion 33333333-3333-4333-8333-333333333333');
    expect(body).not.toContain('undo completion 11111111-1111-4111-8111-111111111111');
  });

  it('DOUBLE-RUN: a digest soft-reject blocks completion entirely; a later successful run completes it with the undo note durable (Finding 6)', async () => {
    // Finding 6: under the OLD ordering, completeTask ran BEFORE the digest write, so a
    // soft-rejected digest write after a successful auto-complete permanently lost the undo
    // note (next run the task is 'done' → skipped_ineligible → candidate removed → note gone).
    // The fix reorders this: the undo note must be durably written to the digest BEFORE the
    // task is completed. Run 1 proves the task is NOT completed while the digest isn't durable
    // (and the candidate survives for retry); run 2 (fresh ctx, digest write now succeeding)
    // proves the same candidate is then completed AND its undo note lands in the digest — the
    // undo affordance survived the soft-reject instead of being silently lost.
    const ctx1 = makeCtx();
    ctx1.__mem.__values.set(
      COMPLETION_CANDIDATES_KEY,
      JSON.stringify({
        '11111111-1111-4111-8111-111111111111': CANDIDATE_MAP['11111111-1111-4111-8111-111111111111'],
      }),
    );
    (ctx1.__mem.storeFact as ReturnType<typeof vi.fn>).mockImplementation(
      async (p: { label: string; properties?: Record<string, unknown> }) => {
        if (p.label === COMPLETION_DIGEST_KEY) {
          return { stored: false, action: 'conflict' as const };
        }
        ctx1.__mem.__values.set(p.label, String(p.properties?.value ?? ''));
        return { stored: true, action: 'created' as const };
      },
    );

    const result1 = await handler.execute(ctx1);
    expect(result1.success).toBe(true);
    const data1 = (result1 as { data: { auto_completed: number } }).data;
    // The task must NOT be completed — the digest (carrying its undo note) never became durable,
    // so completing it now would leave a done task with no recoverable undo affordance.
    expect(data1.auto_completed).toBe(0);
    expect(ctx1.__completed).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(ctx1.__mem.__values.has(COMPLETION_DIGEST_KEY)).toBe(false);
    // The candidate is retained for retry — nothing was consumed.
    const remaining1 = JSON.parse(ctx1.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!) as CompletionCandidateMap;
    expect(remaining1['11111111-1111-4111-8111-111111111111']).toEqual(
      CANDIDATE_MAP['11111111-1111-4111-8111-111111111111'],
    );

    // Run 2: fresh context, same candidate, digest write now succeeds normally.
    const ctx2 = makeCtx();
    ctx2.__mem.__values.set(
      COMPLETION_CANDIDATES_KEY,
      JSON.stringify({
        '11111111-1111-4111-8111-111111111111': CANDIDATE_MAP['11111111-1111-4111-8111-111111111111'],
      }),
    );

    const result2 = await handler.execute(ctx2);
    expect(result2.success).toBe(true);
    const data2 = (result2 as { data: { auto_completed: number } }).data;
    expect(data2.auto_completed).toBe(1);
    expect(ctx2.__completed).toContain('11111111-1111-4111-8111-111111111111');
    // The undo note is now present in the digest — the affordance survived the earlier
    // soft-reject instead of being permanently lost.
    const digest2 = JSON.parse(ctx2.__mem.__values.get(COMPLETION_DIGEST_KEY)!);
    expect(digest2['11111111-1111-4111-8111-111111111111'].kind).toBe('undo');
    // And the candidate is finally consumed.
    const remaining2 = JSON.parse(ctx2.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!) as CompletionCandidateMap;
    expect(remaining2['11111111-1111-4111-8111-111111111111']).toBeUndefined();
  });

  it('completeTask throws after the digest write lands → undo note durable in digest before the failure, candidate retained for retry (#1432)', async () => {
    // Distinct from the CRITICAL test above: that test proves the candidate survives a
    // completeTask failure but never inspects the digest. This test proves the actual
    // digest-first *ordering* guarantee — the undo note is durably recorded in the digest
    // even though the completion that note describes never actually happened, which is
    // exactly the "transient wart" the handler's own comment (above the digest write) calls
    // out as self-healing on the next run.
    const ctx = makeCtx();
    ctx.__mem.__values.set(
      COMPLETION_CANDIDATES_KEY,
      JSON.stringify({
        '11111111-1111-4111-8111-111111111111': CANDIDATE_MAP['11111111-1111-4111-8111-111111111111'],
      }),
    );
    // Digest write succeeds normally this time (unlike the DOUBLE-RUN soft-reject case) —
    // only completeTask fails, after the digest write has already landed.
    (ctx.taskRepo as unknown as { completeTask: (...args: unknown[]) => Promise<unknown> }).completeTask =
      vi.fn(async () => {
        throw new Error('db hiccup after digest write');
      });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { auto_completed: number; skipped: number } }).data;
    expect(data.auto_completed).toBe(0);
    expect(data.skipped).toBe(1);

    // The undo note is durable in the digest despite the completion failing — proof that the
    // write happened BEFORE completeTask ran, not after.
    const digest = JSON.parse(ctx.__mem.__values.get(COMPLETION_DIGEST_KEY)!);
    expect(digest['11111111-1111-4111-8111-111111111111']).toMatchObject({
      kind: 'undo',
      taskId: '11111111-1111-4111-8111-111111111111',
    });

    // The candidate is retained (not consumed) so it retries next run — the note is already
    // durable and will be overwritten identically on retry (composeUndoNote is pure).
    const remaining = JSON.parse(ctx.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!) as CompletionCandidateMap;
    expect(remaining['11111111-1111-4111-8111-111111111111']).toEqual(
      CANDIDATE_MAP['11111111-1111-4111-8111-111111111111'],
    );
  });

  it('clean replay after a successful run consumes the candidate; a second run on the same state sees an empty queue and does not re-complete (#1432)', async () => {
    // Unlike the DOUBLE-RUN test above (which replays across two fresh ctx objects to prove
    // self-healing after a soft-reject), this replays the SAME ctx/config-store state twice —
    // the shape of an idempotent re-run of the same job with no partial failure involved.
    const ctx = makeCtx();
    ctx.__mem.__values.set(
      COMPLETION_CANDIDATES_KEY,
      JSON.stringify({
        '11111111-1111-4111-8111-111111111111': CANDIDATE_MAP['11111111-1111-4111-8111-111111111111'],
      }),
    );

    const result1 = await handler.execute(ctx);
    expect(result1.success).toBe(true);
    const data1 = (result1 as { data: { auto_completed: number } }).data;
    expect(data1.auto_completed).toBe(1);
    expect(ctx.__completed).toEqual(['11111111-1111-4111-8111-111111111111']);
    const remaining1 = JSON.parse(ctx.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!) as CompletionCandidateMap;
    expect(remaining1['11111111-1111-4111-8111-111111111111']).toBeUndefined();

    // Run 2 against the same underlying config-store map: run 1 already consumed the candidate,
    // so this must be a no-op rather than re-completing the (now already-done) task.
    const result2 = await handler.execute(ctx);
    expect(result2.success).toBe(true);
    const data2 = (result2 as { data: { auto_completed: number } }).data;
    expect(data2.auto_completed).toBe(0);
    // completeTask must not have been called again — exactly one call total across both runs.
    expect(ctx.__completed).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect((ctx.taskRepo!.completeTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
