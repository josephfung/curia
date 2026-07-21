import { describe, it, expect, vi } from 'vitest';
import {
  VoiceLearnHandler,
  CONFIG_NAMESPACE,
  DIFFS_CHECKPOINT_KEY,
} from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { ExecutiveProfile } from '../../src/executive/types.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';
import { PENDING_DIFFS_PATH } from '../ceo-inbox-sent-observe/handler.js';
import { VOICE_PROPOSAL_KEY } from '../_shared/learning-state.js';

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
}): ToolContext & {
  __updates: unknown[];
  __docs: Map<string, { body: string; version: number; type: string; path: string; frontmatter: Record<string, unknown> }>;
  __sendNotification: ReturnType<typeof vi.fn>;
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
  // Event-driven CEO notification (#1466): a mocked gateway + principal-resolving contactService,
  // so a produced proposal fires notifyLearningProposal. Exposed as __sendNotification for asserts.
  const sendNotification = vi.fn().mockResolvedValue(true);
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
    toolName: 'voice-learn',
    toolVersion: '0.2.0',
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
      update: vi.fn(async (path: string, params: { body?: string; frontmatter?: Record<string, unknown>; expectedVersion: number }) => {
        const cur = docs.get(path)!;
        const next = {
          ...cur,
          ...(params.body !== undefined ? { body: params.body } : {}),
          ...(params.frontmatter !== undefined ? { frontmatter: params.frontmatter } : {}),
          version: cur.version + 1,
        };
        docs.set(path, next);
        return { ok: true, document: next };
      }),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    outboundGateway: { sendNotification } as unknown as ToolContext['outboundGateway'],
    contactService: {
      findContactBySystemRole: vi.fn().mockResolvedValue({ id: 'principal-1' }),
      getContactWithIdentities: vi.fn().mockResolvedValue({
        identities: [
          { channel: 'email', verified: true, status: 'active', channelIdentifier: 'ceo@example.com' },
        ],
      }),
    } as unknown as ToolContext['contactService'],
    __updates: updates,
    __docs: docs,
    __sendNotification: sendNotification,
  } as unknown as ToolContext & {
    __updates: unknown[];
    __docs: typeof docs;
    __sendNotification: ReturnType<typeof vi.fn>;
  };
}

describe('VoiceLearnHandler', () => {
  const handler = new VoiceLearnHandler();

  it('proposes an updated guide from the diff corpus via the LLM', async () => {
    const mem = makeEntityMemory();
    const ctx = makeCtx({ entityMemory: mem });
    (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: '- Writes short.\n- Dry humour.',
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const stored = JSON.parse(mem.__values.get(VOICE_PROPOSAL_KEY)!) as {
      status: string;
      guide: string;
    };
    expect(stored.status).toBe('pending');
    expect(stored.guide).toContain('Dry humour');
    // profile NOT written directly (human-in-the-loop)
    expect(ctx.__updates).toHaveLength(0);
  });

  it('supersedes an existing pending proposal instead of blocking the run', async () => {
    // Pre-seed a stale pending proposal directly in config, as if a prior run wrote it. No
    // checkpoint is seeded, so the checkpoint filter doesn't gate this run's diffs either.
    const mem = makeEntityMemory();
    mem.__values.set(
      VOICE_PROPOSAL_KEY,
      JSON.stringify({
        status: 'pending',
        generatedAt: '2026-07-01T00:00:00.000Z',
        guide: '- OLD stale guidance.',
      }),
    );
    const ctx = makeCtx({ entityMemory: mem });
    (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: '- Fresh guidance.',
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toMatchObject({ proposed: true });

    // The whole-object config write supersedes the stale proposal — no accumulation, and the
    // stale guide text is entirely gone (not just appended past).
    const stored = JSON.parse(mem.__values.get(VOICE_PROPOSAL_KEY)!) as {
      status: string;
      guide: string;
    };
    expect(stored.guide).toContain('Fresh guidance.');
    expect(stored.guide).not.toContain('OLD stale guidance.');
  });

  it('no pairs → no LLM call, no proposal', async () => {
    const mem = makeEntityMemory();
    const ctx = makeCtx({ diffs: '# empty\n', entityMemory: mem });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(ctx.infraLlm!.extract).not.toHaveBeenCalled();
    expect(mem.__values.has(VOICE_PROPOSAL_KEY)).toBe(false);
  });

  // Event-driven surfacing (#1466): a produced proposal notifies the CEO; a run that produces
  // nothing stays silent (no notification).
  it('notifies the CEO with the inlined guide when a proposal is produced', async () => {
    const mem = makeEntityMemory();
    const ctx = makeCtx({ entityMemory: mem });
    (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: '- Writes short.\n- Dry humour.',
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(ctx.__sendNotification).toHaveBeenCalledTimes(1);
    const payload = ctx.__sendNotification.mock.calls[0]![0];
    expect(payload.notificationType).toBe('learning_proposal');
    expect(payload.ceoEmail).toBe('ceo@example.com');
    // The reviewable guide is inlined so the CEO can approve/dismiss straight from the email.
    expect(payload.body).toContain('Dry humour');
    expect(payload.body).toContain('Reply `approve voice` or `dismiss voice`.');
  });

  it('does NOT notify when the run produces no proposal (empty diffs)', async () => {
    const mem = makeEntityMemory();
    const ctx = makeCtx({ diffs: '# empty\n', entityMemory: mem });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(ctx.__sendNotification).not.toHaveBeenCalled();
  });

  it('does NOT notify when the LLM fails to produce a proposal', async () => {
    const mem = makeEntityMemory();
    const ctx = makeCtx({ entityMemory: mem });
    (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'timeout' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(ctx.__sendNotification).not.toHaveBeenCalled();
  });

  it('does NOT fail the run when the notification send fails (best-effort)', async () => {
    const mem = makeEntityMemory();
    const ctx = makeCtx({ entityMemory: mem });
    ctx.__sendNotification.mockResolvedValue(false);
    (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: '- Writes short.',
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    // The proposal was still persisted despite the notification not landing.
    expect(mem.__values.get(VOICE_PROPOSAL_KEY)).toContain('Writes short.');
  });

  it('LLM failure → no proposal, success result', async () => {
    const mem = makeEntityMemory();
    const ctx = makeCtx({ entityMemory: mem });
    (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'timeout',
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(mem.__values.has(VOICE_PROPOSAL_KEY)).toBe(false);
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

    it('without entityMemory wired, falls back to feeding every accumulated pair, but cannot persist a proposal without a config store', async () => {
      const ctx = makeCtx({}); // no entityMemory
      (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: '- Writes short.',
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      // The checkpoint filter still falls back to feeding every accumulated pair
      // (pairs_considered: 3, same as pre-migration). But the proposal now lives ONLY in config
      // (no doc fallback), so without entityMemory there is nowhere to persist the LLM's output —
      // `proposed` is false with `reason: 'no-config-store'`. This is a deliberate behavior change
      // from pre-migration (which expected `proposed: true` here, since the doc write had no
      // entityMemory dependency).
      expect((result as { data: Record<string, unknown> }).data).toMatchObject({
        pairs_considered: 3,
        proposed: false,
        reason: 'no-config-store',
      });
    });

    // Build `n` diff blocks with strictly increasing sent_at (one per day from 2026-06-01), so the
    // oldest is d1 and the newest is d`n`. Returns the doc text and the ordered sent_at strings so
    // the test can assert against exact checkpoint values. Used to prove batch draining past MAX_PAIRS.
    function buildDiffs(n: number): { text: string; sentAts: string[] } {
      const base = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00Z
      let text = '\n# Pending voice diffs\n\n';
      const sentAts: string[] = [];
      for (let i = 1; i <= n; i++) {
        const iso = new Date(base + (i - 1) * 86_400_000).toISOString();
        sentAts.push(iso);
        text +=
          `## Diff — draft d${i} ↔ sent m${i}\n` +
          `- sent_at: ${iso}\n` +
          `- subject: Hello\n### Draft\nHi ${i}, Best regards\n### Sent\nHi ${i}, Thanks\n---\n`;
      }
      return { text, sentAts };
    }

    it('drains the OLDEST batch first so a >MAX_PAIRS backlog is never stranded past the checkpoint', async () => {
      // 41 pending pairs — one more than MAX_PAIRS (40). The old `slice(-MAX_PAIRS)` fed the NEWEST
      // 40 and advanced the checkpoint to the newest sent_at, stranding d1 forever. The fix feeds
      // the OLDEST 40 (d1..d40) and advances the checkpoint only to d40's sent_at, so d41 survives.
      const { text, sentAts } = buildDiffs(41);
      const mem = makeEntityMemory();
      const ctx = makeCtx({ entityMemory: mem, diffs: text });
      (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: '- Writes short.',
      });

      const first = await handler.execute(ctx);
      expect(first.success).toBe(true);
      // All 41 are eligible (no checkpoint yet), but only the oldest 40 are fed this run, so the
      // checkpoint advances to d40's sent_at (sentAts[39]) — NOT d41's (sentAts[40]).
      expect(mem.__values.get(DIFFS_CHECKPOINT_KEY)).toBe(sentAts[39]);
      // d41 is still strictly newer than the checkpoint, so a second run proposes it rather than
      // dropping it — proof it was not stranded.
      const second = await handler.execute(ctx);
      expect(second.success).toBe(true);
      expect((second as { data: Record<string, unknown> }).data).toMatchObject({
        pairs_considered: 1,
        proposed: true,
      });
      expect(mem.__values.get(DIFFS_CHECKPOINT_KEY)).toBe(sentAts[40]);
    });
  });

  // The comments promise the checkpoint is best-effort; ConfigStore.get/set propagate infra
  // failures, so the handler must swallow them rather than aborting the run or reporting failure.
  describe('checkpoint is genuinely best-effort', () => {
    it('a failing checkpoint READ falls back to feeding every pair, still succeeds', async () => {
      const mem = makeEntityMemory();
      // getFacts backs ConfigStore.get — make it throw so both checkpoint and dismissed reads fail.
      (mem.getFacts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('store down'));
      const ctx = makeCtx({ entityMemory: mem });
      (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: '- Writes short.',
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      // Fell back to feeding all 3 pairs (checkpoint filter disabled) and still proposed.
      expect((result as { data: Record<string, unknown> }).data).toMatchObject({
        pairs_considered: 3,
        proposed: true,
      });
    });

    it('a failing checkpoint WRITE does not fail the run after the proposal is written', async () => {
      const mem = makeEntityMemory();
      // storeFact backs ConfigStore.set. Pre-migration, the proposal write went through
      // ctx.workingDocs (independent of storeFact), so rejecting storeFact unconditionally only
      // ever hit the checkpoint write. Now the proposal write ALSO goes through storeFact, so we
      // reject only the checkpoint key here to keep isolating a checkpoint-write-only failure —
      // the proposal write (this test's premise) must still succeed.
      (mem.storeFact as ReturnType<typeof vi.fn>).mockImplementation(
        async (p: { label: string; properties?: Record<string, unknown> }) => {
          if (p.label === DIFFS_CHECKPOINT_KEY) throw new Error('store down');
          mem.__values.set(p.label, String(p.properties?.value ?? ''));
          return { stored: true, action: 'created' as const };
        },
      );
      const ctx = makeCtx({ entityMemory: mem });
      (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: '- Writes short.',
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect((result as { data: Record<string, unknown> }).data).toMatchObject({ proposed: true });
      // The proposal was still persisted despite the checkpoint write failing.
      expect(mem.__values.get(VOICE_PROPOSAL_KEY)).toContain('Writes short.');
      expect(mem.__values.has(DIFFS_CHECKPOINT_KEY)).toBe(false);
    });

    it('a SOFT-rejected proposal write (stored:false, no throw) does not advance the checkpoint', async () => {
      // Unlike the "checkpoint WRITE fails" test above (which throws only for the checkpoint
      // key, proving the proposal write itself is independent), this drives the opposite and
      // more dangerous case: the PROPOSAL write soft-rejects — resolves normally with
      // stored:false — while the checkpoint write would otherwise succeed. Before the fix,
      // writeVoiceProposal returned void and the handler always advanced the checkpoint right
      // after calling it, so a soft-rejected proposal (nothing actually persisted) would still
      // retire this batch of evidence forever — the proposal is simply lost with no retry.
      const mem = makeEntityMemory();
      (mem.storeFact as ReturnType<typeof vi.fn>).mockImplementation(
        async (p: { label: string; properties?: Record<string, unknown> }) => {
          if (p.label === VOICE_PROPOSAL_KEY) {
            return { stored: false, action: 'conflict' as const };
          }
          mem.__values.set(p.label, String(p.properties?.value ?? ''));
          return { stored: true, action: 'created' as const };
        },
      );
      const ctx = makeCtx({ entityMemory: mem });
      (ctx.infraLlm!.extract as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: '- Writes short.',
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({ proposed: false, reason: 'proposal-not-persisted' });
      // The proposal was never actually stored.
      expect(mem.__values.has(VOICE_PROPOSAL_KEY)).toBe(false);
      // The checkpoint must NOT have advanced — the evidence must retry on the next run.
      expect(mem.__values.has(DIFFS_CHECKPOINT_KEY)).toBe(false);
    });
  });
});
