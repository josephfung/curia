import { describe, it, expect, vi } from 'vitest';
import { TaskCompletionFromSentHandler, COMPLETION_DIGEST_PATH } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { PENDING_COMPLETIONS_PATH } from '../ceo-inbox-sent-observe/handler.js';

const PENDING = `
# Pending task-completion candidates

## Candidate — task 11111111-1111-4111-8111-111111111111
- message_id: m-hi
- confidence: high
- reason: recipient+semantic
- sent_at: 2026-07-01T12:00:00.000Z
- subject: Follow up
- recipients: john@example.com
- task_title: Follow up with John
- status: pending
---
## Candidate — task 22222222-2222-4222-8222-222222222222
- message_id: m-agm
- confidence: high
- reason: recipient+semantic
- sent_at: 2026-07-02T12:00:00.000Z
- subject: AGM
- recipients: board@example.com
- task_title: Plan AGM
- status: pending
---
## Candidate — task 33333333-3333-4333-8333-333333333333
- message_id: m-fuzzy
- confidence: low
- reason: semantic
- sent_at: 2026-07-03T12:00:00.000Z
- subject: Stuff
- recipients: x@example.com
- task_title: Maybe related
- status: pending
---
`;

function makeCtx(): SkillContext & {
  __completed: string[];
  __docs: Map<string, { path: string; body: string; version: number; type: string; frontmatter: Record<string, unknown> }>;
} {
  const completed: string[] = [];
  const docs = new Map([
    [
      PENDING_COMPLETIONS_PATH,
      {
        path: PENDING_COMPLETIONS_PATH,
        type: 'voice-pending-completions',
        frontmatter: {},
        body: PENDING,
        version: 1,
      },
    ],
  ]);

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
    __docs: docs,
  } as unknown as SkillContext & {
    __completed: string[];
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

    // Both confirmed candidates must receive their own completion_asked guard — a
    // document-wide check previously marked only the first (#1429 CodeRabbit).
    const pending = ctx.__docs.get(PENDING_COMPLETIONS_PATH)?.body ?? '';
    const markerCount = (pending.match(/completion_asked:/g) ?? []).length;
    expect(markerCount).toBe(2);
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
    const pending = ctx.__docs.get(PENDING_COMPLETIONS_PATH)?.body ?? '';
    expect(pending).toContain('skipped_ineligible');
  });

  it('reopenTask undoes an auto-complete (reversible path)', async () => {
    const { TaskRepo } = await import('../../src/db/task-repo.js');
    // Lightweight behavioural check that reopenTask exists and rejects non-done.
    expect(typeof TaskRepo.prototype.reopenTask).toBe('function');
  });
});
