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
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createAgentTask, type AgentResponseEvent, type AgentResponseFailureReason } from '../../src/bus/events.js';
// Resume-token format lives in ONE place (#995): decode + version via the shared helper, so a
// future format change can't silently desync this handler from runtime.ts and the resume subscriber.
import { decodeResumeToken, RESUME_TOKEN_VERSION } from '../../src/agents/resume-token.js';
import { delegationKey } from '../../src/agents/delegation-guard.js';
import { clampDelegateWaitTimeoutMs } from '../../src/agents/delegate-timeout.js';
import {
  EXECUTION_PAUSED_PROTOCOL,
  formatPausedProgressMessage,
  parseExecutionPausedPayload,
} from '../../src/agents/resumable-task.js';

// Default wait for the specialist to respond — appropriate for interactive tasks.
// Long-running scheduled tasks should pass timeout_ms explicitly (injected by the runtime
// from the originating agent.task event's expectedDurationSeconds).
const DEFAULT_SPECIALIST_TIMEOUT_MS = 90000;

/** Sentinel shape rejected by the response promise when a specialist returns isError with
 *  structured failure fields — caught in execute() and turned into a typed delegate result. */
interface StructuredDelegateFailure {
  __structuredDelegateFailure: true;
  agent: string;
  reason: AgentResponseFailureReason;
  retryable: boolean;
  errorType?: string;
}

function isStructuredDelegateFailure(err: unknown): err is StructuredDelegateFailure {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as StructuredDelegateFailure).__structuredDelegateFailure === true
  );
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

export class DelegateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
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

    // Use caller-supplied timeout if it's a valid positive finite integer; fall back to default.
    // Invalid values fall back silently so a bad LLM-supplied value never breaks the call.
    // When the runtime injects timeout_ms from expectedDurationSeconds (scheduled tasks), the
    // value should always be valid — a warn here helps distinguish LLM garbage from a runtime bug.
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

    // Identical-delegation guard (#1171): resume continuations are exempt — they carry new
    // CEO direction and a different effective brief. Without a resume_token, block when the
    // runtime has already recorded a non-retryable failure for this agent+task pair.
    const hasResumeToken = typeof resume_token === 'string' && resume_token !== '';
    if (!hasResumeToken && ctx.delegationGuard) {
      const dKey = delegationKey(agent, task);
      if (!ctx.delegationGuard.canAttempt(dKey)) {
        const prior = ctx.delegationGuard.getFailure(dKey);
        ctx.log.warn(
          { targetAgent: agent, reason: prior?.reason },
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
            escalated: ctx.delegationGuard.isEscalated(dKey),
          },
        };
      }
      ctx.delegationGuard.recordInvocation(dKey);
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
      },
    };
    // Preserve the originator forwarding (#972) — without it the specialist loses the chain's
    // TaskOriginator and isPrincipalOriginated() goes false for every skill in its turn.
    if (ctx.taskMetadata?.originator) {
      delegationMetadata.originator = ctx.taskMetadata.originator;
    }

    // Publish an agent.task event for the specialist.
    // parentEventId uses a delegate-prefixed UUID. Ideally this would trace back
    // to the Coordinator's skill.invoke event, but SkillContext doesn't currently
    // carry the invoking event's ID. TODO: Add invokeEventId to SkillContext so
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

    // Set up a one-time listener for the specialist's response BEFORE
    // publishing the task, so we don't miss a fast response.
    // TODO: The EventBus has no unsubscribe mechanism, so this subscriber
    // persists after the delegation completes. The settled guard makes it
    // a near-zero-cost no-op after resolution. Phase 5 should add
    // bus.unsubscribe() or a one-shot subscription pattern.
    let timeoutHandle: NodeJS.Timeout;
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
    try {
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

      return {
        success: true,
        data: {
          response,
          agent,
        },
      };
    } catch (err) {
      if (isStructuredDelegateFailure(err)) {
        const message = formatStructuredFailureMessage(err.agent, err.reason);
        ctx.log.error(
          { targetAgent: err.agent, reason: err.reason, retryable: err.retryable, errorType: err.errorType },
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
          },
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, targetAgent: agent }, 'Delegation failed');
      return { success: false, error: message };
    } finally {
      // Always clean up the timeout on any exit path
      clearTimeout(timeoutHandle!);
    }
  }
}
