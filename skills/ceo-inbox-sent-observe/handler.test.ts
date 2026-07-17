import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CeoInboxSentObserveHandler,
  CONFIG_NAMESPACE,
  WATERMARK_KEY,
  IDLE_BACKOFF_KEY,
  PENDING_DIFFS_PATH,
  PENDING_COMPLETIONS_PATH,
} from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';
import { VOICE_LEARNING_DOC_TYPE } from '../_shared/voice-learning-capture.js';
import { SHADOW_DOC_TYPE, shadowDraftPath } from '../_shared/shadow-draft.js';
import type { ActionLogInsert } from '../../src/autonomy/action-log-types.js';
import type { InfraLlm } from '../../src/skills/infra-llm.js';

function makeEntityMemory(seed: Record<string, string> = {}): EntityMemory & {
  __values: Map<string, string>;
} {
  const values = new Map(Object.entries(seed));
  const anchorNode = {
    id: 'anchor-ceo-inbox',
    label: `config:${CONFIG_NAMESPACE}`,
    type: 'concept' as const,
    properties: { category: 'config', namespace: CONFIG_NAMESPACE },
    aliases: [],
    temporal: {
      createdAt: new Date(),
      lastConfirmedAt: new Date(),
      confidence: 0.7,
      decayClass: 'permanent' as const,
      source: 'system:config-store',
    },
    sensitivity: 'internal' as const,
  };

  return {
    __values: values,
    findEntities: vi.fn(async (label: string) => {
      if (label === `config:${CONFIG_NAMESPACE}`) return [anchorNode];
      return [];
    }),
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
    createEntity: vi.fn(async () => ({ entity: anchorNode, created: true })),
  } as unknown as EntityMemory & { __values: Map<string, string> };
}

function buildCtx(overrides: {
  seed?: Record<string, string>;
  snapshots?: Array<{
    path: string;
    type: string;
    frontmatter: Record<string, unknown>;
    body: string;
    version?: number;
  }>;
  tasks?: Array<{
    id: string;
    title: string;
    description: string | null;
    tags: string[];
    priority: number;
  }>;
  force?: boolean;
  nowMs?: number;
  infraLlm?: InfraLlm;
  withActionLogRepo?: boolean;
} = {}): SkillContext & {
  __mem: ReturnType<typeof makeEntityMemory>;
  __docs: Map<string, { path: string; type: string; frontmatter: Record<string, unknown>; body: string; version: number }>;
  __published: Array<{ type: string; payload: Record<string, unknown> }>;
  __actionLog: ActionLogInsert[];
} {
  const mem = makeEntityMemory(overrides.seed ?? {});
  const docs = new Map(
    (overrides.snapshots ?? []).map((d) => [d.path, { ...d, version: d.version ?? 1 }]),
  );
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const actionLog: ActionLogInsert[] = [];

  const workingDocs = {
    listByPrefix: vi.fn(async (prefix: string) =>
      [...docs.values()].filter((d) => d.path.startsWith(prefix)),
    ),
    read: vi.fn(async (path: string) => docs.get(path) ?? null),
    create: vi.fn(async (params: {
      path: string;
      type: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
    }) => {
      const row = {
        path: params.path,
        type: params.type,
        frontmatter: params.frontmatter ?? {},
        body: params.body ?? '',
        version: 1,
      };
      docs.set(params.path, row);
      return row;
    }),
    append: vi.fn(async (path: string, params: { content: string; expectedVersion: number }) => {
      const cur = docs.get(path);
      if (!cur) throw new Error('missing');
      if (cur.version !== params.expectedVersion) {
        return { ok: false as const, conflict: true as const, document: cur };
      }
      const next = {
        ...cur,
        body: `${cur.body}${params.content}`,
        version: cur.version + 1,
      };
      docs.set(path, next);
      return { ok: true as const, document: next };
    }),
    // Applies the frontmatter and/or body patch to the in-memory doc so follow-up reads reflect
    // reconciled_at (shadow reconcile) and the append+trim body writes — mirrors the real repo's
    // update() semantics closely enough for these assertions.
    update: vi.fn(async (path: string, params: { frontmatter?: Record<string, unknown>; body?: string; expectedVersion: number }) => {
      const cur = docs.get(path);
      if (!cur) throw new Error('missing');
      if (cur.version !== params.expectedVersion) {
        return { ok: false as const, conflict: true as const, document: cur };
      }
      const next = {
        ...cur,
        ...(params.frontmatter !== undefined ? { frontmatter: params.frontmatter } : {}),
        ...(params.body !== undefined ? { body: params.body } : {}),
        version: cur.version + 1,
      };
      docs.set(path, next);
      return { ok: true as const, document: next };
    }),
  };

  const ctx = {
    input: {
      ...(overrides.force ? { force: true } : {}),
      ...(typeof overrides.nowMs === 'number' ? { nowMs: overrides.nowMs } : {}),
    },
    agentId: 'ceo-inbox',
    taskEventId: 'task-evt-1',
    secret(key: string): string {
      if (key === 'nylas_api_key') return 'key';
      if (key === 'ceo_nylas_grant_id') return 'grant';
      // Mirror the real ctx.secret(): an unrecognized key is a wiring bug, not an empty
      // string. Throwing here surfaces any stray secret request instead of masking it.
      throw new Error(`Unexpected secret: ${key}`);
    },
    entityMemory: mem as unknown as EntityMemory,
    workingDocs,
    taskRepo: {
      listTasks: vi.fn(async () => overrides.tasks ?? []),
    },
    bus: {
      publish: vi.fn(async (_layer: string, event: { type: string; payload: Record<string, unknown> }) => {
        published.push(event);
      }),
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...(overrides.infraLlm ? { infraLlm: overrides.infraLlm } : {}),
    ...(overrides.withActionLogRepo
      ? {
          actionLogRepo: {
            insert: vi.fn(async (row: ActionLogInsert) => {
              actionLog.push(row);
              return actionLog.length;
            }),
          },
        }
      : {}),
    __mem: mem,
    __docs: docs,
    __published: published,
    __actionLog: actionLog,
  };

  return ctx as unknown as SkillContext & {
    __mem: ReturnType<typeof makeEntityMemory>;
    __docs: typeof docs;
    __published: typeof published;
    __actionLog: ActionLogInsert[];
  };
}

describe('CeoInboxSentObserveHandler', () => {
  let handler: CeoInboxSentObserveHandler;
  let mockFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handler = new CeoInboxSentObserveHandler();
    mockFetch = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  it('honors watermark — re-run with same watermark scans empty (idempotent)', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const ctx = buildCtx({
      seed: { [WATERMARK_KEY]: '1720000101' },
      force: true,
      nowMs: 1_720_100_000_000,
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: { messages_scanned: number } }).data.messages_scanned).toBe(0);

    const listUrl = String(mockFetch.mock.calls[0]![0]);
    expect(listUrl).toContain('in=SENT');
    expect(listUrl).toContain('received_after=1720000101');
  });

  it('matches a draft snapshot and appends a pending-diffs block', async () => {
    const listResponse = {
      data: [
        {
          id: 'msg-sent-1',
          thread_id: 'thread-1',
          subject: 'Re: Hello',
          from: [{ email: 'ceo@example.com' }],
          to: [{ email: 'alice@example.com' }],
          cc: [],
          snippet: 'Thanks Alice',
          date: 1_720_000_200,
          unread: false,
          folders: ['SENT'],
          attachments: [],
        },
      ],
    };
    const fullResponse = {
      data: {
        ...listResponse.data[0],
        body: '<p>Thanks Alice — following up.</p>',
        bcc: [],
        labels: [],
      },
    };

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-sent-1')) {
        return new Response(JSON.stringify(fullResponse), { status: 200 });
      }
      if (u.includes('/messages?')) {
        return new Response(JSON.stringify(listResponse), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    });

    const ctx = buildCtx({
      force: true,
      nowMs: 1_720_100_000_000,
      snapshots: [
        {
          path: '/scratch/voice-learning/draft-1.md',
          type: VOICE_LEARNING_DOC_TYPE,
          frontmatter: {
            draft_id: 'draft-1',
            thread_id: 'thread-1',
            subject: 'Re: Hello',
            recipients: { to: [{ email: 'alice@example.com' }], cc: [] },
            created_at: '2024-07-03T00:00:00.000Z',
          },
          body: 'Thanks Alice — following up.',
        },
      ],
      tasks: [],
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.draft_matches).toBe(1);
    expect(data.watermark_advanced_to).toBe(1_720_000_201);
    expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('1720000201');

    const diffs = ctx.__docs.get(PENDING_DIFFS_PATH);
    expect(diffs?.body).toContain('draft draft-1');
    expect(diffs?.body).toContain('msg-sent-1');
    expect(ctx.__published.some((e) => e.type === 'ceo.sent_observed')).toBe(true);
  });

  it('persists task-completion candidates for open CEO tasks', async () => {
    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-sent-2')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'msg-sent-2',
              thread_id: 't2',
              subject: 'Follow up',
              from: [{ email: 'ceo@example.com' }],
              to: [{ email: 'alice@example.com' }],
              cc: [],
              body: '<p>Following up on our chat</p>',
              snippet: 'Following up',
              date: 1_720_000_300,
              unread: false,
              folders: ['SENT'],
              bcc: [],
              labels: [],
              attachments: [],
            },
          }),
          { status: 200 },
        );
      }
      if (u.includes('/messages?')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'msg-sent-2',
                thread_id: 't2',
                subject: 'Follow up',
                from: [{ email: 'ceo@example.com' }],
                to: [{ email: 'alice@example.com' }],
                cc: [],
                snippet: 'Following up on our chat with Alice',
                date: 1_720_000_300,
                unread: false,
                folders: ['SENT'],
                attachments: [],
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${u}`);
    });

    const ctx = buildCtx({
      force: true,
      // Pin the clock near the sent date so the fresh candidate survives the retention trim.
      nowMs: 1_720_100_000_000,
      tasks: [
        {
          id: 'task-ceo-1',
          title: 'Follow up with Alice',
          description: 'Email alice@example.com about the chat',
          tags: [],
          priority: 40,
        },
      ],
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: { task_candidates: number } }).data.task_candidates).toBe(1);

    const pending = ctx.__docs.get(PENDING_COMPLETIONS_PATH);
    expect(pending?.body).toContain('task-ceo-1');
  });

  it('reconciles shadow drafts via a batched LLM judge', async () => {
    // A shadow doc for source message 'src-1' on thread-1 was captured when the
    // CEO punted on Curia's shadow draft. The CEO later sent their own reply on
    // the same thread — sent-observe should match them and hand the (shadow,
    // sent) pair to the batched LLM judge instead of the deleted heuristic scorer.
    const listResponse = {
      data: [
        {
          id: 'msg-sent-1',
          thread_id: 'thread-1',
          subject: 'Re: Hello',
          from: [{ email: 'ceo@example.com' }],
          to: [{ email: 'alice@example.com' }],
          cc: [],
          snippet: 'Thanks Alice',
          date: 1_720_000_500,
          unread: false,
          folders: ['SENT'],
          attachments: [],
        },
      ],
    };
    const fullResponse = {
      data: {
        ...listResponse.data[0],
        body: '<p>Thanks Alice, sounds good, let us do Tuesday.</p>',
        bcc: [],
        labels: [],
      },
    };

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-sent-1')) {
        return new Response(JSON.stringify(fullResponse), { status: 200 });
      }
      if (u.includes('/messages?')) {
        return new Response(JSON.stringify(listResponse), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    });

    const extract = vi.fn(async () => ({
      ok: true as const,
      text: '[{"source_message_id":"src-1","same_decision":true,"reason":"same"}]',
    }));

    const ctx = buildCtx({
      force: true,
      nowMs: 1_720_100_000_000,
      infraLlm: { extract, classify: vi.fn() },
      withActionLogRepo: true,
      snapshots: [
        {
          path: shadowDraftPath('src-1'),
          type: SHADOW_DOC_TYPE,
          frontmatter: {
            source_message_id: 'src-1',
            thread_id: 'thread-1',
            subject: 'Re: Hello',
            recipients: ['alice@example.com'],
            created_at: '2024-07-03T00:00:00.000Z',
          },
          body: 'Thanks Alice, how about Wednesday?',
        },
      ],
      tasks: [],
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    // One batched call, not one per pair.
    expect(extract).toHaveBeenCalledTimes(1);

    expect(ctx.__actionLog).toHaveLength(1);
    const row = ctx.__actionLog[0]!;
    expect(row.competenceFlag).toBe(1);
    expect(row.scoredBy).toBe('shadow-reconciler');
    expect(row.skillName).toBe('shadow-draft-eval');
    expect(row.outcome).toBe('shadow_evaluated');

    const shadowDoc = ctx.__docs.get(shadowDraftPath('src-1'));
    expect(shadowDoc?.frontmatter.reconciled_at).toBeTruthy();
    expect(shadowDoc?.frontmatter.competence_flag).toBe(1);

    const data = (result as { data: { shadow_reconciled: number; watermark_advanced_to: number } }).data;
    expect(data.shadow_reconciled).toBe(1);
    // Happy path (evidence persisted AND shadow judge ok) still advances the watermark.
    expect(data.watermark_advanced_to).toBe(1_720_000_501);
    expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('1720000501');
  });

  it('holds the watermark when the shadow-judge LLM batch fails (F2)', async () => {
    // Same shape as the happy shadow test, but the batched judge returns {ok:false}. The
    // shadow's reconciled_at stays unset, so the Sent message must be re-fetched next run —
    // which only happens if the watermark is HELD (received_after is an exclusive lower bound).
    const listResponse = {
      data: [
        {
          id: 'msg-sent-1',
          thread_id: 'thread-1',
          subject: 'Re: Hello',
          from: [{ email: 'ceo@example.com' }],
          to: [{ email: 'alice@example.com' }],
          cc: [],
          snippet: 'Thanks Alice',
          date: 1_720_000_500,
          unread: false,
          folders: ['SENT'],
          attachments: [],
        },
      ],
    };
    const fullResponse = {
      data: {
        ...listResponse.data[0],
        body: '<p>Thanks Alice, sounds good, let us do Tuesday.</p>',
        bcc: [],
        labels: [],
      },
    };

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-sent-1')) {
        return new Response(JSON.stringify(fullResponse), { status: 200 });
      }
      if (u.includes('/messages?')) {
        return new Response(JSON.stringify(listResponse), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    });

    const extract = vi.fn(async () => ({ ok: false as const, error: 'llm unavailable' }));

    const ctx = buildCtx({
      force: true,
      nowMs: 1_720_100_000_000,
      infraLlm: { extract, classify: vi.fn() },
      withActionLogRepo: true,
      snapshots: [
        {
          path: shadowDraftPath('src-1'),
          type: SHADOW_DOC_TYPE,
          frontmatter: {
            source_message_id: 'src-1',
            thread_id: 'thread-1',
            subject: 'Re: Hello',
            recipients: ['alice@example.com'],
            created_at: '2024-07-03T00:00:00.000Z',
          },
          body: 'Thanks Alice, how about Wednesday?',
        },
      ],
      tasks: [],
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    // Watermark NOT advanced — the failed shadow batch holds it for retry.
    const data = (result as { data: { watermark_advanced_to: number | null; shadow_reconciled: number } }).data;
    expect(data.watermark_advanced_to).toBeNull();
    expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBeUndefined();
    // The shadow was neither scored nor stamped, so it will be retried.
    expect(data.shadow_reconciled).toBe(0);
    const shadowDoc = ctx.__docs.get(shadowDraftPath('src-1'));
    expect(shadowDoc?.frontmatter.reconciled_at).toBeUndefined();
  });

  it('matches a shadow to the nearest eligible send, not a later unrelated one (F6)', async () => {
    // Thread-1 carries TWO sends after the shadow was captured: S1 (nearest in time) and
    // a later S2. Both share the shadow's subject + recipient, so ONLY nearest-in-time
    // distinguishes them. The shadow must be judged against S1's body, never S2's.
    const common = {
      thread_id: 'thread-1',
      subject: 'Re: Hello',
      from: [{ email: 'ceo@example.com' }],
      to: [{ email: 'alice@example.com' }],
      cc: [],
      unread: false,
      folders: ['SENT'],
      attachments: [],
    };
    // Newest-first (as Nylas returns): S2 (later) precedes S1 (nearer to shadow capture).
    const listResponse = {
      data: [
        { ...common, id: 'msg-s2', snippet: 'later unrelated', date: 1_720_050_000 },
        { ...common, id: 'msg-s1', snippet: 'the real reply', date: 1_720_000_200 },
      ],
    };

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-s1')) {
        return new Response(
          JSON.stringify({
            data: { ...common, id: 'msg-s1', date: 1_720_000_200, body: '<p>Tuesday works for me.</p>', snippet: 'the real reply', bcc: [], labels: [] },
          }),
          { status: 200 },
        );
      }
      if (u.includes('/messages/msg-s2')) {
        return new Response(
          JSON.stringify({
            data: { ...common, id: 'msg-s2', date: 1_720_050_000, body: '<p>Different unrelated topic entirely.</p>', snippet: 'later unrelated', bcc: [], labels: [] },
          }),
          { status: 200 },
        );
      }
      if (u.includes('/messages?')) {
        return new Response(JSON.stringify(listResponse), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    });

    let capturedPrompt = '';
    const extract = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return {
        ok: true as const,
        text: '[{"source_message_id":"src-1","same_decision":true,"reason":"same"}]',
      };
    });

    const ctx = buildCtx({
      force: true,
      nowMs: 1_720_100_000_000,
      infraLlm: { extract, classify: vi.fn() } as unknown as InfraLlm,
      withActionLogRepo: true,
      snapshots: [
        {
          path: shadowDraftPath('src-1'),
          type: SHADOW_DOC_TYPE,
          frontmatter: {
            source_message_id: 'src-1',
            thread_id: 'thread-1',
            subject: 'Re: Hello',
            recipients: ['alice@example.com'],
            created_at: '2024-07-03T00:00:00.000Z',
          },
          body: 'Thanks Alice, how about Wednesday?',
        },
      ],
      tasks: [],
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    // The judge pair carried S1's body, not S2's.
    expect(capturedPrompt).toContain('Tuesday works for me.');
    expect(capturedPrompt).not.toContain('Different unrelated topic');
    // Only the selected send (S1) had its full body fetched.
    expect(mockFetch.mock.calls.some((c: unknown[]) => String(c[0]).includes('/messages/msg-s1'))).toBe(true);
    expect(mockFetch.mock.calls.some((c: unknown[]) => String(c[0]).includes('/messages/msg-s2'))).toBe(false);
    expect((result as { data: { shadow_reconciled: number } }).data.shadow_reconciled).toBe(1);
  });

  it('holds the watermark and skips scoring when the sent body cannot be fetched (F7)', async () => {
    // The shadow matches a send, but fetching its full body fails. We must NOT score a
    // truncated snippet — the pair is dropped, the shadow left unclaimed, watermark held.
    const listResponse = {
      data: [
        {
          id: 'msg-sent-1',
          thread_id: 'thread-1',
          subject: 'Re: Hello',
          from: [{ email: 'ceo@example.com' }],
          to: [{ email: 'alice@example.com' }],
          cc: [],
          snippet: 'truncated snippet only',
          date: 1_720_000_500,
          unread: false,
          folders: ['SENT'],
          attachments: [],
        },
      ],
    };

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-sent-1')) {
        // Full-body fetch fails.
        throw new Error('nylas 500');
      }
      if (u.includes('/messages?')) {
        return new Response(JSON.stringify(listResponse), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    });

    const extract = vi.fn(async () => ({
      ok: true as const,
      text: '[{"source_message_id":"src-1","same_decision":true,"reason":"same"}]',
    }));

    const ctx = buildCtx({
      force: true,
      nowMs: 1_720_100_000_000,
      infraLlm: { extract, classify: vi.fn() } as unknown as InfraLlm,
      withActionLogRepo: true,
      snapshots: [
        {
          path: shadowDraftPath('src-1'),
          type: SHADOW_DOC_TYPE,
          frontmatter: {
            source_message_id: 'src-1',
            thread_id: 'thread-1',
            subject: 'Re: Hello',
            recipients: ['alice@example.com'],
            created_at: '2024-07-03T00:00:00.000Z',
          },
          body: 'Thanks Alice, how about Wednesday?',
        },
      ],
      tasks: [],
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    // No pair reached the judge, nothing scored, and the watermark is held for retry.
    expect(extract).not.toHaveBeenCalled();
    expect(ctx.__actionLog).toHaveLength(0);
    const data = (result as { data: { watermark_advanced_to: number | null; shadow_reconciled: number } }).data;
    expect(data.watermark_advanced_to).toBeNull();
    expect(data.shadow_reconciled).toBe(0);
    expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBeUndefined();
    const shadowDoc = ctx.__docs.get(shadowDraftPath('src-1'));
    expect(shadowDoc?.frontmatter.reconciled_at).toBeUndefined();
  });

  it('holds the watermark when the judge omits a pair (F8)', async () => {
    // The judge returns an empty array — the only pair goes unjudged. That pair must stay
    // unreconciled and the watermark must be held so it retries next run.
    const listResponse = {
      data: [
        {
          id: 'msg-sent-1',
          thread_id: 'thread-1',
          subject: 'Re: Hello',
          from: [{ email: 'ceo@example.com' }],
          to: [{ email: 'alice@example.com' }],
          cc: [],
          snippet: 'Thanks Alice',
          date: 1_720_000_500,
          unread: false,
          folders: ['SENT'],
          attachments: [],
        },
      ],
    };
    const fullResponse = {
      data: {
        ...listResponse.data[0],
        body: '<p>Thanks Alice, sounds good, let us do Tuesday.</p>',
        bcc: [],
        labels: [],
      },
    };

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-sent-1')) {
        return new Response(JSON.stringify(fullResponse), { status: 200 });
      }
      if (u.includes('/messages?')) {
        return new Response(JSON.stringify(listResponse), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    });

    // Judge succeeds at the LLM layer but returns NO judgement for the pair.
    const extract = vi.fn(async () => ({ ok: true as const, text: '[]' }));

    const ctx = buildCtx({
      force: true,
      nowMs: 1_720_100_000_000,
      infraLlm: { extract, classify: vi.fn() } as unknown as InfraLlm,
      withActionLogRepo: true,
      snapshots: [
        {
          path: shadowDraftPath('src-1'),
          type: SHADOW_DOC_TYPE,
          frontmatter: {
            source_message_id: 'src-1',
            thread_id: 'thread-1',
            subject: 'Re: Hello',
            recipients: ['alice@example.com'],
            created_at: '2024-07-03T00:00:00.000Z',
          },
          body: 'Thanks Alice, how about Wednesday?',
        },
      ],
      tasks: [],
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    expect(extract).toHaveBeenCalledTimes(1);
    // The pair was omitted, so nothing was inserted or marked, and the watermark is held.
    expect(ctx.__actionLog).toHaveLength(0);
    const data = (result as { data: { watermark_advanced_to: number | null; shadow_reconciled: number } }).data;
    expect(data.watermark_advanced_to).toBeNull();
    expect(data.shadow_reconciled).toBe(0);
    expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBeUndefined();
    const shadowDoc = ctx.__docs.get(shadowDraftPath('src-1'));
    expect(shadowDoc?.frontmatter.reconciled_at).toBeUndefined();
  });

  it('skips when idle backoff is active', async () => {
    const nowMs = 1_720_100_000_000;
    const ctx = buildCtx({
      seed: { [IDLE_BACKOFF_KEY]: String(nowMs - 60_000) },
      nowMs,
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: { skipped_backoff: boolean } }).data.skipped_backoff).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('follows next_cursor to scan every message in the window (no page-1 drop)', async () => {
    const mkMsg = (id: string, date: number) => ({
      id,
      thread_id: `t-${id}`,
      subject: 'Note',
      from: [{ email: 'ceo@example.com' }],
      to: [{ email: 'x@example.com' }],
      cc: [],
      snippet: 'body',
      date,
      unread: false,
      folders: ['SENT'],
      attachments: [],
    });

    // Page 1 carries a cursor; page 2 (fetched via page_token) has no cursor → done.
    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('page_token=CURSOR1')) {
        return new Response(JSON.stringify({ data: [mkMsg('m3', 1_720_000_400)] }), { status: 200 });
      }
      if (u.includes('/messages?')) {
        return new Response(
          JSON.stringify({
            data: [mkMsg('m1', 1_720_000_200), mkMsg('m2', 1_720_000_300)],
            next_cursor: 'CURSOR1',
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${u}`);
    });

    const ctx = buildCtx({ force: true, nowMs: 1_720_100_000_000, tasks: [] });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { messages_scanned: number; watermark_advanced_to: number } }).data;
    // All three messages across both pages were scanned — page 2 not dropped.
    expect(data.messages_scanned).toBe(3);
    expect(data.watermark_advanced_to).toBe(1_720_000_401);
    // Second fetch carried the cursor, proving pagination happened.
    expect(
      mockFetch.mock.calls.some((c: unknown[]) => String(c[0]).includes('page_token=CURSOR1')),
    ).toBe(true);
  });

  it('on truncation advances forward and warns (never re-scans or strands via a held watermark)', async () => {
    const mkMsg = (id: string, date: number) => ({
      id,
      thread_id: `t-${id}`,
      subject: 'Note',
      from: [{ email: 'ceo@example.com' }],
      to: [{ email: 'x@example.com' }],
      cc: [],
      snippet: 'body',
      date,
      unread: false,
      folders: ['SENT'],
      attachments: [],
    });

    // Every page returns a full batch AND a cursor → listAllMessages hits the maxScan
    // ceiling and reports truncated=true. Newest message date = 1_720_009_999.
    let n = 0;
    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages?')) {
        // 20 messages per page, always with a next_cursor.
        const data = Array.from({ length: 20 }, (_v, i) => {
          const date = 1_720_009_999 - (n * 20 + i);
          return mkMsg(`m-${n}-${i}`, date);
        });
        n += 1;
        return new Response(JSON.stringify({ data, next_cursor: `c${n}` }), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    });

    const ctx = buildCtx({ force: true, nowMs: 1_720_100_000_000, tasks: [] });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { messages_scanned: number; watermark_advanced_to: number } }).data;
    // Advanced forward to newest+1 (no held-watermark re-scan loop).
    expect(data.watermark_advanced_to).toBe(1_720_010_000);
    expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('1720010000');
    // A truncation warning was emitted (loss is loud, not silent).
    const warnMsgs = (ctx.log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[1]),
    );
    expect(warnMsgs.some((m) => /scan ceiling/i.test(m))).toBe(true);
  });
});
