import type { EventBus } from '../bus/bus.js';
import type { InboundMessageEvent, AgentResponseEvent } from '../bus/events.js';
import { createAgentTask, createOutboundMessage, createContactResolved, createContactUnknown } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ContactResolver } from '../contacts/contact-resolver.js';
import type { InboundSenderContext } from '../contacts/types.js';

export interface DispatcherConfig {
  bus: EventBus;
  logger: Logger;
  contactResolver?: ContactResolver;
}

/**
 * The Dispatcher connects the channel layer to the agent layer via the bus.
 * It does two things:
 * 1. Converts inbound.message → agent.task (routes to Coordinator)
 * 2. Converts agent.response → outbound.message (routes back to the originating channel)
 *
 * It does NOT hold a reference to the agent runtime — all communication is
 * through bus events. This enforces the architectural boundary and ensures
 * every message flows through the audit logger.
 */
export class Dispatcher {
  private bus: EventBus;
  private logger: Logger;
  private contactResolver?: ContactResolver;
  /**
   * Maps agent.task event ID → channel routing info.
   * When the agent publishes agent.response (with parentEventId pointing to the task),
   * we look up where to send the outbound message.
   *
   * We key on the task event ID (not the inbound message ID) because the agent
   * runtime sets parentEventId on its response to the task event that triggered it.
   */
  private taskRouting = new Map<string, { channelId: string; conversationId: string }>();

  constructor(config: DispatcherConfig) {
    this.bus = config.bus;
    this.logger = config.logger;
    this.contactResolver = config.contactResolver;
  }

  register(): void {
    // inbound.message → agent.task
    this.bus.subscribe('inbound.message', 'dispatch', async (event) => {
      await this.handleInbound(event as InboundMessageEvent);
    });

    // agent.response → outbound.message
    this.bus.subscribe('agent.response', 'dispatch', async (event) => {
      await this.handleAgentResponse(event as AgentResponseEvent);
    });

    this.logger.info('Dispatcher registered');
  }

  private async handleInbound(event: InboundMessageEvent): Promise<void> {
    const { payload } = event;
    this.logger.info(
      { channelId: payload.channelId, senderId: payload.senderId },
      'Dispatching to coordinator',
    );

    // Resolve sender if contact resolver is available.
    // Wrapped in try/catch so DB errors degrade gracefully (no sender context)
    // rather than silently dropping the message — the task still dispatches,
    // just without enriched sender info.
    let senderContext: InboundSenderContext | undefined;
    if (this.contactResolver) {
      try {
        senderContext = await this.contactResolver.resolve(payload.channelId, payload.senderId);

        // Publish contact event for audit trail.
        // Skip audit for synthetic IDs (primary-user from CLI/smoke-test) to
        // avoid polluting the audit trail with non-real contacts.
        if (senderContext.resolved) {
          if (senderContext.contactId !== 'primary-user') {
            await this.bus.publish('dispatch', createContactResolved({
              contactId: senderContext.contactId,
              displayName: senderContext.displayName,
              role: senderContext.role,
              kgNodeId: senderContext.kgNodeId,
              verificationStatus: senderContext.verified ? 'verified' : 'unverified',
              channel: payload.channelId,
              channelIdentifier: payload.senderId,
              parentEventId: event.id,
            }));
          }
        } else {
          await this.bus.publish('dispatch', createContactUnknown({
            channel: senderContext.channel,
            senderId: senderContext.senderId,
            parentEventId: event.id,
          }));
        }
      } catch (err) {
        // Resolution failure must not drop the message — log and continue without
        // sender context. The coordinator will handle the missing context gracefully.
        this.logger.error(
          { err, channelId: payload.channelId, senderId: payload.senderId },
          'Contact resolution failed — proceeding without sender context',
        );
      }
    }

    const taskEvent = createAgentTask({
      agentId: 'coordinator',
      conversationId: payload.conversationId,
      channelId: payload.channelId,
      senderId: payload.senderId,
      content: payload.content,
      senderContext,
      parentEventId: event.id,
    });

    // Store routing info keyed by the task event ID so we can look it up
    // when the agent publishes its response (agent sets parentEventId = task.id)
    this.taskRouting.set(taskEvent.id, {
      channelId: payload.channelId,
      conversationId: payload.conversationId,
    });

    await this.bus.publish('dispatch', taskEvent);
  }

  private async handleAgentResponse(event: AgentResponseEvent): Promise<void> {
    // Find the task this response belongs to via parentEventId
    const routing = event.parentEventId
      ? this.taskRouting.get(event.parentEventId)
      : undefined;

    if (!routing) {
      this.logger.warn(
        { parentEventId: event.parentEventId },
        'No routing info for agent response — cannot deliver',
      );
      return;
    }

    // Clean up routing entry — one response per task
    this.taskRouting.delete(event.parentEventId!);

    const outbound = createOutboundMessage({
      conversationId: routing.conversationId,
      channelId: routing.channelId,
      content: event.payload.content,
      parentEventId: event.id,
    });
    await this.bus.publish('dispatch', outbound);
  }
}
