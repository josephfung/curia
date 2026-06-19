// outbound-gateway.ts — single choke-point for all outbound external communication.
//
// All sends from Curia to the outside world MUST pass through this gateway.
// This ensures consistent enforcement of:
//   1. Blocked contact check
//   2. Content filter
//
// Design intent: fail-open on infra errors. If the contact DB is unavailable
// we log a warning and proceed rather than silently blocking legitimate sends.
// The alternative (fail-closed on DB error) would cause Curia to go silent
// whenever the DB hiccups, which is worse than a rare false negative on the
// blocked-contact check.
//
// Adding a new channel:
//   1. Add a new variant to OutboundSendRequest (discriminated union by `channel`)
//   2. Add the channel client to OutboundGatewayConfig
//   3. Add a private dispatch<Channel>() method
//   4. Add a branch in send() to call it
//   The blocked-contact check and content filter in send() are channel-agnostic and
//   run for all channels before dispatch.

import { randomUUID } from 'node:crypto';
import type { NylasClient, NylasMessage, NylasFolder, ListMessagesOptions, SendEmailOptions, AttachmentContent } from '../channels/email/nylas-client.js';
import { readAttachmentFiles, MAX_ATTACHMENT_BYTES, type OutboundAttachmentInput } from './_shared/read-attachments.js';
import type { SignalRpcClient } from '../channels/signal/signal-rpc-client.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { ContactTier, ChannelIdentity } from '../contacts/types.js';
import type { OutboundContentFilter, FilterRecipient } from '../dispatch/outbound-filter.js';
import type { PiiRedactor } from '../dispatch/pii-redactor.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createOutboundBlocked, createOutboundDelivered, createOutboundNotification, createAutonomySendBlocked } from '../bus/events.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import { generateShortRef } from '../autonomy/approval-trigger.js';
import type { OutboundNotificationPayload } from '../bus/events.js';
import { markdownToHtml } from '../channels/email/markdown-to-html.js';
import { scrubPii } from '../pii/scrubber.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmailSendRequest {
  channel: 'email';
  /** Which named account should send this message (e.g. "curia", "joseph").
   *  Used by the gateway to select the right NylasClient from its map.
   *  Defaults to the first configured account when absent. */
  accountId?: string;
  /** Recipient email address */
  to: string;
  subject?: string;
  body: string;
  cc?: string[];
  /** When set, Nylas threads the outbound message as a reply */
  replyToMessageId?: string;
  /** Pre-formed HTML fragment appended verbatim after markdownToHtml(body).
   *  Used for the quoted original message block: the HTML quote must not pass
   *  through markdownToHtml because that converter escapes < and > characters. */
  htmlQuote?: string;
  /** File attachments to include. Each entry must have a file:// URL pointing
   *  to a temp file (from email-download-attachment or similar). The gateway
   *  reads the files from disk before passing them to Nylas. */
  attachments?: OutboundAttachmentInput[];
}

// Re-export so callers can construct attachment lists without importing from read-attachments directly.
export type { OutboundAttachmentInput };

export interface SignalOutboundRequest {
  channel: 'signal';
  /**
   * E.164 phone number for 1:1 sends (e.g. "+14155552671").
   * Mutually exclusive with groupId — set exactly one.
   */
  recipient?: string;
  /**
   * Base64-encoded group V2 ID for group sends.
   * Mutually exclusive with recipient — set exactly one.
   */
  groupId?: string;
  message: string;
}

/**
 * Discriminated union of all supported outbound send requests.
 * Add a new variant here when adding a new channel.
 *
 * Note: OutboundSendRequest is a public API surface — adding a new variant is
 * backwards-compatible, but changing existing field names or types is a breaking
 * change that must be called out in CHANGELOG.md.
 */
export type OutboundSendRequest = EmailSendRequest | SignalOutboundRequest;

// Re-export the old name as an alias so existing callers don't break.
// Previously OutboundSendRequest was a single interface (email-only). Now it's a
// discriminated union. Callers that typed a variable as OutboundSendRequest and
// passed it to send() continue to work unchanged — the union is a superset.
// This alias exists purely for documentation; the type itself is unchanged in
// terms of what email callers already do.
export type { OutboundSendRequest as OutboundEmailSendRequest };

export interface OutboundSendResult {
  success: boolean;
  messageId?: string;
  /** Human-readable reason when success is false */
  blockedReason?: string;
  /** True when the autonomy gate blocked this send */
  gated?: boolean;
  /** Short reference for the action_log row (e.g. 'a3f7c12b'). Present when gated is true. */
  actionRef?: string;
}

/** Result from createEmailDraft() — extends send result with the Nylas draft ID. */
export interface OutboundDraftResult extends OutboundSendResult {
  /** Nylas draft ID when success is true. */
  draftId?: string;
}

export interface OutboundGatewayConfig {
  /**
   * Map of accountId → NylasClient, one entry per configured email account.
   * The gateway uses this map to route email sends and draft creations to the
   * correct Nylas grant. The first entry in the map is treated as the primary
   * account and is used for system notifications (e.g. blocked-content alerts).
   *
   * Optional — gateway can be initialised with only Signal (signalClient) if
   * email is not configured.
   *
   * TODO: If non-Nylas email backends are added in future, replace this map with
   * an AccountManager abstraction that can hold heterogeneous client types and
   * abstract over the underlying send/draft/list APIs per account.
   */
  nylasClients?: Map<string, NylasClient>;

  /**
   * signal-cli RPC client for Signal sends. Optional — gateway can be initialized
   * with only email (nylasClient) if Signal is not configured.
   */
  signalClient?: SignalRpcClient;

  /**
   * The agent's Signal phone number in E.164 format — used as the `account` param in
   * signal-cli RPC calls. Required when signalClient is provided.
   */
  signalPhoneNumber?: string;

  contactService: ContactService;
  contentFilter: OutboundContentFilter;
  bus: EventBus;

  /**
   * Cached channel identities of the principal contact (the human Curia serves).
   * Loaded at startup from the database. Used by isPrincipalRecipient() to
   * determine whether an outbound message is directed at the principal —
   * principal-bound messages bypass the autonomy gate.
   *
   * When empty (no principal contact exists), the principal bypass does not fire.
   */
  principalIdentities?: ChannelIdentity[];

  logger: Logger;

  /**
   * Autonomy service — used to enforce the outbound gate at the 'medium' risk
   * threshold (currently 70, derived from AutonomyService.minScoreForActionRisk).
   * When the live score is below the threshold, send() blocks the dispatch and
   * returns an advisory. Optional — when absent, the gate is skipped (fail-open).
   */
  autonomyService?: AutonomyService;

  /**
   * PII redactor — applied between the blocked-contact check (Step 1) and the
   * content filter (Step 2). Strips PII from the message body based on channel
   * policy and recipient trust level before content validation runs.
   *
   * Fail-closed: if the redactor throws, send() blocks the message and publishes
   * outbound.blocked. We must never deliver unredacted content through a broken
   * redactor.
   *
   * Optional — when absent, content passes through to the content filter unchanged.
   * This preserves backwards compatibility with callers that pre-date PII redaction.
   */
  piiRedactor?: PiiRedactor;

  /**
   * Action log repository — used to write pending_approval rows when the autonomy
   * gate blocks a send. Enables the two-step draft-fallback pattern: the gateway
   * creates an action_log entry on gate, then the channel adapter links the draft
   * ID after creating the fallback artifact.
   *
   * Optional — when absent, gated sends still return { gated: true } but no
   * action_log row is written and no actionRef is assigned.
   */
  actionLogRepo?: ActionLogRepo;

  /**
   * Contact confidence scoring pipeline. When provided, fires message_sent after
   * every successful outbound send. Replaces the setTrustLevel('high') band-aid.
   */
  confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a redacted form of a recipient identifier safe to write to logs.
 * Keeps the first 3 and last 3 characters so the log entry is still useful for
 * debugging (e.g. "joh***com" for an email, "+12***444" for a phone) without
 * logging the full address.
 *
 * Examples:
 *   "joe@example.com"  → "joe***com"
 *   "+14155552671"     → "+14***671"
 *   "abc"              → "***"        (too short — redact fully)
 */
function redactId(value: string): string {
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

/**
 * Build a principal-safe summary of WHY an outbound message was blocked, for the
 * CEO notification body. The summary gives the CEO something actionable without
 * re-leaking the offending content into their mailbox (and through the email
 * provider that carries the notification).
 *
 * Per-finding policy, keyed on the rule name:
 *   - Stage-2 LLM judge findings (rule prefix `llm-judge-`) and Stage-2.5 escalation
 *     judge findings (`disclosure-tier-gate`) carry an ABSTRACT, redaction-safe detail
 *     by construction: the judge prompt forbids quoting the offending value, and the
 *     Stage-2.5 detail is constructed from verdict.disclosureClass + verdict.reason
 *     (never raw content). Their detail is therefore safe to surface, and it is exactly
 *     the "judge's reason" the principal needs to understand the block.
 *   - Stage-1 deterministic-rule findings (`secret-pattern`, `contact-data-leak`,
 *     `internal-structure`, `system-prompt-fragment`) and any other rule can have
 *     the matched fragment embedded in their detail (a secret, an internal marker,
 *     a third party's address). For those we surface ONLY the rule name — never the
 *     detail. This preserves the existing "no sensitive content in the notification"
 *     invariant for the deterministic stage.
 */
function buildBlockReasonSummary(findings: Array<{ rule: string; detail: string }>): string {
  if (findings.length === 0) return 'Content filter (no rule detail available)';
  return findings
    .map((f) => {
      const showDetail = (f.rule.startsWith('llm-judge-') || f.rule === 'disclosure-tier-gate') && f.detail;
      return showDetail ? `${f.rule}: ${f.detail}` : f.rule;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// OutboundGateway
// ---------------------------------------------------------------------------

export class OutboundGateway {
  /** All configured email accounts: accountId → NylasClient. */
  private readonly nylasClients: Map<string, NylasClient>;
  /**
   * The primary NylasClient — first entry in nylasClients, used for system
   * notifications (blocked-content CEO alerts) when no accountId is specified.
   */
  private readonly primaryNylasClient: NylasClient | undefined;
  private readonly signalClient?: SignalRpcClient;
  private readonly signalPhoneNumber?: string;
  private readonly contactService: ContactService;
  private readonly contentFilter: OutboundContentFilter;
  private readonly bus: EventBus;
  private readonly principalIdentities: ChannelIdentity[];
  private readonly log: Logger;
  private readonly autonomyService?: AutonomyService;
  private readonly piiRedactor?: PiiRedactor;
  private readonly actionLogRepo?: ActionLogRepo;
  private readonly confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;

  constructor(config: OutboundGatewayConfig) {
    this.nylasClients = config.nylasClients ?? new Map();
    this.primaryNylasClient = this.nylasClients.values().next().value;
    this.signalClient = config.signalClient;
    this.signalPhoneNumber = config.signalPhoneNumber;
    this.contactService = config.contactService;
    this.contentFilter = config.contentFilter;
    this.bus = config.bus;
    this.principalIdentities = config.principalIdentities ?? [];
    this.log = config.logger.child({ component: 'outbound-gateway' });
    this.autonomyService = config.autonomyService;
    this.piiRedactor = config.piiRedactor;
    this.actionLogRepo = config.actionLogRepo;
    this.confidencePipeline = config.confidencePipeline;
  }

  /**
   * Send an outbound message through the gateway pipeline.
   *
   * Pipeline steps (channel-agnostic):
   *   0. Autonomy gate — score below 'medium' risk threshold blocks all autonomous sends
   *      (skipped when options.humanApproved or options.isSystemNotification is true)
   *   1. Contact blocked check
   *   2. Content filter (fail-closed)
   *   3. Channel dispatch (email → Nylas, signal → signal-cli RPC)
   *
   * @param options.skipNotificationOnBlock  When true, suppress the CEO notification
   *   if the content filter blocks this message. Used by the EmailAdapter's
   *   outbound.notification subscriber to break the recursion cycle: without this
   *   guard, a broken content filter (crash → fail-closed) would trigger
   *   send → block → sendNotification → EmailAdapter → send → block → ... infinitely.
   * @param options.humanApproved  When true, skip Step 0 (autonomy gate) only.
   *   The CEO is explicitly in the loop. All other safety checks (blocked-contact,
   *   content filter) run normally. See ADR-017.
   * @param options.isSystemNotification  When true, skip Step 0 (autonomy gate) only.
   *   Used for infrastructure alerts sent TO the CEO (e.g. approval_requested,
   *   blocked_content). These must never be silenced by the same gate they report on —
   *   if the score is too low to send autonomously, the CEO still needs to know about it.
   *   All other safety checks (blocked-contact, content filter) run normally.
   */
  async send(
    request: OutboundSendRequest,
    options?: {
      skipNotificationOnBlock?: boolean;
      humanApproved?: boolean;
      isSystemNotification?: boolean;
      /** Task event ID for action_log traceability. */
      taskEventId?: string;
      /** Conversation ID for action_log context. */
      conversationId?: string;
      /** Parent bus event ID for the outbound.delivered audit row. Dispatcher-routed
       *  sends pass the outbound.message event ID; skill-invoked sends omit it. */
      parentEventId?: string;
      /**
       * Re-execution recipe for the pending_approval lifecycle.
       *
       * Channel adapters opt in to the two-step draft-fallback pattern by providing
       * this object. When present and the send is gated, the gateway writes a
       * pending_approval row using these values so approve-action can invoke the
       * correct skill with the correct payload on CEO approval.
       *
       * When absent, no pending_approval row is written and the send returns
       * { gated: true } without an actionRef. Adapters without a re-execution
       * path (e.g. Signal today) simply omit this field.
       */
      reExecRecipe?: {
        /** Registered skill name to invoke on approval (e.g. 'send-draft'). */
        skillName: string;
        /**
         * Partial payload to store in the action_log row. May be incomplete at gate
         * time (e.g. draft_id not yet known). Callers fill in missing fields via
         * linkGatedAction() after creating the fallback artifact.
         */
        partialPayload?: Record<string, unknown>;
        /**
         * Human-readable description of the blocked action. Used in the action_log
         * row (visible via list-pending-actions) and the CEO notification body.
         */
        description: string;
      };
    },
  ): Promise<OutboundSendResult> {
    // ------------------------------------------------------------------
    // Step 0: Autonomy gate — score below 'medium' threshold blocks all outbound sends
    // ------------------------------------------------------------------
    // Belt-and-suspenders for medium+ skills: even if the execution layer
    // allowed the skill, the gateway independently blocks the actual send
    // when the score is too low. Fail-open if the service is not wired
    // or the config table is missing.
    if (this.autonomyService && options?.humanApproved) {
      // CEO is explicitly in the loop — autonomy gate does not apply. Log the bypass
      // so operators can trace every humanApproved send in the log stream. See ADR-017.
      this.log.info(
        { channel: request.channel },
        'outbound-gateway: autonomy gate skipped — humanApproved flag set (CEO-authorized action, see ADR-017)',
      );
    } else if (this.autonomyService && options?.isSystemNotification) {
      // Infrastructure alert to the CEO — gate must not silence its own alarm bell.
      // A notification about a blocked action still needs to reach the CEO regardless
      // of the score that caused the block. All other safety checks still run below.
      this.log.info(
        { channel: request.channel },
        'outbound-gateway: autonomy gate skipped — isSystemNotification flag set (infrastructure alert to CEO)',
      );
    } else if (this.autonomyService && this.isPrincipalRecipient(request)) {
      // Agent-to-principal communication — the autonomy gate must not silence
      // the agent's ability to communicate with its oversight authority. Gating
      // principal-bound messages reduces oversight rather than improving it.
      // All other safety checks (blocked-contact, content filter, PII redaction)
      // still run below.
      this.log.info(
        { channel: request.channel },
        'outbound-gateway: autonomy gate skipped — recipient is principal (agent-to-principal communication)',
      );
    } else if (this.autonomyService) {
      // Fail-open on config read only — getConfig() failure must not block sends.
      // The action_log DB write is kept outside this try/catch so a DB error there
      // does NOT cause fail-open; the send stays blocked even if we can't write the row.
      let autonomyConfig: Awaited<ReturnType<typeof this.autonomyService.getConfig>> | null = null;
      try {
        autonomyConfig = await this.autonomyService.getConfig();
      } catch (err) {
        // DB error — fail-open. Log at warn so anomalies are visible in alerting.
        this.log.warn(
          { err, channel: request.channel },
          'outbound-gateway: autonomy gate failed to read config — proceeding without gate (fail-open)',
        );
      }

      const sendThreshold = AutonomyService.minScoreForActionRisk('medium');
      if (autonomyConfig !== null && autonomyConfig.score < sendThreshold) {
        this.log.info(
          { channel: request.channel, currentScore: autonomyConfig.score, sendThreshold },
          `outbound-gateway: send blocked by autonomy gate — score < ${sendThreshold}`,
        );
        this.bus.publish('dispatch', createAutonomySendBlocked({
          channel: request.channel,
          currentScore: autonomyConfig.score,
          requiredScore: sendThreshold,
        })).catch((err) => {
          this.log.warn(
            { err, channel: request.channel },
            'outbound-gateway: failed to publish autonomy.send_blocked event',
          );
        });

        // Two-step draft-fallback: channel adapters opt in by passing reExecRecipe.
        // When present, write a pending_approval row so approve-action can invoke the
        // correct skill on CEO approval. DB failure must NOT cause fail-open — the send
        // stays blocked even if the row can't be written (actionRef will be absent).
        let actionRef: string | undefined;
        if (this.actionLogRepo && options?.taskEventId && options?.reExecRecipe) {
          const recipe = options.reExecRecipe;

          // Hoist expiresAt so both the insert row and the notification body use the
          // same value — if the 48h window ever changes, only one line needs updating.
          const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
          // Hoist candidateRef before the try block so the notification body can
          // reference it directly — avoiding a fragile dependency on the outer-scope
          // actionRef variable which is only set after insert() confirms success.
          const candidateRef = generateShortRef();
          let rowId: number | undefined;
          try {
            // Only assign actionRef after insert confirms the DB row exists to
            // prevent phantom refs if insert throws.
            rowId = await this.actionLogRepo.insert({
              taskId: options.taskEventId,
              conversationId: options.conversationId ?? undefined,
              skillName: recipe.skillName,
              actionRisk: 'medium',
              outcome: 'pending_approval',
              shortRef: candidateRef,
              description: recipe.description,
              payload: recipe.partialPayload ?? {},
              expiresAt,
            });
            // Only commit actionRef now that the row actually exists in the DB
            actionRef = candidateRef;
          } catch (err) {
            this.log.error(
              { err, channel: request.channel, taskEventId: options.taskEventId },
              'outbound-gateway: failed to write action_log row during gate — send is still blocked, actionRef will be absent',
            );
            // actionRef remains undefined — send is still blocked below
          }

          // Notify CEO (best-effort) — mirrors ApprovalTriggerService.request() pattern.
          // sendNotification() has its own try-catch and returns false on failure, so it
          // never throws. Only stamp notification_sent_at if the publish succeeded.
          // setNotificationSentAt is wrapped separately so a DB failure there does not
          // discard the fact that the insert (and the notification delivery) succeeded.
          const principalEmail = this.principalIdentities.find((id) => id.channel === 'email')?.channelIdentifier;
          if (rowId !== undefined && principalEmail) {
            const sent = await this.sendNotification({
              notificationType: 'approval_requested',
              ceoEmail: principalEmail,
              subject: `Approval needed — ${recipe.description}`,
              body: [
                recipe.description,
                '',
                `Autonomy score: ${autonomyConfig.score} (threshold: ${sendThreshold})`,
                `Reference: ${candidateRef}`,
                `Expires: ${expiresAt.toISOString()}`,
                '',
                `Reply with the reference to approve, deny, or dismiss this request.`,
              ].join('\n'),
            });
            if (sent) {
              try {
                await this.actionLogRepo.setNotificationSentAt(rowId);
              } catch (err) {
                // Non-fatal: the pending_approval row exists and gating is correct.
                // Only notification_sent_at is missing — the CEO still received the alert.
                this.log.warn(
                  { err, rowId, taskEventId: options.taskEventId },
                  'outbound-gateway: setNotificationSentAt failed after successful notification — notification_sent_at will be null',
                );
              }
            }
          } else if (rowId !== undefined && !principalEmail) {
            // Row was written but no principal email identity configured — notification silently skipped.
            // Surface this as an error so misconfigured deployments are detectable in alerting.
            this.log.error(
              { rowId, taskEventId: options.taskEventId },
              'outbound-gateway: pending_approval row written but principal notification skipped — no principal email identity configured',
            );
          }
        }

        if (actionRef) {
          return {
            success: false,
            gated: true,
            actionRef,
            blockedReason: `Autonomy score ${autonomyConfig.score} is below send threshold ${sendThreshold}`,
          };
        }

        return {
          success: false,
          gated: true,
          blockedReason:
            `Autonomy score is ${autonomyConfig.score} — direct sends require a score of at least ${sendThreshold}. ` +
            `Use createEmailDraft() for drafts, or ask the CEO to raise the score with set-autonomy.`,
        };
      }
    }

    // Derive a stable recipient identifier for the blocked-contact check and logging.
    // Email: the To address. Signal: phone number (1:1) or base64 group ID.
    const recipientId = request.channel === 'email'
      ? request.to
      : (request.recipient ?? request.groupId ?? '');

    // The message body field differs between channel types.
    const messageBody = request.channel === 'email' ? request.body : request.message;

    // ------------------------------------------------------------------
    // Step 1: Contact blocked check + trust level capture
    // ------------------------------------------------------------------
    // Resolve the recipient to a known contact. If they are explicitly blocked
    // by the CEO, reject immediately without touching the transport layer or filter.
    // We also capture the contact's trust level here for the content filter's
    // contact-data-leak rule — no extra DB call needed.
    //
    // Fail-open on DB errors: an infra failure should not silently prevent
    // sending. We warn so the anomaly is visible in logs/alerting.
    let recipientTier: ContactTier = 'unknown';
    let recipientContactId: string | undefined;
    try {
      const contact = await this.contactService.resolveByChannelIdentity(request.channel, recipientId);
      if (contact !== null) {
        // Use tier for the blocked check (issue #945); tier='blocked' == old status='blocked'.
        if (contact.tier === 'blocked') {
          this.log.warn(
            { channel: request.channel, recipientId: redactId(recipientId), contactId: contact.contactId },
            'outbound-gateway: send blocked — recipient is blocked',
          );
          return { success: false, blockedReason: 'Recipient is blocked' };
        }
        // Capture tier for the content filter, and contact UUID for the PII redactor's
        // CEO bypass check. Both are used downstream: tier by the content filter's disclosure
        // gate, and contact UUID by PiiRedactor.redact() for the principal bypass.
        recipientTier = contact.tier;
        recipientContactId = contact.contactId;
      }
    } catch (err) {
      // DB or service error — log at warn and proceed.
      // recipientTier stays 'unknown', which is the safe/conservative fallback.
      this.log.warn(
        { err, channel: request.channel, recipientId: redactId(recipientId) },
        'outbound-gateway: contact resolution failed, proceeding without blocked check',
      );
    }

    // ------------------------------------------------------------------
    // Step 1.5: PII redaction — strip PII from message body before the content
    // filter sees it. This ensures the filter operates on clean content and that
    // any PII-containing message that slips past detection doesn't reach the wire.
    //
    // Fail-closed: if the redactor throws, block the message. Sending unredacted
    // PII through a broken redactor is worse than dropping the message.
    //
    // Optional: when piiRedactor is not configured, redactedBody == messageBody
    // and the pipeline behaves identically to the pre-redaction behaviour.
    let redactedBody = messageBody;
    // Email subjects can contain PII just as the body can — track a separate
    // variable so we can pass the cleaned subject to dispatchEmail() below.
    let redactedSubject: string | undefined = request.channel === 'email' ? request.subject : undefined;
    if (this.piiRedactor) {
      try {
        const redactionResult = await this.piiRedactor.redact(
          messageBody,
          request.channel,
          { recipientId, recipientContactId },
        );
        redactedBody = redactionResult.content;
        // Redact the subject too — same channel policy applies.
        if (request.channel === 'email' && request.subject) {
          const subjectResult = await this.piiRedactor.redact(
            request.subject,
            request.channel,
            { recipientId, recipientContactId },
          );
          redactedSubject = subjectResult.content;
        }
      } catch (err) {
        this.log.error(
          { err, channel: request.channel, recipientId: redactId(recipientId) },
          'outbound-gateway: PiiRedactor threw — blocking message (fail-closed)',
        );
        const blockId = `block_${randomUUID()}`;
        try {
          await this.bus.publish('dispatch', createOutboundBlocked({
            blockId,
            conversationId: '',
            channelId: request.channel,
            // scrubPii() as a safety fallback — the redactor itself failed, so we apply
            // a best-effort scrub before writing anything to the audit log. This ensures
            // no raw PII leaks into the audit trail even on a redactor failure path.
            content: scrubPii(messageBody),
            recipientId,
            reason: 'pii_redactor_error',
            findings: [{ rule: 'pii_redactor_error', detail: 'PiiRedactor threw an unexpected error' }],
            parentEventId: '',
          }));
        } catch (publishErr) {
          this.log.warn(
            { publishErr, blockId },
            'outbound-gateway: failed to publish outbound.blocked event for PII redactor error',
          );
        }
        return { success: false, blockedReason: 'pii_redactor_error' };
      }
    }

    // ------------------------------------------------------------------
    // Step 2: Content filter
    // ------------------------------------------------------------------
    // Fail-closed: if the filter throws for any reason, treat the message as blocked.
    // A crashing filter is a security anomaly — better to miss a send than let
    // potentially dangerous content through an unchecked pipeline.
    let filterPassed = false;
    let filterFindings: Array<{ rule: string; detail: string }> = [];

    const { recipients, principalIncluded, principalIsSoleRecipient } = this.buildFilterRecipients(request);

    try {
      const filterResult = await this.contentFilter.check({
        content: redactedBody,
        // For Signal sends: passing the phone number/groupId as recipientEmail is intentional.
        // The contact-data-leak rule scans for *email addresses* in the content — a phone
        // number passed here will never match an email pattern, so any leaked email address
        // in the Signal message body is still correctly flagged. The field name is email-centric
        // but the semantics are "the intended recipient identifier".
        recipientEmail: recipientId,
        conversationId: '',
        channelId: request.channel,
        recipientTier,
        recipients,
        principalIncluded,
        principalIsSoleRecipient,
      });
      filterPassed = filterResult.passed;
      filterFindings = filterResult.findings;
    } catch (err) {
      // Filter crash — treat as blocked with a synthetic finding
      this.log.warn(
        { err, channel: request.channel, recipientId: redactId(recipientId) },
        'outbound-gateway: content filter threw — treating as blocked (fail-closed)',
      );
      filterPassed = false;
      filterFindings = [{ rule: 'filter-error', detail: 'Content filter threw an unexpected error' }];
    }

    if (!filterPassed) {
      // Build a human-readable reason from just the rule names (not the full detail
      // which may contain sensitive data fragments that triggered the rule).
      const ruleNames = filterFindings.map((f) => f.rule).join('; ');
      this.log.warn(
        { channel: request.channel, recipientId: redactId(recipientId), rules: ruleNames },
        'outbound-gateway: outbound message blocked by content filter',
      );

      const blockId = `block_${randomUUID()}`;
      // Full reason string (with detail) goes into the bus event for forensics/audit,
      // NOT into any user-facing or notification surface.
      const fullReason = filterFindings.map((f) => `${f.rule}: ${f.detail}`).join('; ');
      // Principal-safe reason for the CEO notification: surfaces the judge's abstract
      // reason but never a Stage-1 finding's (potentially sensitive) detail. See
      // buildBlockReasonSummary for the per-rule policy.
      const reasonSummary = buildBlockReasonSummary(filterFindings);

      // Publish the blocked event for audit logging and downstream consumers.
      // Capture the event so we can link the outbound.notification to it via parentEventId.
      // Use redactedBody so the audit event itself does not contain unredacted PII.
      const blockedEvent = createOutboundBlocked({
        blockId,
        conversationId: '',
        channelId: request.channel,
        content: redactedBody,
        recipientId,
        reason: fullReason,
        findings: filterFindings,
        parentEventId: '',
      });
      try {
        await this.bus.publish('dispatch', blockedEvent);
      } catch (publishErr) {
        this.log.warn(
          { publishErr, blockId },
          'outbound-gateway: failed to publish outbound.blocked event — message is still blocked',
        );
      }

      // Publish an outbound.notification event so the CEO alert routes through the
      // standard safety pipeline via EmailAdapter, rather than bypassing the content
      // filter with a direct dispatchEmail() call (#206).
      //
      // Recursion safety (two layers):
      //   1. The notification body is a hardcoded template addressed to ceoEmail (in the
      //      content filter allowlist), so the filter always passes under normal operation.
      //   2. The EmailAdapter passes skipNotificationOnBlock: true when calling send() for
      //      a notification delivery. If the filter is broken (crash → fail-closed), this
      //      flag prevents send() from re-publishing outbound.notification, breaking the
      //      cycle: send → block → sendNotification → EmailAdapter → send(skip) → block → stop.
      const principalEmailForBlock = this.principalIdentities.find((id) => id.channel === 'email')?.channelIdentifier;
      if (principalEmailForBlock && !options?.skipNotificationOnBlock) {
        // sendNotification() catches errors internally — await is safe and ensures
        // the bus.publish call completes before we return the blocked result.
        await this.sendNotification(
          {
            notificationType: 'blocked_content',
            ceoEmail: principalEmailForBlock,
            subject: 'Action needed — blocked outbound reply',
            body: [
              'An outbound message was blocked by the content filter.',
              '',
              `Reason: ${reasonSummary}`,
              // blockedEvent.timestamp is the audit row's own clock. No principal
              // timezone is plumbed into the gateway (it is infrastructure, not a
              // skill with ctx.timezone), so we stamp UTC explicitly rather than
              // emit an ambiguous bare timestamp.
              `Time: ${blockedEvent.timestamp.toISOString()} (UTC)`,
              `Channel: ${request.channel}`,
              `Intended recipient: ${recipientId}`,
              '',
              `Block ID: ${blockId}`,
              `Audit event ID: ${blockedEvent.id}`,
              '',
              'Search the audit log by the audit event ID above for the full record.',
            ].join('\n'),
            blockId,
            originalChannel: request.channel,
            originalRecipientId: recipientId,
          },
          blockedEvent.id,
        );
      } else if (options?.skipNotificationOnBlock) {
        // This branch fires when a notification delivery itself gets blocked by the
        // content filter (e.g. the filter is in a broken state). The recursion guard
        // prevents an infinite loop. The CEO will not receive this alert.
        this.log.error(
          { blockId, channel: request.channel },
          'outbound-gateway: notification delivery was blocked by content filter — recursion guard active, CEO will NOT receive this alert',
        );
      } else if (!options?.skipNotificationOnBlock) {
        this.log.error(
          { blockId, channel: request.channel, recipientId: redactId(recipientId) },
          'outbound-gateway: principal notification skipped — no principal email identity configured. Block recorded in audit log only.',
        );
      }
      return { success: false, blockedReason: 'Content blocked by filter' };
    }

    // ------------------------------------------------------------------
    // Step 3: Channel dispatch + contact promotion
    // ------------------------------------------------------------------
    // After a successful send, promote the recipient contact from provisional →
    // confirmed (or create one if none exists). The act of sending is the CEO's
    // implicit trust confirmation — replies from this person should never be held.
    //
    // IMPORTANT: pass redactedBody here, not request.body / request.message.
    // The dispatch methods read the body/message field from the request object
    // they receive — if we pass the original `request`, the unredacted content
    // reaches Nylas / signal-cli even though redactedBody was computed above.
    if (request.channel === 'email') {
      const result = await this.dispatchEmail({ ...request, body: redactedBody, subject: redactedSubject });
      if (result.success) {
        await this.promoteOrCreateRecipientContact('email', recipientId);
        await this.publishDelivered({
          channel: 'email',
          recipientId,
          recipientContactId,
          content: redactedBody,
          conversationId: options?.conversationId,
          taskEventId: options?.taskEventId,
          messageId: result.messageId,
          parentEventId: options?.parentEventId,
        });
      }
      return result;
    } else {
      const result = await this.dispatchSignal({ ...request, message: redactedBody });
      // Only promote for 1:1 Signal sends — group sends use a groupId, not an individual
      // phone number. Creating a contact for a group token would pollute the contacts table
      // and would not help with inbound replies (which come from member numbers, not the group ID).
      if (result.success && request.recipient) {
        await this.promoteOrCreateRecipientContact('signal', request.recipient);
      }
      // Emit the audit event for all successful Signal sends (both 1:1 and group).
      // messageId is intentionally omitted — signal-cli RPC returns no ID.
      if (result.success) {
        await this.publishDelivered({
          channel: 'signal',
          recipientId,
          recipientContactId,
          content: redactedBody,
          conversationId: options?.conversationId,
          taskEventId: options?.taskEventId,
          parentEventId: options?.parentEventId,
          // messageId intentionally omitted — signal-cli RPC returns no ID
        });
      }
      return result;
    }
  }

  /**
   * Publish a system notification event to the bus so it routes through the standard
   * outbound safety pipeline (content filter + blocked-contact check) via the
   * EmailAdapter's outbound.notification subscriber.
   *
   * This replaces the former direct dispatchEmail() calls that bypassed the content
   * filter. The notification body is always a hardcoded template (no LLM-generated
   * content) addressed to the CEO email (which is in the content filter allowlist),
   * so the filter will always pass.
   *
   * Callers: the blocked-content path in send() and SignalAdapter.notifyCeoGroupHeld().
   */
  async sendNotification(
    payload: OutboundNotificationPayload,
    parentEventId?: string,
  ): Promise<boolean> {
    try {
      await this.bus.publish(
        'dispatch',
        createOutboundNotification({ ...payload, parentEventId }),
      );
      return true;
    } catch (err) {
      // Non-fatal — the original block/hold is already recorded. Log so the anomaly
      // is visible in alerting but do not throw; the caller's primary operation (block
      // or hold) has already completed successfully.
      this.log.error(
        { err, notificationType: payload.notificationType },
        'outbound-gateway: failed to publish outbound.notification event',
      );
      return false;
    }
  }

  /**
   * Publish the canonical outbound.delivered audit event. Called from every
   * successful wire-level dispatch path. Failures here are logged but never
   * propagate — the message already went out, and we will not make the user's
   * send conditional on the audit subsystem.
   */
  private async publishDelivered(payload: {
    channel: 'signal' | 'email';
    recipientId: string;
    recipientContactId?: string;
    content: string;
    conversationId?: string;
    taskEventId?: string;
    messageId?: string;
    parentEventId?: string;
  }): Promise<void> {
    try {
      await this.bus.publish('dispatch', createOutboundDelivered(payload));
    } catch (err) {
      this.log.error(
        { err, channel: payload.channel, recipientId: redactId(payload.recipientId) },
        'outbound-gateway: failed to publish outbound.delivered event — send already succeeded, audit row is missing',
      );
    }
  }

  /**
   * Check whether the recipient is the principal (the human Curia serves).
   * Resolves against the principal contact's verified channel identities,
   * loaded from the database at startup.
   */
  private isPrincipalRecipient(request: OutboundSendRequest): boolean {
    if (this.principalIdentities.length === 0) return false;

    if (request.channel === 'email' && request.to) {
      const normalized = request.to.toLowerCase();
      return this.principalIdentities.some(
        (id) => id.channel === 'email' && id.channelIdentifier.toLowerCase() === normalized,
      );
    }
    if (request.channel === 'signal' && 'recipient' in request && request.recipient) {
      return this.principalIdentities.some(
        (id) => id.channel === 'signal' && id.channelIdentifier === request.recipient,
      );
    }
    return false;
  }

  /**
   * Check whether an email address belongs to the principal.
   * Used by sendEmailDraft() for the autonomy bypass.
   */
  private isPrincipalEmail(email: string | undefined | null): boolean {
    if (!email || this.principalIdentities.length === 0) return false;
    const normalized = email.toLowerCase();
    return this.principalIdentities.some(
      (id) => id.channel === 'email' && id.channelIdentifier.toLowerCase() === normalized,
    );
  }

  /**
   * Check whether a Signal identifier (E.164 phone) belongs to the principal.
   * Matches against the principal's verified SIGNAL channel identities — the email
   * matcher (isPrincipalEmail) must NOT be used for Signal, or a 1:1 principal Signal
   * reply would be mis-tagged as a third party and lose its private-channel skip.
   */
  private isPrincipalSignal(identifier: string | undefined | null): boolean {
    if (!identifier || this.principalIdentities.length === 0) return false;
    return this.principalIdentities.some(
      (id) => id.channel === 'signal' && id.channelIdentifier === identifier,
    );
  }

  /**
   * Build the structural recipient set for the content filter's Stage 2 judge.
   * `isPrincipal` is computed from the principal's verified channel identities —
   * channel-aware (email matcher for email, Signal matcher for Signal) — NOT the
   * free-text contact role.
   *
   * For email: To + CC merged, in order. For Signal: the single recipient (matched
   * via the principal's Signal identity) or a groupId (never a sole-principal channel,
   * since a group carries other members, so isPrincipal is false there).
   */
  private buildFilterRecipients(request: OutboundSendRequest): {
    recipients: FilterRecipient[];
    principalIncluded: boolean;
    principalIsSoleRecipient: boolean;
  } {
    let tagged: FilterRecipient[];
    if (request.channel === 'email') {
      const emails = [request.to, ...(request.cc ?? [])];
      tagged = emails
        .filter((e) => e.length > 0)
        .map((email) => ({ email, isPrincipal: this.isPrincipalEmail(email) }));
    } else {
      // Signal: tag via the principal's verified Signal identity. A groupId is never
      // the principal's private channel, so it is always a non-principal recipient.
      const identifier = request.recipient ?? request.groupId ?? '';
      const isPrincipal = request.recipient ? this.isPrincipalSignal(request.recipient) : false;
      tagged = identifier.length > 0 ? [{ email: identifier, isPrincipal }] : [];
    }
    return this.finalizeRecipientSet(tagged);
  }

  /**
   * Build the structural recipient set from a flat list of recipient emails.
   * `isPrincipal` is from the principal's verified email identities (isPrincipalEmail),
   * never the contact role. Used by the email draft-send path (drafts are email-only).
   */
  private buildRecipientSet(emails: string[]): {
    recipients: FilterRecipient[];
    principalIncluded: boolean;
    principalIsSoleRecipient: boolean;
  } {
    const tagged: FilterRecipient[] = emails
      .filter((e) => e.length > 0)
      .map((email) => ({ email, isPrincipal: this.isPrincipalEmail(email) }));
    return this.finalizeRecipientSet(tagged);
  }

  /**
   * Deduplicate the tagged recipient list and compute the principal flags.
   * Dedup is by case-insensitive identifier so the same address repeated across
   * To/CC/BCC counts once — otherwise a principal listed twice (e.g. To + CC) would
   * make `principalIsSoleRecipient` false and the judge would run on an effectively
   * single-recipient principal-only send. `principalIsSoleRecipient` is true ONLY when
   * exactly one (deduped) recipient remains and it is the principal.
   */
  private finalizeRecipientSet(tagged: FilterRecipient[]): {
    recipients: FilterRecipient[];
    principalIncluded: boolean;
    principalIsSoleRecipient: boolean;
  } {
    const seen = new Set<string>();
    const recipients: FilterRecipient[] = [];
    for (const r of tagged) {
      const key = r.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      recipients.push(r);
    }
    const principalIncluded = recipients.some((r) => r.isPrincipal);
    const principalIsSoleRecipient = recipients.length === 1 && recipients[0]!.isPrincipal;
    return { recipients, principalIncluded, principalIsSoleRecipient };
  }

  /**
   * After a successful outbound send, ensure the recipient has a confirmed contact record.
   *
   * - If the contact exists and is provisional: promote to confirmed.
   * - If no contact record exists: create one with status confirmed, using the
   *   channel identifier as a placeholder display name (enrichment happens later).
   * - If the contact is already confirmed or blocked: no-op.
   *
   * Fail-open: the message was already sent, so a DB error here must not surface
   * as a send failure. Log at warn so anomalies are visible without alarming callers.
   */
  private async promoteOrCreateRecipientContact(channel: string, recipientId: string): Promise<void> {
    let contact;
    try {
      contact = await this.contactService.resolveByChannelIdentity(channel, recipientId);
    } catch (err) {
      this.log.warn(
        { err, channel, recipientId: redactId(recipientId) },
        'outbound-gateway: contact lookup failed after successful send — recipient may still receive holds on replies',
      );
      return;
    }

    if (contact === null) {
      // No contact record yet — create one so replies from this person are not held.
      // displayName defaults to the identifier (e.g. email address) as a placeholder
      // until the contact is enriched or the CEO assigns a proper name.
      let created;
      try {
        // Explicit tier: the outbound recipient (someone the CEO is emailing) is
        // CEO-trusted — equivalent to the former status='confirmed'→tier='known' path.
        // Set tier='known' explicitly so this intent survives Task 5, which removes
        // createContact's internal status default (#955).
        created = await this.contactService.createContact({
          displayName: recipientId,
          fallbackDisplayName: recipientId,
          source: 'ceo_stated',
          tier: 'known',
        });
      } catch (err) {
        this.log.warn(
          { err, channel, recipientId: redactId(recipientId) },
          'outbound-gateway: createContact failed after successful send — recipient may still receive holds on replies',
        );
        return;
      }

      try {
        await this.contactService.linkIdentity({
          contactId: created.id,
          channel,
          channelIdentifier: recipientId,
          source: 'ceo_stated',
        });
        this.log.info(
          { channel, recipientId: redactId(recipientId), contactId: created.id },
          'outbound-gateway: created confirmed contact for outbound recipient',
        );
      } catch (err) {
        // createContact committed but linkIdentity failed — the contact exists with no
        // channel identity. resolveByChannelIdentity will still return null for this
        // sender on future lookups, so the thread-trust bypass (Fix B) will re-attempt
        // creation. Log at error so an operator can clean up the orphaned contact.
        // TODO: once ContactService exposes a deleteContact method or a transactional
        // createContactWithIdentity helper, use it here to avoid the orphan entirely.
        this.log.error(
          { err, channel, recipientId: redactId(recipientId), orphanedContactId: created.id },
          'outbound-gateway: linkIdentity failed after createContact — orphaned confirmed contact exists; manual cleanup may be needed',
        );
        return;
      }

      // Update confidence score — the message_sent signal gives the contact a
      // non-zero contactConfidence so replies clear the trust floor.
      if (this.confidencePipeline) {
        this.confidencePipeline.incrementalUpdate(created.id, { type: 'message_sent' })
          .catch(err => this.log.warn(
            { err, channel, recipientId: redactId(recipientId), contactId: created.id },
            'outbound-gateway: confidence pipeline update failed after contact creation (non-fatal)',
          ));
      }
      return;
    }

    if (contact.tier === 'blocked') {
      // Anomalous: the send proceeded despite the contact being blocked. This indicates
      // either a race (contact was blocked between the initial check and the send) or
      // a DB error on the earlier blocked-contact check that caused fail-open.
      // Log at error so this is visible in alerting — a message reached a blocked recipient.
      // Uses tier for the gate check (issue #945); tier='blocked' == old status='blocked'.
      this.log.error(
        { channel, recipientId: redactId(recipientId), contactId: contact.contactId },
        'outbound-gateway: sent message to blocked contact — blocked-contact check may have been bypassed due to DB error',
      );
      return;
    }

    if (contact.tier === 'unknown') {
      // tier='unknown' == old status='provisional'. The outbound send implicitly confirms
      // this contact — we know the CEO's system is reaching out to them, so they're trusted
      // enough to receive replies. Promote to 'known' tier (confirmed status).
      // Uses tier for the gate check (issue #945).
      try {
        await this.contactService.setStatus(contact.contactId, 'confirmed');
        this.log.info(
          { channel, recipientId: redactId(recipientId), contactId: contact.contactId },
          'outbound-gateway: promoted unknown-tier contact to known after outbound send',
        );
      } catch (err) {
        this.log.warn(
          { err, channel, recipientId: redactId(recipientId), contactId: contact.contactId },
          'outbound-gateway: setStatus failed after successful send — recipient may still receive holds on replies',
        );
        return;
      }
      // Update confidence score after promotion
      if (this.confidencePipeline) {
        this.confidencePipeline.incrementalUpdate(contact.contactId, { type: 'message_sent' })
          .catch(err => this.log.warn(
            { err, channel, recipientId: redactId(recipientId), contactId: contact.contactId },
            'outbound-gateway: confidence pipeline update failed after promotion (non-fatal)',
          ));
      }
      return;
    }

    // Already confirmed — record the outbound interaction for scoring.
    // Confirmed contacts are the busiest outbound path; omitting them would leave
    // contact_confidence stale for established correspondents.
    if (this.confidencePipeline) {
      this.confidencePipeline.incrementalUpdate(contact.contactId, { type: 'message_sent' })
        .catch(err => this.log.warn(
          { err, channel, recipientId: redactId(recipientId), contactId: contact.contactId },
          'outbound-gateway: confidence pipeline update failed for confirmed contact (non-fatal)',
        ));
    }
  }

  /**
   * Return the IDs of all configured email accounts.
   * Skills use this to iterate across accounts when the caller doesn't know
   * which account owns a resource (e.g. draft discovery in send-draft).
   */
  listAccountIds(): string[] {
    return [...this.nylasClients.keys()];
  }

  /**
   * Fetch a single email message by its Nylas message ID.
   * Read-only — no security filtering applied.
   *
   * @param messageId  Nylas message ID
   * @param accountId  Which account to query. Defaults to the primary account.
   */
  async getEmailMessage(messageId: string, accountId?: string): Promise<NylasMessage> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      throw new Error('outbound-gateway: getEmailMessage called but no nylasClient is configured');
    }
    return client.getMessage(messageId);
  }

  /**
   * Download an email attachment's raw bytes by its Nylas attachment ID.
   * Read-only — no security filtering applied.
   *
   * @param attachmentId  Nylas attachment ID (from email-get's attachments array)
   * @param messageId     ID of the message the attachment belongs to (required by Nylas)
   * @param accountId     Which account to query. Defaults to the primary account.
   */
  async downloadEmailAttachment(
    attachmentId: string,
    messageId: string,
    accountId?: string,
  ): Promise<Buffer> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      throw new Error('outbound-gateway: downloadEmailAttachment called but no nylasClient is configured');
    }
    return client.downloadAttachment(attachmentId, messageId);
  }

  /**
   * List email messages, optionally filtered by the provided options.
   * Read-only — no security filtering applied.
   *
   * @param options    Nylas list-messages query params
   * @param accountId  Which account to query. Defaults to the primary account.
   */
  async listEmailMessages(options?: ListMessagesOptions, accountId?: string): Promise<NylasMessage[]> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      throw new Error('outbound-gateway: listEmailMessages called but no nylasClient is configured');
    }
    return client.listMessages(options);
  }

  /**
   * Create a Nylas draft without sending it — used as a fallback when the autonomy
   * gate blocks a direct send (score too low).
   *
   * Runs the same blocked-contact check as send() but skips the content filter
   * (the filter is designed for messages leaving Curia's control; drafts stay in the
   * mailbox until explicitly sent). The reply goes through the full pipeline when the
   * draft is eventually approved and sent.
   *
   * Drafts are created silently — no notification is sent. The CEO discovers them
   * through the end-of-day Signal digest (see the scheduled digest job) or by checking
   * their Drafts folder directly.
   *
   * TODO(#278): approval interface and send-on-approval remain deferred — see issue for
   * future options (CLI command, Signal reply, webhook).
   */
  async createEmailDraft(request: EmailSendRequest): Promise<OutboundDraftResult> {
    const recipientId = request.to;

    // ------------------------------------------------------------------
    // Blocked contact check
    // ------------------------------------------------------------------
    try {
      const contact = await this.contactService.resolveByChannelIdentity('email', recipientId);
      // Uses tier for the blocked check (issue #945); tier='blocked' == old status='blocked'.
      if (contact !== null && contact.tier === 'blocked') {
        this.log.warn(
          { channel: 'email', recipientId: redactId(recipientId), contactId: contact.contactId },
          'outbound-gateway: draft blocked — recipient is blocked',
        );
        return { success: false, blockedReason: 'Recipient is blocked' };
      }
    } catch (err) {
      // For drafts, fail-closed on contact-resolution errors: a draft created for a
      // blocked contact could be sent by a human later, bypassing the block entirely.
      // Better to drop the draft and surface the error than to silently bypass the check.
      this.log.error(
        { err, channel: 'email', recipientId: redactId(recipientId) },
        'outbound-gateway: contact resolution failed — aborting draft to avoid bypassing block check',
      );
      return { success: false, blockedReason: 'Contact resolution failed; draft not created' };
    }

    return this.dispatchEmailDraft(request);
  }

  /**
   * Send an existing Nylas draft by ID through the full safety pipeline.
   *
   * Unlike send(), which constructs a new message from scratch, this method calls
   * Nylas's drafts.send() endpoint — preserving the draft's full envelope (all To,
   * CC, BCC recipients) and removing the draft from DRAFTS after delivery.
   *
   * Safety pipeline:
   *   0. Autonomy gate — skipped when options.humanApproved is true (CEO in the loop)
   *   1. Blocked-contact check on the primary To recipient
   *   2. Content filter on the draft body
   *   3. Nylas drafts.send() dispatch — sends the actual draft, not a reconstructed copy
   *   4. Recipient contact promotion (provisional → confirmed)
   *
   * Note: PII redaction is not applied here. The draft was created by Curia
   * (content passed through our pipeline at creation time) or authored directly
   * by the CEO. Sending the stored draft as-is is intentional.
   *
   * @param draftId        Nylas draft ID to send
   * @param accountId      Which named account to use. Defaults to the primary account.
   * @param draftMeta      Draft content for safety checks — caller must pre-fetch the draft.
   * @param options        humanApproved: true skips Step 0 only (CEO in the loop).
   */
  async sendEmailDraft(
    draftId: string,
    accountId: string | undefined,
    draftMeta: { recipientEmail: string; body: string; subject: string; allRecipients?: string[] },
    options?: { humanApproved?: boolean; conversationId?: string; taskEventId?: string; parentEventId?: string },
  ): Promise<OutboundSendResult> {
    // ------------------------------------------------------------------
    // Step 0: Autonomy gate
    // ------------------------------------------------------------------
    if (this.autonomyService && options?.humanApproved) {
      this.log.info(
        { draftId },
        'outbound-gateway: autonomy gate skipped — humanApproved flag set (CEO-authorized draft send, see ADR-017)',
      );
    } else if (this.autonomyService && this.isPrincipalEmail(draftMeta.recipientEmail)) {
      // Agent-to-principal: principal-bound draft sends bypass the autonomy gate.
      // Same rationale as the send() principal bypass — see isPrincipalRecipient() comment.
      this.log.info(
        { draftId, channel: 'email' },
        'outbound-gateway: autonomy gate skipped — draft recipient is principal (agent-to-principal communication)',
      );
    } else if (this.autonomyService) {
      try {
        const autonomyConfig = await this.autonomyService.getConfig();
        const sendThreshold = AutonomyService.minScoreForActionRisk('medium');
        if (autonomyConfig !== null && autonomyConfig.score < sendThreshold) {
          this.log.info(
            { draftId, currentScore: autonomyConfig.score, sendThreshold },
            `outbound-gateway: draft send blocked by autonomy gate — score < ${sendThreshold}`,
          );
          this.bus.publish('dispatch', createAutonomySendBlocked({
            channel: 'email',
            currentScore: autonomyConfig.score,
            requiredScore: sendThreshold,
          })).catch((err) => {
            this.log.warn(
              { err, draftId },
              'outbound-gateway: failed to publish autonomy.send_blocked event',
            );
          });
          return {
            success: false,
            blockedReason:
              `Autonomy score is ${autonomyConfig.score} — direct sends require a score of at least ${sendThreshold}. ` +
              `Use createEmailDraft() for drafts, or ask the CEO to raise the score with set-autonomy.`,
          };
        }
      } catch (err) {
        this.log.warn(
          { err, draftId },
          'outbound-gateway: autonomy gate failed to read config — proceeding without gate (fail-open)',
        );
      }
    }

    const { recipientEmail, body } = draftMeta;

    // ------------------------------------------------------------------
    // Step 1: Blocked-contact check
    // ------------------------------------------------------------------
    let recipientTierForDraft: ContactTier = 'unknown';
    let recipientContactIdForDraft: string | undefined;
    try {
      const contact = await this.contactService.resolveByChannelIdentity('email', recipientEmail);
      if (contact !== null) {
        // Uses tier for the blocked check (issue #945); tier='blocked' == old status='blocked'.
        if (contact.tier === 'blocked') {
          this.log.warn(
            { draftId, recipientId: redactId(recipientEmail), contactId: contact.contactId },
            'outbound-gateway: draft send blocked — recipient is blocked',
          );
          return { success: false, blockedReason: 'Recipient is blocked' };
        }
        recipientTierForDraft = contact.tier;
        recipientContactIdForDraft = contact.contactId; // hoisted for outbound.delivered audit
      }
    } catch (err) {
      // Fail-open on DB errors — log at warn so anomalies are visible, but don't
      // silently block a CEO-authorized send due to a transient infrastructure error.
      this.log.warn(
        { err, draftId, recipientId: redactId(recipientEmail) },
        'outbound-gateway: contact resolution failed, proceeding without blocked check',
      );
    }

    // ------------------------------------------------------------------
    // Step 2: Content filter
    // ------------------------------------------------------------------
    // Run on the draft body. The draft is sent as-is by Nylas (PII redaction is not
    // applied — see method doc), but we still run the content filter to catch any
    // flagged patterns before committing to sending. Fail-closed on filter crash.
    let filterPassed = false;
    let filterFindings: Array<{ rule: string; detail: string }> = [];

    // Build the audience set from the draft's full envelope (To + CC + BCC) so a draft
    // addressed To: principal with a CC'd/BCC'd third party still runs the judge.
    // Falls back to the single primary recipient when allRecipients is not supplied.
    const draftEnvelope = (draftMeta.allRecipients && draftMeta.allRecipients.length > 0)
      ? draftMeta.allRecipients
      : [recipientEmail];
    const { recipients: draftRecipients, principalIncluded: draftPrincipalIncluded, principalIsSoleRecipient: draftPrincipalSole } = this.buildRecipientSet(draftEnvelope);

    try {
      const filterResult = await this.contentFilter.check({
        content: body,
        recipientEmail,
        conversationId: '',
        channelId: 'email',
        recipientTier: recipientTierForDraft,
        recipients: draftRecipients,
        principalIncluded: draftPrincipalIncluded,
        principalIsSoleRecipient: draftPrincipalSole,
      });
      filterPassed = filterResult.passed;
      filterFindings = filterResult.findings;
    } catch (err) {
      this.log.warn(
        { err, draftId, recipientId: redactId(recipientEmail) },
        'outbound-gateway: content filter threw — treating as blocked (fail-closed)',
      );
      filterPassed = false;
      filterFindings = [{ rule: 'filter-error', detail: 'Content filter threw an unexpected error' }];
    }

    if (!filterPassed) {
      const ruleNames = filterFindings.map((f) => f.rule).join('; ');
      this.log.warn(
        { draftId, recipientId: redactId(recipientEmail), rules: ruleNames },
        'outbound-gateway: draft send blocked by content filter',
      );

      const blockId = `block_${randomUUID()}`;
      const fullReason = filterFindings.map((f) => `${f.rule}: ${f.detail}`).join('; ');

      const blockedEvent = createOutboundBlocked({
        blockId,
        conversationId: '',
        channelId: 'email',
        content: body,
        recipientId: recipientEmail,
        reason: fullReason,
        findings: filterFindings,
        parentEventId: '',
      });
      try {
        await this.bus.publish('dispatch', blockedEvent);
      } catch (publishErr) {
        this.log.warn(
          { publishErr, blockId },
          'outbound-gateway: failed to publish outbound.blocked event — draft send is still blocked',
        );
      }

      const principalEmailForDraftBlock = this.principalIdentities.find((id) => id.channel === 'email')?.channelIdentifier;
      if (principalEmailForDraftBlock) {
        await this.sendNotification(
          {
            notificationType: 'blocked_content',
            ceoEmail: principalEmailForDraftBlock,
            subject: 'Action needed — blocked draft send',
            body: [
              'A draft send was blocked by the content filter.',
              '',
              `Block ID: ${blockId}`,
              `Draft ID: ${draftId}`,
              `Intended recipient: ${recipientEmail}`,
              '',
              'Please review the audit log for details.',
            ].join('\n'),
            blockId,
            originalChannel: 'email',
            originalRecipientId: recipientEmail,
          },
          blockedEvent.id,
        );
      } else {
        this.log.error(
          { blockId, draftId, recipientId: redactId(recipientEmail) },
          'outbound-gateway: principal notification skipped for blocked draft — no principal email identity configured',
        );
      }
      return { success: false, blockedReason: 'Content blocked by filter' };
    }

    // ------------------------------------------------------------------
    // Step 3: Dispatch via Nylas drafts.send() — sends the actual draft
    // ------------------------------------------------------------------
    const nylasClient = this.getNylasClient(accountId);
    if (!nylasClient) {
      return {
        success: false,
        blockedReason: `Email client not configured for account: ${accountId ?? 'primary'}`,
      };
    }

    let sentMessage: NylasMessage;
    try {
      sentMessage = await nylasClient.sendDraft(draftId);
      this.log.info(
        { messageId: sentMessage.id, draftId, accountId, recipientId: redactId(recipientEmail) },
        'outbound-gateway: draft sent successfully',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        { err, draftId, accountId },
        'outbound-gateway: Nylas sendDraft failed',
      );
      return { success: false, blockedReason: `Draft send failed: ${message}` };
    }

    // ------------------------------------------------------------------
    // Step 4: Contact promotion (same as send())
    // ------------------------------------------------------------------
    await this.promoteOrCreateRecipientContact('email', recipientEmail);

    // Emit the audit event — sendEmailDraft() is a genuine wire send and must
    // produce the same outbound.delivered record as send().
    await this.publishDelivered({
      channel: 'email',
      recipientId: recipientEmail,
      recipientContactId: recipientContactIdForDraft,
      content: body,
      messageId: sentMessage.id,
      conversationId: options?.conversationId,
      taskEventId: options?.taskEventId,
      parentEventId: options?.parentEventId,
    });

    return { success: true, messageId: sentMessage.id };
  }

  /**
   * Retrieve the E.164 phone numbers of all current (non-pending) members of a
   * Signal group. Curia's own phone number is excluded so callers can pass the
   * result directly to trust-check logic without filtering.
   *
   * Throws if:
   *   - Signal client is not configured
   *   - The group is not found in the account's group list
   *   - The signal-cli RPC call fails
   */
  async getSignalGroupMembers(groupId: string): Promise<string[]> {
    if (!this.signalClient) {
      throw new Error('outbound-gateway: Signal client not configured');
    }

    const groups = await this.signalClient.listGroups();
    const group = groups.find((g) => g.id === groupId);

    if (!group) {
      // Log only the presence of a group ID — not the ID value itself (may be sensitive).
      this.log.warn({ hasGroupId: !!groupId }, 'outbound-gateway: getSignalGroupMembers — group not found');
      throw new Error('outbound-gateway: group not found');
    }

    // Exclude Curia's own number — it would otherwise resolve to Curia's own contact
    // record and could skew trust checks (Curia trusts itself, but it shouldn't count
    // as a "verified member" of the group for trust-check purposes).
    return group.members
      .map((m) => m.number)
      .filter((phone): phone is string => !!phone && phone !== this.signalPhoneNumber);
  }

  /**
   * Archive an email message by removing it from the INBOX folder.
   *
   * Routes to the NylasClient for the given accountId (primary account when absent).
   * Does NOT run the content filter or blocked-contact check — archiving is a
   * read-move operation, not an outbound communication.
   *
   * @param messageId  Nylas message ID to archive
   * @param accountId  Named account (e.g. "joseph"). Defaults to the primary account.
   */
  async archiveEmailMessage(
    messageId: string,
    accountId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      return {
        success: false,
        error: `No email client configured for account: ${accountId ?? 'primary'}`,
      };
    }

    try {
      await client.archiveMessage(messageId);
      this.log.info({ messageId, accountId }, 'outbound-gateway: message archived');
      return { success: true };
    } catch (err) {
      this.log.error({ err, messageId, accountId }, 'outbound-gateway: archiveEmailMessage failed');
      return { success: false, error: 'Archive failed' };
    }
  }

  /**
   * List all folders/labels in an email account.
   * For Gmail, returns both system folders (INBOX, SENT, etc.) and user-created labels.
   */
  async listEmailFolders(
    accountId?: string,
  ): Promise<NylasFolder[]> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      throw new Error(`outbound-gateway: listEmailFolders called but no email client configured for account: ${accountId ?? 'primary'}`);
    }
    return client.listFolders();
  }

  /**
   * Create a new folder/label in an email account. For Gmail, creates a user label.
   */
  async createEmailFolder(
    name: string,
    accountId?: string,
  ): Promise<NylasFolder> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      throw new Error(`outbound-gateway: createEmailFolder called but no email client configured for account: ${accountId ?? 'primary'}`);
    }
    return client.createFolder(name);
  }

  /**
   * Mark an email message as read.
   */
  async markEmailAsRead(
    messageId: string,
    accountId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      return {
        success: false,
        error: `No email client configured for account: ${accountId ?? 'primary'}`,
      };
    }

    try {
      await client.markAsRead(messageId);
      this.log.info({ messageId, accountId }, 'outbound-gateway: message marked as read');
      return { success: true };
    } catch (err) {
      this.log.error({ err, messageId, accountId }, 'outbound-gateway: markEmailAsRead failed');
      return { success: false, error: 'Mark as read failed' };
    }
  }

  /**
   * Apply one or more labels to an email message. Resolves label names to Gmail
   * folder IDs, creating any labels that don't yet exist. Preserves existing
   * folders on the message (merge, not replace).
   *
   * @returns Applied and created label names, or an error.
   */
  async labelEmailMessage(
    messageId: string,
    labels: string[],
    accountId?: string,
  ): Promise<{ success: boolean; applied: string[]; created: string[]; folders: string[]; error?: string }> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      return {
        success: false,
        applied: [],
        created: [],
        folders: [],
        error: `No email client configured for account: ${accountId ?? 'primary'}`,
      };
    }

    // Declared outside try so partial progress is reported on failure.
    // If label creation succeeds (commits server-side) but a later step fails,
    // the caller still sees which labels were created as a side effect.
    const created: string[] = [];
    const resolvedIds: string[] = [];

    try {
      // Step 1: List existing folders to build a name → ID lookup
      const existingFolders = await client.listFolders();
      const foldersByName = new Map<string, NylasFolder>(
        existingFolders.map((f) => [f.name.toUpperCase(), f]),
      );

      // Step 2: Resolve each label to a folder ID, creating if needed
      for (const label of labels) {
        const key = label.toUpperCase();
        let folder = foldersByName.get(key);

        if (!folder) {
          this.log.info({ label, accountId }, 'outbound-gateway: creating new label');
          folder = await client.createFolder(label);
          foldersByName.set(key, folder);
          created.push(label);
        }

        resolvedIds.push(folder.id);
      }

      // Step 3: Read current message folders
      const msg = await client.getMessage(messageId);
      const currentFolders = new Set(msg.folders);

      // Step 4: Merge — add new folder IDs without removing existing ones
      for (const id of resolvedIds) {
        currentFolders.add(id);
      }

      const mergedFolders = [...currentFolders];

      // Step 5: Write back the merged folder set
      const result = await client.updateMessageFolders(messageId, mergedFolders);
      const finalFolders = result.folders.length > 0 ? result.folders : mergedFolders;

      this.log.info(
        { messageId, applied: labels, created, accountId },
        'outbound-gateway: labels applied',
      );

      return { success: true, applied: labels, created, folders: finalFolders };
    } catch (err) {
      this.log.error({ err, messageId, labels, accountId, created }, 'outbound-gateway: labelEmailMessage failed');
      return { success: false, applied: [], created, folders: [], error: 'Label operation failed' };
    }
  }

  /**
   * Link a draft (or other fallback result) to a gated action_log row.
   * Called by channel adapters after they create their fallback artifact.
   * No-op when actionLogRepo is not wired or actionRef doesn't match a pending row.
   *
   * taskEventId adds a secondary task_id scope as a defensive measure. short_ref is
   * globally unique (migration 033), so collisions across tasks cannot occur under
   * normal operation — the scope guards against any data inconsistency.
   * When absent, the match is by short_ref + outcome alone (backwards compatibility).
   */
  async linkGatedAction(
    actionRef: string,
    taskEventId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.actionLogRepo) return;
    try {
      const updated = await this.actionLogRepo.linkPayload(actionRef, taskEventId, payload);
      if (!updated) {
        this.log.warn(
          { actionRef, taskEventId },
          'outbound-gateway: linkGatedAction found no pending row for actionRef — may have expired or been cleaned up',
        );
      }
    } catch (err) {
      this.log.error(
        { err, actionRef, taskEventId },
        'outbound-gateway: linkGatedAction DB call failed — action_log row will not have draft_id linked',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Return the NylasClient for the given accountId, or the primary client if
   * accountId is absent. Returns undefined when no clients are configured.
   */
  private getNylasClient(accountId?: string): NylasClient | undefined {
    if (this.nylasClients.size === 0) return undefined;
    if (accountId) {
      const client = this.nylasClients.get(accountId);
      if (!client) {
        // Do NOT fall back to the primary account — sending from the wrong account
        // (wrong From address, wrong mailbox) is a correctness failure, not a graceful
        // degradation. The caller will receive undefined and return { success: false }.
        this.log.error(
          { accountId, availableAccounts: [...this.nylasClients.keys()] },
          'outbound-gateway: no NylasClient found for accountId — operation cannot proceed',
        );
        return undefined;
      }
      return client;
    }
    return this.primaryNylasClient;
  }

  /**
   * Create a Nylas draft without sending.
   * Called from createEmailDraft() after the blocked-contact check passes.
   */
  private async dispatchEmailDraft(request: EmailSendRequest): Promise<OutboundDraftResult> {
    const nylasClient = this.getNylasClient(request.accountId);
    if (!nylasClient) {
      const available = [...this.nylasClients.keys()];
      const reason = request.accountId
        ? `unknown account '${request.accountId}'; available: [${available.join(', ')}]`
        : 'Email client not configured';
      return { success: false, blockedReason: reason };
    }

    // htmlQuote is appended after conversion so it is not re-escaped by markdownToHtml.
    const htmlBody = markdownToHtml(request.body) + (request.htmlQuote ?? '');

    let attachments: AttachmentContent[] | undefined;
    if (request.attachments && request.attachments.length > 0) {
      try {
        attachments = await readAttachmentFiles(request.attachments, MAX_ATTACHMENT_BYTES);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, blockedReason: `Attachment error: ${message}` };
      }
    }

    try {
      const sendOptions: SendEmailOptions = {
        to: [{ email: request.to }],
        cc: request.cc?.map((email) => ({ email })),
        subject: request.subject ?? '',
        body: htmlBody,
        replyToMessageId: request.replyToMessageId,
        attachments,
      };

      const draft = await nylasClient.createDraft(sendOptions);

      this.log.info(
        { draftId: draft.id, channel: 'email', to: request.to, accountId: request.accountId },
        'outbound-gateway: draft created successfully',
      );

      return { success: true, draftId: draft.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        { err, channel: 'email', to: request.to, accountId: request.accountId },
        'outbound-gateway: Nylas createDraft failed',
      );
      return { success: false, blockedReason: `Draft creation failed: ${message}` };
    }
  }

  /**
   * Dispatch a send request to Nylas for email delivery.
   * Maps our flat request shape into the SendEmailOptions the NylasClient expects.
   */
  private async dispatchEmail(request: EmailSendRequest): Promise<OutboundSendResult> {
    const nylasClient = this.getNylasClient(request.accountId);
    if (!nylasClient) {
      return { success: false, blockedReason: 'Email client not configured' };
    }

    // markdownToHtml is a pure function (no I/O, no realistic throw path).
    // Called outside the Nylas try-catch so that any future regression in the
    // converter is not silently misattributed as "Nylas send failed" in logs.
    // htmlQuote is appended after conversion so it is not re-escaped by markdownToHtml.
    const htmlBody = markdownToHtml(request.body) + (request.htmlQuote ?? '');

    let attachments: AttachmentContent[] | undefined;
    if (request.attachments && request.attachments.length > 0) {
      try {
        attachments = await readAttachmentFiles(request.attachments, MAX_ATTACHMENT_BYTES);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, blockedReason: `Attachment error: ${message}` };
      }
    }

    try {
      const sendOptions: SendEmailOptions = {
        to: [{ email: request.to }],
        cc: request.cc?.map((email) => ({ email })),
        subject: request.subject ?? '',
        body: htmlBody,
        replyToMessageId: request.replyToMessageId,
        attachments,
      };

      const sent = await nylasClient.sendMessage(sendOptions);

      this.log.info(
        { messageId: sent.id, channel: 'email', to: request.to, accountId: request.accountId },
        'outbound-gateway: message sent successfully',
      );

      return { success: true, messageId: sent.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        { err, channel: 'email', to: request.to },
        'outbound-gateway: Nylas send failed',
      );
      return { success: false, blockedReason: `Send failed: ${message}` };
    }
  }

  /**
   * Dispatch a send request to signal-cli for Signal delivery.
   * Calls the signal-cli JSON-RPC `send` method via the RPC client.
   */
  private async dispatchSignal(request: SignalOutboundRequest): Promise<OutboundSendResult> {
    if (!this.signalClient) {
      return { success: false, blockedReason: 'Signal client not configured' };
    }

    if (!this.signalPhoneNumber) {
      // Wiring bug in index.ts — signalClient without signalPhoneNumber should never happen.
      this.log.error(
        { channel: 'signal' },
        'outbound-gateway: signalClient is set but signalPhoneNumber is missing — check index.ts wiring',
      );
      return { success: false, blockedReason: 'Signal phone number not configured' };
    }

    if (!request.recipient && !request.groupId) {
      this.log.warn({ channel: 'signal' }, 'outbound-gateway: Signal send has neither recipient nor groupId');
      return { success: false, blockedReason: 'Signal send requires either recipient or groupId' };
    }

    if (request.recipient && request.groupId) {
      // Both set is a caller bug — signal-cli would send to both or error unpredictably.
      // Fail fast with a clear error rather than silently mis-routing.
      // Don't log the actual values — phone numbers and group IDs are PII.
      this.log.warn(
        { channel: 'signal' },
        'outbound-gateway: Signal send has both recipient and groupId set — exactly one required',
      );
      return { success: false, blockedReason: 'Signal send must specify exactly one of recipient or groupId, not both' };
    }

    try {
      await this.signalClient.send({
        account: this.signalPhoneNumber,
        // signal-cli takes recipient as an array; single-element for 1:1 sends
        recipient: request.recipient ? [request.recipient] : undefined,
        groupId: request.groupId,
        message: request.message,
      });

      // Log destination type (1:1 vs group) but not the actual number/ID — PII.
      this.log.info(
        { channel: 'signal', destinationType: request.groupId ? 'group' : '1:1' },
        'outbound-gateway: Signal message sent successfully',
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log destination type only — phone numbers and group IDs are PII.
      this.log.error(
        { err, channel: 'signal', destinationType: request.groupId ? 'group' : '1:1' },
        'outbound-gateway: signal-cli send failed',
      );
      return { success: false, blockedReason: `Send failed: ${message}` };
    }
  }
}
