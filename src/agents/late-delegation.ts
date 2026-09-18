// late-delegation.ts — what to do with a specialist response that arrives after the delegate
// wait gave up (#1799).
//
// Phase 1 (this module) makes the late response *visible and correlated*: it is matched to the
// handle the runtime opened, recorded on the escalation review task, and audited. It does not
// yet re-enter the originating agent — that is Phase 2, and `disposition: 'deliverable'` is the
// branch it will take over. Until then a deliverable result resolves as `annotated_result`: the
// CEO gets the finished work on the review task instead of a note telling them to go find it.
//
// The classification is a pure function of the late response plus two facts about the origin,
// so the live subscriber and the restart sweep cannot disagree about what a given response
// means. Everything with I/O lives in resolveLateDelegation, behind the atomic claim.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import {
  createDelegationLateResolved,
  type LateDelegationResolution,
  type LateDelegationReviewOutcome,
} from '../bus/events.js';
import {
  claimPendingDelegation,
  finalizePendingDelegation,
  releasePendingDelegationClaim,
  type PendingDelegationRow,
} from '../db/queries/pending-delegations.js';
import { EXECUTION_PAUSED_PROTOCOL } from './resumable-task.js';
import { toLocalIso } from '../time/timestamp.js';

/** Mirrors CLARIFICATION_PROTOCOL in skills/request-clarification/handler.ts. Duplicated as a
 *  literal rather than imported so src/ does not depend on a tool handler module — the same
 *  choice runtime.ts makes when it detects the marker. */
const CLARIFICATION_PROTOCOL = 'clarification_request';

/**
 * Origin channels with no path back to the originating turn. A delegated specialist runs on
 * 'internal' with a throwaway `delegate-<uuid>` conversation, so a nested delegation that times
 * out has no turn left to re-enter — the OUTER delegation's own handle is what carries the
 * failure somewhere a human can see it. Mirrors the deliverability guard in
 * SecretCaptureResumeSubscriber, minus 'scheduler': a scheduled job is precisely the origin
 * this mechanism exists to rescue.
 */
const UNROUTABLE_ORIGIN_CHANNELS = new Set(['internal', 'bullpen']);

/** Task statuses that mean a human already disposed of the review row. */
const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled', 'failed']);

/**
 * How long one actor may hold a handle while it annotates the review task and publishes the
 * audit event. Generously longer than two DB writes and a publish, short enough that a crashed
 * actor's work is picked up on the next sweep tick rather than hours later.
 */
export const CLAIM_LEASE_SECONDS = 120;

/** What the late response turned out to be. Maps 1:1 onto a resolution. `abandoned` is the one
 *  disposition classifyLateResponse never returns — it describes the absence of a response, and
 *  only the expiry sweep produces it (see abandonedClassification). */
export type LateDelegationDisposition =
  | 'deliverable'
  | 'error'
  | 'unroutable'
  | 'review_closed'
  | 'clarification'
  | 'paused'
  | 'abandoned';

export interface LateResponseFacts {
  /** The late agent.response payload (bus event payload, or the audit_log row's payload). */
  payload: Record<string, unknown>;
  /** Channel of the originating turn. */
  originChannelId: string;
  /** Status of the escalation review task, or null when there is no linked task. */
  reviewTaskStatus: string | null;
}

export interface LateResponseClassification {
  disposition: LateDelegationDisposition;
  resolution: LateDelegationResolution;
  /** Short machine-readable reason, carried on the audit event. */
  note: string;
  /** Structured failure reason when the specialist ultimately errored. */
  failureReason?: string;
}

/** Parse the `_curia_protocol` marker out of a response body, if it carries one. */
function protocolMarker(content: unknown): string | null {
  if (typeof content !== 'string' || content.trim() === '') return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const marker = parsed['_curia_protocol'];
    return typeof marker === 'string' ? marker : null;
  } catch {
    // Plain-text responses are the norm — not a parse failure worth reporting.
    return null;
  }
}

/**
 * Decide what a late response means. Order matters: a human's disposal of the review task wins
 * over everything (they may already have redone the work by hand), and a structured failure is
 * checked before routability because an errored specialist has nothing to deliver anywhere.
 */
export function classifyLateResponse(facts: LateResponseFacts): LateResponseClassification {
  const { payload, originChannelId, reviewTaskStatus } = facts;

  if (reviewTaskStatus !== null && TERMINAL_TASK_STATUSES.has(reviewTaskStatus)) {
    return {
      disposition: 'review_closed',
      resolution: 'annotated_review_closed',
      note: `review task already ${reviewTaskStatus} — a human disposed of this; not acting on the late result`,
    };
  }

  if (payload['isError'] === true) {
    const reason = typeof payload['reason'] === 'string' ? payload['reason'] : 'unknown';
    return {
      disposition: 'error',
      resolution: 'annotated_error',
      note: `specialist ultimately failed (${reason}) — nothing to deliver`,
      failureReason: reason,
    };
  }

  const marker = protocolMarker(payload['content']);
  if (marker === CLARIFICATION_PROTOCOL) {
    return {
      disposition: 'clarification',
      resolution: 'annotated_clarification',
      note: 'specialist came back with a question, not a result',
    };
  }
  if (marker === EXECUTION_PAUSED_PROTOCOL) {
    return {
      disposition: 'paused',
      resolution: 'annotated_paused',
      note: 'specialist paused mid-task — the resumable continuation path owns it',
    };
  }

  if (UNROUTABLE_ORIGIN_CHANNELS.has(originChannelId)) {
    return {
      disposition: 'unroutable',
      resolution: 'annotated_unroutable',
      note: `origin channel '${originChannelId}' has no turn to re-enter (nested delegation)`,
    };
  }

  return {
    disposition: 'deliverable',
    resolution: 'annotated_result',
    note: 'late result recorded for the principal (re-entry lands in phase 2)',
  };
}

/**
 * Pull the scheduled job id out of an origin conversation id. The scheduler builds
 * `scheduler:<jobId>:<runId>` per run (and `scheduler:<jobId>` for its own notices), so the
 * job id survives even when context truncation drops the original prompt from history — which
 * is what lets a resumed turn report progress against the right job.
 */
export function parseSchedulerJobId(conversationId: string): string | undefined {
  const parts = conversationId.split(':');
  if (parts[0] !== 'scheduler') return undefined;
  const jobId = parts[1];
  return jobId !== undefined && jobId.length > 0 ? jobId : undefined;
}

/**
 * How long to keep a handle open. The floor is twice the wait that already elapsed: a
 * delegation that needed a 12-minute window is slow by nature, and a specialist finishing just
 * past a long wait is the normal case, not a stuck one. Observed overruns are 1–15 minutes, so
 * the configured default (60 min) covers them with room to spare.
 */
export function computeLateDeliveryExpiry(
  now: Date,
  ttlMinutes: number,
  waitTimeoutMs?: number,
): Date {
  const ttlMs = ttlMinutes * 60_000;
  const floorMs = waitTimeoutMs !== undefined && Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0
    ? waitTimeoutMs * 2
    : 0;
  return new Date(now.getTime() + Math.max(ttlMs, floorMs));
}

/** Truncate a late result for inclusion in a progress note, marking any cut. */
export function capResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n…[truncated ${content.length - maxChars} chars — full result is on the agent.response audit event]`;
}

/** The classification for a handle that expired with nothing having arrived. */
export function abandonedClassification(ttlMinutes: number): LateResponseClassification {
  return {
    disposition: 'abandoned',
    resolution: 'abandoned_ttl',
    note: `no response within ${ttlMinutes} minutes of the timeout — work lost`,
  };
}

export interface RenderLateNoteParams {
  targetAgent: string;
  classification: LateResponseClassification;
  /** The late response body; absent for an expired handle. */
  content?: string;
  /** When the specialist delivered, already formatted for the principal's timezone. */
  deliveredAtDisplay?: string;
  maxResultChars: number;
  /** How long the handle stayed open — stated in the abandoned note. */
  ttlMinutes?: number;
}

/**
 * The progress note written onto the escalation review task — the field the daily digest reads
 * (#1267), which is the whole reason this lands there rather than only in a log line.
 */
export function renderLateNote(params: RenderLateNoteParams): string {
  const { targetAgent, classification, content, deliveredAtDisplay, maxResultChars } = params;
  const when = deliveredAtDisplay ? ` at ${deliveredAtDisplay}` : '';

  switch (classification.disposition) {
    case 'deliverable':
      return [
        `${targetAgent} finished after the delegate wait timed out and delivered${when}. Its result is below — the follow-up steps have NOT run yet.`,
        '',
        capResult(content ?? '', maxResultChars),
      ].join('\n');
    case 'error':
      return `${targetAgent} kept running after the timeout and then failed${when} (${classification.failureReason ?? 'unknown'}). The delegated work did not happen.`;
    case 'unroutable':
      return [
        `${targetAgent} delivered${when}, but the delegation came from another specialist's internal turn, so there is nowhere to route it automatically. Result below.`,
        '',
        capResult(content ?? '', maxResultChars),
      ].join('\n');
    case 'clarification':
      return [
        `${targetAgent} did not finish — it came back${when} needing a decision before it can continue:`,
        '',
        capResult(content ?? '', maxResultChars),
      ].join('\n');
    case 'paused':
      return `${targetAgent} paused mid-task${when} with progress saved; the platform's continuation path is carrying it forward, not this delegation.`;
    case 'review_closed':
      return `${targetAgent} delivered${when}, after this review was already closed. No action was taken automatically.`;
    case 'abandoned': {
      const waitedFor = params.ttlMinutes !== undefined
        ? ` within ${params.ttlMinutes} minutes of the delegate timeout`
        : ' before the handle expired';
      return `${targetAgent} never delivered a result — nothing arrived${waitedFor}, so the delegated work did not happen. Treat it as not started.`;
    }
  }
}

export interface HandleLateResponseOptions {
  pool: Pool;
  bus: EventBus;
  taskRepo: TaskRepo;
  logger: Logger;
  handle: PendingDelegationRow;
  /** The late agent.response payload. */
  responsePayload: Record<string, unknown>;
  /** The late agent.response event id — threads the audit chain and lands on the handle. */
  responseEventId: string;
  /** When the specialist actually delivered. */
  respondedAt: Date;
  maxResultChars: number;
  timezone?: string;
}

/**
 * The shared path for a late response, whether it arrived on the bus (live) or was found in
 * audit_log after a restart (sweep). Both go through the same classification and the same
 * atomic claim, so a response cannot be interpreted one way live and another way on recovery.
 */
export async function handleLateResponse(
  opts: HandleLateResponseOptions,
): Promise<ResolveLateDelegationResult> {
  const { pool, bus, taskRepo, logger, handle, responsePayload, responseEventId } = opts;

  // Read the review task's CURRENT status: a human closing it between the timeout and now is
  // exactly the signal that they took over, and it changes what we are allowed to do.
  let reviewTaskStatus: string | null = null;
  if (handle.reviewTaskId) {
    try {
      const reviewTask = await taskRepo.getTask(handle.reviewTaskId);
      reviewTaskStatus = reviewTask?.status ?? null;
    } catch (err) {
      // Classify without it rather than dropping the response — the worst case is that we
      // record a note on a row a human already closed, which annotateReviewTask then detects.
      logger.warn(
        { err, delegateEventId: handle.delegateEventId, reviewTaskId: handle.reviewTaskId },
        'Late delegation: could not read the review task — classifying without its status',
      );
    }
  }

  const classification = classifyLateResponse({
    payload: responsePayload,
    originChannelId: handle.originChannelId,
    reviewTaskStatus,
  });

  const content = typeof responsePayload['content'] === 'string' ? responsePayload['content'] : '';
  const note = renderLateNote({
    targetAgent: handle.targetAgent,
    classification,
    content,
    deliveredAtDisplay: formatDeliveredAt(opts.respondedAt, opts.timezone, logger),
    maxResultChars: opts.maxResultChars,
  });

  return resolveLateDelegation({
    pool,
    bus,
    taskRepo,
    logger,
    handle,
    classification,
    lateResponseEventId: responseEventId,
    note,
    parentEventId: responseEventId,
  });
}

export interface ExpireLateDelegationOptions {
  pool: Pool;
  bus: EventBus;
  taskRepo: TaskRepo;
  logger: Logger;
  handle: PendingDelegationRow;
  ttlMinutes: number;
  maxResultChars: number;
}

/**
 * Close out a handle whose specialist never delivered. This is what stops the review task from
 * standing there indefinitely telling the principal to "check whether it already delivered":
 * the note now says plainly that nothing arrived and the work did not happen.
 */
export async function expireLateDelegation(
  opts: ExpireLateDelegationOptions,
): Promise<ResolveLateDelegationResult> {
  const classification = abandonedClassification(opts.ttlMinutes);
  const note = renderLateNote({
    targetAgent: opts.handle.targetAgent,
    classification,
    maxResultChars: opts.maxResultChars,
    ttlMinutes: opts.ttlMinutes,
  });

  return resolveLateDelegation({
    pool: opts.pool,
    bus: opts.bus,
    taskRepo: opts.taskRepo,
    logger: opts.logger,
    handle: opts.handle,
    classification,
    note,
  });
}

export interface ResolveLateDelegationOptions {
  pool: Pool;
  bus: EventBus;
  taskRepo: TaskRepo;
  logger: Logger;
  handle: PendingDelegationRow;
  classification: LateResponseClassification;
  /** The agent.response event id that resolved this handle; omitted for expiry. */
  lateResponseEventId?: string;
  /** Rendered progress note for the review task. */
  note: string;
  /** Threads the audit chain to the late response (or the sweep's own trigger). */
  parentEventId?: string;
}

export interface ResolveLateDelegationResult {
  /** True only when the side effects landed AND the handle was closed out. */
  resolved: boolean;
  resolution?: LateDelegationResolution;
  reviewTaskOutcome?: LateDelegationReviewOutcome;
  /** Set when the attempt failed in a way the sweep should retry. */
  retryable?: boolean;
}

/**
 * Take the lease on a handle, record the outcome — annotate the review task, publish
 * delegation.late_resolved so every branch is queryable in audit_log — then close the handle.
 *
 * Order matters. The handle is only marked resolved AFTER its side effects land, so a transient
 * annotation failure or a crash mid-flight leaves an expired lease the sweep re-claims instead of
 * a row that claims work which never happened. `{ resolved: false }` means either another actor
 * holds the lease (a normal race between the live subscriber and a sweep tick) or this attempt
 * failed and is being handed back; `retryable` distinguishes them.
 */
export async function resolveLateDelegation(
  opts: ResolveLateDelegationOptions,
): Promise<ResolveLateDelegationResult> {
  const { pool, bus, taskRepo, logger, handle, classification, lateResponseEventId, note } = opts;

  const claimed = await claimPendingDelegation(pool, {
    delegateEventId: handle.delegateEventId,
    resolution: classification.resolution,
    leaseSeconds: CLAIM_LEASE_SECONDS,
    ...(lateResponseEventId !== undefined && { lateResponseEventId }),
  });
  if (!claimed) {
    logger.debug(
      { delegateEventId: handle.delegateEventId },
      'Late delegation: handle is resolved or held by a live lease — skipping',
    );
    return { resolved: false };
  }

  const reviewTaskOutcome = await annotateReviewTask({
    taskRepo,
    logger,
    handle: claimed,
    classification,
    note,
  });

  // `update_failed` is the one non-terminal annotation outcome: the review task exists and is
  // writable in principle, so the note is still owed. Hand the lease back and let the sweep try
  // again rather than closing the handle over a result the principal never saw.
  if (reviewTaskOutcome === 'update_failed') {
    // Token-guarded: if this lease already expired and another actor took over, the release is a
    // no-op rather than a yank of their in-flight work.
    if (claimed.claimToken) {
      await releasePendingDelegationClaim(pool, claimed.delegateEventId, claimed.claimToken);
    }
    logger.warn(
      { delegateEventId: claimed.delegateEventId, reviewTaskId: claimed.reviewTaskId },
      'Late delegation: could not record the outcome on the review task — released for retry',
    );
    return { resolved: false, retryable: true };
  }

  try {
    await bus.publish('system', createDelegationLateResolved(
      {
        delegateEventId: claimed.delegateEventId,
        targetAgent: claimed.targetAgent,
        resolution: classification.resolution,
        reviewTaskOutcome,
        agentId: claimed.originAgentId,
        conversationId: claimed.originConversationId,
        ...(claimed.reviewTaskId !== null && { reviewTaskId: claimed.reviewTaskId }),
        ...(lateResponseEventId !== undefined && { lateResponseEventId }),
        note: classification.note,
      },
      opts.parentEventId,
    ));
  } catch (err) {
    // Deliberately NOT released for retry. The note is already on the review task, and a retry
    // would append a second copy of it to recover an event whose facts (resolution, timing, the
    // response id) are already durable on this row. Losing observability in a narrow DB-trouble
    // window beats duplicating what the principal reads.
    logger.error(
      { err, delegateEventId: claimed.delegateEventId, resolution: classification.resolution },
      'Failed to publish delegation.late_resolved — the resolution is in pending_delegations only',
    );
  }

  // Close the lease now that the side effects have landed, presenting the token this claim minted.
  // A lost race here (we stalled past the lease and another actor took the handle) means that
  // actor owns the outcome — finalizing anyway would mark THEIR unfinished work resolved.
  const finalized = claimed.claimToken
    ? await finalizePendingDelegation(pool, claimed.delegateEventId, claimed.claimToken)
    : null;
  if (!finalized) {
    logger.warn(
      { delegateEventId: claimed.delegateEventId },
      'Late delegation: lease was no longer ours at finalize — another actor owns this handle',
    );
    return { resolved: false };
  }

  logger.info(
    {
      delegateEventId: claimed.delegateEventId,
      targetAgent: claimed.targetAgent,
      resolution: classification.resolution,
      reviewTaskOutcome,
      originConversationId: claimed.originConversationId,
      schedulerJobId: claimed.schedulerJobId,
    },
    'Late delegation resolved',
  );

  return { resolved: true, resolution: classification.resolution, reviewTaskOutcome };
}

interface AnnotateReviewTaskOptions {
  taskRepo: TaskRepo;
  logger: Logger;
  handle: PendingDelegationRow;
  classification: LateResponseClassification;
  note: string;
}

/**
 * Put the outcome on the escalation review task. Phase 1 never closes it — a recorded result
 * still needs a human to run the follow-up steps, so closing it here would hide real work.
 *
 * A review task that reached a terminal state cannot be annotated at all: updateTask's guard
 * rejects writes to done/cancelled rows (and throws on the race), so that case is reported as
 * `review_task_terminal` rather than forced through.
 */
async function annotateReviewTask(
  opts: AnnotateReviewTaskOptions,
): Promise<LateDelegationReviewOutcome> {
  const { taskRepo, logger, handle, note } = opts;

  // Falsy, not just null: a handle written before the review task existed carries no id, and
  // querying for an empty one would be a pointless round trip.
  if (!handle.reviewTaskId) {
    return 'no_review_task';
  }

  try {
    const current = await taskRepo.getTask(handle.reviewTaskId);
    if (!current) {
      logger.warn(
        { delegateEventId: handle.delegateEventId, reviewTaskId: handle.reviewTaskId },
        'Late delegation: review task no longer exists — outcome recorded on the handle only',
      );
      return 'no_review_task';
    }
    if (TERMINAL_TASK_STATUSES.has(current.status)) {
      logger.info(
        {
          delegateEventId: handle.delegateEventId,
          reviewTaskId: handle.reviewTaskId,
          status: current.status,
        },
        'Late delegation: review task is terminal — cannot annotate a closed row',
      );
      return 'review_task_terminal';
    }

    await taskRepo.updateTask(handle.reviewTaskId, { progressNote: note }, 'late-delegation');
    return 'annotated';
  } catch (err) {
    logger.error(
      { err, delegateEventId: handle.delegateEventId, reviewTaskId: handle.reviewTaskId },
      'Late delegation: failed to annotate the review task',
    );
    return 'update_failed';
  }
}

/**
 * Format a delivery timestamp for the principal's timezone, matching skill output conventions.
 * Falls back to UTC rather than throwing: a misconfigured timezone must not be the reason a
 * late result goes unrecorded.
 */
export function formatDeliveredAt(when: Date, timezone?: string, logger?: Logger): string {
  try {
    return toLocalIso(Math.floor(when.getTime() / 1000), timezone) ?? when.toISOString();
  } catch (err) {
    logger?.warn({ err, timezone }, 'Late delegation: invalid timezone — formatting delivery time as UTC');
    return when.toISOString();
  }
}
