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
    // Applies the frontmatter patch to the in-memory doc so a follow-up read()
    // reflects reconciled_at — mirrors the real repo's update() semantics closely
    // enough for the shadow-reconcile assertions below.
    update: vi.fn(async (path: string, params: { frontmatter: Record<string, unknown>; expectedVersion: number }) => {
      const cur = docs.get(path);
      if (!cur) throw new Error('missing');
      if (cur.version !== params.expectedVersion) {
        return { ok: false as const, conflict: true as const, document: cur };
      }
      const next = { ...cur, frontmatter: params.frontmatter, version: cur.version + 1 };
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
      return '';
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
            linked_task_ids: [],
            agent_version: '0.3.0',
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
            disposition: 'punt',
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

    const data = (result as { data: { shadow_reconciled: number } }).data;
    expect(data.shadow_reconciled).toBe(1);
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
