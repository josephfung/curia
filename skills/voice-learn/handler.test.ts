import { describe, it, expect, vi } from 'vitest';
import { VoiceLearnHandler, PENDING_PROPOSALS_PATH } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ExecutiveProfile } from '../../src/executive/types.js';
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

function makeCtx(opts: {
  voice?: Partial<ExecutiveProfile['writingVoice']>;
  diffs?: string;
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
});
