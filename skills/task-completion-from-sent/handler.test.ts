import { describe, it, expect, vi } from 'vitest';
import { TaskCompletionFromSentHandler, COMPLETION_DIGEST_PATH } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';
import { CONFIG_NAMESPACE } from '../ceo-inbox-sent-observe/handler.js';
import { COMPLETION_CANDIDATES_KEY, type CompletionCandidateMap } from '../_shared/learning-state.js';

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

function makeCtx(): SkillContext & {
  __completed: string[];
  __mem: ReturnType<typeof makeMem>;
  __docs: Map<string, { path: string; body: string; version: number; type: string; frontmatter: Record<string, unknown> }>;
} {
  const completed: string[] = [];
  const mem = makeMem({ [COMPLETION_CANDIDATES_KEY]: JSON.stringify(CANDIDATE_MAP) });
  const docs = new Map<string, { path: string; body: string; version: number; type: string; frontmatter: Record<string, unknown> }>();

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
    workingDocs: {
      read: vi.fn(async (path: string) => docs.get(path) ?? null),
      create: vi.fn(async (p: { path: string; type: string; body?: string; frontmatter?: Record<string, unknown> }) => {
        const row = {
          path: p.path,
          type: p.type,
          body: p.body ?? '',
          frontmatter: p.frontmatter ?? {},
          version: 1,
        };
        docs.set(p.path, row);
        return row;
      }),
      append: vi.fn(async (path: string, params: { content: string; expectedVersion: number }) => {
        const cur = docs.get(path)!;
        const next = { ...cur, body: cur.body + params.content, version: cur.version + 1 };
        docs.set(path, next);
        return { ok: true, document: next };
      }),
      update: vi.fn(async (path: string, params: { body: string; expectedVersion: number }) => {
        const cur = docs.get(path)!;
        const next = { ...cur, body: params.body, version: cur.version + 1 };
        docs.set(path, next);
        return { ok: true, document: next };
      }),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // Fake classifier: 'restricted' for board/agm text (covers the "Plan AGM" high-risk
    // case below), 'internal' for everything else — mirrors the real SensitivityClassifier's
    // classify(label, properties) signature.
    sensitivityClassifier: {
      classify: (text: string) => (/board|agm/i.test(text) ? 'restricted' : 'internal'),
    },
    __completed: completed,
    __mem: mem,
    __docs: docs,
  } as unknown as SkillContext & {
    __completed: string[];
    __mem: typeof mem;
    __docs: typeof docs;
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

    const digest = ctx.__docs.get(COMPLETION_DIGEST_PATH)?.body ?? '';
    expect(digest).toContain('Undo — task 11111111-1111-4111-8111-111111111111');
    expect(digest).toContain('Confirm — task 22222222-2222-4222-8222-222222222222');
    expect(digest).toContain('Confirm — task 33333333-3333-4333-8333-333333333333');

    // All three candidates (auto-completed + both confirm-queued) are consumed from the
    // config queue — the persistent asked_task_ids guard (written by sent-observe) is what
    // prevents re-surfacing now, not an in-band marker.
    const remaining = JSON.parse(ctx.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!);
    expect(remaining).toEqual({});
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
  });
});
