import { describe, it, expect, vi } from 'vitest';
import { ResolveLearningDigestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { CONFIG_NAMESPACE, DISMISSED_KEY } from '../voice-learn/handler.js';
import {
  VOICE_PROPOSAL_KEY,
  COMPLETION_DIGEST_KEY,
  type CompletionDigestMap,
} from '../_shared/learning-state.js';
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

  it('reports failure (not success) when the proposal clear soft-rejects after a successful approve', async () => {
    // The profile write (the primary side effect) succeeds, but the clear of the pending
    // proposal soft-rejects (stored:false, no throw — a dedup 'conflict'/'auto_rejected' outcome).
    // Before the fix, the boolean return of writeVoiceProposal was ignored entirely, so this
    // reported success even though the proposal item would still be there next digest list.
    const mem = makeMem();
    mem.__values.set(VOICE_PROPOSAL_KEY, GUIDE_PROPOSAL);
    const update = vi.fn();
    const ctx = {
      input: { action: 'approve_voice' },
      workingDocs: { read: vi.fn(), update: vi.fn() },
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

    // Soft-reject only the proposal-clear write; the profile update above goes through
    // executiveProfileService, independent of storeFact.
    (mem.storeFact as ReturnType<typeof vi.fn>).mockImplementation(
      async (p: { label: string; properties?: Record<string, unknown> }) => {
        if (p.label === VOICE_PROPOSAL_KEY) return { stored: false, action: 'conflict' as const };
        mem.__values.set(p.label, String(p.properties?.value ?? ''));
        return { stored: true, action: 'created' as const };
      },
    );

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/may reappear/);
    // The primary side effect (the profile write) still happened.
    expect(update).toHaveBeenCalled();
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
    const mem = makeMem();
    const digestMap: CompletionDigestMap = {
      t1: { kind: 'undo', taskId: 't1', taskTitle: 'Follow up', note: 'Undo?' },
    };
    mem.__values.set(COMPLETION_DIGEST_KEY, JSON.stringify(digestMap));
    const reopenTask = vi.fn(async () => ({ id: 't1', status: 'open' }));
    const ctx = {
      input: { action: 'undo_completion', task_id: 't1' },
      // Not read/written for completion actions any more (config-store only, #1438) — a
      // minimal stub satisfies the handler's top-level capability guard.
      workingDocs: { read: vi.fn(), update: vi.fn() },
      entityMemory: mem,
      executiveProfileService: { get: vi.fn(), update: vi.fn() },
      taskRepo: { reopenTask, completeTask: vi.fn(), getTask: vi.fn() },
      agentId: 'coordinator',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect(reopenTask).toHaveBeenCalledWith('t1', expect.any(String), 'coordinator');
    // The actioned item is removed from the config map so resolved items don't accumulate.
    const updated = JSON.parse(mem.__values.get(COMPLETION_DIGEST_KEY)!) as CompletionDigestMap;
    expect(updated.t1).toBeUndefined();
  });

  it('reports failure when the digest clear soft-rejects, but the task is still reopened', async () => {
    // reopenTask (the primary side effect) succeeds, but the digest-clear write soft-rejects
    // (stored:false, no throw). The task must still be reopened — we don't add compensation —
    // but the result must be honest that the digest item may reappear, not a blanket success.
    const mem = makeMem();
    const digestMap: CompletionDigestMap = {
      t1: { kind: 'undo', taskId: 't1', taskTitle: 'Follow up', note: 'Undo?' },
    };
    mem.__values.set(COMPLETION_DIGEST_KEY, JSON.stringify(digestMap));
    const reopenTask = vi.fn(async () => ({ id: 't1', status: 'open' }));
    const ctx = {
      input: { action: 'undo_completion', task_id: 't1' },
      workingDocs: { read: vi.fn(), update: vi.fn() },
      entityMemory: mem,
      executiveProfileService: { get: vi.fn(), update: vi.fn() },
      taskRepo: { reopenTask, completeTask: vi.fn(), getTask: vi.fn() },
      agentId: 'coordinator',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    (mem.storeFact as ReturnType<typeof vi.fn>).mockImplementation(
      async (p: { label: string; properties?: Record<string, unknown> }) => {
        if (p.label === COMPLETION_DIGEST_KEY) return { stored: false, action: 'conflict' as const };
        mem.__values.set(p.label, String(p.properties?.value ?? ''));
        return { stored: true, action: 'created' as const };
      },
    );

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/may reappear/);
    // The task was still reopened — the fix is honest reporting, not compensation.
    expect(reopenTask).toHaveBeenCalledWith('t1', expect.any(String), 'coordinator');
  });

  it('fails and keeps the undo item when the task no longer exists (reopenTask returns null)', async () => {
    const mem = makeMem();
    const digestMap: CompletionDigestMap = {
      t1: { kind: 'undo', taskId: 't1', taskTitle: 'Follow up', note: 'Undo?' },
    };
    mem.__values.set(COMPLETION_DIGEST_KEY, JSON.stringify(digestMap));
    // reopenTask returns null when the task is gone — the digest item must survive so the user
    // still sees the undo affordance, and the result must report failure (not a silent success).
    const reopenTask = vi.fn(async () => null);
    const ctx = {
      input: { action: 'undo_completion', task_id: 't1' },
      workingDocs: { read: vi.fn(), update: vi.fn() },
      entityMemory: mem,
      executiveProfileService: { get: vi.fn(), update: vi.fn() },
      taskRepo: { reopenTask, completeTask: vi.fn(), getTask: vi.fn() },
      agentId: 'coordinator',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(false);
    // writeCompletionDigest was never called — the item is preserved for a retry.
    expect(mem.storeFact).not.toHaveBeenCalled();
    const updated = JSON.parse(mem.__values.get(COMPLETION_DIGEST_KEY)!) as CompletionDigestMap;
    expect(updated.t1).toEqual(digestMap.t1);
  });

  it('confirms completion via completeTask and removes the digest item', async () => {
    const mem = makeMem();
    const digestMap: CompletionDigestMap = {
      t1: { kind: 'confirm', taskId: 't1', taskTitle: 'Follow up', note: 'Did emailing them complete it?' },
    };
    mem.__values.set(COMPLETION_DIGEST_KEY, JSON.stringify(digestMap));
    const getTask = vi.fn(async () => ({ id: 't1', status: 'open' }));
    const completeTask = vi.fn(async () => undefined);
    const ctx = {
      input: { action: 'confirm_completion', task_id: 't1' },
      workingDocs: { read: vi.fn(), update: vi.fn() },
      entityMemory: mem,
      executiveProfileService: { get: vi.fn(), update: vi.fn() },
      taskRepo: { reopenTask: vi.fn(), completeTask, getTask },
      agentId: 'coordinator',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect(completeTask).toHaveBeenCalledWith('t1', expect.any(String), 'coordinator');
    // The actioned item is removed from the config map so resolved items don't accumulate.
    const updated = JSON.parse(mem.__values.get(COMPLETION_DIGEST_KEY)!) as CompletionDigestMap;
    expect(updated.t1).toBeUndefined();
  });

  it('fails and keeps the confirm item when the task no longer exists (getTask returns null)', async () => {
    const mem = makeMem();
    const digestMap: CompletionDigestMap = {
      t1: { kind: 'confirm', taskId: 't1', taskTitle: 'Follow up', note: 'Did emailing them complete it?' },
    };
    mem.__values.set(COMPLETION_DIGEST_KEY, JSON.stringify(digestMap));
    const getTask = vi.fn(async () => null);
    const completeTask = vi.fn();
    const ctx = {
      input: { action: 'confirm_completion', task_id: 't1' },
      workingDocs: { read: vi.fn(), update: vi.fn() },
      entityMemory: mem,
      executiveProfileService: { get: vi.fn(), update: vi.fn() },
      taskRepo: { reopenTask: vi.fn(), completeTask, getTask },
      agentId: 'coordinator',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(false);
    expect(completeTask).not.toHaveBeenCalled();
    // writeCompletionDigest was never called — the item is preserved for a retry.
    const updated = JSON.parse(mem.__values.get(COMPLETION_DIGEST_KEY)!) as CompletionDigestMap;
    expect(updated.t1).toEqual(digestMap.t1);
  });

  it('dismisses a queued confirm item without touching the task', async () => {
    const mem = makeMem();
    const digestMap: CompletionDigestMap = {
      t1: { kind: 'confirm', taskId: 't1', taskTitle: 'Follow up', note: 'Did emailing them complete it?' },
    };
    mem.__values.set(COMPLETION_DIGEST_KEY, JSON.stringify(digestMap));
    const getTask = vi.fn();
    const completeTask = vi.fn();
    const reopenTask = vi.fn();
    const ctx = {
      input: { action: 'dismiss_completion', task_id: 't1' },
      workingDocs: { read: vi.fn(), update: vi.fn() },
      entityMemory: mem,
      executiveProfileService: { get: vi.fn(), update: vi.fn() },
      taskRepo: { reopenTask, completeTask, getTask },
      agentId: 'coordinator',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;

    const result = await new ResolveLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect(getTask).not.toHaveBeenCalled();
    expect(completeTask).not.toHaveBeenCalled();
    expect(reopenTask).not.toHaveBeenCalled();
    // The actioned item is removed from the config map so resolved items don't accumulate.
    const updated = JSON.parse(mem.__values.get(COMPLETION_DIGEST_KEY)!) as CompletionDigestMap;
    expect(updated.t1).toBeUndefined();
  });
});
