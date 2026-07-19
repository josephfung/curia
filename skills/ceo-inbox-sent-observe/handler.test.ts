import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CeoInboxSentObserveHandler,
  CONFIG_NAMESPACE,
  WATERMARK_KEY,
  IDLE_BACKOFF_KEY,
  PENDING_DIFFS_PATH,
  BACKFILL_BEFORE_KEY,
  BACKFILL_TARGET_KEY,
} from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';
import { VOICE_LEARNING_DOC_TYPE } from '../_shared/voice-learning-capture.js';
import { SHADOW_DOC_TYPE, shadowDraftPath, SHADOW_SCRATCH_PREFIX } from '../_shared/shadow-draft.js';
import type { ActionLogInsert } from '../../src/autonomy/action-log-types.js';
import type { InfraLlm } from '../../src/skills/infra-llm.js';
import { COMPLETION_CANDIDATES_KEY, ASKED_TASK_IDS_KEY, MATCHED_DRAFT_IDS_KEY } from '../_shared/learning-state.js';

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
      // The handler now walks the full open-task set via listAllTasks (#1433). The mock returns
      // every provided task in one shot — the DB-level keyset paging is exercised in the
      // task-repo integration test, not here.
      listAllTasks: vi.fn(async () => overrides.tasks ?? []),
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
            // Mirror the migration-074 partial unique index: one row per source_message_id.
            // Returns null on a duplicate (ON CONFLICT DO NOTHING), just like the real method.
            insertShadowEvaluated: vi.fn(async (row: ActionLogInsert) => {
              const src = (row.payload as { source_message_id?: string } | undefined)?.source_message_id;
              if (src !== undefined && actionLog.some(
                (r) => (r.payload as { source_message_id?: string } | undefined)?.source_message_id === src,
              )) {
                return null; // already recorded — dedup
              }
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

    // The matched-draft guard is now stored in config, not re-derived from pending-diffs.md.
    expect(JSON.parse(ctx.__mem.__values.get(MATCHED_DRAFT_IDS_KEY)!)).toContain('draft-1');
  });

  it('holds the watermark and persists no diff when a matched draft body cannot be fetched (F8)', async () => {
    // Same matched draft as above, but the full-message fetch fails. A diff built from the
    // truncated snippet would poison the voice proposal, so we must NOT persist it, must NOT count
    // the match, and must HOLD the watermark so the send is re-observed (and re-fetched) next run.
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

    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-sent-1')) {
        // getMessage fails — the full body is unavailable this run.
        return new Response('boom', { status: 500 });
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
    expect(data.draft_matches).toBe(0);
    expect(data.watermark_advanced_to).toBeNull();
    expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBeUndefined();
    // No diff was persisted from the truncated snippet.
    expect(ctx.__docs.get(PENDING_DIFFS_PATH)?.body ?? '').not.toContain('draft draft-1');
    // The failed-fetch draft must NOT be in the stored matched set — it never got a diff, so it
    // must re-match next run (mirrors the old re-derive-from-pending-diffs behavior).
    const matched = ctx.__mem.__values.get(MATCHED_DRAFT_IDS_KEY);
    expect(matched ? JSON.parse(matched) : []).not.toContain('draft-1');
  });

  it('prunes matched_draft_ids to drafts whose snapshot still exists', async () => {
    // Seed the guard with a stale draft id ('gone-draft') whose snapshot doc no longer exists
    // (TTL-swept) alongside 'draft-1', whose snapshot is still present. After a run that matches
    // draft-1, the stored set must drop gone-draft but keep draft-1.
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
      seed: { [MATCHED_DRAFT_IDS_KEY]: JSON.stringify(['gone-draft', 'draft-1']) },
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

    const matched = JSON.parse(ctx.__mem.__values.get(MATCHED_DRAFT_IDS_KEY)!);
    expect(matched).not.toContain('gone-draft');
    expect(matched).toContain('draft-1');
  });

  it('holds the watermark when the matched-draft guard write soft-rejects (stored:false, no throw)', async () => {
    // Same matched-draft-and-diff-persisted setup as the happy-path draft test, but this time
    // the MATCHED_DRAFT_IDS_KEY write soft-rejects (stored:false, no throw) — the real dedup
    // 'conflict'/'auto_rejected' shape storeFact can hit. The guard no longer re-derives from the
    // pending-diffs doc (extractMatchedDraftIds was deleted in #1438), so a lost guard write must
    // hold the watermark for retry rather than being treated as harmless.
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

    // Soft-reject only the matched-draft-guard write — every other storeFact call (diffs doc is
    // an OKF write, not config; watermark/idle-backoff) goes through normally.
    (ctx.__mem.storeFact as ReturnType<typeof vi.fn>).mockImplementation(
      async (params: { label: string; properties?: Record<string, unknown> }) => {
        if (params.label === MATCHED_DRAFT_IDS_KEY) {
          return { stored: false, action: 'conflict' as const };
        }
        ctx.__mem.__values.set(params.label, String(params.properties?.value ?? ''));
        return { stored: true, action: 'created' as const };
      },
    );

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { watermark_advanced_to: number | null } }).data;
    // The watermark must be HELD so the send is re-observed and the guard re-written next run.
    expect(data.watermark_advanced_to).toBeNull();
    expect(ctx.__mem.__values.has(MATCHED_DRAFT_IDS_KEY)).toBe(false);
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

    const stored = JSON.parse(ctx.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!);
    expect(stored['task-ceo-1']).toBeDefined();
    expect(stored['task-ceo-1'].confidence).toBe('high');
    const asked = JSON.parse(ctx.__mem.__values.get(ASKED_TASK_IDS_KEY)!);
    expect(asked).toContain('task-ceo-1');
  });

  it('matches a task beyond the old 100-task cap (>100 open tasks, #1433)', async () => {
    // Regression guard for the pre-#1433 truncation: the handler capped the open-task fetch at
    // 100, so a matching task past that index was silently never considered. It now walks the
    // full set via listAllTasks, so a match at index 130 of 150 must still produce a candidate.
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

    // 149 unrelated filler tasks (no recipient/token overlap with the Alice send) plus the real
    // match dropped in at index 130 — well past the old 100 cap.
    const filler = Array.from({ length: 149 }, (_, i) => ({
      id: `filler-${i}`,
      title: `Quarterly budget review section ${i}`,
      description: 'Unrelated internal planning item',
      tags: [],
      priority: 30,
    }));
    const tasks = [
      ...filler.slice(0, 130),
      {
        id: 'task-ceo-1',
        title: 'Follow up with Alice',
        description: 'Email alice@example.com about the chat',
        tags: [],
        priority: 40,
      },
      ...filler.slice(130),
    ];

    const ctx = buildCtx({ force: true, nowMs: 1_720_100_000_000, tasks });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: { task_candidates: number } }).data.task_candidates).toBe(1);

    const stored = JSON.parse(ctx.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!);
    expect(stored['task-ceo-1']).toBeDefined();
    expect(stored['task-ceo-1'].confidence).toBe('high');
  });

  it('does not persist the asked-guard when the candidate write is held (no candidate lost)', async () => {
    // A matched task, but the completion_candidates config write throws → completionsPersisted
    // is false. That must HOLD the watermark AND skip writing asked_task_ids — otherwise the next
    // run's guard would already contain the task and matchTasksToSent would silently skip it,
    // permanently losing the candidate that never made it into the queue.
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

    // Drive the failure: reject only the completion-candidates config write, letting every
    // other storeFact call (watermark, idle-backoff) through normally — mirrors the
    // checkpoint-write-failure pattern in voice-learn's handler.test.ts.
    (ctx.__mem.storeFact as ReturnType<typeof vi.fn>).mockImplementation(
      async (params: { label: string; properties?: Record<string, unknown> }) => {
        if (params.label === COMPLETION_CANDIDATES_KEY) throw new Error('store down');
        ctx.__mem.__values.set(params.label, String(params.properties?.value ?? ''));
        return { stored: true, action: 'created' as const };
      },
    );

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { watermark_advanced_to: number | null } }).data;
    expect(data.watermark_advanced_to).toBeNull();
    // The asked-guard was never written this run — next run re-matches and re-adds.
    expect(ctx.__mem.__values.has(ASKED_TASK_IDS_KEY)).toBe(false);
  });

  it('holds the watermark and skips the asked-guard when the candidate write SOFT-rejects (stored:false, no throw)', async () => {
    // Same shape as the hard-failure test above, but this time storeFact does NOT throw — it
    // resolves normally with { stored: false } (the real dedup 'conflict'/'auto_rejected' shape
    // ConfigStore.set can hit). Before the fix, completionsPersisted was only ever flipped false
    // in the catch block, so a soft-reject like this one would sail through as "persisted" even
    // though nothing was actually written — silently losing the candidate while still advancing
    // the watermark past the sends that produced it. This is the HIGH-severity regression case.
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

    // Soft-reject only the completion-candidates write — resolves normally with stored:false,
    // mirroring a dedup 'conflict'/'auto_rejected' storeFact outcome rather than an infra error.
    (ctx.__mem.storeFact as ReturnType<typeof vi.fn>).mockImplementation(
      async (params: { label: string; properties?: Record<string, unknown> }) => {
        if (params.label === COMPLETION_CANDIDATES_KEY) {
          return { stored: false, action: 'conflict' as const };
        }
        ctx.__mem.__values.set(params.label, String(params.properties?.value ?? ''));
        return { stored: true, action: 'created' as const };
      },
    );

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { watermark_advanced_to: number | null } }).data;
    // The watermark must be HELD (not advanced) so the candidate-producing send is re-observed.
    expect(data.watermark_advanced_to).toBeNull();
    expect(ctx.__mem.__values.has(COMPLETION_CANDIDATES_KEY)).toBe(false);
    // The asked-guard must NOT have been persisted with this task — otherwise next run's
    // matchTasksToSent would skip it via the guard while the candidate was never actually queued.
    expect(ctx.__mem.__values.has(ASKED_TASK_IDS_KEY)).toBe(false);
  });

  it('prunes asked_task_ids to currently-open tasks on write', async () => {
    // closed-task was asked about previously but is no longer open (completed/cancelled).
    // task-ceo-1 is still open. After a run, the persisted guard should drop closed-task.
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const ctx = buildCtx({
      force: true,
      nowMs: 1_720_100_000_000,
      seed: { [ASKED_TASK_IDS_KEY]: JSON.stringify(['closed-task', 'task-ceo-1']) },
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

    const asked = JSON.parse(ctx.__mem.__values.get(ASKED_TASK_IDS_KEY)!);
    expect(asked).not.toContain('closed-task');
    expect(asked).toContain('task-ceo-1');
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

  it('does not double-insert a shadow row when the reconciled_at mark fails, then re-runs (#1432)', async () => {
    // Run 1: judge succeeds, insert lands, but the reconciled_at mark FAILS → watermark held.
    // Run 2: the same Sent message is re-observed and re-judged, but insertShadowEvaluated dedups
    // on source_message_id, so exactly one shadow row exists across both runs.
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
      data: { ...listResponse.data[0], body: '<p>Thanks Alice, Tuesday works.</p>', bcc: [], labels: [] },
    };
    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-sent-1')) return new Response(JSON.stringify(fullResponse), { status: 200 });
      if (u.includes('/messages?')) return new Response(JSON.stringify(listResponse), { status: 200 });
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

    // Force the reconciled_at mark to fail on run 1 only (shadow-doc path), then restore.
    const realUpdate = ctx.workingDocs!.update;
    let failMark = true;
    ctx.workingDocs!.update = vi.fn(async (path: string, params: { frontmatter?: Record<string, unknown>; body?: string; expectedVersion: number }) => {
      if (failMark && path.startsWith(`${SHADOW_SCRATCH_PREFIX}/`)) {
        const cur = ctx.__docs.get(path)!;
        return { ok: false as const, conflict: true as const, document: cur };
      }
      return realUpdate(path, params);
    }) as typeof realUpdate;

    // Run 1 — insert lands, mark fails, watermark held.
    const r1 = await handler.execute(ctx);
    expect(r1.success).toBe(true);
    expect((r1 as { data: { watermark_advanced_to: number | null } }).data.watermark_advanced_to).toBeNull();
    expect(ctx.__actionLog).toHaveLength(1);
    expect(ctx.__docs.get(shadowDraftPath('src-1'))?.frontmatter.reconciled_at).toBeUndefined();

    // Run 2 — mark now succeeds; the re-judged shadow must NOT create a second row.
    failMark = false;
    const r2 = await handler.execute(ctx);
    expect(r2.success).toBe(true);
    expect(ctx.__actionLog).toHaveLength(1); // deduped — no double-score
    expect(ctx.__docs.get(shadowDraftPath('src-1'))?.frontmatter.reconciled_at).toBeTruthy();
    expect((r2 as { data: { watermark_advanced_to: number | null } }).data.watermark_advanced_to).toBe(1_720_000_501);
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
    // First-ever run (watermark 0) is forward-only: NO backfill drain is initiated (#1431).
    expect(ctx.__mem.__values.get(BACKFILL_BEFORE_KEY)).toBeUndefined();
    expect(ctx.__mem.__values.get(BACKFILL_TARGET_KEY)).toBeUndefined();
  });

  // ── #1431: oldest-first backlog drain ──────────────────────────────────────
  describe('#1431 oldest-first backlog drain', () => {
    // A Sent message summary (matches nothing — no snapshots/tasks/shadows in these tests, so the
    // matching pipeline is a no-op and only the watermark/backfill state machine is exercised).
    function sentMsg(id: string, date: number) {
      return {
        id,
        thread_id: '',
        subject: `s-${id}`,
        from: [{ email: 'ceo@example.com' }],
        to: [{ email: 'a@example.com' }],
        cc: [],
        snippet: '',
        date,
        unread: false,
        folders: ['SENT'],
        attachments: [],
      };
    }

    // Serve a fixed corpus newest-first, honoring received_after (>=), received_before (<=), limit,
    // and page_token. The cursor encodes `${nextOffset}:${after}:${before}` so a page_token request
    // (which omits the filters — Nylas carries them on the cursor) still filters correctly. When
    // `observed` is supplied, every date served in a list page is recorded, so a test can assert no
    // message was ever skipped across the drain.
    function serveSentCorpus(
      fetchSpy: ReturnType<typeof vi.spyOn>,
      corpus: Array<{ id: string; date: number }>,
      observed?: Set<number>,
    ): void {
      const sorted = [...corpus].sort((a, b) => b.date - a.date);
      fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
        const u = new URL(String(url));
        // getMessage — never hit here (nothing matches), but answer with a valid envelope.
        if (/\/messages\/[^?]+$/.test(u.pathname)) {
          return new Response(
            JSON.stringify({ data: { id: 'x', date: 0, body: '', bcc: [], labels: [], folders: ['SENT'] } }),
            { status: 200 },
          );
        }
        const token = u.searchParams.get('page_token');
        let start: number;
        let after: number | null;
        let before: number | null;
        if (token) {
          const [s, a, b] = token.split(':');
          start = Number(s);
          after = a === '' ? null : Number(a);
          before = b === '' ? null : Number(b);
        } else {
          start = 0;
          const a = u.searchParams.get('received_after');
          const b = u.searchParams.get('received_before');
          after = a === null ? null : Number(a);
          before = b === null ? null : Number(b);
        }
        const filtered = sorted.filter(
          (m) => (after === null || m.date >= after) && (before === null || m.date <= before),
        );
        const limit = Number(u.searchParams.get('limit') ?? '20');
        const slice = filtered.slice(start, start + limit);
        if (observed) for (const m of slice) observed.add(m.date);
        const nextStart = start + limit;
        const body: Record<string, unknown> = { data: slice.map((m) => sentMsg(m.id, m.date)) };
        if (nextStart < filtered.length) body.next_cursor = `${nextStart}:${after ?? ''}:${before ?? ''}`;
        return new Response(JSON.stringify(body), { status: 200 });
      });
    }

    it('drains a >SENT_MAX_SCAN backlog across runs with no message skipped', async () => {
      // 1100 messages (dates 1000..2099, unique seconds) above a real floor watermark = 999.
      // SENT_MAX_SCAN is 500, so this needs 3 runs: [1600..2099], [1101..1600], [1000..1101].
      const corpus = Array.from({ length: 1100 }, (_v, i) => ({ id: `m${i}`, date: 1000 + i }));
      const observed = new Set<number>();
      serveSentCorpus(mockFetch, corpus, observed);

      const seed: Record<string, string> = { [WATERMARK_KEY]: '999' };
      for (let run = 0; run < 10; run++) {
        const ctx = buildCtx({ seed: { ...seed }, force: true, nowMs: 9_000_000_000_000, tasks: [] });
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        // Carry the resulting config state into the next run.
        for (const [k, v] of ctx.__mem.__values.entries()) seed[k] = v;
        if (!(Number(seed[BACKFILL_BEFORE_KEY] ?? '0') > 0)) break;
      }

      // Every message date was observed at least once — nothing permanently skipped.
      for (let d = 1000; d <= 2099; d++) expect(observed.has(d)).toBe(true);
      // The watermark jumps past the newest only after the whole range is drained.
      expect(seed[WATERMARK_KEY]).toBe('2100');
      // Backfill keys are cleared once the drain completes.
      expect(Number(seed[BACKFILL_BEFORE_KEY] ?? '0')).toBe(0);
      expect(Number(seed[BACKFILL_TARGET_KEY] ?? '0')).toBe(0);
    });

    it('pins the watermark during the drain and only jumps it on completion', async () => {
      const corpus = Array.from({ length: 1100 }, (_v, i) => ({ id: `m${i}`, date: 1000 + i }));
      serveSentCorpus(mockFetch, corpus);
      const seed: Record<string, string> = { [WATERMARK_KEY]: '999' };

      // Run 1: enters backfill. Watermark stays pinned at 999; target/ceiling recorded.
      let ctx = buildCtx({ seed: { ...seed }, force: true, nowMs: 9_000_000_000_000, tasks: [] });
      let result = await handler.execute(ctx);
      expect((result as { data: { watermark_advanced_to: number | null; backfill_active: boolean } }).data.watermark_advanced_to).toBeNull();
      expect((result as { data: { backfill_active: boolean } }).data.backfill_active).toBe(true);
      expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('999');
      expect(ctx.__mem.__values.get(BACKFILL_TARGET_KEY)).toBe('2099');
      expect(ctx.__mem.__values.get(BACKFILL_BEFORE_KEY)).toBe('1600');
      for (const [k, v] of ctx.__mem.__values.entries()) seed[k] = v;

      // Run 2: descends the ceiling; watermark still pinned.
      ctx = buildCtx({ seed: { ...seed }, force: true, nowMs: 9_000_000_000_000, tasks: [] });
      await handler.execute(ctx);
      expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('999');
      expect(ctx.__mem.__values.get(BACKFILL_BEFORE_KEY)).toBe('1101');
      for (const [k, v] of ctx.__mem.__values.entries()) seed[k] = v;

      // Run 3: drains the oldest sub-window → watermark jumps to target+1, keys cleared.
      ctx = buildCtx({ seed: { ...seed }, force: true, nowMs: 9_000_000_000_000, tasks: [] });
      result = await handler.execute(ctx);
      expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('2100');
      expect((result as { data: { backfill_active: boolean } }).data.backfill_active).toBe(false);
      expect(Number(ctx.__mem.__values.get(BACKFILL_BEFORE_KEY) ?? '0')).toBe(0);
    });

    it('first-ever run (watermark 0) is forward-only — no backfill initiated', async () => {
      const corpus = Array.from({ length: 1100 }, (_v, i) => ({ id: `m${i}`, date: 1000 + i }));
      serveSentCorpus(mockFetch, corpus);

      const ctx = buildCtx({ force: true, nowMs: 9_000_000_000_000, tasks: [] }); // no seed → watermark 0
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      // Advanced to the newest seen; NO backfill drain of history was started.
      expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('2100');
      expect((result as { data: { backfill_active: boolean } }).data.backfill_active).toBe(false);
      expect(ctx.__mem.__values.get(BACKFILL_BEFORE_KEY)).toBeUndefined();
      expect(ctx.__mem.__values.get(BACKFILL_TARGET_KEY)).toBeUndefined();
    });

    it('holds the drain (no completion) on an empty page with a lingering cursor (truncated, 0 messages)', async () => {
      // listAllMessages reports truncated=true even for an empty page that still carries a cursor —
      // an incomplete walk that must NOT be read as fully drained. A backfill run seeing that shape
      // must hold (no watermark jump, no key clear), not declare the drain complete.
      mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
        const u = String(url);
        if (/\/messages\/[^?]+$/.test(new URL(u).pathname)) {
          return new Response(JSON.stringify({ data: { id: 'x', date: 0, body: '', bcc: [], labels: [], folders: ['SENT'] } }), { status: 200 });
        }
        // Empty data + a lingering next_cursor → listAllMessages returns { messages: [], truncated: true }.
        return new Response(JSON.stringify({ data: [], next_cursor: 'LINGER' }), { status: 200 });
      });

      const ctx = buildCtx({
        seed: { [WATERMARK_KEY]: '999', [BACKFILL_BEFORE_KEY]: '1600', [BACKFILL_TARGET_KEY]: '2099' },
        force: true,
        nowMs: 9_000_000_000_000,
        tasks: [],
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      // Everything held: watermark pinned, keys unchanged, drain still active — retries next run.
      expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('999');
      expect(ctx.__mem.__values.get(BACKFILL_BEFORE_KEY)).toBe('1600');
      expect(ctx.__mem.__values.get(BACKFILL_TARGET_KEY)).toBe('2099');
      expect((result as { data: { watermark_advanced_to: number | null; backfill_active: boolean } }).data.watermark_advanced_to).toBeNull();
      expect((result as { data: { backfill_active: boolean } }).data.backfill_active).toBe(true);
    });

    it('floor-guards completion: a lost backfill_target never regresses the watermark to epoch', async () => {
      // Simulate a desync (a soft-rejected target write left BACKFILL_TARGET unset while a drain is
      // active). On completion the watermark must jump to the pinned floor + 1, NOT to 1 (epoch).
      const corpus = Array.from({ length: 101 }, (_v, i) => ({ id: `m${i}`, date: 1000 + i })); // 1000..1100
      serveSentCorpus(mockFetch, corpus);

      // Active drain (BACKFILL_BEFORE set) but NO BACKFILL_TARGET → reads as 0. Window [999, 1101]
      // holds all 101 messages (≤ SENT_MAX_SCAN) so the run is not truncated → drain completes.
      const ctx = buildCtx({
        seed: { [WATERMARK_KEY]: '999', [BACKFILL_BEFORE_KEY]: '1101' },
        force: true,
        nowMs: 9_000_000_000_000,
        tasks: [],
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      // max(floor=999, target=0) + 1 = 1000 — advances forward, never resets to epoch (1).
      expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('1000');
      expect((result as { data: { watermark_advanced_to: number | null } }).data.watermark_advanced_to).toBe(1000);
      expect(Number(ctx.__mem.__values.get(BACKFILL_BEFORE_KEY) ?? '0')).toBe(0);
    });

    it('holds the drain window (no key moves) when evidence persistence fails mid-drain', async () => {
      // Enter a drain, then on the descend run make the matched-guard write soft-reject so
      // advanceOk is false: the ceiling must NOT descend and the watermark must stay pinned.
      const corpus = Array.from({ length: 1100 }, (_v, i) => ({ id: `m${i}`, date: 1000 + i }));
      serveSentCorpus(mockFetch, corpus);
      const seed: Record<string, string> = { [WATERMARK_KEY]: '999' };

      // Run 1 enters backfill (ceiling 1600).
      let ctx = buildCtx({ seed: { ...seed }, force: true, nowMs: 9_000_000_000_000, tasks: [] });
      await handler.execute(ctx);
      for (const [k, v] of ctx.__mem.__values.entries()) seed[k] = v;
      expect(seed[BACKFILL_BEFORE_KEY]).toBe('1600');

      // Run 2: force every storeFact to soft-reject (stored:false) → guard writes fail → advanceOk false.
      ctx = buildCtx({ seed: { ...seed }, force: true, nowMs: 9_000_000_000_000, tasks: [] });
      (ctx.__mem.storeFact as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async () => ({ stored: false, action: 'conflict' as const }),
      );
      await handler.execute(ctx);
      // Ceiling did NOT descend and the watermark stayed pinned — the window retries next run.
      expect(ctx.__mem.__values.get(BACKFILL_BEFORE_KEY)).toBe('1600');
      expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe('999');
    });
  });
});
