// handler.ts — delegate skill implementation.
//
// This skill has bus and agentRegistry access (declared in capabilities)
// that normal skills don't get. It publishes an agent.task event for the
// target specialist, then waits for the specialist's agent.response.
//
// The Coordinator uses this skill to delegate work: it calls
// delegate({ agent: "research-analyst", task: "..." }) and gets back
// the specialist's response, which it can then synthesize into its own reply.
//
// Clarification protocol: when a specialist calls request-clarification,
// the runtime short-circuits and emits a JSON response with
// _curia_protocol: "clarification_request". This handler detects that
// protocol marker and returns a typed result with needs_clarification: true,
// so the coordinator can route the question to the CEO.
//
// Resume: when the coordinator re-delegates with a resume_token, this handler
// decodes the token, constructs a full task brief from the original context +
// CEO's direction, and delegates to the specialist. The specialist sees a
// well-formed task — no special resume detection needed in its prompt.

import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { parseResolvedContactIds } from '../../src/agents/resolved-entities.js';
import { createAgentTask, type AgentResponseEvent, type AgentResponseFailureReason } from '../../src/bus/events.js';
// Resume-token format lives in ONE place (#995): decode + version via the shared helper, so a
// future format change can't silently desync this handler from runtime.ts and the resume subscriber.
import { decodeResumeToken, RESUME_TOKEN_VERSION } from '../../src/agents/resume-token.js';
import {
  ALREADY_IN_FLIGHT_REASON,
  delegationKey,
  findAlreadyDeliveredKey,
} from '../../src/agents/delegation-guard.js';
import {
  runningClaimExpiresAt,
  type AcquireRunningResult,
  type InFlightDelegation,
} from '../../src/db/queries/pending-delegations.js';
import { clampDelegateWaitTimeoutMs } from '../../src/agents/delegate-timeout.js';
import { parseSchedulerJobId, parseStoredOriginator } from '../../src/agents/late-delegation.js';
import {
  EXECUTION_PAUSED_PROTOCOL,
  formatPausedProgressMessage,
  parseExecutionPausedPayload,
} from '../../src/agents/resumable-task.js';
import { validateDelegateBriefDates } from '../../src/agents/delegate-brief-date-validation.js';
import {
  parseSpecialistDeclineMarker,
  SPECIALIST_DECLINE_REASON,
} from '../../src/agents/specialist-decline.js';

// Default wait for the specialist to respond — appropriate for interactive tasks.
// Used only when neither config.delegate.defaultTimeoutMs nor a runtime-resolved
// timeout_ms is available. Long-running work gets a longer window from the runtime,
// which resolves timeout_ms from the originating agent.task event's
// expectedDurationSeconds or the target agent's expected_duration_seconds (#1797).
const DEFAULT_SPECIALIST_TIMEOUT_MS = 90000;

/** Sentinel shape rejected by the response promise when a specialist returns isError with
 *  structured failure fields — caught in execute() and turned into a typed delegate result. */
interface StructuredDelegateFailure {
  __structuredDelegateFailure: true;
  agent: string;
  reason: AgentResponseFailureReason;
  retryable: boolean;
  errorType?: string;
  /** Timeout only (#1799): the delegate agent.task event id. The abandoned specialist stamps
   *  this as parentEventId on the response it publishes after the wait gave up, so it is the
   *  only key that can correlate that late response back to this delegation. Without it
   *  leaving the handler the response is unmatchable and the work is silently lost. */
  delegateEventId?: string;
  /** Timeout only (#1799): the conversation the specialist is running in. */
  delegateConversationId?: string;
  /** Timeout only (#1799): the wait that elapsed, in ms — sets the handle's TTL floor. */
  waitTimeoutMs?: number;
}

function isStructuredDelegateFailure(err: unknown): err is StructuredDelegateFailure {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as StructuredDelegateFailure).__structuredDelegateFailure === true
  );
}

/** Milliseconds since the row was written. Never negative, never fractional.
 *  A running claim is written at dispatch. A pending handle is the post-timeout row. */
function openHandleAgeMs(createdAt: Date): number {
  const ms = Date.now() - createdAt.getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.trunc(ms));
}

function inFlightResult(agent: string, hit: InFlightDelegation): ToolResult {
  return {
    success: true,
    data: {
      agent,
      in_flight: true,
      blocked: true,
      // Not `failed`: a failure is escalated and the turn stops, which hides the status
      // the coordinator needs to give the CEO. This is a refusal to start a second run.
      reason: ALREADY_IN_FLIGHT_REASON,
      retryable: false,
      delegate_event_id: hit.delegateEventId,
      // Age of the row. A running claim starts at dispatch. A promoted pending
      // handle keeps that created_at, so age is not how long the handle has left —
      // handle_expires_at is.
      open_handle_age_ms: openHandleAgeMs(hit.createdAt),
      ...(hit.status !== undefined && { handle_status: hit.status }),
      ...(hit.expiresAt !== undefined && { handle_expires_at: hit.expiresAt.toISOString() }),
      // Principal-safe. Directives to the coordinator live in its prompt, not here —
      // the prompt tells the model this sentence is safe to relay.
      message: `Specialist '${agent}' is already working on an open request in this conversation.`,
    },
  };
}

/**
 * Refuse when this specialist already has an unresolved handle in the originating
 * conversation (#1858). Returns null when the call may proceed.
 *
 * A resume_token continues a specialist that has already stopped (it paused to ask
 * the CEO). Blocking that resume because some other delegation to the same agent
 * timed out is a deliberate fail-closed trade-off: the match is agent × conversation
 * and cannot tell the parked task from the one still running. Starting the resume
 * would be a second concurrent run beside the timed-out specialist. Call this only
 * after a resume token has been validated, so a corrupt or cross-agent token still
 * gets its specific error.
 */
async function refuseIfInFlight(ctx: ToolContext, agent: string): Promise<ToolResult | null> {
  const originConversationId = ctx.conversationId;
  if (!ctx.openDelegationLookup) {
    // Intentionally unwired when late delivery is disabled. Proceeding is today's
    // behaviour; consulting stranded rows with the subscriber and sweep off would
    // block that agent in that conversation permanently. The boot log says so.
    return null;
  }
  if (typeof originConversationId !== 'string' || originConversationId === '') {
    ctx.log.warn(
      { targetAgent: agent },
      'Delegate call has no originating conversation — cannot match an in-flight handle',
    );
    return null;
  }

  let inFlight: InFlightDelegation | null;
  try {
    inFlight = await ctx.openDelegationLookup.findInFlight(agent, originConversationId);
  } catch (err) {
    // Fail closed. Starting the run when we could not prove the specialist is idle is
    // how the duplicate CEO message happens. A database outage is tracked apart from
    // the consecutive-error budget.
    ctx.log.error(
      { err, targetAgent: agent, originConversationId },
      'In-flight delegation check failed — refusing to start another specialist run',
    );
    return {
      success: false,
      error: `Could not check whether '${agent}' is already running in this conversation. Not starting another run.`,
      errorType: 'DATABASE_UNAVAILABLE',
    };
  }
  if (!inFlight) return null;

  ctx.log.warn(
    {
      targetAgent: agent,
      originConversationId,
      delegateEventId: inFlight.delegateEventId,
      openHandleAgeMs: openHandleAgeMs(inFlight.createdAt),
    },
    'Blocked delegate — specialist already has an unresolved handle in this conversation',
  );
  return inFlightResult(agent, inFlight);
}

/**
 * Claim the specialist for this conversation before the run is published (#1893).
 *
 * Three outcomes, and no other:
 * - `{ ok: true, delegateEventId }` — this call holds the running row.
 * - `{ ok: true }` with no id — nothing was written. Late delivery is off, or the
 *   turn has no origin to store (voice, an approval re-invoke). Dispatch anyway.
 * - `{ ok: false, result }` — do not dispatch. The insert threw, or another turn
 *   already holds this specialist.
 */
async function acquireDispatchClaim(
  ctx: ToolContext,
  agent: string,
  delegateEventId: string,
  effectiveTask: string,
  conversationId: string,
  specialistTimeoutMs: number,
): Promise<{ ok: true; delegateEventId?: string } | { ok: false; result: ToolResult }> {
  if (!ctx.openDelegationLookup?.acquireRunning) return { ok: true };

  const originAgentId = ctx.agentId;
  const originConversationId = ctx.conversationId;
  const originChannelId = ctx.channelId;
  const originSenderId = ctx.senderId;
  if (
    typeof originAgentId !== 'string' || originAgentId === ''
    || typeof originConversationId !== 'string' || originConversationId === ''
    || typeof originChannelId !== 'string' || originChannelId === ''
    || typeof originSenderId !== 'string' || originSenderId === ''
  ) {
    // A missing sender is a caller that never plumbed InvokeOptions.senderId.
    // origin_sender_id is NOT NULL, so the claim cannot be written. Refusing
    // here turns delegation off for that caller.
    ctx.log.warn(
      { targetAgent: agent, hasSender: typeof originSenderId === 'string' && originSenderId !== '' },
      'Delegate call has no origin for a dispatch claim — starting the specialist without overlap protection',
    );
    return { ok: true };
  }

  const rawOriginator = ctx.taskMetadata?.['originator'];
  const originator = typeof rawOriginator === 'object' && rawOriginator !== null && !Array.isArray(rawOriginator)
    ? parseStoredOriginator(rawOriginator as Record<string, unknown>)
    : undefined;
  let acquired: AcquireRunningResult;
  try {
    const schedulerJobId = parseSchedulerJobId(originConversationId);
    acquired = await ctx.openDelegationLookup.acquireRunning({
      delegateEventId,
      delegateConversationId: conversationId,
      targetAgent: agent,
      delegateTask: effectiveTask,
      originAgentId,
      originConversationId,
      originChannelId,
      originSenderId,
      ...(ctx.taskEventId !== undefined && { originTaskEventId: ctx.taskEventId }),
      ...(schedulerJobId !== undefined && { schedulerJobId }),
      ...(originator !== undefined && { originator }),
      expiresAt: runningClaimExpiresAt(new Date(), specialistTimeoutMs),
    });
  } catch (err) {
    ctx.log.error(
      { err, targetAgent: agent, originConversationId },
      'Dispatch claim failed — refusing to start another specialist run',
    );
    return {
      ok: false,
      result: {
        success: false,
        error: `Could not claim the in-flight slot for '${agent}'. Not starting another run.`,
        errorType: 'DATABASE_UNAVAILABLE',
      },
    };
  }
  if (!acquired.acquired) {
    ctx.log.warn(
      {
        targetAgent: agent,
        originConversationId,
        delegateEventId: acquired.inFlight.delegateEventId,
      },
      'Blocked delegate — another turn claimed this specialist in this conversation',
    );
    return { ok: false, result: inFlightResult(agent, acquired.inFlight) };
  }
  return { ok: true, delegateEventId: acquired.claim.delegateEventId };
}

function formatStructuredFailureMessage(agent: string, reason: AgentResponseFailureReason): string {
  switch (reason) {
    case 'maxTurns':
      return `Specialist '${agent}' exceeded its turn budget and could not complete the task`;
    case 'maxConsecutiveErrors':
      return `Specialist '${agent}' exceeded its consecutive error budget and could not complete the task`;
    case 'tool_error':
      return `Specialist '${agent}' failed due to a tool error`;
    case 'api_error':
      return `Specialist '${agent}' failed due to an API error`;
    case 'blocked':
      return `Specialist '${agent}' was blocked from completing the task`;
    case 'timeout':
      return `Specialist '${agent}' did not respond within the delegate wait window — the task may still be running`;
    default:
      return `Specialist '${agent}' could not complete the task`;
  }
}

export class DelegateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { agent, task, conversation_id, timeout_ms, resume_token } = ctx.input as {
      agent?: string;
      task?: string;
      conversation_id?: string;
      timeout_ms?: unknown;
      resume_token?: string;
    };

    // Validate required inputs
    if (!agent || typeof agent !== 'string') {
      return { success: false, error: 'Missing required input: agent (string)' };
    }
    if (!task || typeof task !== 'string') {
      return { success: false, error: 'Missing required input: task (string)' };
    }

    // timeout_ms is NOT part of this skill's LLM-facing input schema — the runtime is its only
    // source, and it discards anything the model emits before the call reaches here (#1797).
    // Use the caller-supplied timeout if it's a valid positive finite integer; fall back to the
    // configured default otherwise. Invalid values fall back silently rather than failing the
    // call, and the warn below flags a runtime bug (the injected value should always be valid).
    const isValidTimeout =
      typeof timeout_ms === 'number' &&
      Number.isInteger(timeout_ms) &&
      timeout_ms > 0 &&
      Number.isFinite(timeout_ms);
    const specialistTimeoutMs = clampDelegateWaitTimeoutMs(
      isValidTimeout ? (timeout_ms as number) : (ctx.defaultDelegateTimeoutMs ?? DEFAULT_SPECIALIST_TIMEOUT_MS),
    );

    if (timeout_ms !== undefined && !isValidTimeout) {
      ctx.log.warn(
        { targetAgent: agent, providedTimeoutMs: timeout_ms },
        'timeout_ms was provided but is not a valid positive integer — using default timeout',
      );
    }

    // Defensive guard — ExecutionLayer already fails-closed if capabilities are missing,
    // but guard here too in case the handler is invoked outside the execution layer.
    if (!ctx.bus || !ctx.agentRegistry) {
      return {
        success: false,
        error: 'Delegate skill requires bus and agentRegistry. Declare both in capabilities.',
      };
    }

    // Validate target agent exists and isn't the coordinator
    if (!ctx.agentRegistry.has(agent)) {
      const available = ctx.agentRegistry.listSpecialists().map(a => a.name).join(', ');
      // The tool result is all the model sees. Log it too — a transcript is not
      // an error signal, and historical threads keep re-teaching the bad name. (#1898)
      ctx.log.error(
        { agent, available: available || 'none' },
        'delegate: target agent not found',
      );
      return {
        success: false,
        error: `Agent '${agent}' not found. Available specialists: ${available || 'none'}`,
      };
    }

    const targetAgent = ctx.agentRegistry.get(agent)!;
    if (targetAgent.role === 'coordinator') {
      return {
        success: false,
        error: 'You cannot delegate to the coordinator — that would create a loop. Delegate to a specialist instead.',
      };
    }

    const conversationId = conversation_id ?? `delegate-${randomUUID()}`;

    const hasResumeToken = typeof resume_token === 'string' && resume_token !== '';
    if (!hasResumeToken) {
      const briefValidation = validateDelegateBriefDates({
        agent,
        task,
        priorDateResolves: ctx.turnDateResolveResults ?? [],
      });
      if (!briefValidation.ok) {
        ctx.log.warn(
          { targetAgent: agent, priorDates: (ctx.turnDateResolveResults ?? []).map(r => r.isoDate) },
          'Rejected calendar delegate brief — date handoff validation failed',
        );
        return { success: false, error: briefValidation.error };
      }
    }

    // Identical-delegation guard (#1171): resume continuations are exempt — they carry new
    // CEO direction and a different effective brief. Without a resume_token, block when the
    // runtime has already recorded a non-retryable failure for this agent+task pair.
    //
    // One reason overrides that exemption: `already_delivered` (#1799). The runtime seeds it when
    // this turn was woken with a late result already in hand, and a resume of finished work would
    // re-run its side effects. This handler is the second gate — it is what actually publishes the
    // specialist task, and it validates only the token's agent, never the task — so the check has
    // to live here too, not only in the runtime.
    const dKey = delegationKey(agent, task);
    if (ctx.delegationGuard) {
      // The delivered record is keyed on the ORIGINAL task. A resume's `task` is the CEO's new
      // direction, so the key has to be resolved from the token too — otherwise the block misses
      // exactly the shape a resume normally takes and this handler publishes the work again.
      const deliveredKey = findAlreadyDeliveredKey(
        ctx.delegationGuard,
        agent,
        task,
        hasResumeToken ? resume_token : undefined,
      );
      const blockKey = deliveredKey
        ?? (!hasResumeToken && !ctx.delegationGuard.canAttempt(dKey) ? dKey : undefined);
      if (blockKey !== undefined) {
        const prior = ctx.delegationGuard.getFailure(blockKey);
        ctx.log.warn(
          { targetAgent: agent, reason: prior?.reason, viaResumeToken: hasResumeToken },
          'Blocked identical re-delegation at delegate handler',
        );
        return {
          success: true,
          data: {
            agent,
            failed: true,
            blocked: true,
            reason: prior?.reason ?? 'blocked',
            retryable: false,
            message: prior?.message ?? formatStructuredFailureMessage(agent, 'blocked'),
            escalated: ctx.delegationGuard.isEscalated(blockKey),
          },
        };
      }
    }

    // Resume flow: when resume_token is provided, decode it and construct a
    // full task brief from the original context + the CEO's direction (the
    // `task` parameter). The specialist receives a self-contained task —
    // no special resume detection logic needed in its prompt.
    let effectiveTask = task;
    if (resume_token && typeof resume_token === 'string') {
      // Decode via the shared helper, which returns null (never throws) for malformed base64/JSON
      // or non-string required fields. The token is opaque to the LLM, so an undecodable one must
      // not silently produce a broken task brief.
      const payload = decodeResumeToken(resume_token);
      if (!payload) {
        // decodeResumeToken absorbs the parse error (returns null rather than throwing), so the
        // specific decode reason isn't surfaced here. The token is opaque names+NL, so the target
        // agent is the actionable signal; a malformed token is unrecoverable regardless of reason.
        ctx.log.error({ targetAgent: agent }, 'Failed to decode resume_token');
        return {
          success: false,
          error: 'resume_token could not be decoded. The token may be corrupted — ask the CEO to repeat their request.',
        };
      }

      // The helper is lenient on version; warn (but proceed) so a future format change surfaces in
      // logs rather than silently misbehaving.
      if (payload.v !== RESUME_TOKEN_VERSION) {
        ctx.log.warn(
          { targetAgent: agent, tokenVersion: payload.v, expectedVersion: RESUME_TOKEN_VERSION },
          'resume_token version mismatch — attempting to use anyway',
        );
      }

      // Even with valid types, empty original_task/context can't form a usable brief — reject so a
      // corrupted token never yields a degenerate task.
      if (!payload.original_task || !payload.context) {
        const versionNote = payload.v !== RESUME_TOKEN_VERSION
          ? ` Token version ${String(payload.v)} does not match expected version ${RESUME_TOKEN_VERSION} — this may be the cause.`
          : '';
        return {
          success: false,
          error: `resume_token is missing required fields (original_task, context).${versionNote} The token may be corrupted — ask the CEO to repeat their request.`,
        };
      }

      // Guard against cross-agent token misuse: if the coordinator passes a
      // resume_token generated for one specialist but targets a different one,
      // the task brief would contain another agent's context. Reject early.
      // Use strict equality (not payload.agent && payload.agent !== agent) so that a
      // malformed token with agent: "" cannot bypass the guard via a falsy agent field.
      if (payload.agent !== agent) {
        ctx.log.warn(
          { targetAgent: agent, tokenAgent: payload.agent || '(empty)' },
          'resume_token agent mismatch — possible cross-agent token misuse or corrupted token',
        );
        return {
          success: false,
          error: payload.agent
            ? `resume_token was generated for agent '${payload.agent}' but is being used to delegate to '${agent}'. Re-delegate to the correct specialist or ask the CEO to repeat their request.`
            : `resume_token has an empty agent field and cannot be validated. The token may be corrupted — ask the CEO to repeat their request.`,
        };
      }

      effectiveTask = [
        'You are continuing a task that was paused to get the CEO\'s direction.',
        '',
        '## Original Task',
        payload.original_task,
        '',
        '## Your Progress So Far',
        payload.context,
        '',
        '## CEO\'s Direction',
        task,
        '',
        'Continue from where you left off.',
      ].join('\n');

      ctx.log.info(
        { targetAgent: agent, originalAgent: payload.agent },
        'Resuming task with resume_token — constructed task brief from original context + CEO direction',
      );
    }

    // After resume-token validation (#995). A bad token must still get its decode or
    // agent-mismatch error; an open handle must not replace that with already_in_flight.
    const inFlightRefusal = await refuseIfInFlight(ctx, agent);
    if (inFlightRefusal) return inFlightRefusal;

    ctx.log.info(
      { targetAgent: agent, task: effectiveTask.slice(0, 100), timeoutMs: specialistTimeoutMs },
      'Delegating task to specialist',
    );

    // Forward the coordinator's relay context so that if the specialist mints a secret-capture
    // link, the capture origin can re-enter the COORDINATOR (a deliverable channel) and re-delegate
    // back to this specialist via resume_token (#995). originalTask is the specialist's brief, used
    // to build that resume_token. Only `delegate` sets delegationOrigin — it is the structural
    // signal that a task is running as a delegated specialist.
    const delegationMetadata: Record<string, unknown> = {
      delegationOrigin: {
        conversationId: ctx.conversationId,
        channelId: ctx.channelId,
        agentId: ctx.agentId,
        originalTask: effectiveTask,
        // The coordinator task whose relay this specialist's sends may lock (#1860).
        ...(typeof ctx.taskEventId === 'string' && ctx.taskEventId.length > 0
          ? { taskEventId: ctx.taskEventId }
          : {}),
      },
    };
    // Preserve the originator forwarding (#972) — without it the specialist loses the chain's
    // TaskOriginator and isPrincipalOriginated() goes false for every skill in its turn.
    if (ctx.taskMetadata?.originator) {
      delegationMetadata.originator = ctx.taskMetadata.originator;
    }

    // Publish an agent.task event for the specialist.
    // parentEventId uses a delegate-prefixed UUID. Ideally this would trace back
    // to the Coordinator's tool.invoke event, but ToolContext doesn't currently
    // carry the invoking event's ID. TODO: Add invokeEventId to ToolContext so
    // capability-gated skills can maintain the full audit causal chain.
    const taskEvent = createAgentTask({
      agentId: agent,
      conversationId,
      channelId: 'internal',
      senderId: 'coordinator',
      content: effectiveTask,
      metadata: delegationMetadata,
      // Forward the live-principal-turn signal (#1126) across this SYNCHRONOUS delegation: a
      // specialist acting inside the CEO's live turn (e.g. the contacts specialist running
      // contact-set-tier, or the setup-wizard minting a secret-capture link) inherits live-ness
      // and can satisfy the elevated gate. This is safe precisely because delegation is
      // ephemeral request/response — the sub-task is a bus event, never a persisted/wakeable row,
      // and `liveTurn` is a distinct field no persistence skill copies. It is "live" only for the
      // duration of this synchronous call; the moment work crosses an async boundary
      // (scheduler-create, task wake_at, a persisted bullpen thread) the signal is gone.
      liveTurn: ctx.liveTurn,
      parentEventId: `delegate-${randomUUID()}`,
    });

    // Claim before subscribing. A refusal returns before the response listener
    // and its timer exist, so a busy conversation does not accumulate subscribers
    // that never settle. The call stays inside the try: a throw while arming the
    // listener still releases a claim this call acquired.
    let acquiredDelegateEventId: string | undefined;
    let retainRunningClaim = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const claim = await acquireDispatchClaim(
        ctx,
        agent,
        taskEvent.id,
        effectiveTask,
        conversationId,
        specialistTimeoutMs,
      );
      if (!claim.ok) return claim.result;
      acquiredDelegateEventId = claim.delegateEventId;

      // Record only once this call holds the claim (or no claim is wired). An
      // in-flight refusal did not start a specialist, so it must not consume an
      // attempt. A resume continuation still does not consume one (#1171).
      if (ctx.delegationGuard && !hasResumeToken) {
        ctx.delegationGuard.recordInvocation(dKey);
      }

      // Set up a one-time listener for the specialist's response BEFORE
      // publishing the task, so we don't miss a fast response.
      // TODO: The EventBus has no unsubscribe mechanism, so this subscriber
      // persists after the delegation completes. The settled guard makes it
      // a near-zero-cost no-op after resolution. Phase 5 should add
      // bus.unsubscribe() or a one-shot subscription pattern.
      const responsePromise = new Promise<string>((resolve, reject) => {
        let settled = false;

        timeoutHandle = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject({
              __structuredDelegateFailure: true,
              agent,
              reason: 'timeout',
              // Non-retryable: the specialist may still be running (possibly_succeeded below).
              // A second delegation risks concurrent duplicate side effects — worse than
              // escalating a task that turned out dead. Auto-retry would only help the rare
              // "specialist actually died" case at the cost of duplicate emails in prod.
              retryable: false,
              // Correlation ids for late delivery (#1799) — the run we are abandoning here keeps
              // going, so hand the runtime what it needs to recognise its eventual response.
              delegateEventId: taskEvent.id,
              delegateConversationId: conversationId,
              waitTimeoutMs: specialistTimeoutMs,
            } satisfies StructuredDelegateFailure);
          }
        }, specialistTimeoutMs);

        ctx.bus!.subscribe('agent.response', 'system', async (event) => {
          if (settled) return; // Skip processing after settlement — prevents double-resolve
          try {
            const responseEvent = event as AgentResponseEvent;
            // Match on the task event ID — the specialist sets parentEventId to the task ID
            if (responseEvent.parentEventId === taskEvent.id) {
              settled = true;
              clearTimeout(timeoutHandle);
              // isError means the specialist hit an unrecoverable error (context overflow,
              // LLM failure, budget exhaustion). Reject so the catch block returns
              // { success: false } or a structured failure result when reason is present.
              if (responseEvent.payload.isError) {
                const { errorType, reason, retryable } = responseEvent.payload;
                if (reason !== undefined && retryable !== undefined) {
                  reject({
                    __structuredDelegateFailure: true,
                    agent,
                    reason,
                    retryable,
                    ...(errorType !== undefined && { errorType }),
                  } satisfies StructuredDelegateFailure);
                  return;
                }
                reject(new Error(`Specialist '${agent}' encountered an error and could not complete the task`));
              } else {
                const pausedPayload = parseExecutionPausedPayload(responseEvent.payload.content, ctx.log);
                if (pausedPayload) {
                  resolve(JSON.stringify({
                    _curia_protocol: EXECUTION_PAUSED_PROTOCOL,
                    agent,
                    task_id: pausedPayload.task_id,
                    done: pausedPayload.done,
                    total: pausedPayload.total,
                    next: pausedPayload.next,
                    message: formatPausedProgressMessage({
                      done: pausedPayload.done,
                      total: pausedPayload.total,
                      next: pausedPayload.next,
                    }),
                  }));
                  return;
                }
                resolve(responseEvent.payload.content);
              }
            }
          } catch (err) {
            // Fail fast on malformed events rather than silently hanging until timeout
            if (!settled) {
              settled = true;
              clearTimeout(timeoutHandle);
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
        });
      });

      // Publish the task to the bus — the specialist will pick it up.
      // We publish as 'dispatch' layer because only dispatch can publish agent.task
      // per the permission model. Infrastructure skills are trusted to impersonate layers.
      //
      // IMPORTANT: await both concurrently via Promise.all rather than sequentially.
      // The EventBus awaits subscriber handlers in sequence, so publish() does not resolve
      // until the specialist's full processing chain completes (which can take 60–90s).
      // If we awaited publish() first and then responsePromise, the 90s timeout could fire
      // while responsePromise had no rejection handler yet — causing an unhandledRejection
      // that crashes the process. Promise.all attaches handlers to both promises immediately,
      // closing that window. See: https://github.com/josephfung/curia/issues/73
      // retainRunningClaim is set only when the wait timer itself fires — that
      // rejection carries delegateEventId, which is what the runtime promotes.
      // A specialist that reports reason 'timeout' does not, and retaining the
      // claim would block the conversation until the sweep re-delivered the answer.
      const [response] = await Promise.all([
        responsePromise,
        ctx.bus.publish('dispatch', taskEvent),
      ]);
      ctx.log.info({ targetAgent: agent }, 'Specialist responded');

      // Clarification protocol detection: the runtime emits a JSON response
      // with _curia_protocol: "clarification_request" when a specialist calls
      // request-clarification. Detect this and return a typed result so the
      // coordinator gets structured fields (needs_clarification, question,
      // context, resume_token) instead of raw text to parse.
      try {
        const parsed = JSON.parse(response) as Record<string, unknown>;
        if (parsed._curia_protocol === 'clarification_request') {
          // Validate that the protocol payload has the required fields as strings.
          // The runtime produces these deterministically, but defensive validation
          // prevents a malformed response from reaching the coordinator as typed data.
          const question = parsed.question;
          const ctxValue = parsed.context;
          const resumeToken = parsed.resume_token;
          if (
            typeof question !== 'string' || question.trim() === '' ||
            typeof ctxValue !== 'string' || ctxValue.trim() === '' ||
            typeof resumeToken !== 'string' || resumeToken.trim() === ''
          ) {
            ctx.log.warn(
              { targetAgent: agent },
              'Clarification protocol marker present but payload fields are invalid — falling back to raw response',
            );
          } else {
            ctx.log.info(
              { targetAgent: agent, question: question.slice(0, 100) },
              'Specialist requested clarification — returning typed result to coordinator',
            );
            return {
              success: true,
              data: {
                agent,
                needs_clarification: true,
                question,
                context: ctxValue,
                resume_token: resumeToken,
              },
            };
          }
        }

        if (parsed._curia_protocol === EXECUTION_PAUSED_PROTOCOL) {
          const done = parsed.done;
          const total = parsed.total;
          const next = parsed.next;
          const message = parsed.message;
          if (
            typeof done !== 'number' ||
            typeof total !== 'number' ||
            typeof next !== 'string' ||
            typeof message !== 'string'
          ) {
            ctx.log.warn(
              { targetAgent: agent },
              'Execution paused protocol marker present but payload fields are invalid — falling back to raw response',
            );
          } else {
            ctx.log.info(
              { targetAgent: agent, done, total },
              'Specialist paused mid-task — returning typed paused result to coordinator',
            );
            return {
              success: true,
              data: {
                agent,
                paused: true,
                done,
                total,
                next,
                message,
                ...(typeof parsed.task_id === 'string' && { task_id: parsed.task_id }),
              },
            };
          }
        }
      } catch (err) {
        // SyntaxError is expected for normal text responses — suppress silently.
        // Any other error is unexpected and should be logged for debugging.
        if (!(err instanceof SyntaxError)) {
          ctx.log.warn(
            { err, targetAgent: agent },
            'Unexpected error parsing specialist response for clarification protocol — treating as normal text response',
          );
        }
      }

      // Prose replies are not JSON. A structured decline is an XML marker in that
      // prose (#1871) — distinguishable from a successful answer so the coordinator
      // does not reword the brief and retry.
      const decline = parseSpecialistDeclineMarker(response);
      if (decline) {
        ctx.log.info(
          { targetAgent: agent, declineReason: decline.reason },
          'Specialist declined the delegated task',
        );
        return {
          success: true,
          data: {
            agent,
            declined: true,
            failed: true,
            reason: SPECIALIST_DECLINE_REASON,
            retryable: false,
            message: decline.message,
          },
        };
      }

      // Pull contact IDs out before the execution layer strips the
      // <resolved_entities> tags. The structured field survives sanitization;
      // the markup in `response` does not (#1818).
      const resolvedContactIds = parseResolvedContactIds(response);
      return {
        success: true,
        data: {
          response,
          agent,
          ...(resolvedContactIds.length > 0 ? { resolvedContactIds } : {}),
        },
      };
    } catch (err) {
      if (isStructuredDelegateFailure(err)) {
        // The wait timer started the specialist and set delegateEventId. Keep
        // the claim so the timeout subscriber can promote it. A specialist
        // failure that merely uses the reason 'timeout' has no id to promote.
        if (err.reason === 'timeout' && err.delegateEventId !== undefined) retainRunningClaim = true;
        const message = formatStructuredFailureMessage(err.agent, err.reason);
        ctx.log.error(
          {
            targetAgent: err.agent,
            reason: err.reason,
            retryable: err.retryable,
            errorType: err.errorType,
            delegateEventId: err.delegateEventId,
          },
          'Delegation failed with structured specialist error',
        );
        return {
          success: true,
          data: {
            agent: err.agent,
            failed: true,
            reason: err.reason,
            retryable: err.retryable,
            ...(err.errorType !== undefined && { errorType: err.errorType }),
            message,
            ...(err.reason === 'timeout' && { possibly_succeeded: true }),
            // #1799: only the timeout branch sets these — they let the runtime open a pending
            // delegation handle so the specialist's late response is not orphaned.
            ...(err.delegateEventId !== undefined && { delegate_event_id: err.delegateEventId }),
            ...(err.delegateConversationId !== undefined && {
              delegate_conversation_id: err.delegateConversationId,
            }),
            ...(err.waitTimeoutMs !== undefined && { wait_timeout_ms: err.waitTimeoutMs }),
          },
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, targetAgent: agent }, 'Delegation failed');
      return { success: false, error: message };
    } finally {
      // Always clean up the timeout on any exit path. Unset when we returned
      // before the listener was armed (claim conflict, acquire failure).
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (acquiredDelegateEventId && !retainRunningClaim && ctx.openDelegationLookup?.releaseRunning) {
        try {
          await ctx.openDelegationLookup.releaseRunning(acquiredDelegateEventId);
        } catch (err) {
          // releaseRunning marks the row delivered when the delete throws, so the
          // sweep cannot re-send a result this caller already has. This log is the
          // case where that mark failed too — the row stays running until expires_at.
          ctx.log.error(
            { err, targetAgent: agent, delegateEventId: acquiredDelegateEventId },
            'Failed to release the running delegation claim',
          );
        }
      }
    }
  }
}
