// secret-capture-resume-subscriber.ts — agent resume after secret capture (#972).
//
// Today secret capture is fire-and-forget: the agent mints a link, the user fills it, and
// nothing tells the agent. This thin subscriber closes that loop. It listens for the
// `secret.captured` event (published by the capture endpoint on a successful redeem) and does
// exactly one thing: re-enter the originating agent by publishing a synthetic `agent.task`
// back into the same conversation. The agent then reasons — from its OWN conversation history —
// about whether it now has everything it asked for, and either proceeds (e.g. via the #973
// consumer skill) or tells the user what's still outstanding.
//
// Deliberately NOT here: any group/coordination state, captured-vs-pending bookkeeping, or
// completion logic. The LLM already has that context; duplicating it in a DB table would be
// redundant and brittle. This service is a pure router: event in → agent.task out.
//
// The secret VALUE never reaches this code. The event carries only the secret name/label and
// routing metadata (consistent with #971's structural guarantee), so neither the resume task
// nor its content can contain a value.

import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { BusEvent, SecretCapturedEvent } from '../bus/events.js';
import { createAgentTask } from '../bus/events.js';

/**
 * Seeds channel routing for the synthetic resume task so the agent's response is delivered back
 * to the originating channel. Without it, the dispatcher's handleAgentResponse finds no routing
 * for the task id and drops the reply (the same path bullpen tasks take). In production this is
 * `Dispatcher.registerExternalTaskRouting`; tests inject a spy.
 */
export type ResumeRoutingRegistrar = (
  taskEventId: string,
  routing: { channelId: string; conversationId: string; senderId: string; accountId?: string },
) => void;

/** Cap on the dedup set so a long-running process can't grow it without bound (one entry per
 *  capture otherwise lives for the process lifetime). Generous — duplicates are rare — and FIFO
 *  eviction of the oldest id is safe because the source (redeem) is idempotent, so an evicted id
 *  re-arriving would at worst re-enter the agent once, which it tolerates (re-checks its history). */
const MAX_DISPATCHED_IDS = 10_000;

export class SecretCaptureResumeSubscriber {
  // In-memory guard against double-dispatch on duplicate event delivery. The redeem is already
  // idempotent on consumed_at (one capture → one event), so this only defends against the bus
  // delivering the same event id twice. A process restart clears it, which is fine: a re-emitted
  // event after a restart re-entering the agent once more is harmless (the agent re-checks its
  // own history). Bounded to MAX_DISPATCHED_IDS with FIFO eviction so it never leaks.
  private readonly dispatched = new Set<string>();

  constructor(
    private readonly bus: EventBus,
    private readonly logger: Logger,
    /** Optional: when provided, routing is registered before publish so the resumed response
     *  reaches the user. Absent in tests that only assert the published task. */
    private readonly registerRouting?: ResumeRoutingRegistrar,
  ) {}

  /** Subscribe to secret.captured. Call once at startup, alongside the bus/scheduler wiring. */
  start(): void {
    this.bus.subscribe('secret.captured', 'system', (event: BusEvent) => this.handle(event as SecretCapturedEvent));
    this.logger.info('SecretCaptureResumeSubscriber started — listening for secret.captured');
  }

  private async handle(event: SecretCapturedEvent): Promise<void> {
    // Duplicate-delivery guard: one capture must re-enter the agent exactly once. A duplicate of
    // the same event id is genuinely unexpected (redeem is idempotent on consumed_at, so the
    // source emits exactly one event per capture) — so log at info: a steady stream of these
    // would point at a bus re-delivery bug worth noticing, not routine noise.
    if (this.dispatched.has(event.id)) {
      this.logger.info({ eventId: event.id }, 'secret.captured already handled — skipping duplicate');
      return;
    }

    const { secretName, label, conversationId, agentId, channelId, taskEventId, resumeIntent, originator } = event.payload;

    // Essential routing must be present to re-enter an agent. A token minted outside an agent
    // context (or before #972's migration) has no origin — there is nothing to resume, so we
    // skip cleanly rather than fabricate a destination.
    if (!agentId || !conversationId || !channelId) {
      this.logger.info(
        { eventId: event.id, secretName, hasAgentId: !!agentId, hasConversationId: !!conversationId, hasChannelId: !!channelId },
        'secret.captured has no routable origin — not resuming an agent',
      );
      return;
    }

    // Mark dispatched BEFORE publishing so a synchronous re-delivery during publish can't slip
    // through (mirrors the scheduler tracking its pending job before publish()).
    this.markDispatched(event.id);

    const displayName = label ?? secretName;
    const intentLine = resumeIntent ? ` Original request: ${resumeIntent}.` : '';
    const content =
      `The secret '${displayName}' was just captured and saved to the vault.${intentLine} ` +
      `If you now have everything you need to continue, proceed. Otherwise, tell the user what ` +
      `is still outstanding (check your conversation history for any other secrets you asked for).`;

    // Attribute the resumed turn to whoever started the chain. originator is round-tripped from
    // JSONB (typed Record<string, unknown>), so validate contactId is actually a string before
    // using it as senderId — a malformed persisted value must not produce a non-string senderId.
    // The originator object is still preserved verbatim on metadata so authorization gates resolve
    // exactly as they did on the original task.
    const contactId = originator?.['contactId'];
    const senderId = typeof contactId === 'string' && contactId.length > 0 ? contactId : 'secret-capture';

    // Build the task first so we know its id, then seed dispatcher routing BEFORE publishing —
    // otherwise the agent's response could arrive before routing exists, or find none and be
    // dropped (the dispatcher only auto-routes tasks that came through handleInbound).
    const task = createAgentTask({
      agentId,
      conversationId,
      channelId,
      senderId,
      content,
      metadata: originator ? { originator } : undefined,
      // Thread back to the originating agent.task when known so the causal chain is intact;
      // fall back to this event's id otherwise (agent.task requires a parentEventId).
      parentEventId: taskEventId ?? event.id,
    });

    try {
      this.registerRouting?.(task.id, { channelId, conversationId, senderId });
      await this.bus.publish('system', task);
      this.logger.info({ eventId: event.id, agentId, conversationId, secretName }, 'Resumed agent after secret capture');
    } catch (err) {
      // Roll back the dedup marker so a retry (e.g. operator replay) can re-attempt the resume,
      // log it, then propagate per the catch policy (the bus isolates subscriber errors, so this
      // does not punish the publisher — it just ensures the failure is never silently swallowed).
      this.dispatched.delete(event.id);
      this.logger.error({ err, eventId: event.id, agentId, conversationId }, 'Failed to dispatch resume agent.task after secret capture');
      throw err;
    }
  }

  /** Record an event id as handled, evicting the oldest when the bounded set is full. */
  private markDispatched(eventId: string): void {
    if (this.dispatched.size >= MAX_DISPATCHED_IDS) {
      // Sets preserve insertion order, so the first key is the oldest — FIFO eviction.
      const oldest = this.dispatched.values().next().value;
      if (oldest !== undefined) this.dispatched.delete(oldest);
    }
    this.dispatched.add(eventId);
  }
}
