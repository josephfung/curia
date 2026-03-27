import type { EventBus } from '../bus/bus.js';
import type { InboundMessageEvent, AgentResponseEvent } from '../bus/events.js';
import { createAgentTask, createOutboundMessage, createContactResolved, createContactUnknown, createMessageHeld } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ContactResolver } from '../contacts/contact-resolver.js';
import type { HeldMessageService } from '../contacts/held-messages.js';
import type { InboundSenderContext, ChannelPolicyConfig } from '../contacts/types.js';

export interface DispatcherConfig {
  bus: EventBus;
  logger: Logger;
  contactResolver?: ContactResolver;
  heldMessages?: HeldMessageService;
  channelPolicies?: Record<string, ChannelPolicyConfig>;
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
  private heldMessages?: HeldMessageService;
  private channelPolicies?: Record<string, ChannelPolicyConfig>;
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
    this.heldMessages = config.heldMessages;
    this.channelPolicies = config.channelPolicies;
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
          // Unknown sender — publish audit event and check channel policy
          await this.bus.publish('dispatch', createContactUnknown({
            channel: senderContext.channel,
            senderId: senderContext.senderId,
            parentEventId: event.id,
          }));

          const policy = this.channelPolicies?.[payload.channelId];

          if (policy?.unknownSender === 'hold_and_notify' && this.heldMessages) {
            try {
              // Hold the message instead of routing to coordinator
              const subject = (payload.metadata as Record<string, unknown> | undefined)?.subject as string | null ?? null;
              const heldId = await this.heldMessages.hold({
                channel: payload.channelId,
                senderId: payload.senderId,
                conversationId: payload.conversationId,
                content: payload.content,
                subject,
                metadata: payload.metadata ?? {},
              });

              // Publish held event so CLI can notify and audit can log
              await this.bus.publish('dispatch', createMessageHeld({
                heldMessageId: heldId,
                channel: payload.channelId,
                senderId: payload.senderId,
                subject,
                parentEventId: event.id,
              }));

              this.logger.info(
                { heldMessageId: heldId, channel: payload.channelId, senderId: payload.senderId },
                'Message held from unknown sender',
              );
            } catch (holdErr) {
              // Fail closed: if we can't hold the message, drop it rather than
              // routing an unknown sender's message to the coordinator.
              // This is a security boundary — prefer message loss over policy bypass.
              this.logger.error(
                { err: holdErr, channel: payload.channelId, senderId: payload.senderId },
                'Failed to hold unknown sender message — dropping (fail-closed)',
              );
            }
            return; // Always return — whether hold succeeded or failed
          }

          if (policy?.unknownSender === 'reject') {
            this.logger.info(
              { channel: payload.channelId, senderId: payload.senderId },
              'Rejected message from unknown sender',
            );
            return; // Silently drop
          }

          // 'allow' policy or no policy configured — fall through to normal routing
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
