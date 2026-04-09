import type { EventBus } from '../bus/bus.js';
import type { InboundMessageEvent, AgentResponseEvent, AgentErrorEvent } from '../bus/events.js';
import { createAgentTask, createOutboundMessage, createContactResolved, createContactUnknown, createMessageHeld, createMessageRejected, createConversationCheckpoint } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ContactResolver } from '../contacts/contact-resolver.js';
import type { HeldMessageService } from '../contacts/held-messages.js';
import type { InboundSenderContext, ChannelPolicyConfig } from '../contacts/types.js';
import type { InboundScanner } from './inbound-scanner.js';
import type { DbPool } from '../db/connection.js';

export interface DispatcherConfig {
  bus: EventBus;
  logger: Logger;
  contactResolver?: ContactResolver;
  heldMessages?: HeldMessageService;
  channelPolicies?: Record<string, ChannelPolicyConfig>;
  /** Layer 1 prompt injection scanner. When provided, every inbound message is
   *  scanned before reaching the Coordinator — tags stripped, risk_score attached. */
  injectionScanner?: InboundScanner;
  /** Postgres pool — used to query working_memory for checkpoint turns.
   *  When omitted, checkpoint scheduling is disabled (e.g. in unit tests). */
  pool?: DbPool;
  /** Milliseconds of inactivity before conversation.checkpoint fires. Default: 600000. */
  conversationCheckpointDebounceMs?: number;
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
  private injectionScanner?: InboundScanner;
  /**
   * Maps agent.task event ID → channel routing info.
   * When the agent publishes agent.response (with parentEventId pointing to the task),
   * we look up where to send the outbound message.
   *
   * We key on the task event ID (not the inbound message ID) because the agent
   * runtime sets parentEventId on its response to the task event that triggered it.
   */
  private taskRouting = new Map<string, { channelId: string; conversationId: string; senderId: string }>();
  /** Key: `${conversationId}:${agentId}` — reset on every agent.response */
  private checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pool: DbPool | undefined;
  private conversationCheckpointDebounceMs: number;

  constructor(config: DispatcherConfig) {
    this.bus = config.bus;
    this.logger = config.logger;
    this.contactResolver = config.contactResolver;
    this.heldMessages = config.heldMessages;
    this.channelPolicies = config.channelPolicies;
    this.injectionScanner = config.injectionScanner;
    this.pool = config.pool;
    this.conversationCheckpointDebounceMs = config.conversationCheckpointDebounceMs ?? 600_000;
  }

  /** Clear all pending checkpoint timers. Call during graceful shutdown. */
  close(): void {
    for (const timer of this.checkpointTimers.values()) {
      clearTimeout(timer);
    }
    this.checkpointTimers.clear();
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

    // agent.error → log for awareness (the runtime also sends agent.response for user notification)
    this.bus.subscribe('agent.error', 'dispatch', async (event) => {
      await this.handleAgentError(event as AgentErrorEvent);
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

            // Provisional contacts are treated like unknown senders for policy purposes.
            // They have a contact record (so the resolver finds them), but the CEO hasn't
            // confirmed them yet. Apply the same hold/reject policy as unknown senders.
            if (senderContext.status === 'provisional' || senderContext.status === 'blocked') {
              const policy = this.channelPolicies?.[payload.channelId];

              if (senderContext.status === 'blocked') {
                this.logger.info(
                  { channel: payload.channelId, senderId: payload.senderId, contactId: senderContext.contactId },
                  'Blocked sender — dropping message',
                );
                // Wrapped in its own try/catch so a publish failure (e.g. audit hook throws)
                // cannot escape to the outer resolver catch and fall through to coordinator
                // routing. The return below is unconditional — fail-closed regardless.
                try {
                  await this.bus.publish('dispatch', createMessageRejected({
                    conversationId: payload.conversationId,
                    channelId: payload.channelId,
                    senderId: payload.senderId,
                    reason: 'blocked_sender',
                    parentEventId: event.id,
                  }));
                } catch (publishErr) {
                  this.logger.error(
                    { err: publishErr, channel: payload.channelId, senderId: payload.senderId },
                    'Failed to publish blocked-sender rejection event — dropping (fail-closed)',
                  );
                }
                return;
              }

              if (policy?.unknownSender === 'hold_and_notify' && this.heldMessages) {
                try {
                  const subject = (payload.metadata as Record<string, unknown> | undefined)?.subject as string | null ?? null;
                  const heldId = await this.heldMessages.hold({
                    channel: payload.channelId,
                    senderId: payload.senderId,
                    conversationId: payload.conversationId,
                    content: payload.content,
                    subject,
                    metadata: payload.metadata ?? {},
                  });

                  await this.bus.publish('dispatch', createMessageHeld({
                    heldMessageId: heldId,
                    channel: payload.channelId,
                    senderId: payload.senderId,
                    subject,
                    parentEventId: event.id,
                  }));

                  this.logger.info(
                    { heldMessageId: heldId, channel: payload.channelId, senderId: payload.senderId, contactId: senderContext.contactId },
                    'Message held from provisional sender',
                  );
                } catch (holdErr) {
                  this.logger.error(
                    { err: holdErr, channel: payload.channelId, senderId: payload.senderId },
                    'Failed to hold provisional sender message — dropping (fail-closed)',
                  );
                }
                return;
              }

              if (policy?.unknownSender === 'reject') {
                this.logger.info(
                  { channel: payload.channelId, senderId: payload.senderId },
                  'Rejected message from provisional sender',
                );
                try {
                  await this.bus.publish('dispatch', createMessageRejected({
                    conversationId: payload.conversationId,
                    channelId: payload.channelId,
                    senderId: payload.senderId,
                    reason: 'provisional_sender',
                    parentEventId: event.id,
                  }));
                } catch (publishErr) {
                  this.logger.error(
                    { err: publishErr, channel: payload.channelId, senderId: payload.senderId },
                    'Failed to publish provisional-sender rejection event — dropping (fail-closed)',
                  );
                }
                return;
              }
            }
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
            try {
              await this.bus.publish('dispatch', createMessageRejected({
                conversationId: payload.conversationId,
                channelId: payload.channelId,
                senderId: payload.senderId,
                reason: 'unknown_sender',
                parentEventId: event.id,
              }));
            } catch (publishErr) {
              this.logger.error(
                { err: publishErr, channel: payload.channelId, senderId: payload.senderId },
                'Failed to publish unknown-sender rejection event — dropping (fail-closed)',
              );
            }
            return;
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

    // Layer 1 prompt injection scan — runs after policy gates so blocked/held
    // messages never reach the scanner. Sanitized content replaces raw content
    // before it reaches the Coordinator's LLM; risk_score is attached as metadata.
    let taskContent = payload.content;
    let injectionMetadata: Record<string, unknown> | undefined;

    if (this.injectionScanner) {
      try {
        const scan = this.injectionScanner.scan(payload.content);
        taskContent = scan.sanitizedContent;

        if (scan.riskScore > 0) {
          injectionMetadata = {
            risk_score: scan.riskScore,
            injection_findings: scan.findings,
          };
          this.logger.warn(
            {
              channelId: payload.channelId,
              senderId: payload.senderId,
              risk_score: scan.riskScore,
              findings: scan.findings.map(f => f.pattern),
            },
            'Inbound message flagged for potential prompt injection',
          );
        }
      } catch (scanErr) {
        // Fail-open: a scanner crash must not silently drop the message.
        // Log at error level (visible in monitoring) and forward the raw content
        // to the Coordinator — Layer 2 defense (role separation + system prompt
        // directives) remains active. Dropping the message here would be a worse
        // outcome than forwarding unsanitized content with Layer 2 still intact.
        // taskContent remains payload.content (set above); injectionMetadata remains undefined.
        this.logger.error(
          { err: scanErr, channelId: payload.channelId, senderId: payload.senderId },
          'Inbound scanner threw unexpectedly — forwarding raw content to coordinator (Layer 2 defense still active)',
        );
      }
    }

    const taskEvent = createAgentTask({
      agentId: 'coordinator',
      conversationId: payload.conversationId,
      channelId: payload.channelId,
      senderId: payload.senderId,
      content: taskContent,
      senderContext,
      // Merge: preserve any pre-existing inbound metadata (e.g. email subject from
      // the email adapter) and layer injection findings on top. When there are no
      // injection findings, pass through the original metadata object unchanged
      // (no copy) to avoid unnecessary allocation on the clean-message hot path.
      metadata: injectionMetadata
        ? { ...(payload.metadata ?? {}), ...injectionMetadata }
        : payload.metadata,
      parentEventId: event.id,
    });

    // Store routing info keyed by the task event ID so we can look it up
    // when the agent publishes its response (agent sets parentEventId = task.id).
    this.taskRouting.set(taskEvent.id, {
      channelId: payload.channelId,
      conversationId: payload.conversationId,
      senderId: payload.senderId,
    });

    await this.bus.publish('dispatch', taskEvent);
  }

  private async handleAgentError(event: AgentErrorEvent): Promise<void> {
    // Log the error for dispatch-layer visibility.
    // The runtime already sends an agent.response with a user-facing message,
    // so we don't need to create a separate outbound.message here.
    // The routing entry is NOT cleaned up — the agent.response handler does that.
    this.logger.warn(
      { agentId: event.payload.agentId, errorType: event.payload.errorType, source: event.payload.source },
      'Agent error reported',
    );
  }

  private async handleAgentResponse(event: AgentResponseEvent): Promise<void> {
    const routing = event.parentEventId
      ? this.taskRouting.get(event.parentEventId)
      : undefined;

    if (!routing) {
      // Expected for bullpen tasks: BullpenDispatcher publishes agent.task events with
      // channelId "bullpen", which have no routing entry here. Downgraded to debug to
      // avoid noisy warn logs in normal operation.
      this.logger.debug(
        { parentEventId: event.parentEventId },
        'No routing info for agent response — expected for bullpen tasks, skipping outbound delivery',
      );
      return;
    }

    this.taskRouting.delete(event.parentEventId!);

    // Publish outbound.message to the bus — the email adapter will pick it up
    // and route it through OutboundGateway (blocked-contact check + content filter).
    // No filter logic lives here anymore; it all runs inside the gateway.
    const outbound = createOutboundMessage({
      conversationId: routing.conversationId,
      channelId: routing.channelId,
      content: event.payload.content,
      parentEventId: event.id,
    });
    await this.bus.publish('dispatch', outbound);

    // Schedule a checkpoint for this conversation — resets the debounce timer if
    // already running, so only fires after a full window of inactivity.
    this.scheduleCheckpoint(routing.conversationId, event.payload.agentId, routing.channelId);
  }

  private scheduleCheckpoint(conversationId: string, agentId: string, channelId: string): void {
    // Checkpoint requires pool to query working_memory — if not configured, skip.
    if (!this.pool) return;

    const key = `${conversationId}:${agentId}`;
    const existing = this.checkpointTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.checkpointTimers.delete(key);
      // Fire-and-forget — errors are logged inside fireCheckpoint
      void this.fireCheckpoint(conversationId, agentId, channelId);
    }, this.conversationCheckpointDebounceMs);

    this.checkpointTimers.set(key, timer);
  }

  private async fireCheckpoint(conversationId: string, agentId: string, channelId: string): Promise<void> {
    try {
      // Look up the last watermark for this conversation+agent pair
      const watermarkResult = await this.pool!.query<{ last_checkpoint_at: string }>(
        `SELECT last_checkpoint_at FROM conversation_checkpoints
         WHERE conversation_id = $1 AND agent_id = $2`,
        [conversationId, agentId],
      );
      const since = watermarkResult.rows[0]?.last_checkpoint_at ?? '';

      // Fetch turns from working memory since the watermark. Also select created_at so
      // we can carry the newest turn's timestamp as `through` in the event payload — the
      // processor uses that exact value as the new watermark, avoiding the window between
      // the batch read and the upsert where new turns could otherwise be silently skipped.
      // Two explicit query strings rather than a conditional template fragment — avoids
      // the risk of a parameter slot ($3) drifting out of sync with the array when edited.
      // Exclude archived rows — they were summarized and their content is preserved
      // in the synthetic summary turn. Including them would feed stale/duplicate
      // turns to the relationship-extraction processor.
      const turnsQuery = since
        ? `SELECT role, content, created_at FROM working_memory
           WHERE conversation_id = $1 AND agent_id = $2
             AND role IN ('user', 'assistant') AND archived = false AND created_at > $3
           ORDER BY created_at ASC`
        : `SELECT role, content, created_at FROM working_memory
           WHERE conversation_id = $1 AND agent_id = $2
             AND role IN ('user', 'assistant') AND archived = false
           ORDER BY created_at ASC`;
      const turnsResult = await this.pool!.query<{ role: string; content: string; created_at: string }>(
        turnsQuery,
        since ? [conversationId, agentId, since] : [conversationId, agentId],
      );

      if (turnsResult.rows.length === 0) {
        // Nothing new since last checkpoint — skip publishing
        return;
      }

      const turns = turnsResult.rows.map(row => ({
        role: row.role as 'user' | 'assistant',
        content: row.content,
      }));

      // Use the last row's created_at as the batch upper bound (rows ordered ASC).
      const through = turnsResult.rows[turnsResult.rows.length - 1]!.created_at;

      const event = createConversationCheckpoint({
        conversationId,
        agentId,
        channelId,
        since,
        through,
        turns,
      });

      await this.bus.publish('dispatch', event);
      this.logger.info(
        { conversationId, agentId, turnCount: turns.length },
        'Conversation checkpoint published',
      );
    } catch (err) {
      this.logger.error({ err, conversationId, agentId }, 'Failed to fire conversation checkpoint');
    }
  }
}
