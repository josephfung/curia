// late-delegation-phase1.test.ts — end-to-end correlation of a late specialist response (#1799).
//
// The prod failure this covers: the weekly travel sweep delegated to calendar, the wait timed
// out, the coordinator's turn stopped, and calendar delivered a full result minutes later that
// nothing consumed — four weeks running, with a "Review: … could not complete delegated work"
// row piling up each time. Phase 1's contract is that the late response is matched back to the
// delegation, lands on that review row, and is auditable.
//
// Real Postgres and a real EventBus with the real AuditLogger attached as the write-ahead hook:
// the sweep's restart recovery reads audit_log, so a mocked audit layer would test nothing.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { AuditLogger } from '../../src/audit/logger.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { LateDelegationSubscriber } from '../../src/agents/late-delegation-subscriber.js';
import { LateDelegationSweep } from '../../src/agents/late-delegation-sweep.js';
import {
  createAgentResponse,
  createDelegationTimedOut,
  type DelegationTimedOutEvent,
} from '../../src/bus/events.js';
import {
  claimPendingDelegation,
  finalizePendingDelegation,
  getPendingDelegationByDelegateEventId,
  recordPendingDelegation,
  releasePendingDelegationClaim,
} from '../../src/db/queries/pending-delegations.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'LateDelegation Test';
const logger = pino({ level: 'silent' });

/** Unique per test so a rerun against a dirty DB cannot collide on the UNIQUE key. */
let seq = 0;
function nextDelegateEventId(): string {
  seq += 1;
  return `late-deleg-test-${process.pid}-${seq}`;
}

function timedOutEvent(
  overrides: Partial<DelegationTimedOutEvent['payload']> = {},
): DelegationTimedOutEvent {
  return createDelegationTimedOut(
    {
      delegateEventId: nextDelegateEventId(),
      delegateConversationId: 'delegate-conv-1',
      targetAgent: 'calendar',
      delegateTask: 'Detect travel since Aug 17',
      agentId: 'coordinator',
      conversationId: 'scheduler:cff7f3bb-job:run-1',
      channelId: 'scheduler',
      senderId: 'scheduler',
      originTaskEventId: 'origin-task-1',
      originator: {
        contactId: 'contact-ceo',
        systemRole: 'principal',
        channel: 'scheduler',
        initiatedAt: '2026-09-14T12:00:00.000Z',
      },
      waitTimeoutMs: 90_000,
      ...overrides,
    },
    'origin-task-1',
  );
}

describeIf('Late delegation phase 1 — correlation, review-task record, audit (#1799)', () => {
  let pool: pg.Pool;
  let bus: EventBus;
  let taskRepo: TaskRepo;
  let subscriber: LateDelegationSubscriber;
  let sweep: LateDelegationSweep;
  // Set true only after requireCuriaTestDatabase confirms we are on curia_test. The cleanup hooks
  // gate on it: DATABASE_URL presence is the execution gate, not proof of which database the pool
  // reached, and vitest still runs afterAll after a FAILED beforeAll — so without this flag a
  // guard abort against a mispointed URL would still fire these DELETEs at a real database.
  let onTestDb = false;

  async function cleanup(): Promise<void> {
    if (!onTestDb) return;
    await pool.query(
      `DELETE FROM pending_delegations WHERE review_task_id IN (SELECT id FROM tasks WHERE title LIKE $1)
          OR delegate_event_id LIKE 'late-deleg-test-%'`,
      [`%${PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
      [`%${PREFIX}%`],
    );
    await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`%${PREFIX}%`]);
    // audit_log is append-only by trigger (migration 021) — its rows stay, as in every other
    // integration test that publishes events.
  }

  /** A stand-in for the CEO row escalateDelegationFailure creates. */
  async function createReviewTask(): Promise<string> {
    const task = await taskRepo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX}: Review: calendar could not complete delegated work`,
      owner: 'ceo',
      source: 'coordinator',
      tags: ['delegation-failure', 'calendar', 'agent_incomplete'],
      progressNote: 'Specialist may still be running — check whether it already delivered.',
    });
    return task.id;
  }

  async function lastNote(taskId: string): Promise<string | undefined> {
    const task = await taskRepo.getTask(taskId);
    const notes = (task?.progress?.['notes'] ?? []) as Array<{ note?: string }>;
    return notes[notes.length - 1]?.note;
  }

  async function noteCount(taskId: string): Promise<number> {
    const task = await taskRepo.getTask(taskId);
    return ((task?.progress?.['notes'] ?? []) as unknown[]).length;
  }

  async function lateResolvedAudit(delegateEventId: string): Promise<{
    outcome: string | null;
    target_type: string | null;
    conversation_id: string | null;
    payload: Record<string, unknown>;
  } | null> {
    const { rows } = await pool.query(
      `SELECT outcome, target_type, conversation_id, payload FROM audit_log
        WHERE event_type = 'delegation.late_resolved' AND target_id = $1
        ORDER BY seq DESC LIMIT 1`,
      [delegateEventId],
    );
    return (rows[0] as {
      outcome: string | null;
      target_type: string | null;
      conversation_id: string | null;
      payload: Record<string, unknown>;
    } | undefined) ?? null;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    onTestDb = true;
    const auditLogger = new AuditLogger(pool, logger);
    // Write-ahead hook: every published event is persisted before delivery, exactly as in
    // production. This is what makes the sweep's audit_log recovery path real.
    bus = new EventBus(
      logger,
      (event) => auditLogger.log(event),
      (eventId) => auditLogger.markAcknowledged(eventId),
    );
    taskRepo = new TaskRepo(pool, bus, logger, 'America/Toronto');

    subscriber = new LateDelegationSubscriber({
      pool,
      bus,
      logger,
      taskRepo,
      ttlMinutes: 60,
      maxResultChars: 500,
      timezone: 'America/Toronto',
    });
    subscriber.start();

    sweep = new LateDelegationSweep({
      pool,
      bus,
      logger,
      taskRepo,
      intervalMinutes: 5,
      ttlMinutes: 60,
      maxResultChars: 500,
      timezone: 'America/Toronto',
    });
  });

  afterAll(async () => {
    sweep?.stop();
    await cleanup();
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it('opens one durable handle per timed-out delegation, with the origin routing intact', async () => {
    const reviewTaskId = await createReviewTask();
    const event = timedOutEvent({ reviewTaskId });
    await bus.publish('agent', event);

    const handle = await getPendingDelegationByDelegateEventId(pool, event.payload.delegateEventId);
    expect(handle).not.toBeNull();
    expect(handle?.status).toBe('pending');
    expect(handle?.targetAgent).toBe('calendar');
    expect(handle?.originConversationId).toBe('scheduler:cff7f3bb-job:run-1');
    expect(handle?.originAgentId).toBe('coordinator');
    expect(handle?.originChannelId).toBe('scheduler');
    // The job id is recovered from the conversation id, so a resumed turn can report against it
    // even if history is truncated away.
    expect(handle?.schedulerJobId).toBe('cff7f3bb-job');
    expect(handle?.reviewTaskId).toBe(reviewTaskId);
    expect(handle?.originator?.['contactId']).toBe('contact-ceo');
    expect(new Date(handle!.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('opens no second handle when the same delegation times out again', async () => {
    const event = timedOutEvent();
    await bus.publish('agent', event);
    // A DISTINCT event carrying the same delegate id — an operator replay or a re-emit. The same
    // event object cannot be published twice: audit_log is keyed on the event id, so a literal
    // duplicate is rejected before any subscriber sees it.
    await bus.publish('agent', timedOutEvent({ delegateEventId: event.payload.delegateEventId }));

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pending_delegations WHERE delegate_event_id = $1`,
      [event.payload.delegateEventId],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('matches the late response, records the result on the review task, and audits it', async () => {
    const reviewTaskId = await createReviewTask();
    const event = timedOutEvent({ reviewTaskId });
    await bus.publish('agent', event);

    // The abandoned specialist finishes and publishes — minutes later in prod, immediately here.
    const late = createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'Travel detected: YYZ→SFO Oct 2–5, YYZ→LHR Oct 19–24.',
      parentEventId: event.payload.delegateEventId,
    });
    await bus.publish('agent', late);

    const handle = await getPendingDelegationByDelegateEventId(pool, event.payload.delegateEventId);
    expect(handle?.status).toBe('resolved');
    expect(handle?.resolution).toBe('annotated_result');
    expect(handle?.lateResponseEventId).toBe(late.id);
    expect(handle?.resolvedAt).not.toBeNull();

    // The result itself lands on the row the digest reads — the point of the annotate floor.
    const note = await lastNote(reviewTaskId);
    expect(note).toContain('Travel detected: YYZ→SFO Oct 2–5');
    expect(note).toContain('have NOT run yet');

    // Phase 1 does not close the row: a recorded result still needs a human to run the
    // follow-up steps, so closing it here would hide real work.
    const task = await taskRepo.getTask(reviewTaskId);
    expect(task?.status).toBe('open');

    const audit = await lateResolvedAudit(event.payload.delegateEventId);
    expect(audit).not.toBeNull();
    expect(audit?.target_type).toBe('delegation');
    expect(audit?.outcome).toBe('success');
    // The audit row links the late response to the conversation that asked for the work.
    expect(audit?.conversation_id).toBe('scheduler:cff7f3bb-job:run-1');
    expect(audit?.payload['resolution']).toBe('annotated_result');
    expect(audit?.payload['reviewTaskOutcome']).toBe('annotated');
  });

  it('acts on a late response at most once, however many times it is replayed', async () => {
    const reviewTaskId = await createReviewTask();
    const event = timedOutEvent({ reviewTaskId });
    await bus.publish('agent', event);

    const before = await noteCount(reviewTaskId);
    const late = createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'Travel detected: one trip.',
      parentEventId: event.payload.delegateEventId,
    });
    await bus.publish('agent', late);
    // Two more responses for the same delegation — a chatty specialist, or a second run of one.
    // Each is its own event; only the first may act on the handle.
    for (const content of ['Travel detected: one trip (again).', 'Still one trip.']) {
      await bus.publish('agent', createAgentResponse({
        agentId: 'calendar',
        conversationId: 'delegate-conv-1',
        content,
        parentEventId: event.payload.delegateEventId,
      }));
    }

    expect(await noteCount(reviewTaskId)).toBe(before + 1);
    // And the sweep, seeing the same response in audit_log, does not re-open the question.
    const result = await sweep.tick();
    expect(result.recovered).toBe(0);
  });

  it('records a specialist that ultimately failed as work that did not happen', async () => {
    const reviewTaskId = await createReviewTask();
    const event = timedOutEvent({ reviewTaskId });
    await bus.publish('agent', event);

    await bus.publish('agent', createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'I ran out of turns.',
      isError: true,
      reason: 'maxTurns',
      retryable: false,
      parentEventId: event.payload.delegateEventId,
    }));

    const handle = await getPendingDelegationByDelegateEventId(pool, event.payload.delegateEventId);
    expect(handle?.resolution).toBe('annotated_error');
    const note = await lastNote(reviewTaskId);
    expect(note).toContain('maxTurns');
    expect(note).toContain('did not happen');
    // Still open: nothing was delivered, so the escalation stands.
    expect((await taskRepo.getTask(reviewTaskId))?.status).toBe('open');
  });

  it('defers to a human who already closed the review task', async () => {
    const reviewTaskId = await createReviewTask();
    const event = timedOutEvent({ reviewTaskId });
    await bus.publish('agent', event);

    // The CEO dealt with it by hand before the specialist came back.
    await taskRepo.completeTask(reviewTaskId, 'Handled manually', 'ceo');

    await bus.publish('agent', createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'Travel detected: one trip.',
      parentEventId: event.payload.delegateEventId,
    }));

    const handle = await getPendingDelegationByDelegateEventId(pool, event.payload.delegateEventId);
    expect(handle?.resolution).toBe('annotated_review_closed');
    const audit = await lateResolvedAudit(event.payload.delegateEventId);
    // A closed row cannot be annotated (append-only guard on terminal tasks), and that is
    // reported rather than forced.
    expect(audit?.payload['reviewTaskOutcome']).toBe('review_task_terminal');
    expect((await taskRepo.getTask(reviewTaskId))?.status).toBe('done');
  });

  it('marks a nested delegation unroutable instead of pretending it can be delivered', async () => {
    const reviewTaskId = await createReviewTask();
    const event = timedOutEvent({
      reviewTaskId,
      channelId: 'internal',
      conversationId: 'delegate-outer-conv',
    });
    await bus.publish('agent', event);

    await bus.publish('agent', createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'Inner result.',
      parentEventId: event.payload.delegateEventId,
    }));

    const handle = await getPendingDelegationByDelegateEventId(pool, event.payload.delegateEventId);
    expect(handle?.resolution).toBe('annotated_unroutable');
    expect(handle?.schedulerJobId).toBeNull();
    expect(await lastNote(reviewTaskId)).toContain('Inner result.');
  });

  describe('sweep backstop', () => {
    it('recovers a response that arrived while nothing was listening (restart path)', async () => {
      const reviewTaskId = await createReviewTask();
      const delegateEventId = nextDelegateEventId();

      // Simulate the restart: the handle exists in the DB, but the response was published with
      // no live matcher — it only exists in audit_log.
      await recordPendingDelegation(pool, {
        delegateEventId,
        delegateConversationId: 'delegate-conv-restart',
        targetAgent: 'calendar',
        delegateTask: 'Detect travel since Aug 17',
        originAgentId: 'coordinator',
        originConversationId: 'scheduler:restart-job:run-2',
        originChannelId: 'scheduler',
        originSenderId: 'scheduler',
        reviewTaskId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await pool.query(
        `INSERT INTO audit_log (event_type, source_layer, source_id, payload, conversation_id, parent_event_id)
         VALUES ('agent.response', 'agent', 'calendar', $1::jsonb, 'delegate-conv-restart', $2)`,
        [
          JSON.stringify({
            agentId: 'calendar',
            conversationId: 'delegate-conv-restart',
            content: 'Travel detected after restart: YYZ→JFK Nov 3.',
          }),
          delegateEventId,
        ],
      );

      const result = await sweep.tick();
      expect(result.recovered).toBe(1);

      const handle = await getPendingDelegationByDelegateEventId(pool, delegateEventId);
      expect(handle?.status).toBe('resolved');
      expect(handle?.resolution).toBe('annotated_result');
      expect(await lastNote(reviewTaskId)).toContain('Travel detected after restart');
    });

    it('abandons an expired handle and corrects the review task', async () => {
      const reviewTaskId = await createReviewTask();
      const delegateEventId = nextDelegateEventId();
      await recordPendingDelegation(pool, {
        delegateEventId,
        delegateConversationId: 'delegate-conv-expired',
        targetAgent: 'calendar',
        delegateTask: 'Detect travel since Aug 17',
        originAgentId: 'coordinator',
        originConversationId: 'scheduler:expired-job:run-3',
        originChannelId: 'scheduler',
        originSenderId: 'scheduler',
        reviewTaskId,
        expiresAt: new Date(Date.now() - 60_000),
      });

      const result = await sweep.tick();
      expect(result.abandoned).toBe(1);

      const handle = await getPendingDelegationByDelegateEventId(pool, delegateEventId);
      expect(handle?.resolution).toBe('abandoned_ttl');

      // The row no longer tells the principal to go check whether it delivered.
      const note = await lastNote(reviewTaskId);
      expect(note).toContain('never delivered');
      expect(note).toContain('60 minutes');
      expect((await taskRepo.getTask(reviewTaskId))?.status).toBe('open');

      const audit = await lateResolvedAudit(delegateEventId);
      expect(audit?.outcome).toBe('failure');
      expect(audit?.payload['resolution']).toBe('abandoned_ttl');
    });

    it('re-claims a handle whose actor died mid-flight and finishes the work', async () => {
      const reviewTaskId = await createReviewTask();
      const delegateEventId = nextDelegateEventId();
      await recordPendingDelegation(pool, {
        delegateEventId,
        delegateConversationId: 'delegate-conv-crash',
        targetAgent: 'calendar',
        delegateTask: 'Detect travel since Aug 17',
        originAgentId: 'coordinator',
        originConversationId: 'scheduler:crash-job:run-1',
        originChannelId: 'scheduler',
        originSenderId: 'scheduler',
        reviewTaskId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await pool.query(
        `INSERT INTO audit_log (event_type, source_layer, source_id, payload, conversation_id, parent_event_id)
         VALUES ('agent.response', 'agent', 'calendar', $1::jsonb, 'delegate-conv-crash', $2)`,
        [
          JSON.stringify({ agentId: 'calendar', content: 'Travel detected: YYZ→BOS Dec 1.' }),
          delegateEventId,
        ],
      );
      // An actor took the lease and died before annotating — exactly the state a crash leaves.
      await pool.query(
        `UPDATE pending_delegations
            SET status = 'claimed', claimed_at = now() - interval '10 minutes',
                claim_token = gen_random_uuid(), resolution = 'annotated_result'
          WHERE delegate_event_id = $1`,
        [delegateEventId],
      );

      const result = await sweep.tick();
      expect(result.recovered).toBe(1);

      const handle = await getPendingDelegationByDelegateEventId(pool, delegateEventId);
      expect(handle?.status).toBe('resolved');
      // The work the dead actor owed is now actually done.
      expect(await lastNote(reviewTaskId)).toContain('Travel detected: YYZ→BOS Dec 1.');
    });

    it('does not touch a handle whose lease is still live', async () => {
      const reviewTaskId = await createReviewTask();
      const delegateEventId = nextDelegateEventId();
      await recordPendingDelegation(pool, {
        delegateEventId,
        delegateConversationId: 'delegate-conv-live',
        targetAgent: 'calendar',
        delegateTask: 'Detect travel',
        originAgentId: 'coordinator',
        originConversationId: 'scheduler:live-job:run-1',
        originChannelId: 'scheduler',
        originSenderId: 'scheduler',
        reviewTaskId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await pool.query(
        `INSERT INTO audit_log (event_type, source_layer, source_id, payload, conversation_id, parent_event_id)
         VALUES ('agent.response', 'agent', 'calendar', $1::jsonb, 'delegate-conv-live', $2)`,
        [JSON.stringify({ agentId: 'calendar', content: 'In-flight result.' }), delegateEventId],
      );
      const notesBefore = await noteCount(reviewTaskId);
      await pool.query(
        `UPDATE pending_delegations
            SET status = 'claimed', claimed_at = now(),
                claim_token = gen_random_uuid(), resolution = 'annotated_result'
          WHERE delegate_event_id = $1`,
        [delegateEventId],
      );

      const result = await sweep.tick();

      // Another actor is mid-flight; stealing the handle would double-annotate the review task.
      expect(result.recovered).toBe(0);
      expect(await noteCount(reviewTaskId)).toBe(notesBefore);
      const handle = await getPendingDelegationByDelegateEventId(pool, delegateEventId);
      expect(handle?.status).toBe('claimed');
    });

    it('refuses a stale holder finalizing or releasing a newer claimant\'s lease', async () => {
      // Worker A claims, stalls past its lease, and worker B takes over. A must not be able to
      // close out — or hand back — work B now owns: finalizing B's in-flight handle would mark
      // unfinished work resolved and strand it, which is the loss the lease exists to prevent.
      const delegateEventId = nextDelegateEventId();
      await recordPendingDelegation(pool, {
        delegateEventId,
        delegateConversationId: 'delegate-conv-steal',
        targetAgent: 'calendar',
        delegateTask: 'Detect travel',
        originAgentId: 'coordinator',
        originConversationId: 'scheduler:steal-job:run-1',
        originChannelId: 'scheduler',
        originSenderId: 'scheduler',
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const workerA = await claimPendingDelegation(pool, {
        delegateEventId,
        resolution: 'annotated_result',
        leaseSeconds: 120,
      });
      expect(workerA?.claimToken).toBeTruthy();

      // A stalls: backdate its lease so it is expired, then B steals it.
      await pool.query(
        `UPDATE pending_delegations SET claimed_at = now() - interval '10 minutes' WHERE delegate_event_id = $1`,
        [delegateEventId],
      );
      const workerB = await claimPendingDelegation(pool, {
        delegateEventId,
        resolution: 'annotated_result',
        leaseSeconds: 120,
      });
      expect(workerB?.claimToken).toBeTruthy();
      expect(workerB!.claimToken).not.toBe(workerA!.claimToken);

      // A wakes up and tries to finish. Both attempts must be no-ops.
      expect(await finalizePendingDelegation(pool, delegateEventId, workerA!.claimToken!)).toBeNull();
      await releasePendingDelegationClaim(pool, delegateEventId, workerA!.claimToken!);

      const stillB = await getPendingDelegationByDelegateEventId(pool, delegateEventId);
      expect(stillB?.status).toBe('claimed');
      expect(stillB?.claimToken).toBe(workerB!.claimToken);

      // B finishes normally with its own token.
      const finalized = await finalizePendingDelegation(pool, delegateEventId, workerB!.claimToken!);
      expect(finalized?.status).toBe('resolved');
    });

    it('leaves a young handle with no response alone', async () => {
      const delegateEventId = nextDelegateEventId();
      await recordPendingDelegation(pool, {
        delegateEventId,
        delegateConversationId: 'delegate-conv-young',
        targetAgent: 'calendar',
        delegateTask: 'Detect travel',
        originAgentId: 'coordinator',
        originConversationId: 'scheduler:young-job:run-1',
        originChannelId: 'scheduler',
        originSenderId: 'scheduler',
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const result = await sweep.tick();
      expect(result.recovered).toBe(0);
      expect(result.abandoned).toBe(0);
      expect(result.untouched).toBeGreaterThanOrEqual(1);

      const handle = await getPendingDelegationByDelegateEventId(pool, delegateEventId);
      expect(handle?.status).toBe('pending');
    });
  });
});
