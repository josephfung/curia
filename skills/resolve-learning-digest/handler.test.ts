import { describe, it, expect, vi } from 'vitest';
import { ResolveLearningDigestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { CONFIG_NAMESPACE, DISMISSED_KEY } from '../voice-learn/handler.js';
import { COMPLETION_DIGEST_PATH } from '../task-completion-from-sent/handler.js';
import { VOICE_PROPOSAL_KEY } from '../_shared/learning-state.js';
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

const GUIDE_PROPOSAL = JSON.stringify({
  status: 'pending',
  generatedAt: '2026-07-16T00:00:00.000Z',
  guide: '- Writes short.\n- Dry humour.',
});

describe('ResolveLearningDigestHandler', () => {
  it('approves a voice guide proposal and writes it into WritingVoice.guide', async () => {
    const mem = makeMem();
    mem.__values.set(VOICE_PROPOSAL_KEY, GUIDE_PROPOSAL);
    const update = vi.fn();
    const ctx = {
      input: { action: 'approve_voice' },
      workingDocs: {
        read: vi.fn(),
        update: vi.fn(),
      },
      entityMemory: mem,
      executiveProfileService: {
        get: () => ({
          writingVoice: {
            tone: [],
            formality: 50,
            patterns: [],
            vocabulary: { prefer: [], avoid: [] },
            signOff: '',
            guide: '',
          },
        }),
        update,
      },
      taskRepo: { reopenTask: vi.fn(), completeTask: vi.fn(), getTask: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        writingVoice: expect.objectContaining({ guide: expect.stringContaining('Dry humour') }),
      }),
      'skill',
      expect.any(String),
    );
    // The resolved proposal is cleared from config (the approved guide now lives in the
    // versioned profile), so it doesn't stay "pending" and get re-surfaced in the digest.
    expect(mem.__values.get(VOICE_PROPOSAL_KEY)).toBe('null');
  });

  it('dismisses a voice guide proposal and writes dismissal guard', async () => {
    const mem = makeMem();
    mem.__values.set(VOICE_PROPOSAL_KEY, GUIDE_PROPOSAL);
    const ctx = {
      input: { action: 'dismiss_voice' },
      workingDocs: {
        read: vi.fn(),
        update: vi.fn(),
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
    // The dismissed proposal is cleared from config; the dismiss cooldown is what suppresses
    // re-proposal, and it lives in config too (asserted below).
    expect(mem.__values.get(VOICE_PROPOSAL_KEY)).toBe('null');
    expect(mem.__values.get(DISMISSED_KEY)).toContain('guide');
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
    // The actioned item is removed from the queue doc so resolved items don't accumulate.
    expect(docs.get(COMPLETION_DIGEST_PATH)!.body).not.toContain('## Undo — task t1');
  });

  it('fails and keeps the undo item when the task no longer exists (reopenTask returns null)', async () => {
    const digestBody = `## Undo — task t1\n- status: undo_available\n- task_title: Follow up\n- note: Undo?\n---\n`;
    const docs = new Map([
      [
        COMPLETION_DIGEST_PATH,
        { path: COMPLETION_DIGEST_PATH, body: digestBody, version: 1, type: 'x', frontmatter: {} },
      ],
    ]);
    // reopenTask returns null when the task is gone — the digest item must survive so the user
    // still sees the undo affordance, and the result must report failure (not a silent success).
    const reopenTask = vi.fn(async () => null);
    const update = vi.fn();
    const ctx = {
      input: { action: 'undo_completion', task_id: 't1' },
      workingDocs: {
        read: vi.fn(async (p: string) => docs.get(p) ?? null),
        update,
      },
      entityMemory: makeMem(),
      executiveProfileService: { get: vi.fn(), update: vi.fn() },
      taskRepo: { reopenTask, completeTask: vi.fn(), getTask: vi.fn() },
      agentId: 'coordinator',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(false);
    // The digest was never rewritten — the item is preserved for a retry.
    expect(update).not.toHaveBeenCalled();
    expect(docs.get(COMPLETION_DIGEST_PATH)!.body).toContain('## Undo — task t1');
  });
});
