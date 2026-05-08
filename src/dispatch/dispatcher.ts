import type { EventBus } from '../bus/bus.js';
import type { InboundMessageEvent, AgentResponseEvent, AgentErrorEvent } from '../bus/events.js';
import { createAgentTask, createOutboundMessage, createContactResolved, createContactUnknown, createMessageHeld, createMessageRejected, createConversationCheckpoint } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ContactResolver } from '../contacts/contact-resolver.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { HeldMessageService } from '../contacts/held-messages.js';
import type { InboundSenderContext, ChannelPolicyConfig, TrustLevel, UnknownSenderPolicy } from '../contacts/types.js';
import type { InboundScanner } from './inbound-scanner.js';
import type { RateLimiter } from './rate-limiter.js';
import type { DbPool } from '../db/connection.js';
import { computeTrustScore, DEFAULT_TRUST_WEIGHTS } from './trust-scorer.js';
import type { TrustScorerWeights } from './trust-scorer.js';
import type { WorkingMemory } from '../memory/working-memory.js';
import { formatOutboundMemo, extractRecentMemos, buildContextPreamble } from './context-memo.js';

/** Redact a channel identifier (email address or phone number) for safe log output. */
function redactSenderId(value: string): string {
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

/**
 * Merge channel-supplied metadata with injection findings and CEO identity.
 * SECURITY: always strips `ceoInitiated` from channel-supplied metadata — that
 * flag is stamped exclusively by the dispatcher from the contact resolver result.
 * Any pre-existing value from the channel is untrusted. See ADR-017.
 */
function mergeTaskMetadata(
  channelMetadata: Record<string, unknown> | undefined,
  injectionMetadata: Record<string, unknown> | undefined,
  ceoMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!channelMetadata && !injectionMetadata && !ceoMeta) return undefined;
  return {
    ...(channelMetadata ?? {}),
    ceoInitiated: undefined,          // strip untrusted channel value
    ...(injectionMetadata ?? {}),
    ...(ceoMeta ?? {}),               // ceoMeta.ceoInitiated wins if present
  };
}

export interface DispatcherConfig {
  bus: EventBus;
  logger: Logger;
  contactResolver?: ContactResolver;
  /**
   * ContactService — used to promote or create confirmed contacts when thread-originated
   * trust is detected (Fix B). When omitted, the trust bypass still routes the message
   * to the coordinator, but no contact promotion occurs.
   */
  contactService?: ContactService;
  heldMessages?: HeldMessageService;
  channelPolicies?: Record<string, ChannelPolicyConfig>;
  /** Layer 1 prompt injection scanner. When provided, every inbound message is
   *  scanned before reaching the Coordinator — tags stripped, risk_score attached. */
  injectionScanner?: InboundScanner;
  /** Postgres pool — used to query working_memory for checkpoint turns and to check
   *  the audit_log for prior outbound messages (thread-originated trust bypass).
   *  When omitted, checkpoint scheduling and thread trust checks are disabled. */
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
  /** Contact confidence scoring pipeline. When provided, fires message_seen on
   *  every resolved inbound sender. When absent, scoring is disabled. */
  confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
  /** Working memory — used to write outbound context memos on non-threaded channels
   *  and read them back for inbound context injection. When omitted, context
   *  bridging is disabled (e.g. in unit tests that don't exercise it). */
  workingMemory?: WorkingMemory;
  /** TTL for outbound context memos in milliseconds. Memos older than this are
   *  excluded from inbound injection. Default: 86400000 (24 hours). */
  contextMemoTtlMs?: number;
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
  private contactService?: ContactService;
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
  private taskRouting = new Map<
    string,
    {
      channelId: string;
      conversationId: string;
      senderId: string;
      accountId?: string;
    }
  >();
  /** Key: `${conversationId}:${agentId}` — reset on every agent.response */
  private checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pool: DbPool | undefined;
  private conversationCheckpointDebounceMs: number;
  private maxMessageBytes: number;
  private confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
  private workingMemory?: WorkingMemory;
  private contextMemoTtlMs: number;

  constructor(config: DispatcherConfig) {
    this.bus = config.bus;
    this.logger = config.logger;
    this.contactResolver = config.contactResolver;
    this.contactService = config.contactService;
    this.heldMessages = config.heldMessages;
    this.channelPolicies = config.channelPolicies;
    this.injectionScanner = config.injectionScanner;
    this.rateLimiter = config.rateLimiter;
    this.pool = config.pool;
    this.conversationCheckpointDebounceMs = config.conversationCheckpointDebounceMs ?? 600_000;
    this.trustScorerWeights = config.trustScorerWeights ?? DEFAULT_TRUST_WEIGHTS;
    this.trustScoreFloor = config.trustScoreFloor ?? 0.2;
    this.maxMessageBytes = config.maxMessageBytes ?? 102_400;
    this.confidencePipeline = config.confidencePipeline;
    this.workingMemory = config.workingMemory;
    this.contextMemoTtlMs = config.contextMemoTtlMs ?? 86_400_000;

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

    // Resolve sender if contact resolver is available.
    // Wrapped in try/catch so DB errors degrade gracefully (no sender context)
    // rather than silently dropping the message — the task still dispatches,
    // just without enriched sender info.
    //
    // threadTrusted: set when the thread-trust bypass fires (Fix B). Used below to exempt
    // this message from the trust score floor — the contact was just promoted, so the
    // stale senderContext values must not trigger a re-hold on the same message.
    let senderContext: InboundSenderContext | undefined;
    let threadTrusted = false;
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

            // Fire-and-forget: update contact confidence for this interaction.
            // Non-blocking — the trust score for THIS message already used the
            // stored contactConfidence. This update benefits the NEXT inbound.
            // Skip blocked contacts — they are being dropped and should not accrue history.
            if (this.confidencePipeline && senderContext.status !== 'blocked') {
              const resolvedContactId = senderContext.contactId;
              this.confidencePipeline.incrementalUpdate(resolvedContactId, { type: 'message_seen' })
                .catch(err => this.logger.warn({ err, contactId: resolvedContactId }, 'Confidence pipeline update failed (non-fatal)'));
            }

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
                // Belt-and-suspenders: before holding, check whether Curia previously sent
                // an outbound to this exact address in this conversation. If so, the sender
                // is implicitly trusted — promote their contact and route normally.
                // Fix A (outbound-gateway) covers most cases; this catches the edge case
                // where Fix A didn't run (e.g. DB error at send time, or historical sends
                // before Fix A was deployed).
                if (await this.hasOutboundToRecipientInConversation(payload.conversationId, payload.senderId)) {
                  this.logger.info(
                    { channel: payload.channelId, senderId: payload.senderId, contactId: senderContext.contactId, conversationId: payload.conversationId },
                    'Dispatcher: thread-originated trust detected for provisional sender — promoting and routing to coordinator',
                  );
                  await this.promoteToConfirmedByThreadTrust(payload.channelId, payload.senderId, senderContext.contactId);
                  // Exempt this message from the trust score floor below — senderContext still
                  // holds the pre-promotion values (stale contactConfidence/trustLevel), so without
                  // this flag the floor check would re-hold the very message we just decided to route.
                  threadTrusted = true;
                  // Fall through to normal coordinator routing below.
                } else {
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
          // Channel trust levels are loaded from channel-trust.yaml and validated to 'low' | 'medium' | 'high'.
          // 'ceo' is a contact-level trust level only — channels themselves are never ceo-trust.
          const prelimChannelTrust = (this.channelPolicies?.[payload.channelId]?.trust ?? 'low') as 'low' | 'medium' | 'high';
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
            // Belt-and-suspenders: before holding, check whether Curia previously sent
            // an outbound to this exact address in this conversation. If so, the sender
            // is implicitly trusted — promote them and route normally.
            if (await this.hasOutboundToRecipientInConversation(payload.conversationId, payload.senderId)) {
              this.logger.info(
                { channel: payload.channelId, senderId: payload.senderId, conversationId: payload.conversationId },
                'Dispatcher: thread-originated trust detected for unknown sender — promoting and routing to coordinator',
              );
              await this.promoteToConfirmedByThreadTrust(payload.channelId, payload.senderId, undefined);
              // Same stale-context exemption as the provisional path above.
              threadTrusted = true;
              // Fall through to normal coordinator routing below.
            } else {
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

    // Inbound context injection for non-threaded channels.
    // Placed AFTER the injection scanner so the preamble (system-generated content)
    // wraps the already-sanitized user content and is not itself scanned or overwritten.
    // Best-effort: failure is logged but does not block message routing.
    const inboundPolicy = this.channelPolicies?.[payload.channelId];
    if (this.workingMemory && inboundPolicy && !inboundPolicy.threaded) {
      try {
        const history = await this.workingMemory.getHistory(
          payload.conversationId, 'coordinator',
        );
        const recentMemos = extractRecentMemos(history, this.contextMemoTtlMs);
        const preamble = buildContextPreamble(recentMemos, taskContent);
        if (preamble !== null) {
          taskContent = preamble;
          this.logger.debug(
            { channelId: payload.channelId, conversationId: payload.conversationId, memoCount: recentMemos.length },
            'Injected outbound context preamble into task content',
          );
        }
      } catch (err) {
        this.logger.warn(
          { err, channelId: payload.channelId, conversationId: payload.conversationId },
          'Failed to read outbound context memos — proceeding without context injection',
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
      // Confirmed contacts are exempt: a contact with status='confirmed' has passed explicit CEO
      // approval and should route unconditionally regardless of contact_confidence. The floor is
      // designed for unknown or provisional senders, not explicitly approved contacts. Provisional
      // contacts still go through the floor check.
      const policy = this.channelPolicies[payload.channelId];
      if (
        !threadTrusted &&
        !(senderContext?.resolved && senderContext.status === 'confirmed') &&
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

    // CC role marker: when the email adapter determined that Curia was CC'd rather than
    // directly addressed, prepend a context block so the coordinator knows it was an
    // observer on this email (e.g. the CEO looping Curia in on a message to a third party).
    if (payload.channelId === 'email') {
      const meta = payload.metadata as Record<string, unknown> | undefined;
      const curiaRole = meta?.curiaRole as string | undefined;
      if (curiaRole === 'cc') {
        // Runtime type guard — metadata values cross a Record<string, unknown> boundary,
        // so a bare `as string[]` cast could silently accept a non-array from a future
        // code path. Mirrors the isFinite guard on injectionRiskScore above.
        const rawRecipients = meta?.primaryRecipientEmails;
        const primaryRecipients = Array.isArray(rawRecipients) ? (rawRecipients as string[]) : [];
        // Sanitize each address before interpolation — primaryRecipientEmails comes from
        // the Nylas To-field (attacker-controlled) and is injected into taskContent AFTER
        // the injection scanner has already run on payload.content. Without sanitization,
        // a crafted email address could embed prompt injection patterns that bypass Layer 1.
        // RFC 5321 limits email addresses to 254 characters; anything longer is malformed.
        const MAX_RECIPIENTS_IN_PREAMBLE = 10;
        const sanitizedRecipients = primaryRecipients
          .map((addr) => String(addr).replace(/[\n\r\[\]<>]/g, '').trim().slice(0, 254))
          .filter((addr) => addr.length > 0)
          .slice(0, MAX_RECIPIENTS_IN_PREAMBLE);
        const omittedCount = Math.max(0, primaryRecipients.length - sanitizedRecipients.length);
        const recipientListBase = sanitizedRecipients.length > 0
          ? sanitizedRecipients.join(', ')
          : 'unknown recipients';
        const recipientList = omittedCount > 0
          ? `${recipientListBase}, +${omittedCount} more`
          : recipientListBase;
        // Extract the Nylas message ID from metadata so the coordinator can pass it
        // to email-reply to thread a response from Curia's own account.
        // Sanitize for the same reason as recipient addresses above — this value
        // comes from Nylas and is interpolated into the task preamble after the
        // injection scanner has run on payload.content.
        const rawNylasMessageId = meta?.nylasMessageId;
        let nylasMessageId: string | undefined;
        if (typeof rawNylasMessageId === 'string' && rawNylasMessageId.trim()) {
          const sanitized = rawNylasMessageId.replace(/[\n\r\[\]<>]/g, '').trim().slice(0, 200);
          if (sanitized.length === 0) {
            // Non-empty raw value collapsed to empty after sanitization — structurally
            // suspicious (e.g. a message ID composed entirely of stripped characters).
            // Omit from preamble and warn so operators have an audit trail.
            // rawNylasMessageId is deliberately excluded from the log — it may be attacker-controlled.
            this.logger.warn(
              { channelId: payload.channelId, conversationId: payload.conversationId },
              'CC preamble: nylasMessageId was non-empty but sanitized to empty — omitting Message ID from preamble',
            );
          } else {
            nylasMessageId = sanitized;
          }
        } else {
          // nylasMessageId absent or non-string — warn so operators can diagnose
          // a coordinator that falls back to email-draft-save due to missing Message ID.
          this.logger.warn(
            {
              channelId: payload.channelId,
              conversationId: payload.conversationId,
              senderId: redactSenderId(payload.senderId),
              rawType: typeof rawNylasMessageId,
            },
            'CC preamble: nylasMessageId absent or invalid — Message ID omitted; coordinator may fall back to email-draft-save',
          );
        }

        this.logger.info(
          { channelId: payload.channelId, senderId: payload.senderId, primaryRecipients: recipientList },
          'CC role preamble injected — Curia was not the primary recipient',
        );
        // Include Message ID and Account so the coordinator can call email-reply
        // with the correct message ID.
        // Without these identifiers the coordinator cannot use email-reply and falls back
        // to email-draft-save, where it has historically chosen the wrong account (CEO's).
        const ccIdentifierBlock = nylasMessageId
          ? `Message ID: ${nylasMessageId}\nAccount: ${payload.accountId ?? 'curia'}\n\n`
          : `Account: ${payload.accountId ?? 'curia'}\n\n`;
        taskContent =
          `[OWNER CC — this email was addressed to ${recipientList}; you were CC'd, not the primary recipient]\n` +
          ccIdentifierBlock +
          taskContent;
      }
    }

    // Stamp ceoInitiated when the sender is the CEO directly.
    // This flag is the hard gate in CEO-authorized skills (e.g. send-draft).
    // See ADR-017 for the full security reasoning.
    // Use `resolved` discriminant to narrow InboundSenderContext to SenderContext before
    // accessing `.role`, which does not exist on UnknownSenderContext.
    const ceoMeta = senderContext?.resolved && senderContext.role === 'ceo'
      ? { ceoInitiated: true as const, senderId: payload.senderId, channelId: payload.channelId }
      : undefined;

    const taskEvent = createAgentTask({
      agentId: 'coordinator',
      conversationId: payload.conversationId,
      channelId: payload.channelId,
      accountId: payload.accountId,
      senderId: payload.senderId,
      content: taskContent,
      senderContext,
      messageTrustScore,
      // SECURITY: always strip ceoInitiated from channel-supplied metadata —
      // it is stamped exclusively by this function from the contact resolver.
      // A crafted inbound with { ceoInitiated: true } must never propagate.
      // See ADR-017.
      metadata: mergeTaskMetadata(
        payload.metadata as Record<string, unknown> | undefined,
        injectionMetadata,
        ceoMeta,
      ),
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
      // senderId is the person we're replying to — record it as recipientId so the
      // dispatcher can later verify thread-originated trust when their reply arrives.
      recipientId: routing.senderId,
      parentEventId: event.id,
      // The agent.response's parentEventId is the agent.task that triggered it — thread
      // this through so the email adapter can pass it to gateway.send() for action_log context.
      taskEventId: event.parentEventId ?? undefined,
    });
    await this.bus.publish('dispatch', outbound);

    // Write an outbound context memo to working memory for non-threaded channels.
    // When the user replies, the inbound handler reads these memos and prepends
    // them to the coordinator's task content so it knows what it last said.
    // Best-effort: failure is logged but does not block outbound delivery.
    const channelPolicy = this.channelPolicies?.[routing.channelId];
    if (this.workingMemory && channelPolicy && !channelPolicy.threaded) {
      try {
        const memo = formatOutboundMemo({
          conversationId: routing.conversationId,
          content: event.payload.content,
          taskEventId: event.parentEventId ?? undefined,
        });
        await this.workingMemory.addTurn(routing.conversationId, 'coordinator', {
          role: 'system',
          content: memo,
        });
        this.logger.debug(
          { channelId: routing.channelId, conversationId: routing.conversationId },
          'Outbound context memo written to working memory',
        );
      } catch (err) {
        this.logger.warn(
          { err, channelId: routing.channelId, conversationId: routing.conversationId },
          'Failed to write outbound context memo — context bridging degraded for this message',
        );
      }
    }

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

  /**
   * Check whether Curia has previously sent an outbound message to `senderId` in
   * `conversationId`. Used to detect thread-originated trust: if the CEO directed Curia
   * to email someone and they reply on the same thread, the reply should not be held even
   * if the contact is still provisional or unknown in the contact book.
   *
   * The recipient filter (`payload->>'recipientId'`) is essential for security: without it,
   * a forwarding attack is possible — Person1 receives our email, forwards to Person2 who
   * replies on the same thread, and Person2 bypasses the hold without ever being emailed
   * by Curia directly.
   *
   * Returns false (safe default — hold the message) if:
   *   - pool is not configured
   *   - conversationId is empty
   *   - the DB query fails
   */
  private async hasOutboundToRecipientInConversation(
    conversationId: string,
    senderId: string,
  ): Promise<boolean> {
    if (!this.pool || !conversationId) return false;

    try {
      const result = await this.pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM audit_log
           WHERE event_type = 'outbound.message'
             AND conversation_id = $1
             AND payload->>'recipientId' = $2
         ) AS exists`,
        [conversationId, senderId],
      );
      return result.rows[0]?.exists ?? false;
    } catch (err) {
      // Fail-closed: if the DB is unavailable, default to holding the message.
      // Returning false causes the caller to apply the normal hold policy, which is
      // the safe choice — an unexpected hold is recoverable, but silently bypassing
      // the hold policy on a DB error would be a security regression.
      this.logger.warn(
        { err, conversationId, senderId: redactSenderId(senderId) },
        'Dispatcher: audit_log thread-trust check failed — proceeding with normal hold policy',
      );
      return false;
    }
  }

  /**
   * Promote a sender's contact to confirmed status when thread-originated trust is detected.
   * Called by both the provisional-sender and unknown-sender hold paths when we find a prior
   * outbound to this person in the same conversation.
   *
   * - If the contact has a contactId (provisional): calls setStatus(confirmed).
   * - If no contactId (unknown sender): creates a new confirmed contact with the channel
   *   identifier as a placeholder display name.
   * - Fails silently on error — the message will still be routed to the coordinator even
   *   if the promotion fails.
   */
  private async promoteToConfirmedByThreadTrust(
    channelId: string,
    senderId: string,
    contactId: string | undefined,
  ): Promise<void> {
    if (!this.contactService) return;

    if (contactId) {
      try {
        await this.contactService.setStatus(contactId, 'confirmed');
        this.logger.info(
          { channelId, contactId },
          'Dispatcher: promoted provisional contact to confirmed via thread-originated trust',
        );
      } catch (err) {
        this.logger.warn(
          { err, channelId, contactId, senderId: redactSenderId(senderId) },
          'Dispatcher: setStatus failed during thread-trust promotion — message will still route to coordinator',
        );
      }
      // Set trustLevel: 'high' so future inbounds from this contact score above the trust floor.
      // Failure is non-fatal: the status promotion already took effect; warn so it's visible.
      try {
        await this.contactService.setTrustLevel(contactId, 'high');
      } catch (err) {
        this.logger.warn(
          { err, channelId, contactId, senderId: redactSenderId(senderId) },
          'Dispatcher: setTrustLevel failed after thread-trust promotion — future messages may still fall below trust floor',
        );
      }
      return;
    }

    // Unknown sender — create a confirmed contact so future messages are not held.
    let created;
    try {
      created = await this.contactService.createContact({
        displayName: senderId,
        fallbackDisplayName: senderId,
        status: 'confirmed',
        source: 'ceo_stated',
      });
    } catch (err) {
      this.logger.warn(
        { err, channelId, senderId: redactSenderId(senderId) },
        'Dispatcher: createContact failed during thread-trust promotion — message will still route to coordinator',
      );
      return;
    }

    try {
      await this.contactService.linkIdentity({
        contactId: created.id,
        channel: channelId,
        channelIdentifier: senderId,
        source: 'ceo_stated',
      });
      this.logger.info(
        { channelId, contactId: created.id },
        'Dispatcher: created confirmed contact for unknown sender via thread-originated trust',
      );
    } catch (err) {
      // createContact committed but linkIdentity failed — orphaned confirmed contact with no
      // channel identity. Future lookups will still return null, so the thread-trust check
      // will re-attempt creation. Log at error so an operator can clean up the orphaned row.
      // TODO: once ContactService exposes a deleteContact or transactional create-with-identity
      // helper, use it here to avoid the orphan.
      this.logger.error(
        { err, channelId, senderId: redactSenderId(senderId), orphanedContactId: created.id },
        'Dispatcher: linkIdentity failed after createContact during thread-trust promotion — orphaned confirmed contact exists; manual cleanup may be needed',
      );
      return;
    }

    // Set trustLevel: 'high' so future inbounds score above the trust floor.
    // Failure is non-fatal: the contact was created and linked; warn so it's visible.
    try {
      await this.contactService.setTrustLevel(created.id, 'high');
    } catch (err) {
      this.logger.warn(
        { err, channelId, contactId: created.id, senderId: redactSenderId(senderId) },
        'Dispatcher: setTrustLevel failed after thread-trust contact creation — future messages may still fall below trust floor',
      );
    }
  }
}
