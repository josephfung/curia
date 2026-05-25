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
import { createAgentTask, type AgentResponseEvent } from '../../src/bus/events.js';

/** Version marker for resume tokens — allows forward-compatible format changes. */
const RESUME_TOKEN_VERSION = 1;

interface ResumeTokenPayload {
  v: number;
  agent: string;
  original_task: string;
  partial_findings: string;
}

// Default wait for the specialist to respond — appropriate for interactive tasks.
// Long-running scheduled tasks should pass timeout_ms explicitly (injected by the runtime
// from the originating agent.task event's expectedDurationSeconds).
const DEFAULT_SPECIALIST_TIMEOUT_MS = 90000;

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
    const specialistTimeoutMs = isValidTimeout ? (timeout_ms as number) : DEFAULT_SPECIALIST_TIMEOUT_MS;

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

    // Resume flow: when resume_token is provided, decode it and construct a
    // full task brief from the original context + the CEO's direction (the
    // `task` parameter). The specialist receives a self-contained task —
    // no special resume detection logic needed in its prompt.
    let effectiveTask = task;
    if (resume_token && typeof resume_token === 'string') {
      try {
        const decoded = JSON.parse(
          Buffer.from(resume_token, 'base64').toString('utf-8'),
        ) as Record<string, unknown>;

        if (decoded.v !== RESUME_TOKEN_VERSION) {
          ctx.log.warn(
            { targetAgent: agent, tokenVersion: decoded.v, expectedVersion: RESUME_TOKEN_VERSION },
            'resume_token version mismatch — attempting to use anyway',
          );
        }

        // Runtime validation: the token is opaque to the LLM, so a corrupted
        // token must not silently produce a broken task brief.
        const payload = decoded as unknown as ResumeTokenPayload;
        if (!payload.original_task || !payload.partial_findings) {
          const versionNote = decoded.v !== RESUME_TOKEN_VERSION
            ? ` Token version ${String(decoded.v)} does not match expected version ${RESUME_TOKEN_VERSION} — this may be the cause.`
            : '';
          return {
            success: false,
            error: `resume_token is missing required fields (original_task, partial_findings).${versionNote} The token may be corrupted — ask the CEO to repeat their request.`,
          };
        }

        // Guard against cross-agent token misuse: if the coordinator passes a
        // resume_token generated for one specialist but targets a different one,
        // the task brief would contain another agent's context. Reject early.
        if (payload.agent && payload.agent !== agent) {
          ctx.log.warn(
            { targetAgent: agent, tokenAgent: payload.agent },
            'resume_token was generated for a different agent — possible cross-agent token misuse',
          );
          return {
            success: false,
            error: `resume_token was generated for agent '${payload.agent}' but is being used to delegate to '${agent}'. Re-delegate to the correct specialist or ask the CEO to repeat their request.`,
          };
        }

        effectiveTask = [
          'You are continuing a task that was paused to get the CEO\'s direction.',
          '',
          '## Original Task',
          payload.original_task,
          '',
          '## Your Previous Findings',
          payload.partial_findings,
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
      } catch (err) {
        ctx.log.error({ err, targetAgent: agent }, 'Failed to decode resume_token');
        return {
          success: false,
          error: 'resume_token could not be decoded. The token may be corrupted — ask the CEO to repeat their request.',
        };
      }
    }

    ctx.log.info(
      { targetAgent: agent, task: effectiveTask.slice(0, 100), timeoutMs: specialistTimeoutMs },
      'Delegating task to specialist',
    );

    // Publish an agent.task event for the specialist.
    // parentEventId uses a delegate-prefixed UUID. Ideally this would trace back
    // to the Coordinator's skill.invoke event, but SkillContext doesn't currently
    // carry the invoking event's ID. TODO: Add invokeEventId to SkillContext so
    // capability-gated skills can maintain the full audit causal chain.
    //
    // Forward the parent task's originator so the specialist inherits the original
    // TaskOriginator. Without this, a CEO-initiated task delegated to a specialist
    // would lose its originator at the delegation boundary and isPrincipalOriginated()
    // would return false for all skill calls inside the specialist's turn.
    const taskEvent = createAgentTask({
      agentId: agent,
      conversationId,
      channelId: 'internal',
      senderId: 'coordinator',
      content: effectiveTask,
      // Forward only the originator field, not the full taskMetadata. Other metadata fields
      // (e.g. future billing context, routing hints) are coordinator-internal and should
      // not propagate transitively down the delegation chain unless explicitly designed to.
      metadata: ctx.taskMetadata?.originator
        ? { originator: ctx.taskMetadata.originator }
        : undefined,
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
          reject(new Error(`Specialist '${agent}' did not respond within ${specialistTimeoutMs}ms`));
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
            // { success: false } instead of forwarding the fallback message as a result.
            if (responseEvent.payload.isError) {
              reject(new Error(`Specialist '${agent}' encountered an error and could not complete the task`));
            } else {
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
      // partial_findings, resume_token) instead of raw text to parse.
      try {
        const parsed = JSON.parse(response) as Record<string, unknown>;
        if (parsed._curia_protocol === 'clarification_request') {
          // Validate that the protocol payload has the required fields as strings.
          // The runtime produces these deterministically, but defensive validation
          // prevents a malformed response from reaching the coordinator as typed data.
          const question = parsed.question;
          const partialFindings = parsed.partial_findings;
          const resumeToken = parsed.resume_token;
          if (
            typeof question !== 'string' || question.trim() === '' ||
            typeof partialFindings !== 'string' || partialFindings.trim() === '' ||
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
                partial_findings: partialFindings,
                resume_token: resumeToken,
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
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, targetAgent: agent }, 'Delegation failed');
      return { success: false, error: message };
    } finally {
      // Always clean up the timeout on any exit path
      clearTimeout(timeoutHandle!);
    }
  }
}
