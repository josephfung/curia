import { describe, it, expect, vi } from 'vitest';
import { ResolveLearningDigestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { PENDING_PROPOSALS_PATH, CONFIG_NAMESPACE, DISMISSED_KEY } from '../voice-learn/handler.js';
import { COMPLETION_DIGEST_PATH } from '../task-completion-from-sent/handler.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';

function makeMem(): EntityMemory & { __values: Map<string, string> } {
  const values = new Map<string, string>();
  const anchor = {
    id: 'a1',
    label: `config:${CONFIG_NAMESPACE}`,
    temporal: { createdAt: new Date(), lastConfirmedAt: new Date(), confidence: 0.9, decayClass: 'permanent', source: 't' },
  };
  return {
    __values: values,
    findEntities: vi.fn(async () => [anchor]),
    getFacts: vi.fn(async () =>
      [...values.entries()].map(([key, value]) => ({
        id: key,
        label: key,
        properties: { key, value, namespace: CONFIG_NAMESPACE },
        temporal: { createdAt: new Date(), lastConfirmedAt: new Date(), confidence: 0.9, decayClass: 'permanent', source: 't' },
      })),
    ),
    storeFact: vi.fn(async (p: { label: string; properties?: Record<string, unknown> }) => {
      values.set(p.label, String(p.properties?.value ?? ''));
      return { stored: true, action: 'created' };
    }),
    createEntity: vi.fn(async () => ({ entity: anchor, created: false })),
  } as unknown as EntityMemory & { __values: Map<string, string> };
}

describe('ResolveLearningDigestHandler', () => {
  it('dismisses a voice proposal and writes dismissal guard', async () => {
    const docs = new Map([
      [
        PENDING_PROPOSALS_PATH,
        {
          path: PENDING_PROPOSALS_PATH,
          body: `## Proposal — signOff\n- status: pending\n- description: Prefer Thanks\n- sample_count: 3\n- consistency: 1.00\n- patch: {"sign_off":"Thanks"}\n---\n`,
          version: 1,
          type: 'x',
          frontmatter: {},
        },
      ],
    ]);
    const mem = makeMem();
    const ctx = {
      input: { action: 'dismiss_voice', field: 'signOff' },
      workingDocs: {
        read: vi.fn(async (p: string) => docs.get(p) ?? null),
        update: vi.fn(async (p: string, params: { body: string }) => {
          const cur = docs.get(p)!;
          docs.set(p, { ...cur, body: params.body, version: cur.version + 1 });
          return { ok: true, document: docs.get(p) };
        }),
      },
      entityMemory: mem,
      executiveProfileService: {
        get: () => ({ writingVoice: { tone: [], formality: 50, patterns: [], vocabulary: { prefer: [], avoid: [] }, signOff: '' } }),
        update: vi.fn(),
      },
      taskRepo: { reopenTask: vi.fn(), completeTask: vi.fn(), getTask: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect(docs.get(PENDING_PROPOSALS_PATH)!.body).toContain('status: dismissed');
    expect(mem.__values.get(DISMISSED_KEY)).toContain('signOff');
  });

  it('undoes an auto-complete via reopenTask', async () => {
    const docs = new Map([
      [
        COMPLETION_DIGEST_PATH,
        {
          path: COMPLETION_DIGEST_PATH,
          body: `## Undo — task t1\n- status: undo_available\n- task_title: Follow up\n- note: Undo?\n---\n`,
          version: 1,
          type: 'x',
          frontmatter: {},
        },
      ],
    ]);
    const reopenTask = vi.fn(async () => ({ id: 't1', status: 'open' }));
    const ctx = {
      input: { action: 'undo_completion', task_id: 't1' },
      workingDocs: {
        read: vi.fn(async (p: string) => docs.get(p) ?? null),
        update: vi.fn(async (p: string, params: { body: string }) => {
          const cur = docs.get(p)!;
          docs.set(p, { ...cur, body: params.body, version: cur.version + 1 });
          return { ok: true, document: docs.get(p) };
        }),
      },
      entityMemory: makeMem(),
      executiveProfileService: { get: vi.fn(), update: vi.fn() },
      taskRepo: { reopenTask, completeTask: vi.fn(), getTask: vi.fn() },
      agentId: 'coordinator',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect(reopenTask).toHaveBeenCalledWith('t1', expect.any(String), 'coordinator');
    expect(docs.get(COMPLETION_DIGEST_PATH)!.body).toContain('status: undone');
  });
});
