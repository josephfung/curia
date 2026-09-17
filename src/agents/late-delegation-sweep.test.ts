// late-delegation-sweep.test.ts — branch selection and per-handle isolation (#1799).
//
// The DB-backed behaviour (real claim semantics, real task rows) is covered by
// tests/integration/late-delegation-phase1.test.ts. This file drives the sweep's control flow
// in-process: which branch a handle takes, that a claim lost to another path is not counted as
// work done, and that one failing handle does not abort the pass.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type pg from 'pg';
import { EventBus } from '../bus/bus.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { DelegationLateResolvedEvent } from '../bus/events.js';
import { LateDelegationSweep } from './late-delegation-sweep.js';

const logger = pino({ level: 'silent' });

interface FakeHandleRow {
  id: string;
  delegate_event_id: string;
  delegate_conversation_id: string;
  target_agent: string;
  delegate_task: string;
  origin_agent_id: string;
  origin_conversation_id: string;
  origin_channel_id: string;
  origin_sender_id: string;
  origin_task_event_id: string | null;
  originator: Record<string, unknown> | null;
  scheduler_job_id: string | null;
  review_task_id: string | null;
  status: string;
  resolution: string | null;
  late_response_event_id: string | null;
  wake_task_event_id: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

function handleRow(overrides: Partial<FakeHandleRow> = {}): FakeHandleRow {
  return {
    id: 'handle-1',
    delegate_event_id: 'delegate-evt-1',
    delegate_conversation_id: 'delegate-conv-1',
    target_agent: 'calendar',
    delegate_task: 'Detect travel',
    origin_agent_id: 'coordinator',
    origin_conversation_id: 'scheduler:job-1:run-1',
    origin_channel_id: 'scheduler',
    origin_sender_id: 'scheduler',
    origin_task_event_id: 'origin-1',
    originator: null,
    scheduler_job_id: 'job-1',
    review_task_id: null,
    status: 'pending',
    resolution: null,
    late_response_event_id: null,
    wake_task_event_id: null,
    created_at: '2026-09-14T12:00:00.000Z',
    expires_at: '2026-09-14T13:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

interface FakePoolOptions {
  open: FakeHandleRow[];
  /** audit_log hit per delegate_event_id, when the specialist did respond. */
  auditHits?: Record<string, { id: string; payload: Record<string, unknown>; timestamp: string }>;
  /** delegate_event_ids whose claim loses the race (another path resolved it first). */
  claimLoses?: Set<string>;
  /** delegate_event_ids whose audit lookup throws. */
  auditThrows?: Set<string>;
}

function fakePool(opts: FakePoolOptions): { pool: pg.Pool; claims: Array<{ id: string; resolution: string }> } {
  const claims: Array<{ id: string; resolution: string }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM pending_delegations') && sql.includes("status = 'pending'")) {
      return { rows: opts.open };
    }
    if (sql.includes('FROM audit_log')) {
      const id = params[0] as string;
      if (opts.auditThrows?.has(id)) throw new Error('audit_log unavailable');
      const hit = opts.auditHits?.[id];
      return { rows: hit ? [hit] : [] };
    }
    if (sql.includes('UPDATE pending_delegations') && sql.includes("SET status = 'resolved'")) {
      const id = params[0] as string;
      const resolution = params[1] as string;
      if (opts.claimLoses?.has(id)) return { rows: [] };
      claims.push({ id, resolution });
      const row = opts.open.find((r) => r.delegate_event_id === id) ?? handleRow({ delegate_event_id: id });
      return { rows: [{ ...row, status: 'resolved', resolution, resolved_at: '2026-09-14T12:30:00.000Z' }] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  });
  return { pool: { query } as unknown as pg.Pool, claims };
}

/** Duck-typed TaskRepo: no review task on these handles unless a test says otherwise. */
function fakeTaskRepo(): TaskRepo {
  return {
    getTask: vi.fn(async () => null),
    updateTask: vi.fn(async () => null),
  } as unknown as TaskRepo;
}

function makeSweep(pool: pg.Pool, bus: EventBus) {
  return new LateDelegationSweep({
    pool,
    bus,
    logger,
    taskRepo: fakeTaskRepo(),
    intervalMinutes: 5,
    ttlMinutes: 60,
    maxResultChars: 500,
  });
}

function collectResolved(bus: EventBus): DelegationLateResolvedEvent[] {
  const events: DelegationLateResolvedEvent[] = [];
  bus.subscribe('delegation.late_resolved', 'system', (event) => {
    events.push(event as DelegationLateResolvedEvent);
  });
  return events;
}

const NOW = new Date('2026-09-14T12:30:00.000Z');

describe('LateDelegationSweep.tick (#1799)', () => {
  it('recovers a handle whose response is already in audit_log', async () => {
    const { pool, claims } = fakePool({
      open: [handleRow()],
      auditHits: {
        'delegate-evt-1': {
          id: 'response-evt-1',
          payload: { agentId: 'calendar', content: 'Travel detected: one trip.' },
          timestamp: '2026-09-14T12:06:43.000Z',
        },
      },
    });
    const bus = new EventBus(logger);
    const resolved = collectResolved(bus);

    const result = await makeSweep(pool, bus).tick(NOW);

    expect(result).toMatchObject({ examined: 1, recovered: 1, abandoned: 0, untouched: 0 });
    expect(claims).toEqual([{ id: 'delegate-evt-1', resolution: 'annotated_result' }]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload.lateResponseEventId).toBe('response-evt-1');
    expect(resolved[0]!.payload.reviewTaskOutcome).toBe('no_review_task');
  });

  it('prefers recovery over expiry when a response exists on an expired handle', async () => {
    // A real result is worth more than a tidy abandonment, so the audit_log check comes first.
    const { pool, claims } = fakePool({
      open: [handleRow({ expires_at: '2026-09-14T12:00:00.000Z' })],
      auditHits: {
        'delegate-evt-1': {
          id: 'response-evt-late',
          payload: { agentId: 'calendar', content: 'Arrived very late but complete.' },
          timestamp: '2026-09-14T12:25:00.000Z',
        },
      },
    });
    const bus = new EventBus(logger);

    const result = await makeSweep(pool, bus).tick(NOW);

    expect(result.recovered).toBe(1);
    expect(result.abandoned).toBe(0);
    expect(claims[0]!.resolution).toBe('annotated_result');
  });

  it('abandons an expired handle with no response', async () => {
    const { pool, claims } = fakePool({ open: [handleRow({ expires_at: '2026-09-14T12:00:00.000Z' })] });
    const bus = new EventBus(logger);
    const resolved = collectResolved(bus);

    const result = await makeSweep(pool, bus).tick(NOW);

    expect(result).toMatchObject({ recovered: 0, abandoned: 1, untouched: 0 });
    expect(claims).toEqual([{ id: 'delegate-evt-1', resolution: 'abandoned_ttl' }]);
    expect(resolved[0]!.payload.lateResponseEventId).toBeUndefined();
  });

  it('leaves an unexpired handle with no response alone', async () => {
    const { pool, claims } = fakePool({ open: [handleRow({ expires_at: '2026-09-14T14:00:00.000Z' })] });
    const bus = new EventBus(logger);

    const result = await makeSweep(pool, bus).tick(NOW);

    expect(result).toMatchObject({ recovered: 0, abandoned: 0, untouched: 1 });
    expect(claims).toEqual([]);
  });

  it('does not count a handle another path claimed first', async () => {
    const { pool } = fakePool({
      open: [handleRow()],
      auditHits: {
        'delegate-evt-1': {
          id: 'response-evt-1',
          payload: { agentId: 'calendar', content: 'result' },
          timestamp: '2026-09-14T12:06:43.000Z',
        },
      },
      claimLoses: new Set(['delegate-evt-1']),
    });
    const bus = new EventBus(logger);
    const resolved = collectResolved(bus);

    const result = await makeSweep(pool, bus).tick(NOW);

    // The live subscriber got there first — no double annotation, no double audit event.
    expect(result).toMatchObject({ recovered: 0, abandoned: 0, untouched: 1 });
    expect(resolved).toHaveLength(0);
  });

  it('keeps sweeping after one handle fails, leaving the failed one open', async () => {
    const { pool, claims } = fakePool({
      open: [
        handleRow({ id: 'h-bad', delegate_event_id: 'delegate-bad' }),
        handleRow({
          id: 'h-good',
          delegate_event_id: 'delegate-good',
          expires_at: '2026-09-14T12:00:00.000Z',
        }),
      ],
      auditThrows: new Set(['delegate-bad']),
    });
    const bus = new EventBus(logger);

    const result = await makeSweep(pool, bus).tick(NOW);

    expect(result.examined).toBe(2);
    expect(result.abandoned).toBe(1);
    expect(result.untouched).toBe(1);
    expect(claims).toEqual([{ id: 'delegate-good', resolution: 'abandoned_ttl' }]);
  });

  it('reports an empty pass without touching anything', async () => {
    const { pool, claims } = fakePool({ open: [] });
    const bus = new EventBus(logger);
    const result = await makeSweep(pool, bus).tick(NOW);
    expect(result).toEqual({ examined: 0, recovered: 0, abandoned: 0, untouched: 0 });
    expect(claims).toEqual([]);
  });
});

describe('LateDelegationSweep interval (#1799)', () => {
  it('skips an interval while the previous tick is still running', async () => {
    vi.useFakeTimers();
    const { pool } = fakePool({ open: [] });
    const bus = new EventBus(logger);
    const sweep = makeSweep(pool, bus);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tickSpy = vi.spyOn(sweep, 'tick').mockImplementation(async () => {
      await gate;
      return { examined: 0, recovered: 0, abandoned: 0, untouched: 0 };
    });

    sweep.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    release!();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    sweep.stop();
    vi.useRealTimers();
  });

  it('stops firing after stop()', async () => {
    vi.useFakeTimers();
    const { pool } = fakePool({ open: [] });
    const sweep = makeSweep(pool, new EventBus(logger));
    const tickSpy = vi.spyOn(sweep, 'tick');

    sweep.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    sweep.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);

    expect(tickSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
