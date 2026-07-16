import { describe, it, expect, vi } from 'vitest';
import {
  VoiceLearnHandler,
  PENDING_PROPOSALS_PATH,
  CONFIG_NAMESPACE,
  DIFFS_CHECKPOINT_KEY,
} from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ExecutiveProfile } from '../../src/executive/types.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';
import { PENDING_DIFFS_PATH } from '../ceo-inbox-sent-observe/handler.js';

const DIFFS = `
# Pending voice diffs

## Diff — draft d1 ↔ sent m1
- sent_at: 2026-07-01T12:00:00.000Z
- subject: Hello
### Draft
Hi Alice, Best regards
### Sent
Hi Alice, Thanks
---
## Diff — draft d2 ↔ sent m2
- sent_at: 2026-07-02T12:00:00.000Z
- subject: Hello
### Draft
Hello Bob, Best regards
### Sent
Hello Bob, Thanks
---
## Diff — draft d3 ↔ sent m3
- sent_at: 2026-07-03T12:00:00.000Z
- subject: Hello
### Draft
Hi Carol, Best regards
### Sent
Hi Carol, Thanks
---
`;

// Map-backed fake EntityMemory matching the (findEntities, getFacts, storeFact, createEntity)
// surface ConfigStore actually calls — same idiom used in ceo-inbox-sent-observe's and
// resolve-learning-digest's test suites, reused here so ConfigStore.get/set behave like real
// persistent storage across two separate handler.execute() calls (needed to prove the
// checkpoint survives from one weekly run to the next).
function makeEntityMemory(): EntityMemory & { __values: Map<string, string> } {
  const values = new Map<string, string>();
  const anchor = {
    id: 'anchor-1',
    label: `config:${CONFIG_NAMESPACE}`,
    type: 'concept' as const,
    properties: { category: 'config', namespace: CONFIG_NAMESPACE },
    aliases: [],
    temporal: {
      createdAt: new Date(),
      lastConfirmedAt: new Date(),
      confidence: 0.9,
      decayClass: 'permanent' as const,
      source: 'system:config-store',
    },
    sensitivity: 'internal' as const,
  };

  return {
    __values: values,
    findEntities: vi.fn(async (label: string) => (label === anchor.label ? [anchor] : [])),
    getFacts: vi.fn(async () =>
      [...values.entries()].map(([key, value]) => ({
        id: `fact-${key}`,
        label: key,
        properties: { key, value, namespace: CONFIG_NAMESPACE },
        type: 'fact' as const,
        aliases: [],
        temporal: {
          createdAt: new Date(),
          lastConfirmedAt: new Date(),
          confidence: 0.9,
          decayClass: 'permanent' as const,
          source: 'system:config-store',
        },
        sensitivity: 'internal' as const,
      })),
    ),
    storeFact: vi.fn(async (params: { label: string; properties?: Record<string, unknown> }) => {
      values.set(params.label, String(params.properties?.value ?? ''));
      return { stored: true, action: 'created' as const };
    }),
    createEntity: vi.fn(async () => ({ entity: anchor, created: true })),
  } as unknown as EntityMemory & { __values: Map<string, string> };
}

function makeCtx(opts: {
  voice?: Partial<ExecutiveProfile['writingVoice']>;
  diffs?: string;
  entityMemory?: EntityMemory;
}): SkillContext & {
  __updates: unknown[];
  __docs: Map<string, { body: string; version: number; type: string; path: string; frontmatter: Record<string, unknown> }>;
} {
  const voice = {
    tone: ['direct', 'warm'],
    formality: 50,
    patterns: ['Concise and to the point', 'Professional but approachable'],
    vocabulary: { prefer: [] as string[], avoid: [] as string[] },
    signOff: '',
    guide: '',
    ...opts.voice,
  };
  const profile: ExecutiveProfile = { writingVoice: voice };
  const updates: unknown[] = [];
  const docs = new Map<string, { body: string; version: number; type: string; path: string; frontmatter: Record<string, unknown> }>();
  if (opts.diffs !== '') {
    docs.set(PENDING_DIFFS_PATH, {
      path: PENDING_DIFFS_PATH,
      type: 'voice-pending-diffs',
      frontmatter: {},
      body: opts.diffs ?? DIFFS,
      version: 1,
    });
  }

  return {
    input: {},
    agentId: 'ceo-inbox',
    skillName: 'voice-learn',
    skillVersion: '0.2.0',
    entityMemory: opts.entityMemory,
    executiveProfileService: {
      get: () => profile,
      update: vi.fn(async (next: ExecutiveProfile) => {
        updates.push(next);
        profile.writingVoice = next.writingVoice;
      }),
    },
    infraLlm: {
      extract: vi.fn(),
      classify: vi.fn(),
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
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    __updates: updates,
    __docs: docs,
  } as unknown as SkillContext & {
    __updates: unknown[];
    __docs: typeof docs;
  };
}

describe('VoiceLearnHandler', () => {
  const handler = new VoiceLearnHandler();

  it('proposes an updated guide from the diff corpus via the LLM', async () => {
    const ctx = makeCtx({});
    (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: '- Writes short.\n- Dry humour.',
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const proposals = ctx.__docs.get(PENDING_PROPOSALS_PATH)?.body ?? '';
    expect(proposals).toContain('## Guide Proposal');
    expect(proposals).toContain('Dry humour');
    // profile NOT written directly (human-in-the-loop)
    expect(ctx.__updates).toHaveLength(0);
  });

  it('no pairs → no LLM call, no proposal', async () => {
    const ctx = makeCtx({ diffs: '# empty\n' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(ctx.infraLlm!.extract).not.toHaveBeenCalled();
    expect(ctx.__docs.get(PENDING_PROPOSALS_PATH)).toBeUndefined();
  });

  it('LLM failure → no proposal, success result', async () => {
    const ctx = makeCtx({});
    (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'timeout',
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(ctx.__docs.get(PENDING_PROPOSALS_PATH)).toBeUndefined();
  });

  // CodeRabbit finding #11: without a consumption checkpoint, the never-consumed
  // pending-diffs.md doc gets re-fed to the LLM in full on every weekly run — even after a
  // proposal from the SAME evidence was already approved/dismissed — producing a near-duplicate
  // guide proposal indefinitely. These tests prove the checkpoint (persisted via ConfigStore,
  // keyed on the newest `sentAt` actually fed to the LLM) closes that loop.
  describe('diffs checkpoint (evidence consumption)', () => {
    it('persists a checkpoint after a successful proposal, and a second run with no newer diffs skips the LLM', async () => {
      const mem = makeEntityMemory();
      const ctx = makeCtx({ entityMemory: mem });
      (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: '- Writes short.\n- Dry humour.',
      });

      // First run: no checkpoint yet, so all 3 pairs in DIFFS are fed to the LLM. The newest
      // sent_at among them is d3's 2026-07-03T12:00:00.000Z — that becomes the checkpoint.
      const first = await handler.execute(ctx);
      expect(first.success).toBe(true);
      expect((first as { data: Record<string, unknown> }).data).toMatchObject({
        pairs_considered: 3,
        proposed: true,
      });
      expect(ctx.infraLlm!.extract).toHaveBeenCalledTimes(1);
      expect(mem.__values.get(DIFFS_CHECKPOINT_KEY)).toBe('2026-07-03T12:00:00.000Z');

      // Second run: same pending-diffs.md (never consumed/rewritten — the doc itself is
      // untouched), but now a checkpoint is on record. No pair has a sentAt strictly newer than
      // the checkpoint, so the LLM must NOT be called again and no new proposal should be made.
      const second = await handler.execute(ctx);
      expect(second.success).toBe(true);
      const secondData = (second as { data: { reason?: string } }).data;
      expect(secondData).toMatchObject({ pairs_considered: 0, proposed: false });
      expect(secondData.reason).toBe('no-new-evidence');
      // Still exactly one LLM call total — the second run never reached the LLM step.
      expect(ctx.infraLlm!.extract).toHaveBeenCalledTimes(1);
    });

    it('a diff pair newer than the checkpoint is still proposed on the next run', async () => {
      const mem = makeEntityMemory();
      // Seed the checkpoint as if a prior run had already consumed d1 and d2.
      mem.__values.set(DIFFS_CHECKPOINT_KEY, '2026-07-02T12:00:00.000Z');
      const ctx = makeCtx({ entityMemory: mem });
      (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: '- Writes short.',
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      // Only d3 (sent_at 2026-07-03) is newer than the checkpoint.
      expect((result as { data: Record<string, unknown> }).data).toMatchObject({
        pairs_considered: 1,
        proposed: true,
      });
      expect(ctx.infraLlm!.extract).toHaveBeenCalledTimes(1);
      expect(mem.__values.get(DIFFS_CHECKPOINT_KEY)).toBe('2026-07-03T12:00:00.000Z');
    });

    it('without entityMemory wired, falls back to feeding every accumulated pair (pre-fix behaviour)', async () => {
      const ctx = makeCtx({}); // no entityMemory
      (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: '- Writes short.',
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect((result as { data: Record<string, unknown> }).data).toMatchObject({
        pairs_considered: 3,
        proposed: true,
      });
    });
  });
});
