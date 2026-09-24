// late-delegation.ts — what to do with a specialist response that arrives after the delegate
// wait gave up (#1799).
//
// A deliverable result re-enters the originating agent in its ORIGINAL conversation, carrying the
// specialist's output, so the follow-up steps that died with the timed-out turn actually run. The
// review task the escalation created is then closed with the delivery time. Every other outcome —
// the specialist ultimately failed, came back with a question, has nowhere to be delivered, or a
// human already took over — is recorded on that review task instead and leaves it open.
//
// The classification is a pure function of the late response plus two facts about the origin,
// so the live subscriber and the restart sweep cannot disagree about what a given response
// means. Everything with I/O lives in resolveLateDelegation, behind the atomic claim.

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import {
  createAgentTask,
  createDelegationLateResolved,
  type LateDelegationResolution,
  type LateDelegationReviewOutcome,
} from '../bus/events.js';
import { makeWakeContext } from '../autonomy/effective-standing.js';
import { isPgUniqueViolation } from './resumable-continuation.js';
import type { ContactTier, SystemRole, TaskOriginator } from '../contacts/types.js';
import {
  claimPendingDelegation,
  finalizePendingDelegation,
  releasePendingDelegationClaim,
  setPendingDelegationWakeEventId,
  type PendingDelegationRow,
} from '../db/queries/pending-delegations.js';
import { EXECUTION_PAUSED_PROTOCOL } from './resumable-task.js';
import { toLocalIso } from '../time/timestamp.js';
import { LATE_SPECIALIST_RESULT_MARKER } from '../memory/synthetic-user-turn.js';

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

/**
 * Origins where a woken agent's REPLY has nobody waiting for it, even though the wake itself is
 * worth publishing. A scheduled run is the motivating case: the side effects (create the trip
 * tasks, advance the cursor) are the point, and there is no conversation to answer into — so no
 * dispatcher routing is registered and the response is simply not relayed.
 */
const NON_REPLYABLE_ORIGIN_CHANNELS = new Set(['scheduler', 'internal', 'bullpen']);

/**
 * Registers dispatcher routing for a wake task so the woken agent's reply reaches the principal.
 * In production this is `Dispatcher.registerExternalTaskRouting`; tests inject a spy. Mirrors the
 * secret-capture resume path (#972), which has the same problem: a synthetic task the dispatcher
 * never saw arrive has no routing entry, so its response would be dropped.
 */
export type LateWakeRoutingRegistrar = (
  taskEventId: string,
  routing: {
    channelId: string;
    conversationId: string;
    senderId: string;
    originator: TaskOriginator;
  },
) => void;

/** Narrow the stored originator bag into a TaskOriginator; undefined when it cannot be trusted. */
export function parseStoredOriginator(
  raw: Record<string, unknown> | null,
): TaskOriginator | undefined {
  if (!raw) return undefined;
  if (typeof raw['contactId'] !== 'string' || typeof raw['channel'] !== 'string') return undefined;
  if (typeof raw['initiatedAt'] !== 'string') return undefined;
  const systemRole = raw['systemRole'];
  if (
    systemRole !== null && systemRole !== undefined
    && systemRole !== 'principal' && systemRole !== 'system' && systemRole !== 'agent'
  ) {
    return undefined;
  }
  const tier = raw['tier'];
  if (
    tier !== undefined && tier !== null
    && tier !== 'principal' && tier !== 'trusted' && tier !== 'known'
    && tier !== 'unknown' && tier !== 'blocked'
  ) {
    return undefined;
  }
  const result: TaskOriginator = {
    contactId: raw['contactId'],
    systemRole: (systemRole ?? null) as SystemRole | null,
    channel: raw['channel'],
    initiatedAt: raw['initiatedAt'],
  };
  if (tier !== undefined) result.tier = tier as ContactTier | null;
  return result;
}

/** Fail-closed originator for routing when the handle carried none (#1733 / #1059). */
function unresolvedOriginator(channelId: string, now: Date): TaskOriginator {
  return {
    contactId: 'unresolved',
    systemRole: null,
    channel: channelId,
    initiatedAt: now.toISOString(),
    tier: null,
  };
}

/** Task statuses that mean a human already disposed of the review row. */
const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled', 'failed']);

/**
 * How long one actor may hold a handle while it annotates the review task and publishes the
 * audit event. Generously longer than two DB writes and a publish, short enough that a crashed
 * actor's work is picked up on the next sweep tick rather than hours later.
 */
export const CLAIM_LEASE_SECONDS = 120;

/** Namespace for the derived wake event id — changing it would un-fence every existing handle. */
const WAKE_EVENT_ID_NAMESPACE = 'curia:late-delegation-wake';

/**
 * The wake event id for a handle, derived from its delegate event id rather than random.
 *
 * This is the fence that makes waking the originator idempotent no matter how the lease behaves.
 * `EventBus.publish()` awaits its subscribers, and one of those subscribers is the woken agent's
 * whole turn — minutes of LLM rounds and tool calls. That routinely outlives the 120s lease, so a
 * sweep can re-claim the row while the first turn is still running and try to wake it again. With a
 * derived id the second attempt carries the SAME event id, and the audit logger's write-ahead hook
 * — which inserts into audit_log before any subscriber sees the event — rejects it on the primary
 * key. The duplicate never reaches AgentRuntime.
 *
 * Not a true RFC-4122 v5 (that requires SHA-1); SHA-256 truncated to 16 bytes with the version and
 * variant bits set. The requirement here is stability and UUID shape — audit_log.id is a UUID
 * column — not interoperability with other v5 generators.
 */
export function deterministicWakeEventId(delegateEventId: string): string {
  const bytes = createHash('sha256')
    .update(`${WAKE_EVENT_ID_NAMESPACE}:${delegateEventId}`)
    .digest()
    .subarray(0, 16);
  const b = Buffer.from(bytes);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

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

/** The dispositions that end up recorded on the review task rather than delivered. */
export type RecordedDisposition = Exclude<LateDelegationDisposition, 'deliverable'>;

export interface LateResponseFacts {
  /** The late agent.response payload (bus event payload, or the audit_log row's payload). */
  payload: Record<string, unknown>;
  /** Channel of the originating turn. */
  originChannelId: string;
  /** Status of the escalation review task, or null when there is no linked task. */
  reviewTaskStatus: string | null;
  /** False when the originating agent is no longer registered, so a wake would reach nobody. */
  originAgentRegistered?: boolean;
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

  // An agent that has since been removed from the roster cannot be woken: the task would be
  // published to a type nobody subscribes to and vanish. Recording it beats publishing into the void.
  if (facts.originAgentRegistered === false) {
    return {
      disposition: 'unroutable',
      resolution: 'annotated_unroutable',
      note: 'originating agent is no longer registered — nothing to re-enter',
    };
  }

  return {
    disposition: 'deliverable',
    resolution: 'delivered',
    note: 'late result handed back to the originating turn',
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

/** The classification for a handle that expired with nothing having arrived. Typed as a recorded
 *  disposition because there is, by definition, nothing to deliver. */
export function abandonedClassification(
  ttlMinutes: number,
): LateResponseClassification & { disposition: RecordedDisposition } {
  return {
    disposition: 'abandoned',
    resolution: 'abandoned_ttl',
    note: `no response within ${ttlMinutes} minutes of the timeout — work lost`,
  };
}

export interface RenderLateNoteParams {
  targetAgent: string;
  /** Narrowed to the recorded outcomes: a delivered result uses renderDeliveredNote instead. */
  classification: LateResponseClassification & { disposition: RecordedDisposition };
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

export interface LateResultBriefParams {
  targetAgent: string;
  /** The specialist's result, verbatim (capped). */
  content: string;
  /** Delivery time, formatted for the principal's timezone. */
  deliveredAtDisplay: string;
  maxResultChars: number;
  /** Scheduled job behind the originating turn, when there was one. */
  schedulerJobId?: string;
}

/**
 * The brief for the wake task that re-enters the originating agent.
 *
 * It deliberately does NOT restate the original delegated brief. #1064 is the precedent: a
 * notify `agent.task` that echoed the original intent made the coordinator re-execute the work it
 * was reporting on and send a duplicate message. The original brief is already in the agent's
 * conversation history, because the wake re-enters the SAME conversationId — so restating it here
 * would add nothing except an instruction the model might act on twice.
 *
 * What it does carry: the result, the fact that the work is already done, and what remains.
 * When the origin was a scheduled run, name `scheduler-report` so the agent records the
 * outcome — but do not embed a bare job UUID (attractive nuisance for bullpen thread_id;
 * the skill derives job_id from the same conversationId this wake re-enters — #1828).
 */
export function buildLateResultBrief(params: LateResultBriefParams): string {
  const { targetAgent, content, deliveredAtDisplay, maxResultChars, schedulerJobId } = params;

  // One complete sentence per element — never hard-wrapped mid-sentence. A model reads either
  // shape, but an unbroken sentence survives being grepped for, quoted in a log, or asserted on.
  const lines = [
    // Marker prefix is registered in synthetic-user-turn.ts so contact recall and
    // the sender backfill can tell this apart from a human message (#1892).
    `${LATE_SPECIALIST_RESULT_MARKER}${targetAgent}, delivered ${deliveredAtDisplay}]`,
    '',
    `The work you delegated to '${targetAgent}' timed out from your side, but the specialist kept running, finished, and returned this result:`,
    '',
    capResult(content, maxResultChars),
    '',
    `This is the real result. Do NOT delegate this work again — a repeat delegation to '${targetAgent}' is blocked for this turn.`,
    '',
    'Before acting, check this conversation for steps you already completed, and do not repeat a side effect that already happened (messages sent, tasks created, cursors advanced).',
    'Then complete only the follow-up steps that are still outstanding.',
  ];

  if (schedulerJobId) {
    lines.push(
      '',
      'When you are done, record the outcome with scheduler-report (job_id is derived automatically) so the next scheduled run starts from the right place.',
    );
  }

  return lines.join('\n');
}

/** Note put on the review task when the late result was handed back to the originating agent. */
export function renderDeliveredNote(params: {
  targetAgent: string;
  deliveredAtDisplay: string;
  originConversationId: string;
}): string {
  return (
    `${params.targetAgent} delivered at ${params.deliveredAtDisplay}, after the delegate wait had `
    + `timed out. The result was handed back to the originating turn (${params.originConversationId}), `
    + 'which is completing the follow-up steps. Closing this review — no action needed unless that '
    + 'turn reports a problem.'
  );
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
  /** Registered agent names. When provided, an unknown origin agent is recorded, not woken. */
  knownAgents?: Set<string>;
  /** Seeds dispatcher routing for a wake whose origin can receive a reply. */
  registerRouting?: LateWakeRoutingRegistrar;
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
    ...(opts.knownAgents !== undefined && {
      originAgentRegistered: opts.knownAgents.has(handle.originAgentId),
    }),
  });

  const content = typeof responsePayload['content'] === 'string' ? responsePayload['content'] : '';
  const deliveredAtDisplay = formatDeliveredAt(opts.respondedAt, opts.timezone, logger);

  // The deliver branch hands the result back to the originating agent and closes the review task.
  // Every other disposition records the outcome on that task and leaves it open for a human.
  if (classification.disposition === 'deliverable') {
    return resolveLateDelegation({
      pool,
      bus,
      taskRepo,
      logger,
      handle,
      classification,
      lateResponseEventId: responseEventId,
      note: renderDeliveredNote({
        targetAgent: handle.targetAgent,
        deliveredAtDisplay,
        originConversationId: handle.originConversationId,
      }),
      parentEventId: responseEventId,
      wakeBrief: buildLateResultBrief({
        targetAgent: handle.targetAgent,
        content,
        deliveredAtDisplay,
        maxResultChars: opts.maxResultChars,
        ...(handle.schedulerJobId !== null && { schedulerJobId: handle.schedulerJobId }),
      }),
      closeReviewTask: true,
      ...(opts.registerRouting !== undefined && { registerRouting: opts.registerRouting }),
    });
  }

  return resolveLateDelegation({
    pool,
    bus,
    taskRepo,
    logger,
    handle,
    classification,
    lateResponseEventId: responseEventId,
    note: renderLateNote({
      targetAgent: handle.targetAgent,
      // The deliverable branch returned above, so the disposition here is a recorded one.
      // LateResponseClassification is a single interface rather than a discriminated union, so
      // that guarantee has to be stated rather than inferred.
      classification: classification as LateResponseClassification & { disposition: RecordedDisposition },
      content,
      deliveredAtDisplay,
      maxResultChars: opts.maxResultChars,
    }),
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
  /** Deliver branch only: re-enter the originating agent with this brief before closing out. */
  wakeBrief?: string;
  /** Deliver branch only: seeds dispatcher routing when the origin can receive a reply. */
  registerRouting?: LateWakeRoutingRegistrar;
  /** Deliver branch only: close the review task rather than leaving it open with a note. */
  closeReviewTask?: boolean;
}

export interface ResolveLateDelegationResult {
  /** True only when the side effects landed AND the handle was closed out. */
  resolved: boolean;
  resolution?: LateDelegationResolution;
  reviewTaskOutcome?: LateDelegationReviewOutcome;
  /** Set when the attempt failed in a way the sweep should retry. */
  retryable?: boolean;
  /** The wake agent.task published back to the originating agent, on the deliver branch. */
  wakeTaskEventId?: string;
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

  // Wake the originator FIRST on the deliver branch: it is the only irreversible step here, so
  // everything after it is bookkeeping that must not trigger a retry.
  //
  // The wake's event id is DERIVED from the handle rather than random, which is what makes this
  // safe against the lease expiring underneath a slow turn. `EventBus.publish()` awaits its
  // subscribers, and one of them is the woken agent's entire turn — easily longer than the 120s
  // lease — so another actor can re-claim this row while that turn is still running. Its attempt
  // carries the same id, and the audit logger's write-ahead insert rejects it before any subscriber
  // sees it. The stored id below is therefore a record, not the guarantee.
  let wakeTaskEventId = claimed.wakeTaskEventId ?? undefined;
  if (opts.wakeBrief !== undefined) {
    const wakeEventId = deterministicWakeEventId(claimed.delegateEventId);

    // Record the id BEFORE publishing. A crash in between is then recoverable either way: the row
    // names the wake, and re-publishing that same id is inert if it already went out.
    try {
      await setPendingDelegationWakeEventId(pool, claimed.delegateEventId, wakeEventId);
    } catch (err) {
      logger.warn(
        { err, delegateEventId: claimed.delegateEventId, wakeEventId },
        'Late delegation: could not record the wake id before publishing — proceeding, the derived id still fences a duplicate',
      );
    }

    try {
      const outcome = await publishLateWake({
        bus,
        logger,
        handle: claimed,
        brief: opts.wakeBrief,
        wakeEventId,
        parentEventId: opts.parentEventId ?? lateResponseEventId,
        ...(opts.registerRouting !== undefined && { registerRouting: opts.registerRouting }),
      });
      // Either this attempt delivered it or an earlier one did; both mean the originator has the
      // result, and both must close the handle rather than leave it for another pass.
      void outcome;
      wakeTaskEventId = wakeEventId;
    } catch (err) {
      // Nothing was delivered (the write-ahead hook rejects before subscribers), so a retry is safe
      // — and necessary, or the result is lost.
      if (claimed.claimToken) {
        await releasePendingDelegationClaim(pool, claimed.delegateEventId, claimed.claimToken);
      }
      logger.error(
        { err, delegateEventId: claimed.delegateEventId, originAgentId: claimed.originAgentId },
        'Late delegation: failed to wake the originating agent — released for retry',
      );
      return { resolved: false, retryable: true };
    }
  }

  const reviewTaskOutcome = await recordOnReviewTask({
    taskRepo,
    logger,
    handle: claimed,
    note,
    close: opts.closeReviewTask === true,
  });

  // `update_failed` is the one non-terminal review-task outcome: the row exists and is writable in
  // principle, so the note is still owed. Hand the lease back so the sweep retries — UNLESS the
  // wake already went out, in which case a retry would re-enter the originating agent a second
  // time. A review row missing its closing note is a far smaller problem than duplicate work.
  if (reviewTaskOutcome === 'update_failed' && wakeTaskEventId === undefined) {
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
  if (reviewTaskOutcome === 'update_failed') {
    logger.error(
      { delegateEventId: claimed.delegateEventId, reviewTaskId: claimed.reviewTaskId, wakeTaskEventId },
      'Late delegation: the originator was woken but the review task could not be updated — not retrying',
    );
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
        ...(wakeTaskEventId !== undefined && { wakeTaskEventId }),
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
      wakeTaskEventId,
      originConversationId: claimed.originConversationId,
      schedulerJobId: claimed.schedulerJobId,
    },
    'Late delegation resolved',
  );

  return {
    resolved: true,
    resolution: classification.resolution,
    reviewTaskOutcome,
    ...(wakeTaskEventId !== undefined && { wakeTaskEventId }),
  };
}

interface PublishLateWakeOptions {
  bus: EventBus;
  logger: Logger;
  handle: PendingDelegationRow;
  brief: string;
  /** Derived from the handle, so a duplicate attempt is rejected by audit_log's primary key. */
  wakeEventId: string;
  parentEventId?: string;
  registerRouting?: LateWakeRoutingRegistrar;
}

/**
 * Re-enter the originating agent with the late result, in its ORIGINAL conversation — which is
 * what makes the follow-up possible at all: the agent's own history still holds the brief it was
 * working from and whatever it had already done before the wait timed out.
 *
 * Three properties of this event matter beyond the content:
 *   - `originator` is restored from the handle, so the follow-up steps still pass the autonomy
 *     gate. Without it `isPrincipalOriginated()` goes false and creating the trip tasks this
 *     mechanism exists to produce would be blocked.
 *   - `wakeContext` marks it derived, so the standing ladder can only DOWNGRADE the lineage's
 *     authority against the live autonomy score, never grant it.
 *   - `liveTurn` is deliberately absent. This crosses an async boundary (#1126), so the elevated
 *     self-approval signal of the original turn must not be resurrected minutes later.
 */
type PublishLateWakeOutcome = 'published' | 'already_published';

async function publishLateWake(opts: PublishLateWakeOptions): Promise<PublishLateWakeOutcome> {
  const { bus, logger, handle, brief } = opts;
  const now = new Date();
  const originator = parseStoredOriginator(handle.originator);

  if (!originator && handle.originator) {
    logger.warn(
      { delegateEventId: handle.delegateEventId },
      'Late delegation: stored originator is malformed — waking without a lineage rather than fabricating one',
    );
  }

  const minted = createAgentTask({
    agentId: handle.originAgentId,
    conversationId: handle.originConversationId,
    channelId: handle.originChannelId,
    senderId: handle.originSenderId,
    content: brief,
    // The wake brief is Curia reporting to itself. senderId carries the original
    // requester for routing, but nobody said this (#1892).
    syntheticTurn: true,
    metadata: {
      ...(originator !== undefined && { originator }),
      wakeContext: makeWakeContext(true),
      // Consumed by the runtime to seed DelegationGuard, so the woken turn cannot re-delegate
      // work that has already been done (#1799 / #1310).
      lateDelegation: { agent: handle.targetAgent, task: handle.delegateTask },
    },
    // Chain to the late response, so audit_log links that response to the turn it restarted.
    parentEventId: opts.parentEventId ?? handle.delegateEventId,
  });
  // The factory mints a random id; this event's identity must instead be a function of the handle
  // so that a re-publication is recognisable as the same event. See deterministicWakeEventId.
  const task = { ...minted, id: opts.wakeEventId };

  // Routing must exist BEFORE publish: the bus awaits subscribers, so the woken agent can respond
  // inside publish() and the dispatcher would find no entry for a task it never saw arrive.
  if (opts.registerRouting && !NON_REPLYABLE_ORIGIN_CHANNELS.has(handle.originChannelId)) {
    opts.registerRouting(task.id, {
      channelId: handle.originChannelId,
      conversationId: handle.originConversationId,
      senderId: handle.originSenderId,
      originator: originator ?? unresolvedOriginator(handle.originChannelId, now),
    });
  }

  try {
    await bus.publish('system', task);
  } catch (err) {
    // A primary-key collision on audit_log means this exact wake was already published — by an
    // earlier attempt whose lease expired while the woken turn was still running inside publish().
    // The write-ahead hook runs BEFORE subscriber delivery, so the duplicate reached no subscriber
    // and no second agent turn started. That is the fence working, not a failure.
    if (isPgUniqueViolation(err)) {
      logger.info(
        { delegateEventId: handle.delegateEventId, wakeTaskEventId: task.id },
        'Late delegation: wake was already published (audit id collision) — not delivering a second',
      );
      return 'already_published';
    }
    throw err;
  }

  logger.info(
    {
      delegateEventId: handle.delegateEventId,
      wakeTaskEventId: task.id,
      originAgentId: handle.originAgentId,
      originConversationId: handle.originConversationId,
      hadOriginator: originator !== undefined,
    },
    'Late delegation: woke the originating agent with the late result',
  );

  return 'published';
}

interface RecordOnReviewTaskOptions {
  taskRepo: TaskRepo;
  logger: Logger;
  handle: PendingDelegationRow;
  note: string;
  /** True on the deliver branch: the follow-up is running, so the review is finished. */
  close: boolean;
}

/**
 * Put the outcome on the escalation review task — closing it when the result was handed back to
 * the originating agent, annotating and leaving it open otherwise. Closing on delivery is the
 * point of the whole mechanism: the row said "check whether it already delivered", something
 * finally checked, and leaving it open would recreate the backlog rot #1799 opened with.
 *
 * A review task that reached a terminal state cannot be written at all: updateTask's guard
 * rejects done/cancelled rows (and throws on the race), so that case is reported as
 * `review_task_terminal` rather than forced through.
 */
async function recordOnReviewTask(
  opts: RecordOnReviewTaskOptions,
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

    if (opts.close) {
      await taskRepo.completeTask(handle.reviewTaskId, note, 'late-delegation');
      return 'closed';
    }
    await taskRepo.updateTask(handle.reviewTaskId, { progressNote: note }, 'late-delegation');
    return 'annotated';
  } catch (err) {
    logger.error(
      { err, delegateEventId: handle.delegateEventId, reviewTaskId: handle.reviewTaskId, close: opts.close },
      'Late delegation: failed to record the outcome on the review task',
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
