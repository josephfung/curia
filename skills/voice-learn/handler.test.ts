import { describe, it, expect, vi } from 'vitest';
import { VoiceLearnHandler, PENDING_PROPOSALS_PATH, CONFIG_NAMESPACE, PROVENANCE_KEY } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';
import type { ExecutiveProfile } from '../../src/executive/types.js';
import { PENDING_DIFFS_PATH } from '../ceo-inbox-sent-observe/handler.js';
import { DEFAULT_PROVENANCE } from '../_shared/voice-learn-logic.js';

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

function makeMem(seed: Record<string, string> = {}): EntityMemory & { __values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
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

function makeCtx(opts: {
  voice?: Partial<ExecutiveProfile['writingVoice']>;
  diffs?: string;
  dryRun?: boolean;
}): SkillContext & { __updates: unknown[]; __docs: Map<string, { body: string; version: number; type: string; path: string; frontmatter: Record<string, unknown> }> } {
  const voice = {
    tone: ['direct', 'warm'],
    formality: 50,
    patterns: ['Concise and to the point', 'Professional but approachable'],
    vocabulary: { prefer: [] as string[], avoid: [] as string[] },
    signOff: '',
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
    input: opts.dryRun ? { dry_run: true } : {},
    agentId: 'ceo-inbox',
    executiveProfileService: {
      get: () => profile,
      update: vi.fn(async (next: ExecutiveProfile) => {
        updates.push(next);
        profile.writingVoice = next.writingVoice;
      }),
    },
    entityMemory: makeMem({
      [PROVENANCE_KEY]: JSON.stringify(DEFAULT_PROVENANCE),
    }),
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

  it('auto path: fills empty sign-off from consistent samples', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { auto_applied: number; bootstrap: boolean } }).data;
    expect(data.auto_applied).toBeGreaterThanOrEqual(1);
    expect(data.bootstrap).toBe(true);
    expect(ctx.__updates.length).toBeGreaterThanOrEqual(1);
  });

  it('propose path: operator-set sign-off is not auto-applied', async () => {
    const ctx = makeCtx({
      voice: { signOff: 'Cheers' },
    });
    // Mark signOff as operator-set in provenance store.
    const mem = ctx.entityMemory as EntityMemory & { __values: Map<string, string> };
    mem.__values.set(
      PROVENANCE_KEY,
      JSON.stringify({ ...DEFAULT_PROVENANCE, signOff: 'operator-set' }),
    );

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    // Sign-off should be proposed, not auto-applied over operator-set.
    const proposals = ctx.__docs.get(PENDING_PROPOSALS_PATH);
    expect(proposals?.body ?? '').toMatch(/signOff|sign_off|Thanks/i);
  });

  it('cold-start / zero data: no pairs → no fabrication', async () => {
    const ctx = makeCtx({ diffs: '# empty\n' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: { pairs_considered: number } }).data.pairs_considered).toBe(0);
    expect(ctx.__updates).toHaveLength(0);
  });
});
