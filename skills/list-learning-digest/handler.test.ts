import { describe, it, expect, vi } from 'vitest';
import { ListLearningDigestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import {
  VOICE_PROPOSAL_KEY,
  COMPLETION_DIGEST_KEY,
  LEARNING_STATE_NAMESPACE,
  type CompletionDigestMap,
} from '../_shared/learning-state.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';

// Map-backed fake EntityMemory backing ConfigStore.get, same idiom used across the other
// learning-subsystem handler tests (voice-learn, resolve-learning-digest).
function makeMem(): EntityMemory & { __values: Map<string, string> } {
  const values = new Map<string, string>();
  const anchor = {
    id: 'a1',
    label: `config:${LEARNING_STATE_NAMESPACE}`,
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
    findEntities: vi.fn(async () => (values.size > 0 ? [anchor] : [])),
    getFacts: vi.fn(async () =>
      [...values.entries()].map(([key, value]) => ({
        id: key,
        label: key,
        properties: { key, value, namespace: LEARNING_STATE_NAMESPACE },
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

describe('ListLearningDigestHandler', () => {
  it('returns empty message when no items', async () => {
    const ctx = {
      workingDocs: {
        read: vi.fn().mockResolvedValue(null),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;
    const result = await new ListLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { sections_markdown: string; message?: string } }).data;
    expect(data.sections_markdown).toBe('');
    expect(data.message).toContain('No pending');
  });

  it('renders both sections when items exist', async () => {
    const mem = makeMem();
    mem.__values.set(
      VOICE_PROPOSAL_KEY,
      JSON.stringify({
        status: 'pending',
        generatedAt: '2026-07-16T00:00:00.000Z',
        guide: '- Writes short.\n- Dry humour.',
      }),
    );
    const digestMap: CompletionDigestMap = {
      t1: { kind: 'undo', taskId: 't1', taskTitle: 'Follow up', note: 'Marked done. Undo?' },
    };
    mem.__values.set(COMPLETION_DIGEST_KEY, JSON.stringify(digestMap));
    const ctx = {
      entityMemory: mem,
      workingDocs: { read: vi.fn().mockResolvedValue(null) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;
    const result = await new ListLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { sections_markdown: string; voice_guide: string | null } }).data;
    expect(data.voice_guide).toContain('Dry humour');
    expect(data.sections_markdown).toContain('### Proposed writing-voice update');
    expect(data.sections_markdown).toContain('### Task completion from sent mail');
    // UX unchanged: the CEO still replies with these exact commands to act on the item.
    expect(data.sections_markdown).toContain('undo completion t1');
  });

  it('does not render the voice section when entityMemory is unavailable', async () => {
    const ctx = {
      workingDocs: { read: vi.fn().mockResolvedValue(null) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;
    const result = await new ListLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { sections_markdown: string; voice_guide: string | null } }).data;
    // Without entityMemory neither the voice proposal nor the completion digest (both now
    // config-store values, #1438) can be read, so both sections are omitted.
    expect(data.voice_guide).toBeNull();
    expect(data.sections_markdown).not.toContain('### Proposed writing-voice update');
    expect(data.sections_markdown).not.toContain('### Task completion from sent mail');
  });

  it('renders the completion section from config even with no pending voice proposal', async () => {
    const mem = makeMem();
    const digestMap: CompletionDigestMap = {
      t2: { kind: 'confirm', taskId: 't2', taskTitle: 'Plan AGM', note: 'Did emailing complete it?' },
    };
    mem.__values.set(COMPLETION_DIGEST_KEY, JSON.stringify(digestMap));
    const ctx = {
      entityMemory: mem,
      workingDocs: { read: vi.fn().mockResolvedValue(null) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;
    const result = await new ListLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { sections_markdown: string; voice_guide: string | null } }).data;
    expect(data.voice_guide).toBeNull();
    expect(data.sections_markdown).not.toContain('### Proposed writing-voice update');
    expect(data.sections_markdown).toContain('### Task completion from sent mail');
    expect(data.sections_markdown).toContain('confirm completion t2');
  });
});
