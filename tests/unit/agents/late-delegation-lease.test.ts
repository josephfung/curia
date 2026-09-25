// late-delegation-lease.test.ts — one resolution when the woken turn outlives the claim (#1861).
//
// EventBus.publish awaits the woken turn. That turn is longer than CLAIM_LEASE_SECONDS, so a
// sweep used to re-claim the row, fence the duplicate wake, and still annotate the review task
// and emit delegation.late_resolved a second time. These tests drive resolveLateDelegation
// against a pool that enforces the lease the way Postgres does.

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import type pg from 'pg';
import { EventBus } from '../../../src/bus/bus.js';
import type { TaskRepo } from '../../../src/db/task-repo.js';
import type { DelegationLateResolvedEvent } from '../../../src/bus/events.js';
import type { PendingDelegationRow } from '../../../src/db/queries/pending-delegations.js';
import {
  CLAIM_LEASE_RENEW_INTERVAL_MS,
  CLAIM_LEASE_SECONDS,
  deterministicWakeEventId,
  resolveLateDelegation,
} from '../../../src/agents/late-delegation.js';

const logger = pino({ level: 'silent' });

interface LeaseState {
  status: string;
  claimedAt: number | null;
  claimToken: string | null;
  resolution: string | null;
  wakeTaskEventId: string | null;
}

function dbRow(lease: LeaseState): Record<string, unknown> {
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
    review_task_id: 'review-1',
    status: lease.status,
    claimed_at: lease.claimedAt === null ? null : new Date(lease.claimedAt),
    claim_token: lease.claimToken,
    resolution: lease.resolution,
    late_response_event_id: 'response-evt-1',
    wake_task_event_id: lease.wakeTaskEventId,
    created_at: new Date('2026-09-14T12:00:00.000Z'),
    expires_at: new Date('2026-09-14T13:00:00.000Z'),
    resolved_at: lease.status === 'resolved' ? new Date() : null,
  };
}

function handle(): PendingDelegationRow {
  return {
    id: 'handle-1',
    delegateEventId: 'delegate-evt-1',
    delegateConversationId: 'delegate-conv-1',
    targetAgent: 'calendar',
    delegateTask: 'Detect travel',
    originAgentId: 'coordinator',
    originConversationId: 'scheduler:job-1:run-1',
    originChannelId: 'scheduler',
    originSenderId: 'scheduler',
    originTaskEventId: 'origin-1',
    originator: null,
    schedulerJobId: 'job-1',
    reviewTaskId: 'review-1',
    status: 'pending',
    claimedAt: null,
    claimToken: null,
    resolution: null,
    lateResponseEventId: 'response-evt-1',
    wakeTaskEventId: null,
    createdAt: new Date('2026-09-14T12:00:00.000Z'),
    expiresAt: new Date('2026-09-14T13:00:00.000Z'),
    resolvedAt: null,
  };
}

interface LeasePool {
  pool: pg.Pool;
  row: LeaseState;
  /** Tokens that successfully refreshed the lease, in order. */
  renewals: string[];
  claimAttempts: number;
  claimsWon: number;
}

function leasePool(opts: { lateResolved?: boolean } = {}): LeasePool {
  const row: LeaseState = {
    status: 'pending',
    claimedAt: null,
    claimToken: null,
    resolution: null,
    wakeTaskEventId: null,
  };
  const renewals: string[] = [];
  let claimAttempts = 0;
  let claimsWon = 0;
  let tokenSeq = 0;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SET status = 'claimed'")) {
      claimAttempts += 1;
      const leaseMs = Number(params[4]) * 1000;
      // Mirrors `claimed_at < now() - lease`: equal to the boundary is still live.
      const expired = row.claimedAt !== null && row.claimedAt + leaseMs < Date.now();
      const claimable = row.status === 'pending'
        || row.status === 'running'
        || (row.status === 'claimed' && expired);
      if (!claimable) return { rows: [] };
      tokenSeq += 1;
      claimsWon += 1;
      row.status = 'claimed';
      row.claimedAt = Date.now();
      row.claimToken = `token-${tokenSeq}`;
      row.resolution = params[1] as string;
      return { rows: [dbRow(row)] };
    }
    if (sql.includes('SET claimed_at = now()') && sql.includes('claim_token = $2')) {
      const token = params[1] as string;
      if (row.status === 'claimed' && row.claimToken === token) {
        row.claimedAt = Date.now();
        renewals.push(token);
        return { rows: [{ delegate_event_id: params[0] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SET wake_task_event_id')) {
      row.wakeTaskEventId = params[1] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = 'resolved'")) {
      if (row.status === 'claimed' && row.claimToken === params[1]) {
        row.status = 'resolved';
        return { rows: [dbRow(row)] };
      }
      return { rows: [] };
    }
    if (sql.includes("SET status = 'pending'")) {
      if (row.status === 'claimed' && row.claimToken === params[1]) {
        row.status = 'pending';
        row.claimedAt = null;
        row.claimToken = null;
        row.resolution = null;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("event_type = 'delegation.late_resolved'")) {
      return { rows: opts.lateResolved ? [{ found: 1 }] : [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return {
    pool: { query } as unknown as pg.Pool,
    row,
    renewals,
    get claimAttempts() { return claimAttempts; },
    get claimsWon() { return claimsWon; },
  };
}

function openReview(): { repo: TaskRepo; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => null);
  const repo = {
    getTask: vi.fn(async () => ({ id: 'review-1', status: 'open' })),
    updateTask: vi.fn(async () => null),
    completeTask: complete,
  } as unknown as TaskRepo;
  return { repo, complete };
}

function collectResolved(bus: EventBus): DelegationLateResolvedEvent[] {
  const events: DelegationLateResolvedEvent[] = [];
  bus.subscribe('delegation.late_resolved', 'system', (event) => {
    events.push(event as DelegationLateResolvedEvent);
  });
  return events;
}

/** Write-ahead uniqueness for agent.task, matching the audit logger's primary key. */
function fencingBus(alreadySent: Iterable<string> = []): EventBus {
  const seen = new Set(alreadySent);
  return new EventBus(logger, async (event) => {
    if (event.type !== 'agent.task') return;
    if (seen.has(event.id)) {
      const err = new Error('duplicate key value violates unique constraint "audit_log_pkey"') as Error & { code?: string };
      err.code = '23505';
      throw err;
    }
    seen.add(event.id);
  });
}

function resolutionOpts(
  pool: pg.Pool,
  bus: EventBus,
  taskRepo: TaskRepo,
): Parameters<typeof resolveLateDelegation>[0] {
  return {
    pool,
    bus,
    taskRepo,
    logger,
    handle: handle(),
    classification: {
      disposition: 'deliverable',
      resolution: 'delivered',
      note: 'late result handed back to the originating turn',
    },
    lateResponseEventId: 'response-evt-1',
    note: 'calendar delivered. Closing this review.',
    wakeBrief: 'The specialist finished. Do not delegate again.',
    closeReviewTask: true,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveLateDelegation lease (#1861)', () => {
  it('emits one resolution when the woken turn outlives the claim lease', async () => {
    vi.useFakeTimers();
    const lease = leasePool();
    const bus = fencingBus();
    const resolved = collectResolved(bus);
    const { repo, complete } = openReview();

    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let enteredTurn: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredTurn = resolve; });
    let wakes = 0;
    bus.subscribe('agent.task', 'system', async () => {
      wakes += 1;
      enteredTurn!();
      await turnGate;
    });

    const first = resolveLateDelegation(resolutionOpts(lease.pool, bus, repo));
    await entered;

    // Past the lease, with the renewal ticks in between. Without those ticks the second
    // claim would win: claimed_at + lease < now.
    await vi.advanceTimersByTimeAsync(CLAIM_LEASE_SECONDS * 1000 + 1_000);

    const second = await resolveLateDelegation(resolutionOpts(lease.pool, bus, repo));

    expect(second).toEqual({ resolved: false });
    expect(lease.claimAttempts).toBe(2);
    expect(lease.claimsWon).toBe(1);
    expect(lease.row.status).toBe('claimed');
    expect(lease.row.claimToken).toBe('token-1');
    expect(lease.renewals.length).toBeGreaterThanOrEqual(3);
    expect(lease.renewals.every((token) => token === 'token-1')).toBe(true);
    expect(CLAIM_LEASE_RENEW_INTERVAL_MS * 3).toBeLessThanOrEqual(CLAIM_LEASE_SECONDS * 1000);
    expect(complete).not.toHaveBeenCalled();
    expect(resolved).toHaveLength(0);
    expect(wakes).toBe(1);

    releaseTurn!();
    const firstResult = await first;

    expect(firstResult.resolved).toBe(true);
    expect(firstResult.reviewTaskOutcome).toBe('closed');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload.reviewTaskOutcome).toBe('closed');
    expect(resolved[0]!.payload.delegateEventId).toBe('delegate-evt-1');
    expect(wakes).toBe(1);
    expect(lease.row.status).toBe('resolved');
  });

  it('lets the actor who took the lease record the outcome, and the stalled holder does not', async () => {
    const lease = leasePool();
    const bus = fencingBus();
    const resolved = collectResolved(bus);
    const { repo, complete } = openReview();

    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let enteredTurn: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredTurn = resolve; });
    let wakes = 0;
    bus.subscribe('agent.task', 'system', async () => {
      wakes += 1;
      enteredTurn!();
      await turnGate;
    });

    const first = resolveLateDelegation(resolutionOpts(lease.pool, bus, repo));
    await entered;

    // Renewal did not keep up: the lease reads as expired, so a second actor can take it.
    lease.row.claimedAt = Date.now() - 10 * 60_000;
    const second = await resolveLateDelegation(resolutionOpts(lease.pool, bus, repo));

    expect(second.resolved).toBe(true);
    expect(second.reviewTaskOutcome).toBe('closed');
    expect(lease.claimsWon).toBe(2);
    expect(lease.row.claimToken).toBe('token-2');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload.reviewTaskOutcome).toBe('closed');
    expect(wakes).toBe(1);

    releaseTurn!();
    const firstResult = await first;

    expect(firstResult).toEqual({ resolved: false });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveLength(1);
    expect(wakes).toBe(1);
    expect(lease.row.status).toBe('resolved');
  });

  it('closes a re-claim without a second annotation when the outcome is already audited', async () => {
    const lease = leasePool({ lateResolved: true });
    const wakeId = deterministicWakeEventId('delegate-evt-1');
    const bus = fencingBus([wakeId]);
    const resolved = collectResolved(bus);
    const { repo, complete } = openReview();
    let wakes = 0;
    bus.subscribe('agent.task', 'system', () => { wakes += 1; });

    const result = await resolveLateDelegation(resolutionOpts(lease.pool, bus, repo));

    expect(result).toEqual({ resolved: true, resolution: 'delivered', wakeTaskEventId: wakeId });
    expect(wakes).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(resolved).toHaveLength(0);
    expect(lease.row.status).toBe('resolved');
  });

  it('releases the lease when the wake fails so a later attempt can still resolve', async () => {
    const lease = leasePool();
    let wakeAttempts = 0;
    const bus = new EventBus(logger, async (event) => {
      if (event.type !== 'agent.task') return;
      wakeAttempts += 1;
      if (wakeAttempts === 1) throw new Error('audit write failed');
    });
    const resolved = collectResolved(bus);
    const { repo, complete } = openReview();
    const opts = resolutionOpts(lease.pool, bus, repo);

    const first = await resolveLateDelegation(opts);
    expect(first).toEqual({ resolved: false, retryable: true });
    expect(lease.row.status).toBe('pending');
    expect(lease.row.claimToken).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(resolved).toHaveLength(0);

    const second = await resolveLateDelegation(opts);
    expect(second.resolved).toBe(true);
    expect(second.reviewTaskOutcome).toBe('closed');
    expect(wakeAttempts).toBe(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveLength(1);
    expect(lease.row.status).toBe('resolved');
  });
});
