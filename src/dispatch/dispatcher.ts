import type { EventBus } from '../bus/bus.js';
import type { InboundMessageEvent, AgentResponseEvent, AgentErrorEvent } from '../bus/events.js';
import { createAgentTask, createOutboundMessage, createContactResolved, createContactUnknown, createMessageHeld, createMessageRejected, createConversationCheckpoint } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ContactResolver } from '../contacts/contact-resolver.js';
import type { HeldMessageService } from '../contacts/held-messages.js';
import type { InboundSenderContext, ChannelPolicyConfig, TrustLevel, UnknownSenderPolicy } from '../contacts/types.js';
import type { InboundScanner } from './inbound-scanner.js';
import type { RateLimiter } from './rate-limiter.js';
import type { DbPool } from '../db/connection.js';
import { computeTrustScore, DEFAULT_TRUST_WEIGHTS } from './trust-scorer.js';
import type { TrustScorerWeights } from './trust-scorer.js';

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
  /** Weights for messageTrustScore computation. Defaults to DEFAULT_TRUST_WEIGHTS if omitted. */
  trustScorerWeights?: TrustScorerWeights;
  /** Messages scoring below this floor trigger hold_and_notify regardless of per-channel policy
   *  (unless channel is 'ignore'). Default: 0.2 */
  trustScoreFloor?: number;
  /** In-memory rate limiter. When provided, enforces global and per-sender message rate limits.
   *  When omitted, rate limiting is disabled (e.g. in unit tests that don't exercise it). */
  rateLimiter?: RateLimiter;
  /** Maximum inbound message content size in bytes. Messages exceeding this are
   *  rejected before routing. Default: 102400 (100KB). */
  maxMessageBytes?: number;
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
  private rateLimiter?: RateLimiter;
  private trustScorerWeights: TrustScorerWeights;
  private trustScoreFloor: number;
  /**
   * Maps agent.task event ID → channel routing info.
   * When the agent publishes agent.response (with parentEventId pointing to the task),
   * we look up where to send the outbound message.
   *
   * We key on the task event ID (not the inbound message ID) because the agent
   * runtime sets parentEventId on its response to the task event that triggered it.
   */
  private taskRouting = new Map<string, { channelId: string; conversationId: string; senderId: string; accountId?: string }>();
  /** Key: `${conversationId}:${agentId}` — reset on every agent.response */
  private checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pool: DbPool | undefined;
  private conversationCheckpointDebounceMs: number;
  private maxMessageBytes: number;

  constructor(config: DispatcherConfig) {
    this.bus = config.bus;
    this.logger = config.logger;
    this.contactResolver = config.contactResolver;
    this.heldMessages = config.heldMessages;
    this.channelPolicies = config.channelPolicies;
    this.injectionScanner = config.injectionScanner;
    this.rateLimiter = config.rateLimiter;
    this.pool = config.pool;
    this.conversationCheckpointDebounceMs = config.conversationCheckpointDebounceMs ?? 600_000;
    this.trustScorerWeights = config.trustScorerWeights ?? DEFAULT_TRUST_WEIGHTS;
    this.trustScoreFloor = config.trustScoreFloor ?? 0.2;
    this.maxMessageBytes = config.maxMessageBytes ?? 102_400;

    // Warn if the trust floor is active but no held-message service was provided — the floor
    // silently becomes a no-op in that case, which is a security-relevant degradation.
    if (this.trustScoreFloor > 0 && !this.heldMessages) {
      this.logger.warn(
        { trustScoreFloor: this.trustScoreFloor },
        'Dispatcher: trustScoreFloor is configured but heldMessages service is not available — floor enforcement is disabled',
      );
    }
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

    // Reject oversized messages before any processing — no routing, no contact
    // lookup, no LLM cost. The inbound.message event is already in the audit log
    // (write-ahead); this rejection creates a causal chain via parentEventId.
    const contentByteSize = Buffer.byteLength(payload.content, 'utf-8');
    if (contentByteSize > this.maxMessageBytes) {
      this.logger.warn(
        { channelId: payload.channelId, senderId: payload.senderId, contentByteSize, maxBytes: this.maxMessageBytes },
        'Inbound message exceeded size limit — rejected',
      );
      await this.bus.publish('dispatch', createMessageRejected({
        conversationId: payload.conversationId,
        channelId: payload.channelId,
        senderId: payload.senderId,
        reason: 'message_too_large',
        size: contentByteSize,
        limit: this.maxMessageBytes,
        parentEventId: event.id,
      }));
      return;
    }

    this.logger.info(
      { channelId: payload.channelId, senderId: payload.senderId },
      'Dispatching to coordinator',
    );

    // Global rate limit — checked before any policy-gate processing so that aggregate
    // flooding (e.g. a DoS attack across many senders) is stopped as early as possible.
    // Intentionally fail-open: if publish throws, we log and still drop the message.
    if (this.rateLimiter && !this.rateLimiter.checkGlobal()) {
      this.logger.warn(
        { channelId: payload.channelId, senderId: payload.senderId },
        'Global rate limit exceeded — dropping message',
      );
      try {
        await this.bus.publish('dispatch', createMessageRejected({
          conversationId: payload.conversationId,
          channelId: payload.channelId,
          senderId: payload.senderId,
          reason: 'global_rate_limited',
          parentEventId: event.id,
        }));
      } catch (publishErr) {
        this.logger.error(
          { err: publishErr, channelId: payload.channelId, senderId: payload.senderId },
          'Failed to publish global-rate-limit rejection event — dropping (fail-closed)',
        );
      }
      return;
    }

    // Observation-mode messages originate from a monitored inbox (e.g. the CEO's
    // personal email) where Curia is an observer, not the recipient. Senders are
    // third parties emailing the CEO — they should not enter the contact trust flow,
    // be held, or have provisional contact records created on their behalf. Route
    // directly to the coordinator (with no senderContext) so it can surface the
    // email to the CEO as an observation.
    // Rate limiting and injection scanning still run below — those protections apply
    // regardless of how the message is routed.
    const isObservationMode = (payload.metadata as Record<string, unknown> | undefined)?.observationMode === true;
    if (isObservationMode) {
      this.logger.info(
        { channelId: payload.channelId, senderId: payload.senderId, accountId: payload.accountId },
        'Observation-mode email — bypassing contact trust flow, routing to coordinator',
      );
    }

    // Resolve sender if contact resolver is available.
    // Wrapped in try/catch so DB errors degrade gracefully (no sender context)
    // rather than silently dropping the message — the task still dispatches,
    // just without enriched sender info.
    let senderContext: InboundSenderContext | undefined;
    if (this.contactResolver && !isObservationMode) {
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

              if (policy?.unknownSender === 'ignore') {
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
          // Unknown sender — determine routing decision first so the audit event is self-contained.
          // Compute a preliminary trust score (injection risk not yet available — the unknown-sender
          // branch returns early before the scanner runs).
          const prelimChannelTrust = (this.channelPolicies?.[payload.channelId]?.trust ?? 'low') as TrustLevel;
          const prelimScore = computeTrustScore({
            channelTrustLevel: prelimChannelTrust,
            contactConfidence: 0.0,  // unknown sender has no confidence
            injectionRiskScore: 0,
            trustLevel: null,
            weights: this.trustScorerWeights,
          });

          const policy = this.channelPolicies?.[payload.channelId];

          // Routing decision reflects the configured policy intent. When hold_and_notify is
          // configured but heldMessages is not wired, the decision still says 'hold_and_notify'
          // so the audit trail is accurate — execution may degrade but the intent is recorded.
          const routingDecision: UnknownSenderPolicy =
            policy?.unknownSender === 'hold_and_notify' ? 'hold_and_notify'
            : policy?.unknownSender === 'ignore' ? 'ignore'
            : 'allow';

          // Wrapped in its own try/catch so a publish failure (e.g. audit hook throws)
          // cannot escape to the outer resolver catch and fall through to normal routing —
          // which would bypass the hold/ignore policy. Fail-closed: drop the message.
          try {
            await this.bus.publish('dispatch', createContactUnknown({
              channel: senderContext.channel,
              senderId: senderContext.senderId,
              channelTrustLevel: prelimChannelTrust,
              messageTrustScore: prelimScore,
              routingDecision,
              parentEventId: event.id,
            }));
          } catch (publishErr) {
            this.logger.error(
              { err: publishErr, channel: payload.channelId, senderId: payload.senderId },
              'Failed to publish contact.unknown event — dropping message (fail-closed)',
            );
            return;
          }

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

          if (policy?.unknownSender === 'ignore') {
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

    // Per-sender rate limit — checked after policy gates so blocked/held senders
    // (already dropped above) don't consume quota for legitimate senders.
    // Uses the raw senderId from the inbound payload — no stable contactId needed
    // because unknown senders are more likely to flood from a single address, and
    // the global limit covers multi-address abuse.
    //
    // Note: the global counter above was already incremented for this message. If the
    // per-sender check drops it here, the global quota is still consumed. This is
    // intentional: global tracks message arrivals at the dispatch layer (a DoS signal),
    // not messages that survive both checks and reach the coordinator.
    if (this.rateLimiter && !this.rateLimiter.checkSender(payload.senderId)) {
      this.logger.warn(
        { channelId: payload.channelId, senderId: payload.senderId },
        'Per-sender rate limit exceeded — dropping message',
      );
      try {
        await this.bus.publish('dispatch', createMessageRejected({
          conversationId: payload.conversationId,
          channelId: payload.channelId,
          senderId: payload.senderId,
          reason: 'sender_rate_limited',
          parentEventId: event.id,
        }));
      } catch (publishErr) {
        this.logger.error(
          { err: publishErr, channelId: payload.channelId, senderId: payload.senderId },
          'Failed to publish sender-rate-limit rejection event — dropping (fail-closed)',
        );
      }
      return;
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

    // Compute messageTrustScore from channel trust, contact confidence, and injection risk.
    // contactConfidence: from resolved sender context (0.0 for unknown senders)
    // channelTrustLevel: from channel policy config (default 'low' if not configured)
    // trustLevel override: per-contact field from DB (null means use channel default)
    let messageTrustScore: number | undefined;
    if (this.channelPolicies) {
      const channelTrust = (this.channelPolicies[payload.channelId]?.trust ?? 'low') as TrustLevel;
      const contactConfidence =
        senderContext?.resolved ? senderContext.contactConfidence : 0.0;
      const trustLevelOverride =
        senderContext?.resolved ? senderContext.trustLevel : null;
      // Validate the injection risk score before use — a non-finite value (NaN, ±Infinity)
      // from a buggy scanner implementation would propagate through the formula and silently
      // produce a NaN trust score, which bypasses the floor check (NaN < floor = false).
      const rawRiskScore = injectionMetadata?.risk_score;
      const injectionRiskScore =
        typeof rawRiskScore === 'number' && isFinite(rawRiskScore) ? rawRiskScore : 0;
      if (rawRiskScore !== undefined && injectionRiskScore !== rawRiskScore) {
        this.logger.error(
          { rawRiskScore, channelId: payload.channelId },
          'Injection scanner returned non-finite risk score — defaulting to 0',
        );
      }

      messageTrustScore = computeTrustScore({
        channelTrustLevel: channelTrust,
        contactConfidence,
        injectionRiskScore,
        trustLevel: trustLevelOverride,
        weights: this.trustScorerWeights,
      });

      // Trust floor: if score is below the floor, apply hold_and_notify unless channel is 'ignore'.
      // This overrides per-channel 'allow' policies for very low-trust messages — including unknown
      // senders on 'allow' channels. Unknown senders on 'hold_and_notify' and 'ignore' channels
      // already returned early above, so there is no risk of double-holding here.
      //
      // Observation-mode messages bypass the floor: we already skipped the contact-resolver path
      // (isObservationMode check above), so senderContext is undefined and contactConfidence is 0.
      // Without the bypass, observation-mode emails would always fall below the 0.2 floor and get
      // silently held — making the entire observation-mode feature non-functional in production.
      const policy = this.channelPolicies[payload.channelId];
      if (
        !isObservationMode &&
        messageTrustScore < this.trustScoreFloor &&
        policy?.unknownSender !== 'ignore' &&
        this.heldMessages
      ) {
        this.logger.warn(
          { channelId: payload.channelId, senderId: payload.senderId, messageTrustScore, floor: this.trustScoreFloor },
          'Message trust score below floor — holding regardless of channel policy',
        );
        const subject = (payload.metadata as Record<string, unknown> | undefined)?.subject as string | null ?? null;
        let held = false;
        try {
          const heldId = await this.heldMessages.hold({
            channel: payload.channelId,
            senderId: payload.senderId,
            conversationId: payload.conversationId,
            content: payload.content,
            subject,
            metadata: payload.metadata ?? {},
          });
          held = true; // hold succeeded — message is now in held_messages; must not reach coordinator
          // Publish the audit event separately. A failure here does not un-hold the message,
          // so we catch it independently and never fall through to the coordinator.
          try {
            await this.bus.publish('dispatch', createMessageHeld({
              heldMessageId: heldId,
              channel: payload.channelId,
              senderId: payload.senderId,
              subject,
              parentEventId: event.id,
            }));
          } catch (publishErr) {
            this.logger.error(
              { err: publishErr, channelId: payload.channelId, senderId: payload.senderId, heldMessageId: heldId },
              'Failed to publish message.held audit event — message is held but CEO notification may be delayed',
            );
          }
        } catch (holdErr) {
          this.logger.error(
            { err: holdErr, channelId: payload.channelId, senderId: payload.senderId },
            'Failed to hold low-trust message — proceeding to coordinator (fail-open for trust floor)',
          );
          // Fail-open for trust floor only: unlike the unknown-sender security gate,
          // a low-trust score from a known contact should not silently drop the message.
          // The coordinator still receives it with the low score visible.
        }
        // Always return if the hold succeeded — a publish failure is not a reason to forward to the coordinator.
        if (held) return;
      }
    }

    // Observation-mode preamble: prepend an explicit directive so the coordinator
    // LLM cannot miss the context. Relying solely on the system prompt was
    // insufficient — in testing the model replied as itself rather than
    // summarising. The preamble is injected after the injection scanner so it
    // is never treated as potentially hostile user content.
    // The preamble also injects the 4-way triage protocol and surfaces identifiers
    // (nylasMessageId, accountId) so the coordinator can call skills like email-archive.
    if (isObservationMode) {
      // Extract identifiers needed for skill calls (e.g. email-archive) from payload metadata.
      const nylasMessageId = (payload.metadata as Record<string, unknown> | undefined)?.nylasMessageId as string | undefined;
      const observingAccountId = payload.accountId;

      // Always include Account so the coordinator knows which mailbox to act on.
      // Message ID is only present when the email adapter has surfaced it via metadata.
      const identifierBlock = nylasMessageId
        ? `Message ID: ${nylasMessageId}\nAccount: ${observingAccountId ?? 'primary'}\n\n`
        : `Account: ${observingAccountId ?? 'primary'}\n\n`;

      taskContent =
        `[OBSERVATION MODE — monitored inbox]\n` +
        `This email arrived in a monitored inbox. You watch it on the CEO's behalf.\n` +
        `You are NOT the recipient. NEVER reply to the sender as yourself or sign with your name.\n\n` +
        identifierBlock +
        `TRIAGE — evaluate in order:\n\n` +
        `1. STANDING INSTRUCTIONS: use entity-context to look up the sender. If the CEO has\n` +
        `   given you a standing instruction for this sender or email type, follow it.\n\n` +
        `2. CLASSIFY and act:\n` +
        `   - URGENT — time-sensitive, requires CEO decision, from a known contact:\n` +
        `     Send the CEO a message on a high-urgency channel (e.g. Signal): sender, subject,\n` +
        `     one-sentence summary, key ask. Do NOT reply to the sender.\n` +
        `   - ACTIONABLE — calendar booking, add attendee, change location, clear task:\n` +
        `     Do it using your existing skills. No notification. It will appear in the weekly log.\n` +
        `   - NEEDS DRAFT — a reply is warranted and you can write it:\n` +
        `     Save a draft with email-reply. The CEO will review before it sends.\n` +
        `   - NOISE — receipt, newsletter, automated notification, no action needed:\n` +
        `     Call email-archive. No notification.\n\n` +
        `3. WHEN IN DOUBT: default to URGENT (notify) rather than acting silently.\n` +
        `   It is better to surface something than to quietly act on it incorrectly.\n\n` +
        `--- Original message ---\n` +
        taskContent;
    }

    const taskEvent = createAgentTask({
      agentId: 'coordinator',
      conversationId: payload.conversationId,
      channelId: payload.channelId,
      accountId: payload.accountId,
      senderId: payload.senderId,
      content: taskContent,
      senderContext,
      messageTrustScore,
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
    // accountId is stored so the outbound.message is routed to the same email account
    // that received the original inbound message.
    this.taskRouting.set(taskEvent.id, {
      channelId: payload.channelId,
      conversationId: payload.conversationId,
      senderId: payload.senderId,
      accountId: payload.accountId,
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
      accountId: routing.accountId,
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
