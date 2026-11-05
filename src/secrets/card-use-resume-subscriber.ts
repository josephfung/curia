// card-use-resume-subscriber.ts — agent resume after a saved-card decision (#1358).
//
// When the principal answers a card-use confirmation somewhere other than the requesting
// conversation (the console, a reaction), the agent that asked is parked mid-checkout. The
// execution layer publishes `card_use.decided` with `resume: true`; this subscriber re-enters the
// originating agent with a synthetic `agent.task` carrying fixed copy for the outcome. When the
// principal approved inline (`resume: false`) the approve-action result already told the agent to
// continue, so this subscriber must skip — a second continuation would double-drive the checkout.
//
// Modeled on SecretCaptureResumeSubscriber: same routing registration before publish, same
// dedup-before-publish guard, same originator attribution. The event carries brand-free routing
// metadata and the purpose text only — never the card number or CVV.

import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { BusEvent, CardUseDecidedEvent } from '../bus/events.js';
import { createAgentTask } from '../bus/events.js';
import { decodeResumeToken } from '../agents/resume-token.js';
import {
  NON_DELIVERABLE_CHANNELS,
  parseOriginator,
  unresolvedExternalOriginator,
  type ResumeRoutingRegistrar,
} from './secret-capture-resume-subscriber.js';

/** Bound on the dedup set; FIFO eviction, same reasoning as the secret-capture subscriber. */
const MAX_DISPATCHED_IDS = 10_000;

function resumeCopy(decision: CardUseDecidedEvent['payload']['decision'], purpose: string, site: string): string {
  switch (decision) {
    case 'approved':
      return `The principal approved the card payment for ${purpose} on ${site}. Continue the checkout in the same browser session.`;
    case 'denied':
      return `The principal declined the card payment for ${purpose}. Don't fill the card; tell them you stopped.`;
    case 'expired':
      return `The card confirmation for ${purpose} expired without an answer. Ask again only if they still want it.`;
    case 'failed':
      return `The principal approved the card payment for ${purpose}, but a technical failure stopped the approval from taking effect, so no card was filled. Tell them what happened and ask whether to retry.`;
  }
}

export class CardUseResumeSubscriber {
  private readonly dispatched = new Set<string>();

  constructor(
    private readonly bus: EventBus,
    private readonly logger: Logger,
    /** When provided, routing is registered before publish so the resumed reply reaches the user. */
    private readonly registerRouting?: ResumeRoutingRegistrar,
  ) {}

  /** Subscribe to card_use.decided. Call once at startup. */
  start(): void {
    this.bus.subscribe('card_use.decided', 'system', (event: BusEvent) => this.handle(event as CardUseDecidedEvent));
    this.logger.info('CardUseResumeSubscriber started — listening for card_use.decided');
  }

  private async handle(event: CardUseDecidedEvent): Promise<void> {
    const { requestId, secretName, siteDomain, decision, resume, origin, purpose } = event.payload;

    // Inline approval: the originating conversation already got the continuation.
    if (!resume) {
      this.logger.debug({ eventId: event.id, requestId, decision }, 'card_use.decided has resume=false — not resuming');
      return;
    }

    if (this.dispatched.has(event.id)) {
      this.logger.info({ eventId: event.id, requestId }, 'card_use.decided already handled — skipping duplicate');
      return;
    }

    const { agentId, conversationId, channelId, taskEventId, originator, resumeToken } = origin;
    if (!agentId || !conversationId || !channelId) {
      this.logger.info(
        { eventId: event.id, requestId, hasAgentId: !!agentId, hasConversationId: !!conversationId, hasChannelId: !!channelId },
        'card_use.decided has no routable origin — not resuming an agent',
      );
      return;
    }

    if (NON_DELIVERABLE_CHANNELS.has(channelId)) {
      this.logger.warn(
        { eventId: event.id, requestId, agentId, channelId },
        'card_use.decided origin is a non-user-facing channel — cannot deliver a resume there; skipping',
      );
      return;
    }

    let content = resumeCopy(decision, purpose, siteDomain);
    if (resumeToken) {
      // Delegated specialist (#995): the coordinator must re-delegate with the token so the
      // specialist (which holds the browser session) is the one that continues.
      const decoded = decodeResumeToken(resumeToken);
      if (!decoded) {
        this.logger.warn(
          { eventId: event.id, requestId, agentId, tokenLength: resumeToken.length, tokenPrefix: resumeToken.slice(0, 8) },
          'card_use.decided carried a resume_token that could not be decoded — skipping specialist re-delegation',
        );
        return;
      }
      content =
        `${content} The specialist '${decoded.agent}' paused waiting for this. Re-delegate to '${decoded.agent}' ` +
        `to continue, passing this resume_token EXACTLY as given (do not alter, redact, or shorten it):\n\n${resumeToken}\n\n` +
        `Then relay its reply to the user.`;
    }

    const contactId = originator?.['contactId'];
    const senderId = typeof contactId === 'string' && contactId.length > 0 ? contactId : 'card-use';
    const parsedOriginator = parseOriginator(originator);
    const routingOriginator = parsedOriginator ?? unresolvedExternalOriginator(channelId);
    if (!parsedOriginator) {
      this.logger.warn(
        { eventId: event.id, channelId, conversationId, hadOriginatorBag: !!originator },
        'card_use.decided missing or malformed originator — using fail-closed unresolved originator for Gate C (#1733)',
      );
    }

    // Mark before publishing so a synchronous re-delivery can't slip through; placed after
    // validation so skipped events stay replayable.
    this.markDispatched(event.id);

    const task = createAgentTask({
      agentId,
      conversationId,
      channelId,
      senderId,
      content,
      // Curia telling the agent the decision, not something the principal said (#1892).
      syntheticTurn: true,
      metadata: { originator: routingOriginator },
      parentEventId: taskEventId ?? event.id,
    });

    // Deny and dismiss run inside the requesting turn, which holds the conversation lane, so
    // awaiting delivery would wait on that lane until the turn ends. Persist the task first
    // (awaited, so a process stop cannot lose the continuation), then start delivery detached.
    // A failure is logged and the dedup mark released.
    try {
      this.registerRouting?.(task.id, { channelId, conversationId, senderId, originator: routingOriginator });
    } catch (err) {
      this.dispatched.delete(event.id);
      this.logger.error({ err, eventId: event.id, agentId, conversationId }, 'Failed to register routing for the card-use resume agent.task');
      throw err;
    }
    let staged;
    try {
      staged = await this.bus.stagePublish('system', task);
    } catch (err) {
      this.dispatched.delete(event.id);
      this.logger.error({ err, eventId: event.id, agentId, conversationId }, 'Failed to persist resume agent.task after card-use decision');
      throw err;
    }
    void staged.deliver().then(
      () => this.logger.info({ eventId: event.id, agentId, conversationId, secretName, decision }, 'Resumed agent after card-use decision'),
      (err: unknown) => {
        this.logger.error({ err, eventId: event.id, agentId, conversationId }, 'Failed to deliver resume agent.task after card-use decision');
      },
    );
  }

  private markDispatched(eventId: string): void {
    if (this.dispatched.size >= MAX_DISPATCHED_IDS) {
      const oldest = this.dispatched.values().next().value;
      if (oldest !== undefined) this.dispatched.delete(oldest);
    }
    this.dispatched.add(eventId);
  }
}
