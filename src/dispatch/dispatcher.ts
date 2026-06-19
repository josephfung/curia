import type { EventBus } from '../bus/bus.js';
import type { InboundMessageEvent, AgentResponseEvent, AgentErrorEvent, SkillResultEvent } from '../bus/events.js';
import { createAgentTask, createOutboundMessage, createOutboundSuppressedDuplicate, createContactResolved, createContactUnknown, createMessageRejected, createConversationCheckpoint } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ContactResolver } from '../contacts/contact-resolver.js';
import type { InboundSenderContext, ChannelPolicyConfig, TrustLevel, UnknownSenderPolicy, TaskOriginator } from '../contacts/types.js';
import { isAutomatedKind } from '../contacts/types.js';
import { JUDGMENT_ELEVATION_THRESHOLD } from '../contacts/confidence-scorer.js';
import type { InboundScanner } from './inbound-scanner.js';
import type { RateLimiter } from './rate-limiter.js';
import type { DbPool } from '../db/connection.js';
import { computeTrustScore, DEFAULT_TRUST_WEIGHTS } from './trust-scorer.js';
import type { TrustScorerWeights } from './trust-scorer.js';
import { parseEmailMetadata, sanitizeNylasMessageId, buildCcPreamble, buildThreadParticipantsBlock } from './email-metadata.js';

/** Redact a channel identifier (email address or phone number) for safe log output. */
function redactSenderId(value: string): string {
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

/**
 * Merge channel-supplied metadata with injection findings and originator context.
 * SECURITY: strips both `ceoInitiated` (legacy) and `originator` after all untrusted
 * spreads — so neither channel metadata nor injection metadata can smuggle a forged
 * originator. The trusted `originatorMeta` spread wins last.
 */
function mergeTaskMetadata(
  channelMetadata: Record<string, unknown> | undefined,
  injectionMetadata: Record<string, unknown> | undefined,
  originatorMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!channelMetadata && !injectionMetadata && !originatorMeta) return undefined;
  return {
    ...(channelMetadata ?? {}),
    ...(injectionMetadata ?? {}),
    ceoInitiated: undefined,          // strip legacy untrusted channel value (after all untrusted spreads)
    originator: undefined,            // strip untrusted channel value (after all untrusted spreads)
    ...(originatorMeta ?? {}),        // trusted stamp wins last
  };
}

export interface DispatcherConfig {
  bus: EventBus;
  logger: Logger;
  contactResolver?: ContactResolver;
  channelPolicies?: Record<string, ChannelPolicyConfig>;
  /** Layer 1 prompt injection scanner. When provided, every inbound message is
   *  scanned before reaching the Coordinator — tags stripped, risk_score attached. */
  injectionScanner?: InboundScanner;
  /** Postgres pool — used to query working_memory for checkpoint turns. */
  pool?: DbPool;
  /** Milliseconds of inactivity before conversation.checkpoint fires. Default: 600000. */
  conversationCheckpointDebounceMs?: number;
  /** Weights for messageTrustScore computation. Defaults to DEFAULT_TRUST_WEIGHTS if omitted. */
  trustScorerWeights?: TrustScorerWeights;
  /** In-memory rate limiter. When provided, enforces global and per-sender message rate limits.
   *  When omitted, rate limiting is disabled (e.g. in unit tests that don't exercise it). */
  rateLimiter?: RateLimiter;
  /** Maximum inbound message content size in bytes. Messages exceeding this are
   *  rejected before routing. Default: 102400 (100KB). */
  maxMessageBytes?: number;
  /** Contact confidence scoring pipeline. When provided, fires message_seen on
   *  every resolved inbound sender. When absent, scoring is disabled. */
  confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
  /** Curia's own email address — used to substitute "you" for Curia's address
   *  in thread-participants blocks (PR1-D). */
  selfEmail?: string;
  /** Outbound context service — v2 context bridging. When present, replaces
   *  the working-memory-based context memo injection. */
  outboundContextService?: import('./outbound-context.js').OutboundContextService;
  /** Contact service for automatic tier elevation (issue #951).
   *  When absent, all elevation paths are silently skipped. */
  contactService?: import('../contacts/contact-service.js').ContactService;
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
  private channelPolicies?: Record<string, ChannelPolicyConfig>;
  private injectionScanner?: InboundScanner;
  private rateLimiter?: RateLimiter;
  private trustScorerWeights: TrustScorerWeights;
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
      /** Set to true when a human-facing reply skill (email-reply, email-send) succeeds
       *  during this task. handleAgentResponse suppresses outbound.message when true. */
      humanReplySent: boolean;
    }
  >();
  /** Key: `${conversationId}:${agentId}` — reset on every agent.response */
  private checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pool: DbPool | undefined;
  private conversationCheckpointDebounceMs: number;
  private maxMessageBytes: number;
  private confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
  /** Curia's own email address — used in thread-participants substitution (PR1-D). */
  private selfEmail?: string;
  /** Outbound context service — v2 context bridging (replaces working-memory memo read path). */
  private _outboundContextService?: import('./outbound-context.js').OutboundContextService;
  /** Contact service for automatic tier elevation (issue #951). */
  private contactService?: import('../contacts/contact-service.js').ContactService;

  constructor(config: DispatcherConfig) {
    this.bus = config.bus;
    this.logger = config.logger;
    this.contactResolver = config.contactResolver;
    this.channelPolicies = config.channelPolicies;
    this.injectionScanner = config.injectionScanner;
    this.rateLimiter = config.rateLimiter;
    this.pool = config.pool;
    this.conversationCheckpointDebounceMs = config.conversationCheckpointDebounceMs ?? 600_000;
    this.trustScorerWeights = config.trustScorerWeights ?? DEFAULT_TRUST_WEIGHTS;
    this.maxMessageBytes = config.maxMessageBytes ?? 102_400;
    this.confidencePipeline = config.confidencePipeline;
    this.selfEmail = config.selfEmail;
    this._outboundContextService = config.outboundContextService;
    this.contactService = config.contactService;
  }

  /**
   * Register channel routing for an agent.task that did NOT originate from handleInbound.
   *
   * Normal tasks get a routing entry inside handleInbound (keyed by task event id) so
   * handleAgentResponse can turn the agent's reply into an outbound.message. A task published
   * directly to the bus by trusted infra — the secret-capture resume path (#972) — never passes
   * through handleInbound, so without this its response would find no routing and be dropped as
   * "no routing info" (the same path bullpen tasks take), never reaching the user.
   *
   * accountId is optional: when absent the email adapter falls back to the default account.
   */
  registerExternalTaskRouting(
    taskEventId: string,
    routing: { channelId: string; conversationId: string; senderId: string; accountId?: string },
  ): void {
    this.taskRouting.set(taskEventId, {
      channelId: routing.channelId,
      conversationId: routing.conversationId,
      senderId: routing.senderId,
      accountId: routing.accountId,
      humanReplySent: false,
    });
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

    // skill.result → reply-lock: detect successful email-reply / email-send calls so
    // handleAgentResponse can suppress the duplicate outbound.message. See #847.
    this.bus.subscribe('skill.result', 'dispatch', async (event) => {
      await this.handleSkillResult(event as SkillResultEvent);
    });

    this.logger.info(
      { outboundContextBridge: this._outboundContextService != null },
      'Dispatcher registered',
    );
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

            // Auto-elevation paths 2 and 3 — skip blocked contacts entirely.
            if (senderContext.tier !== 'blocked') {
              const resolvedContactId = senderContext.contactId;

              // Path 2: domain-validated org elevation — awaited so the unknown-sender gate below
              // sees the updated tier on the first inbound. Organizations emailing us are implicitly
              // domain-validated; no confidence score is needed.
              if (this.contactService && senderContext.kind === 'organization' && senderContext.tier === 'unknown') {
                const cs = this.contactService;
                try {
                  const elevated = await cs.elevateTierToKnown(resolvedContactId, 'domain-validated');
                  if (elevated) senderContext.tier = 'known';
                } catch (err) {
                  this.logger.warn({ err, contactId: resolvedContactId }, 'domain-validated elevation failed (non-fatal)');
                }
              }

              // Path 3: judgment elevation — fire-and-forget; updates confidence history for the NEXT
              // inbound. The trust score for THIS message already used the stored contactConfidence.
              // Capture tier/kind snapshots before the IIFE so it sees pre-message values even if
              // senderContext is mutated (e.g. by Path 2 above).
              if (this.confidencePipeline) {
                const contactService = this.contactService;
                const snapshotTier = senderContext.tier;
                const snapshotKind = senderContext.kind;
                void (async () => {
                  try {
                    const newConfidence = await this.confidencePipeline!.incrementalUpdate(resolvedContactId, { type: 'message_seen' });
                    if (
                      contactService &&
                      snapshotTier === 'unknown' &&
                      !isAutomatedKind(snapshotKind) &&
                      newConfidence >= JUDGMENT_ELEVATION_THRESHOLD
                    ) {
                      await contactService.elevateTierToKnown(resolvedContactId, 'judgment');
                    }
                  } catch (err) {
                    this.logger.warn({ err, contactId: resolvedContactId }, 'Confidence pipeline or judgment elevation failed (non-fatal)');
                  }
                })();
              }
            }

            // Unknown/blocked contacts gate: applies to tier='unknown' (was: provisional) and
            // tier='blocked'. These have a contact record (so the resolver finds them), but the
            // contact has not been confirmed. Apply the same hold/reject policy as unknown senders.
            // Uses tier for the gate check (issue #945): 'unknown' == old 'provisional',
            // 'blocked' == old 'blocked'.
            //
            // Automated senders (kind='automated') bypass the tier gate when tier='unknown' —
            // that is their normal starting state, since they are created on first contact and
            // never go through the CEO confirmation flow. The coordinator uses kind='automated'
            // context to treat them as low-salience machine mail.
            //
            // Blocked contacts are explicitly blocked by operator decision — always gate them,
            // regardless of kind. Automated senders only bypass the gate when tier='unknown'
            // (their normal starting state) — not when they've been explicitly blocked.
            if (senderContext.tier === 'blocked' ||
                (senderContext.tier === 'unknown' && !isAutomatedKind(senderContext.kind))) {
              const policy = this.channelPolicies?.[payload.channelId];

              if (senderContext.tier === 'blocked') {
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

              if (policy?.unknownSender === 'ignore') {
                this.logger.info(
                  { channel: payload.channelId, senderId: payload.senderId, contactId: senderContext.contactId },
                  'Rejected message from unknown-tier sender per ignore policy',
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

              // 'allow' policy (or no policy) — route to coordinator in low-trust mode.
              // The coordinator receives the sender's full context plus tier='unknown' in the
              // authorization block, which the runtime translates to behavioral constraints.
              this.logger.info(
                { channel: payload.channelId, senderId: payload.senderId, contactId: senderContext.contactId },
                'Routing unknown-tier sender to coordinator in low-trust mode',
              );
            }
          }
        } else {
          // No contact record — truly unknown sender. Compute a preliminary trust score for audit.
          const prelimChannelTrust = (this.channelPolicies?.[payload.channelId]?.trust ?? 'low') as 'low' | 'medium' | 'high';
          const prelimScore = computeTrustScore({
            channelTrustLevel: prelimChannelTrust,
            contactConfidence: 0.0,
            injectionRiskScore: 0,
            trustLevel: null,
            weights: this.trustScorerWeights,
          });

          const policy = this.channelPolicies?.[payload.channelId];
          const routingDecision: UnknownSenderPolicy = policy?.unknownSender === 'ignore' ? 'ignore' : 'allow';

          // Wrapped in its own try/catch so a publish failure cannot escape to the outer catch.
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

          if (policy?.unknownSender === 'ignore') {
            this.logger.info(
              { channel: payload.channelId, senderId: payload.senderId },
              'Rejected message from unknown sender per ignore policy',
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

          // No contact record — truly unknown sender. The automated-kind bypass above
          // does not apply here because there is no kind field without a contact record.
          // The first message from a new automated sender follows the normal unknownSender
          // policy. Subsequent messages (after createContact runs) will have kind='automated'
          // and bypass the unknown-tier gate.
          // TODO(#953): Consider classifyEmailSender(senderId) here to apply the bypass
          // on first contact for recognizable-pattern addresses.
          //
          // 'allow' policy or no policy — route to coordinator without sender context.
          // runtime.ts injects a low-trust signal block so the coordinator knows to apply skepticism.
        }
      } catch (err) {
        // Resolution failure must not drop the message — log and continue without
        // sender context. The runtime will inject a LOW-TRUST block for the unresolved sender.
        this.logger.error(
          { err, channelId: payload.channelId, senderId: payload.senderId },
          'Contact resolution failed — proceeding without sender context; runtime will inject LOW-TRUST block (fail-open: message reaches coordinator)',
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

    // Context bridging v2: inject active outbound context entries.
    // Unlike v1 (which only applied to non-threaded channels), v2 injects for all
    // inbound messages — the LLM judges relevance across channels.
    // Placed AFTER the injection scanner so the preamble (system-generated content)
    // wraps the already-sanitized user content and is not itself scanned or overwritten.
    // Best-effort: failure is logged but does not block message routing.
    if (this._outboundContextService) {
      try {
        const activeEntries = await this._outboundContextService.getActive();
        const preamble = this._outboundContextService.formatInjectionBlock(activeEntries, taskContent);
        if (preamble !== null) {
          taskContent = preamble;
          this.logger.debug(
            { channelId: payload.channelId, conversationId: payload.conversationId, entryCount: activeEntries.length },
            'Injected active outbound context into task content',
          );
        }
      } catch (err) {
        this.logger.error(
          { err, channelId: payload.channelId, conversationId: payload.conversationId },
          'Failed to read outbound context entries — proceeding without context injection',
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

    }

    // Email metadata: parse once here and pass to the preamble builders below,
    // replacing the repeated `payload.metadata as Record<string, unknown>` casts
    // that previously appeared in both the thread-participants and CC preamble blocks.
    if (payload.channelId === 'email') {
      const emailMeta = parseEmailMetadata(payload.metadata);

      // Thread-participants block: inject structured participant context for every
      // inbound email so the coordinator can reason about who's on the thread.
      // Placed before the CC preamble so the CC role marker appears on top.
      const participantsBlock = buildThreadParticipantsBlock(emailMeta, this.selfEmail);
      if (participantsBlock !== null) {
        taskContent = participantsBlock + taskContent;
      }

      // CC role marker: when the email adapter determined that Curia was CC'd rather than
      // directly addressed, prepend a context block so the coordinator knows it was an
      // observer on this email (e.g. the CEO looping Curia in on a message to a third party).
      if (emailMeta.curiaRole === 'cc') {
        const msgIdResult = sanitizeNylasMessageId(emailMeta.nylasMessageId);
        let nylasMessageId: string | undefined;
        if (msgIdResult.ok) {
          nylasMessageId = msgIdResult.value;
        } else if (msgIdResult.reason === 'empty-after-sanitize') {
          // Non-empty raw value collapsed to empty after sanitization — structurally
          // suspicious (e.g. composed entirely of stripped characters).
          // Omit from preamble and warn so operators have an audit trail.
          // The raw value is deliberately excluded from the log — it may be attacker-controlled.
          this.logger.warn(
            { channelId: payload.channelId, conversationId: payload.conversationId },
            'CC preamble: nylasMessageId was non-empty but sanitized to empty — omitting Message ID from preamble',
          );
        } else {
          // nylasMessageId absent or non-string — warn so operators can diagnose
          // a coordinator that falls back to email-draft-save due to missing Message ID.
          this.logger.warn(
            {
              channelId: payload.channelId,
              conversationId: payload.conversationId,
              senderId: redactSenderId(payload.senderId),
              rawType: typeof emailMeta.nylasMessageId,
            },
            'CC preamble: nylasMessageId absent or invalid — Message ID omitted; coordinator may fall back to email-draft-save',
          );
        }

        this.logger.info(
          { channelId: payload.channelId, senderId: payload.senderId, primaryRecipientCount: emailMeta.primaryRecipientEmails.length },
          'CC role preamble injected — Curia was not the primary recipient',
        );

        taskContent = buildCcPreamble(emailMeta, payload.accountId, nylasMessageId) + taskContent;
      }
    }

    // Stamp TaskOriginator on every task — not just principal-originated ones.
    // The originator tracks who started this task chain. For inbound messages,
    // that's the sender. For self-initiated tasks (scheduler, proactive), the
    // caller sets originator before invoking createAgentTask.
    // SECURITY: originator is the ONLY source of systemRole for downstream
    // authorization. Channel-supplied originator is stripped in mergeTaskMetadata.
    const originator: TaskOriginator | undefined = senderContext?.resolved
      ? {
          contactId: senderContext.contactId,
          systemRole: senderContext.systemRole ?? null,
          channel: payload.channelId,
          initiatedAt: new Date().toISOString(),
          tier: senderContext.tier,
        }
      : undefined;
    const originatorMeta = originator ? { originator } : undefined;
    if (!originator) {
      this.logger.warn(
        { channelId: payload.channelId, senderId: payload.senderId },
        'Dispatcher: dispatching task without TaskOriginator — sender was unresolved; isPrincipalOriginated will return false for this task',
      );
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
      // SECURITY: always strip ceoInitiated (legacy) and originator from channel-supplied
      // metadata — originator is stamped exclusively by this function from the contact resolver.
      // A crafted inbound with a forged originator must never propagate.
      // See ADR-017.
      metadata: mergeTaskMetadata(
        payload.metadata as Record<string, unknown> | undefined,
        injectionMetadata,
        originatorMeta,
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
      humanReplySent: false,
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

  /**
   * Reply-lock: detect when a human-facing reply skill fires successfully during a task
   * and mark the routing entry so handleAgentResponse can suppress the duplicate outbound.
   *
   * The skill.result event carries conversationId but not the agent.task ID directly,
   * so we scan the routing map for an entry with a matching conversationId and senderId.
   * This works for both the direct-coordinator case (coordinator calls email-reply) and
   * the delegated-specialist case (T2125 calls email-reply; coordinator's routing entry
   * shares the same conversationId). See #847.
   *
   * NOTE: This relies on single-process in-order event delivery — skill.result must be
   * delivered to all subscribers (including this handler) before agent.response is
   * delivered. The bus processes subscribers sequentially within a single Node.js
   * event loop; multi-process deployments would require a persistent lock instead.
   */
  private async handleSkillResult(event: SkillResultEvent): Promise<void> {
    const { skillName, conversationId, result } = event.payload;

    if (skillName !== 'email-reply' && skillName !== 'email-send') return;
    if (!result.success) return;

    // Extract outbound recipients from result.data.
    // email-reply returns { to: string } (single address).
    // email-send returns { to: string } where the value may be comma-joined for multiple recipients.
    const data = result.data as unknown as Record<string, unknown>;
    const toRaw = typeof data?.to === 'string' ? data.to : undefined;
    if (!toRaw) {
      // The skill contract (to: string) was not met — log a warning so duplicate sends are
      // observable. The lock fails open: outbound.message will still be published.
      this.logger.warn(
        { skillName, conversationId },
        'Dispatcher reply-lock: skill result missing expected { to: string } field — reply-lock NOT set, duplicate send may occur',
      );
      return;
    }

    // Parse comma-separated recipients and normalise to lowercase for case-insensitive matching.
    const recipients = toRaw.split(',').map((addr) => addr.trim().toLowerCase());

    // Find every routing entry for this conversation where the reply target includes the
    // original inbound sender. Multiple entries for the same conversationId are possible
    // but rare; we set the flag on all of them to be safe.
    let matched = false;
    for (const [taskId, routing] of this.taskRouting.entries()) {
      if (
        routing.conversationId === conversationId &&
        recipients.includes(routing.senderId.toLowerCase())
      ) {
        routing.humanReplySent = true;
        matched = true;
        this.logger.debug(
          { taskId, conversationId, skillName },
          'Dispatcher reply-lock: human-facing reply detected — outbound.message will be suppressed',
        );
      }
    }

    if (!matched) {
      // Expected for bullpen tasks or when the routing entry was already cleaned up.
      this.logger.debug(
        { skillName, conversationId, routingMapSize: this.taskRouting.size },
        'Dispatcher reply-lock: no routing entry matched skill result — no lock set',
      );
    }

    // Path 1: Correspondence elevation — attempt to elevate each outbound recipient
    // from unknown → known. Fires for all recipients regardless of reply-lock match.
    // elevateTierToKnown() is a no-op when the contact is already elevated.
    if (this.contactResolver && this.contactService) {
      const cr = this.contactResolver;
      const cs = this.contactService;
      for (const address of recipients) {
        void (async () => {
          try {
            const ctx = await cr.resolve('email', address);
            if (ctx.resolved) {
              await cs.elevateTierToKnown(ctx.contactId, 'correspondence');
            }
          } catch (err) {
            this.logger.warn({ err, address }, 'Correspondence elevation failed (non-fatal)');
          }
        })();
      }
    }
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

    // Reply-lock: if a human-facing reply skill (email-reply, email-send) already fired
    // successfully during this task, suppress the outbound.message to prevent a duplicate
    // send. Emit outbound.suppressed_duplicate for the audit trail. See #847.
    if (routing.humanReplySent) {
      this.logger.info(
        { agentId: event.payload.agentId, conversationId: routing.conversationId, routingTaskId: event.parentEventId },
        'Dispatcher reply-lock: suppressing duplicate outbound.message — human-facing reply already sent',
      );
      const suppressed = createOutboundSuppressedDuplicate({
        routingTaskId: event.parentEventId!,
        agentId: event.payload.agentId,
        conversationId: routing.conversationId,
        reason: 'human_reply_already_sent',
        parentEventId: event.id,
      });
      await this.bus.publish('dispatch', suppressed);
      this.scheduleCheckpoint(routing.conversationId, event.payload.agentId, routing.channelId);
      return;
    }

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
