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
//   1. Add `src/channels/<name>/outbound-request.ts` and contribute
//      `extractRecipients` on that channel's `principal-rules.ts` (ADR-035) —
//      recipient projection for principal tagging needs no gateway edit.
//   2. Re-export the new request variant into OutboundSendRequest below
//      (public API union) and add the channel client to OutboundGatewayConfig.
//   3. Add a private dispatch<Channel>() method and a branch in send() to call it.
//   The blocked-contact check and content filter in send() are channel-agnostic and
//   run for all channels before dispatch. Principal identity compare + Gate C
//   carve-out live on PrincipalChannelRules (ADR-034).

import { randomUUID } from 'node:crypto';
import type { NylasClient, NylasMessage, NylasFolder, ListMessagesOptions, SendEmailOptions, AttachmentContent } from '../channels/email/nylas-client.js';
import { readAttachmentFiles, MAX_ATTACHMENT_BYTES, type OutboundAttachmentInput } from './_shared/read-attachments.js';
import type { EmailRecipientSource, EmailSendRequest } from '../channels/email/outbound-request.js';
import type { SignalOutboundRequest } from '../channels/signal/outbound-request.js';
import type { SlackOutboundRequest } from '../channels/slack/outbound-request.js';
import type { SmsOutboundRequest } from '../channels/sms/outbound-request.js';
import type { SignalRpcClient } from '../channels/signal/signal-rpc-client.js';
import type { SlackClient } from '../channels/slack/slack-client.js';
import type { SmsClient } from '../channels/sms/sms-client.js';
import { TelnyxSendError } from '../channels/sms/sms-client.js';
import { TELNYX_ERROR_OPTED_OUT } from '../channels/sms/types.js';
import type { ContactService } from '../contacts/contact-service.js';
import { classifyEmailSender } from '../contacts/contact-service.js';
import type { ContactTier, ChannelIdentity } from '../contacts/types.js';
import {
  isPrincipalIdentity,
  computePrincipalIsSoleRecipient,
} from '../contacts/principal-recipient.js';
import { findPrincipalChannelRules } from '../contacts/principal-channel-registry.js';
import type { ProjectedRecipient } from '../contacts/principal-channel-rules.js';
import type { OutboundContentFilter, FilterRecipient } from '../dispatch/outbound-filter.js';
import type { PiiRedactor } from '../dispatch/pii-redactor.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createOutboundBlocked, createOutboundDelivered, createOutboundNotification, createAutonomySendBlocked } from '../bus/events.js';
import type { ChannelReconnectEvent } from '../bus/events.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
import { markdownToMrkdwn } from '../format/markdown-to-mrkdwn.js';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import { generateShortRef } from '../autonomy/approval-trigger.js';
import {
  buildApprovalNotificationBody,
  enrichGatewayApprovalPayload,
  resolveNotificationRecipientTier,
} from '../autonomy/approval-notification.js';
import { deliverApprovalToChatChannels } from '../autonomy/approval-channel-notify.js';
import type { OutboundNotificationPayload } from '../bus/events.js';
import { markdownToHtml } from '../format/markdown-to-html.js';
import { scrubPii } from '../pii/scrubber.js';
import type { ExportControlService } from '../security/export-controls.js';
import {
  ExportControlService as ExportControlServiceClass,
  extractDestinationFromEmailRequest,
  formatDestination,
} from '../security/export-controls.js';
import { OutboundQueueFullError, type OutboundQueueRepo } from './outbound-queue-repo.js';
import type { ExportItem } from '../security/export-controls.js';
import type { ConversationEntityState } from '../entity-context/conversation-entities.js';
import { describeUnresolvedIdentity, emailLocalNameTokens } from '../agents/resolved-entities.js';
import type { IdentityGateMode } from '../config.js';
import type { ErrorType } from '../errors/types.js';
import type { CallBudget } from '../util/call-budget.js';
import { nylasMessageFailure } from '../channels/email/nylas-message-id.js';
import {
  PRINCIPAL_RECIPIENT_ALIAS,
  parseRecipientReference,
  resolveRecipientReference,
  type RecipientReferenceFields,
  type RecipientResolution,
} from './_shared/recipient-reference.js';

// ---------------------------------------------------------------------------
// Public types — request variants owned by channel packages; re-exported here
// so existing callers keep a stable import path (public API surface).
// ---------------------------------------------------------------------------

export type { EmailSendRequest } from '../channels/email/outbound-request.js';
export type { SignalOutboundRequest } from '../channels/signal/outbound-request.js';
export type { SlackOutboundRequest } from '../channels/slack/outbound-request.js';
export type { SmsOutboundRequest } from '../channels/sms/outbound-request.js';

// Re-export so callers can construct attachment lists without importing from read-attachments directly.
export type { OutboundAttachmentInput };

/**
 * Discriminated union of all supported outbound send requests.
 * Variants live in `src/channels/<name>/outbound-request.ts`; re-export the new
 * variant into this union when adding a channel (delivery dispatch still needs
 * a gateway branch — recipient projection for principal tagging does not).
 *
 * Note: OutboundSendRequest is a public API surface — adding a new variant is
 * backwards-compatible, but changing existing field names or types is a breaking
 * change that must be called out in CHANGELOG.md.
 */
export type OutboundSendRequest =
  | EmailSendRequest
  | SignalOutboundRequest
  | SlackOutboundRequest
  | SmsOutboundRequest;

// Re-export the old name as an alias so existing callers don't break.
// Previously OutboundSendRequest was a single interface (email-only). Now it's a
// discriminated union. Callers that typed a variable as OutboundSendRequest and
// passed it to send() continue to work unchanged — the union is a superset.
// This alias exists purely for documentation; the type itself is unchanged in
// terms of what email callers already do.
export type { OutboundSendRequest as OutboundEmailSendRequest };

/**
 * Queue JSON is untyped. Only the exact `email_participant` opt-in counts;
 * any other value, including rows queued before #2071, fails closed.
 * The display name is used only for that opt-in's duplicate check.
 */
function emailProvenanceFromPayload(payload: EmailSendRequest): {
  source?: EmailRecipientSource;
  displayName?: string;
} {
  if (payload.recipientSource !== 'email_participant') return {};
  const rawName = payload.recipientDisplayName;
  const displayName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined;
  return {
    source: 'email_participant',
    ...(displayName ? { displayName } : {}),
  };
}

export interface OutboundSendResult {
  success: boolean;
  messageId?: string;
  /** Human-readable reason when success is false */
  blockedReason?: string;
  /**
   * Content-filter rule name(s) that triggered a block (e.g. `llm-judge-audience-leak`).
   * Populated by both `send()` (#1051) and `sendEmailDraft()` (#1158) when the content
   * filter rejects the send, giving the agent's tool loop the specific rule category so
   * it can address the root cause and retry. Rule names only — never the (potentially
   * sensitive) finding detail.
   *
   * Optional because non-filter block paths (blocked recipient, autonomy gate, client
   * misconfiguration) set `blockedReason` without a rule set — callers must treat absence
   * as "no rule info available".
   */
  blockedRules?: string[];
  /**
   * Recipients of a blocked send that match no contact, or only an unverified
   * identity (#2033). Set only on filter blocks, and only when the contact lookup
   * succeeded; `blockedReason` already carries the agent-facing note.
   */
  unmatchedRecipients?: string[];
  /** True when the autonomy gate blocked this send */
  gated?: boolean;
  /** Short reference for the action_log row (e.g. 'a3f7c12b'). Present when gated is true. */
  actionRef?: string;
  /**
   * True when the send was durably queued because the channel transport was down (#1380).
   * `success` is still true — the message was accepted for later delivery, not dropped.
   */
  queued?: boolean;
  /**
   * When success is false, hints that the failure is transport/availability related
   * and the gateway may enqueue for later retry on queueable channels (#1380).
   * Permanent failures (opt-out, validation) must leave this unset/false.
   */
  queueable?: boolean;
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

  /**
   * Slack Socket Mode / Web API client. Optional — only when Slack channel is enabled.
   */
  slackClient?: SlackClient;

  /**
   * Telnyx SMS client. Optional — only when SMS channel is enabled.
   */
  smsClient?: SmsClient;

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

  /**
   * Conversation-scoped resolved contacts (#1818). When set, a send to a
   * non-principal recipient is blocked if the body has an unconfirmed-name
   * hedge, or an unresolved name next to an invitation or attendance cue.
   * Other names are not blocked. Absent in tests and in boots that have no
   * database — the gate is skipped.
   */
  conversationEntities?: ConversationEntityState;

  /**
   * Kill switch for the identity gate (#1818). `enforce` blocks, `shadow`
   * logs the block and sends, `off` does not inspect the text. Default
   * `enforce` when omitted, including in tests.
   */
  identityGate?: IdentityGateMode;

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

  /**
   * Bulk export gate service (#201) — enforces item-count threshold, destination
   * allowlisting, and restricted sensitivity ceiling on email attachments.
   */
  exportControlService?: ExportControlService;

  /**
   * Durable outbound queue for disconnected / unavailable channels (#1380).
   * Channels that opt in via `Channel.supportsOutboundQueue` are registered in
   * `outboundQueueReadiness`; post-policy sends are persisted while not ready
   * (or when dispatch returns `queueable: true`) and flushed on `channel.reconnect`.
   */
  outboundQueue?: OutboundQueueRepo;
  /**
   * Readiness probes for queueable channels, keyed by channel name (`signal`,
   * `slack`, `sms`, `email`, …). Built at bootstrap from each adapter's `isOutboundReady`
   * (or the underlying client). Absent channels are never auto-queued.
   */
  outboundQueueReadiness?: ReadonlyMap<string, () => boolean>;
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
 * principal notification body. The summary gives the principal something actionable without
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

/**
 * A blocked send's recipient that the contact lookup could not tie to a confirmed
 * address (#2033): no contact at all, or a match on an unverified identity only.
 * The second covers a mistyped address that was delivered once before: the gateway
 * recorded it as an unverified `outbound_recipient` contact, and it must not stop
 * counting as suspect from then on.
 */
export interface UnmatchedRecipient {
  identifier: string;
  reason: 'no-contact' | 'unverified';
}

/**
 * Agent-facing note for a blocked send whose recipient matches no contact (#2033).
 *
 * Block reasons describe the content, so an agent with a mistyped address edits
 * the message until it passes. On 2026-10-07 that loop delivered principal-facing
 * content to an invented domain on the fifth try. Naming the recipient points the
 * agent at the address first.
 */
export function formatUnmatchedRecipientNote(unmatched: readonly UnmatchedRecipient[]): string {
  const sentence = (ids: string[], verbOne: string, verbMany: string, rest: string) =>
    ids.length === 0 ? '' : `${ids.join(', ')} ${ids.length === 1 ? verbOne : verbMany} ${rest} `;
  const none = unmatched.filter((u) => u.reason === 'no-contact').map((u) => u.identifier);
  const unverified = unmatched.filter((u) => u.reason === 'unverified').map((u) => u.identifier);
  return (
    'Recipient check: ' +
    sentence(none, 'matches', 'match', 'no known contact.') +
    sentence(unverified, 'matches', 'match', 'only an unverified contact address, one nobody has confirmed.') +
    `The block may be about who this is going to, not what it says. Check the recipient before you rewrite ` +
    `the message. To reach a known person, send by their contact ID, or "${PRINCIPAL_RECIPIENT_ALIAS}" for ` +
    'the principal, instead of typing an address.'
  );
}

/**
 * The recipient lines of the principal's "outbound message blocked" FYI, marking
 * any recipient that matches no contact (#2033). The 2026-10-07 FYIs read as
 * content problems while the address was the problem.
 */
function unmatchedRecipientNotificationLines(intended: string, unmatched: readonly UnmatchedRecipient[]): string[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const label = (u: UnmatchedRecipient) => (u.reason === 'no-contact' ? 'matches no known contact' : 'unverified contact address');
  const forIntended = unmatched.find((u) => same(u.identifier, intended));
  const others = unmatched.filter((u) => !same(u.identifier, intended));
  return [
    `Intended recipient: ${intended}${forIntended ? ` (${label(forIntended)})` : ''}`,
    ...(others.length > 0
      ? [`Other recipients to check: ${others.map((u) => `${u.identifier} (${label(u)})`).join(', ')}`]
      : []),
  ];
}

/**
 * A pending-approval payload for display, minus recipient fields that hold a
 * contact reference (#2033). The caller fills those from the resolved request,
 * so the principal approves a send to an address, not to a bare contact UUID.
 * The stored payload keeps the reference; approval re-resolves it.
 */
function withoutRecipientReferences(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => {
      if (typeof value !== 'string') return true;
      // to / recipient hold one reference; cc holds a list that may mix them in.
      if (key === 'to' || key === 'recipient') return parseRecipientReference(value) === null;
      if (key === 'cc') return !value.split(',').some((entry) => parseRecipientReference(entry) !== null);
      return true;
    }),
  );
}

/** Node.js network-error `code` values that indicate a transient, retryable failure. */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
]);

/**
 * True when an error carries a **structured** signal that it is transient/retryable —
 * an HTTP status of 408/429/5xx (`statusCode`/`status`) or a Node network-error `code` —
 * independent of its message text. Callers OR this with a message-regex fallback so a
 * retryable failure is not misclassified as permanent just because the provider only
 * stringified it (#1380 review). Auth/validation (4xx other than 408/429) is not matched.
 */
export function hasTransientErrorSignal(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: unknown; status?: unknown; code?: unknown };
  const status = typeof e.statusCode === 'number' ? e.statusCode
    : typeof e.status === 'number' ? e.status
      : undefined;
  if (status !== undefined && (status === 408 || status === 429 || status >= 500)) return true;
  return typeof e.code === 'string' && TRANSIENT_ERROR_CODES.has(e.code);
}

/**
 * A named mailbox is not in the configured Nylas client map.
 * Gate C returns this message to the agent instead of escalating (#1832).
 */
export class UnknownEmailAccountError extends Error {
  readonly accountId: string;

  constructor(accountId: string, available: readonly string[]) {
    super(`unknown account '${accountId}'; available: [${available.join(', ')}]`);
    this.name = 'UnknownEmailAccountError';
    this.accountId = accountId;
  }
}

// ---------------------------------------------------------------------------
// OutboundGateway
// ---------------------------------------------------------------------------

export class OutboundGateway {
  /** All configured email accounts: accountId → NylasClient. */
  private readonly nylasClients: Map<string, NylasClient>;
  /**
   * The primary NylasClient — first entry in nylasClients, used for system
   * notifications (blocked-content principal alerts) when no accountId is specified.
   */
  private readonly primaryNylasClient: NylasClient | undefined;
  private readonly signalClient?: SignalRpcClient;
  private readonly signalPhoneNumber?: string;
  private readonly slackClient?: SlackClient;
  private readonly smsClient?: SmsClient;
  private readonly contactService: ContactService;
  private readonly contentFilter: OutboundContentFilter;
  private readonly bus: EventBus;
  private readonly principalIdentities: ChannelIdentity[];
  private readonly conversationEntities?: ConversationEntityState;
  private readonly identityGate: IdentityGateMode;
  private readonly log: Logger;
  private readonly autonomyService?: AutonomyService;
  private readonly piiRedactor?: PiiRedactor;
  private readonly actionLogRepo?: ActionLogRepo;
  private readonly confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
  private readonly exportControlService?: ExportControlService;
  private readonly outboundQueue?: OutboundQueueRepo;
  private readonly outboundQueueReadiness: Map<string, () => boolean>;
  private flushInFlight = new Set<string>();
  /** Backoff timers for HTTP channels that queued on a transient failure (#1380). */
  private flushRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: OutboundGatewayConfig) {
    this.nylasClients = config.nylasClients ?? new Map();
    this.primaryNylasClient = this.nylasClients.values().next().value;
    this.signalClient = config.signalClient;
    this.signalPhoneNumber = config.signalPhoneNumber;
    this.slackClient = config.slackClient;
    this.smsClient = config.smsClient;
    this.contactService = config.contactService;
    this.contentFilter = config.contentFilter;
    this.bus = config.bus;
    this.principalIdentities = config.principalIdentities ?? [];
    this.conversationEntities = config.conversationEntities;
    this.identityGate = config.identityGate ?? 'enforce';
    this.log = config.logger.child({ component: 'outbound-gateway' });
    this.autonomyService = config.autonomyService;
    this.piiRedactor = config.piiRedactor;
    this.actionLogRepo = config.actionLogRepo;
    this.confidencePipeline = config.confidencePipeline;
    this.exportControlService = config.exportControlService;
    this.outboundQueue = config.outboundQueue;
    this.outboundQueueReadiness = new Map(config.outboundQueueReadiness ?? []);
  }

  /**
   * Register or replace a channel's outbound-queue readiness probe (#1380).
   * Called when an adapter that sets `supportsOutboundQueue` is constructed —
   * SMS readiness depends on adapter start/stop, which happens after gateway boot.
   */
  setOutboundQueueReadiness(channel: string, isReady: () => boolean): void {
    this.outboundQueueReadiness.set(channel, isReady);
  }

  /**
   * Subscribe to `channel.reconnect` so queued messages flush when a transport
   * comes back (#1380). Call once after construction.
   */
  start(): void {
    if (!this.outboundQueue) return;
    this.bus.subscribe('channel.reconnect', 'system', (event) => {
      const e = event as ChannelReconnectEvent;
      void this.flushChannel(e.payload.channel).catch((err) => {
        this.log.error({ err, channel: e.payload.channel }, 'outbound-gateway: queue flush failed');
      });
    });
    this.log.info('Outbound gateway queue flush subscriber registered');
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
   * @param options.skipNotificationOnBlock  When true, suppress the principal notification
   *   if the content filter blocks this message. Used by the EmailAdapter's
   *   outbound.notification subscriber to break the recursion cycle: without this
   *   guard, a broken content filter (crash → fail-closed) would trigger
   *   send → block → sendNotification → EmailAdapter → send → block → ... infinitely.
   * @param options.humanApproved  When true, skip Step 0 (autonomy gate) only.
   *   The principal is explicitly in the loop. All other safety checks (blocked-contact,
   *   content filter) run normally. See ADR-017.
   * @param options.isSystemNotification  When true, skip Step 0 (autonomy gate) only.
   *   Used for infrastructure alerts sent TO the principal (e.g. approval_requested,
   *   blocked_content). These must never be silenced by the same gate they report on —
   *   if the score is too low to send autonomously, the principal still needs to know about it.
   *   All other safety checks (blocked-contact, content filter) run normally.
   * @param options.recipientSource  Provenance for a contact this send creates (#2071).
   *   Applies to the email To only. Default `outbound_recipient` (unverified), so a
   *   caller that does not set it fails closed. `email-reply` passes
   *   `email_participant` only when To was copied from a From header that is not
   *   an owned mailbox and that passed SPF, DKIM, and DMARC. The gateway cannot
   *   infer that from `replyToMessageId`: `email-send` sets it too. A likely
   *   duplicate still records `outbound_recipient`.
   * @param options.recipientDisplayName  From display name for that duplicate check.
   *   Omitted when the header has no real name. Not sent to the provider.
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
       * correct skill with the correct payload on principal approval.
       *
       * When absent, no pending_approval row is written and the send returns
       * { gated: true } without an actionRef. Adapters without a re-execution
       * path (e.g. Signal today) simply omit this field.
       */
      reExecRecipe?: {
        /** Registered skill name to invoke on approval (e.g. 'send-draft'). */
        toolName: string;
        /**
         * Partial payload to store in the action_log row. May be incomplete at gate
         * time (e.g. draft_id not yet known). Callers fill in missing fields via
         * linkGatedAction() after creating the fallback artifact.
         */
        partialPayload?: Record<string, unknown>;
        /**
         * Human-readable description of the blocked action. Used in the action_log
         * row (visible via list-pending-actions) and the principal notification body.
         */
        description: string;
      };
      /** Export gate context for attachment bulk-export audit and approval (#201). */
      exportContext?: {
        toolName: string;
        agentId?: string;
        exportItems?: unknown;
      };
      /**
       * Provenance for a contact this send creates when the recipient has none.
       * Email To only. Omitted means `outbound_recipient` (#2071).
       */
      recipientSource?: EmailRecipientSource;
      /**
       * From display name, used only when `recipientSource` is `email_participant`.
       * An address is not a name; omit it and the duplicate check is identifier-only.
       */
      recipientDisplayName?: string;
      /**
       * The principal directed this send. Send skills compute it with
       * isPrincipalDirectedSend(). It lifts only the Stage 2.5 disclosure gate;
       * every other check still runs. Omitted means the gate applies (#1870).
       */
      principalDirected?: boolean;
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
      // principal is explicitly in the loop — autonomy gate does not apply. Log the bypass
      // so operators can trace every humanApproved send in the log stream. See ADR-017.
      this.log.info(
        { channel: request.channel },
        'outbound-gateway: autonomy gate skipped — humanApproved flag set (principal-authorized action, see ADR-017)',
      );
    } else if (this.autonomyService && options?.isSystemNotification) {
      // Infrastructure alert to the principal — gate must not silence its own alarm bell.
      // A notification about a blocked action still needs to reach the principal regardless
      // of the score that caused the block. All other safety checks still run below.
      this.log.info(
        { channel: request.channel },
        'outbound-gateway: autonomy gate skipped — isSystemNotification flag set (infrastructure alert to principal)',
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
        }, options?.parentEventId)).catch((err) => {
          this.log.warn(
            { err, channel: request.channel },
            'outbound-gateway: failed to publish autonomy.send_blocked event',
          );
        });

        // Two-step draft-fallback: channel adapters opt in by passing reExecRecipe.
        // When present, write a pending_approval row so approve-action can invoke the
        // correct skill on principal approval. DB failure must NOT cause fail-open — the send
        // stays blocked even if the row can't be written (actionRef will be absent).
        let actionRef: string | undefined;
        const actionLogRepo = this.actionLogRepo;
        if (actionLogRepo && options?.taskEventId && options?.reExecRecipe) {
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
            rowId = await actionLogRepo.insert({
              taskId: options.taskEventId,
              conversationId: options.conversationId ?? undefined,
              toolName: recipe.toolName,
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

          // Notify principal (best-effort) — mirrors ApprovalTriggerService.request() pattern.
          // sendNotification() has its own try-catch and returns false on failure, so it
          // never throws. Only stamp notification_sent_at if the publish succeeded.
          // setNotificationSentAt is wrapped separately so a DB failure there does not
          // discard the fact that the insert (and the notification delivery) succeeded.
          const principalEmail = this.principalIdentities.find((id) => id.channel === 'email')?.channelIdentifier;
          if (rowId !== undefined) {
            const notificationPayload = enrichGatewayApprovalPayload(
              withoutRecipientReferences(recipe.partialPayload ?? {}),
              request.channel === 'email'
                ? { to: request.to, cc: request.cc?.join(', '), subject: request.subject, body: request.body }
                : request.channel === 'slack'
                  // `recipient` is the field the approval renderer shows (#2033).
                  ? { slackChannelId: request.slackChannelId, recipient: request.slackUserId ?? request.slackChannelId, message: request.message }
                  : { recipient: request.recipient, message: request.message },
            );
            const extraLines = [
              `Autonomy score: ${autonomyConfig.score} (threshold: ${sendThreshold})`,
            ];

            if (principalEmail) {
              const recipientTier = await resolveNotificationRecipientTier(
                this.contactService,
                principalEmail,
                this.log,
              );
              const sent = await this.sendNotification({
                notificationType: 'approval_requested',
                ceoEmail: principalEmail,
                subject: `Approval needed — ${recipe.description}`,
                body: buildApprovalNotificationBody({
                  preamble: recipe.description,
                  shortRef: candidateRef,
                  expiresAt,
                  toolName: recipe.toolName,
                  payload: notificationPayload,
                  recipientTier,
                  logger: this.log,
                  ceoEmail: principalEmail,
                  extraLines,
                  callToAction:
                    'Reply with the reference to approve, deny, or dismiss this request.',
                }),
              });
              if (sent) {
                try {
                  await actionLogRepo.setNotificationSentAt(rowId);
                } catch (err) {
                  // Non-fatal: the pending_approval row exists and gating is correct.
                  // Only notification_sent_at is missing — the principal still received the alert.
                  this.log.warn(
                    { err, rowId, taskEventId: options.taskEventId },
                    'outbound-gateway: setNotificationSentAt failed after successful notification — notification_sent_at will be null',
                  );
                }
              }
            } else {
              // Row was written but no principal email identity configured — email skipped.
              // Slack/Signal DMs below may still deliver. Surface misconfig in alerting.
              this.log.error(
                { rowId, taskEventId: options.taskEventId },
                'outbound-gateway: pending_approval row written but principal email notification skipped — no principal email identity configured',
              );
            }

            // Slack/Signal DMs for reaction→approval correlation (#1479).
            const chatBody = buildApprovalNotificationBody({
              preamble: recipe.description,
              shortRef: candidateRef,
              expiresAt,
              toolName: recipe.toolName,
              payload: notificationPayload,
              recipientTier: 'principal',
              extraLines,
              callToAction: 'React 👍 to approve or 👎 to deny this request.',
            });
            await deliverApprovalToChatChannels({
              outboundGateway: this,
              actionLogRepo,
              actionLogId: rowId,
              body: chatBody,
              principalIdentities: this.principalIdentities,
              logger: this.log,
            });
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
            `Use createEmailDraft() for drafts, or ask the principal to raise the score with set-autonomy.`,
        };
      }
    }

    // Derive a stable recipient identifier for the blocked-contact check and logging.
    // Email: the To address. Signal: phone number (1:1) or base64 group ID.
    // Slack: prefer the peer user id (U…); fall back to conversation id only for logging.
    // SMS: peer E.164.
    const recipientId = request.channel === 'email'
      ? request.to
      : request.channel === 'slack'
        ? (request.slackUserId ?? request.slackChannelId)
        : request.channel === 'sms'
          ? request.recipient
          : (request.recipient ?? request.groupId ?? '');

    // The message body field differs between channel types.
    const messageBody = request.channel === 'email' ? request.body : request.message;

    // ------------------------------------------------------------------
    // Step 0.5: No-reply / automated recipient guard (email only, #1302)
    // ------------------------------------------------------------------
    // A no-reply address is a dead end: replying there is undeliverable, and it was a
    // recurring source of mis-addressed sends — the coordinator narrating principal-
    // directed status ("pending approval on your end") back down an automated-
    // notification thread, auto-routed to the noreply@ sender (#1302).
    //
    // This is a *recipient* problem, not a *content* problem: the address cannot be
    // fixed by rewriting, so we hard-block (like the Step-1 blocked-contact check
    // below) rather than returning a rewrite-and-retry reason to the agent — which
    // would only invite futile retries against an immutable recipient. We still record
    // an outbound.blocked audit event so the suppression is visible, but we deliberately
    // do NOT send the principal an FYI (these automated notifications are routine; a per-drop
    // alert would be noise — the audit log is the record).
    //
    // Predicate: block only when EVERY recipient classifies as automated (no deliverable
    // human anywhere on the envelope). A normal send that merely CCs a noreply address
    // still reaches its human recipients and is not blocked. Signal is exempt —
    // recipients are phone numbers / group IDs, where "no-reply" has no meaning.
    if (request.channel === 'email') {
      const emailRecipients = this.buildFilterRecipients(request).recipients;
      if (
        emailRecipients.length > 0 &&
        emailRecipients.every((r) => classifyEmailSender(r.email) === 'automated')
      ) {
        this.log.warn(
          { channel: request.channel, recipientId: redactId(recipientId), rule: 'no-reply-recipient' },
          'outbound-gateway: send blocked — all recipients are no-reply/automated addresses',
        );
        const blockId = `block_${randomUUID()}`;
        try {
          // scrubPii() because we run before Step 1.5 PII redaction — the audit event
          // must never carry raw PII, matching the fail-closed redactor-error path below.
          await this.bus.publish('dispatch', createOutboundBlocked({
            blockId,
            conversationId: options?.conversationId ?? '',
            channelId: request.channel,
            content: scrubPii(messageBody),
            recipientId,
            reason: 'no_reply_recipient',
            findings: [{ rule: 'no-reply-recipient', detail: 'All recipients classify as automated/no-reply; message not deliverable' }],
            parentEventId: options?.parentEventId ?? '',
          }));
        } catch (publishErr) {
          this.log.warn(
            { publishErr, blockId },
            'outbound-gateway: failed to publish outbound.blocked event for no-reply recipient — message is still blocked',
          );
        }
        // Terse, terminal result — no blockedRules (that field is the content filter's
        // "here is what to rewrite" affordance; omitting it signals a non-fixable
        // recipient problem, discouraging retry loops).
        return { success: false, blockedReason: 'Recipient is a no-reply/automated address; message not deliverable' };
      }
    }

    // ------------------------------------------------------------------
    // Step 1: Contact blocked check + trust level capture
    // ------------------------------------------------------------------
    // Resolve the recipient to a known contact. If they are explicitly blocked
    // by the principal, reject immediately without touching the transport layer or filter.
    // We also capture the contact's trust level here for the content filter's
    // contact-data-leak rule — no extra DB call needed.
    //
    // Fail-open on DB errors: an infra failure should not silently prevent
    // sending. We warn so the anomaly is visible in logs/alerting.
    let recipientTier: ContactTier = 'unknown';
    // Set when the lookup threw, so the disclosure gate can label an outage-caused
    // 'unknown' tier rather than treat it as a genuinely unknown recipient (#1870).
    let recipientTierUnresolved = false;
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
        // principal bypass check. Both are used downstream: tier by the content filter's disclosure
        // gate, and contact UUID by PiiRedactor.redact() for the principal bypass.
        recipientTier = contact.tier;
        recipientContactId = contact.contactId;
      }
    } catch (err) {
      // DB or service error — log at warn and proceed.
      // recipientTier stays 'unknown', which is the safe/conservative fallback.
      // The Stage 2.5 disclosure gate still evaluates at 'unknown' (fail-closed); see
      // FilterCheckInput.recipientTierUnresolved for why.
      recipientTierUnresolved = true;
      this.log.warn(
        { err, channel: request.channel, recipientId: redactId(recipientId) },
        'outbound-gateway: contact resolution failed, proceeding without blocked check',
      );
    }

    // After Step 1 so a blocked recipient is reported as blocked, not as an
    // unresolved identity (#1818).
    const identityBlock = await this.blockForUnresolvedIdentity({
      request,
      messageBody,
      recipientId,
      options,
    });
    if (identityBlock) {
      // Its reason names "an external recipient", never which one (#2033).
      return this.withUnmatchedRecipientNote(
        identityBlock,
        await this.findUnmatchedRecipients(request.channel, this.personRecipients(request)),
      );
    }

    // ------------------------------------------------------------------
    // Step 1.25: Bulk export controls — attachments only (#201)
    // ------------------------------------------------------------------
    let exportAuditItems: ExportItem[] | undefined;
    if (
      this.exportControlService
      && request.channel === 'email'
      && request.attachments
      && request.attachments.length > 0
    ) {
      const rawExportItems = Array.isArray(options?.exportContext?.exportItems)
        ? options.exportContext.exportItems as Array<Record<string, unknown>>
        : undefined;
      const exportEval = await this.exportControlService.evaluateGatewayAttachments({
        attachments: request.attachments.map((a) => ({
          filename: a.filename,
          nodeId: a.nodeId,
          sensitivity: a.sensitivity,
        })),
        destination: extractDestinationFromEmailRequest(request.to),
        exportItems: rawExportItems?.map((e) => ({
          node_id: typeof e['node_id'] === 'string' ? e['node_id'] : undefined,
          label: typeof e['label'] === 'string' ? e['label'] : undefined,
          sensitivity: typeof e['sensitivity'] === 'string' ? e['sensitivity'] : undefined,
        })),
        humanApproved: options?.humanApproved,
      });

      if (exportEval) {
        const { outcome, items } = exportEval;

        if (outcome.action === 'block') {
          this.log.warn(
            { channel: request.channel, recipientId: redactId(recipientId), code: outcome.code },
            'outbound-gateway: export blocked — restricted bulk export',
          );
          return this.withUnmatchedRecipientNote(
            { success: false, blockedReason: outcome.message },
            await this.findUnmatchedRecipients(request.channel, this.personRecipients(request)),
          );
        }

        if (outcome.action === 'approval_required') {
          this.log.info(
            { channel: request.channel, code: outcome.code, itemCount: items.length },
            'outbound-gateway: export requires principal approval',
          );
          const itemSummary = ExportControlServiceClass.formatItemSummary(items);
          let actionRef: string | undefined;
          if (this.actionLogRepo && options?.taskEventId && options?.reExecRecipe) {
            const recipe = options.reExecRecipe;
            const candidateRef = generateShortRef();
            try {
              await this.actionLogRepo.insert({
                taskId: options.taskEventId,
                conversationId: options.conversationId ?? undefined,
                toolName: recipe.toolName,
                actionRisk: 'medium',
                outcome: 'pending_approval',
                shortRef: candidateRef,
                description: recipe.description,
                payload: recipe.partialPayload ?? {},
                expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
              });
              actionRef = candidateRef;
            } catch (err) {
              this.log.error({ err }, 'outbound-gateway: failed to write export-gate action_log row');
            }
          }
          const principalEmail = this.principalIdentities.find((id) => id.channel === 'email')?.channelIdentifier;
          if (principalEmail && options?.reExecRecipe) {
            const recipe = options.reExecRecipe;
            const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
            try {
              const recipientTier = await resolveNotificationRecipientTier(
                this.contactService,
                principalEmail,
                this.log,
              );
              await this.sendNotification({
                notificationType: 'approval_requested',
                ceoEmail: principalEmail,
                subject: `Approval needed — ${recipe.description}`,
                body: buildApprovalNotificationBody({
                  preamble: outcome.message,
                  shortRef: actionRef ?? 'pending',
                  expiresAt,
                  toolName: recipe.toolName,
                  payload: {
                    ...withoutRecipientReferences(recipe.partialPayload ?? {}),
                    // The display shows the resolved addresses; the stored payload keeps the references.
                    ...(request.channel === 'email'
                      ? { to: request.to, ...(request.cc && request.cc.length > 0 ? { cc: request.cc.join(', ') } : {}) }
                      : {}),
                    export_items: items.map((i) => ({
                      node_id: i.nodeId,
                      label: i.label,
                      sensitivity: i.sensitivity,
                    })),
                  },
                  recipientTier,
                  logger: this.log,
                  ceoEmail: principalEmail,
                  extraLines: [`Items:\n${itemSummary}`],
                  callToAction:
                    'Reply with the reference to approve, deny, or dismiss this request.',
                }),
              }, options?.parentEventId);
            } catch (err) {
              this.log.error(
                { err, channel: request.channel, taskEventId: options?.taskEventId },
                'outbound-gateway: export-gate approval notification failed — send still blocked',
              );
            }
          }
          return {
            success: false,
            gated: true,
            actionRef,
            blockedReason: `${outcome.message}\n\n${itemSummary}`,
          };
        }

        if (outcome.action === 'allow') {
          exportAuditItems = items;
        }
      }
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
            conversationId: options?.conversationId ?? '',
            channelId: request.channel,
            // scrubPii() as a safety fallback — the redactor itself failed, so we apply
            // a best-effort scrub before writing anything to the audit log. This ensures
            // no raw PII leaks into the audit trail even on a redactor failure path.
            content: scrubPii(messageBody),
            recipientId,
            reason: 'pii_redactor_error',
            findings: [{ rule: 'pii_redactor_error', detail: 'PiiRedactor threw an unexpected error' }],
            parentEventId: options?.parentEventId ?? '',
          }));
        } catch (publishErr) {
          this.log.warn(
            { publishErr, blockId },
            'outbound-gateway: failed to publish outbound.blocked event for PII redactor error',
          );
        }
        return this.withUnmatchedRecipientNote(
          { success: false, blockedReason: 'pii_redactor_error' },
          await this.findUnmatchedRecipients(request.channel, this.personRecipients(request)),
        );
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
        recipientTierUnresolved,
        principalDirected: options?.principalDirected === true,
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
      // Principal-safe reason for the principal notification: surfaces the judge's abstract
      // reason but never a Stage-1 finding's (potentially sensitive) detail. See
      // buildBlockReasonSummary for the per-rule policy.
      const reasonSummary = buildBlockReasonSummary(filterFindings);
      // Recipients that match no contact (#2033). The judge reasons about content
      // only, so without this the agent rewrites the body to a wrong address.
      const unmatched = await this.findUnmatchedRecipients(request.channel, this.personRecipients(request));

      // Publish the blocked event for audit logging and downstream consumers.
      // Capture the event so we can link the outbound.notification to it via parentEventId.
      // Use redactedBody so the audit event itself does not contain unredacted PII.
      const blockedEvent = createOutboundBlocked({
        blockId,
        conversationId: options?.conversationId ?? '',
        channelId: request.channel,
        content: redactedBody,
        recipientId,
        reason: fullReason,
        findings: filterFindings,
        parentEventId: options?.parentEventId ?? '',
      });
      try {
        await this.bus.publish('dispatch', blockedEvent);
      } catch (publishErr) {
        this.log.warn(
          { publishErr, blockId },
          'outbound-gateway: failed to publish outbound.blocked event — message is still blocked',
        );
      }

      // Publish an outbound.notification event so the principal alert routes through the
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
            // Softened from a call-to-action to informational (#1051): the agent now
            // receives the block reason in the skill result and may self-correct and
            // resend on its own. The audit log remains the ground truth; this alert is
            // an FYI, not a task the principal must action.
            subject: 'FYI — outbound message blocked',
            body: [
              'An outbound message was blocked by the content filter.',
              'The agent received the reason and may rewrite the message and retry on its own.',
              '',
              `Reason: ${reasonSummary}`,
              // blockedEvent.timestamp is the audit row's own clock. No principal
              // timezone is plumbed into the gateway (it is infrastructure, not a
              // skill with ctx.timezone), so we stamp UTC explicitly rather than
              // emit an ambiguous bare timestamp.
              `Time: ${blockedEvent.timestamp.toISOString()} (UTC)`,
              `Channel: ${request.channel}`,
              ...unmatchedRecipientNotificationLines(recipientId, unmatched),
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
        // prevents an infinite loop. The principal will not receive this alert.
        this.log.error(
          { blockId, channel: request.channel },
          'outbound-gateway: notification delivery was blocked by content filter — recursion guard active, principal will NOT receive this alert',
        );
      } else if (!options?.skipNotificationOnBlock) {
        this.log.error(
          { blockId, channel: request.channel, recipientId: redactId(recipientId) },
          'outbound-gateway: principal notification skipped — no principal email identity configured. Block recorded in audit log only.',
        );
      }
      // Surface the principal-safe reason summary and the rule name(s) to the
      // caller (#1051). reasonSummary (computed above via buildBlockReasonSummary)
      // obeys the same per-rule safety contract as the principal notification — it only
      // includes an LLM-judge finding's abstract detail, never a Stage-1 rule's
      // matched fragment. Surfacing it here gives the agent's tool-use loop enough
      // signal to rewrite the message and retry organically; blockedRules carries
      // the specific rule category (rule names only) so it can fix the root cause.
      return this.withUnmatchedRecipientNote(
        {
          success: false,
          blockedReason: reasonSummary,
          blockedRules: filterFindings.map((f) => f.rule),
        },
        unmatched,
      );
    }

    // ------------------------------------------------------------------
    // Step 3: Channel dispatch + contact promotion
    // ------------------------------------------------------------------
    // After a successful send, promote the recipient contact from provisional →
    // confirmed (or create one if none exists). The act of sending is the principal's
    // implicit trust confirmation — replies from this person should never be held.
    //
    // IMPORTANT: pass redactedBody here, not request.body / request.message.
    // The dispatch methods read the body/message field from the request object
    // they receive — if we pass the original `request`, the unredacted content
    // reaches Nylas / signal-cli even though redactedBody was computed above.
    if (request.channel === 'email') {
      // Provenance lives on the request so a queued payload keeps it. Only send()
      // options set it; a value already on the request is dropped. dispatchEmail
      // copies named provider fields, so Nylas never sees these (#2071).
      const toSend: EmailSendRequest = { ...request, body: redactedBody, subject: redactedSubject };
      delete toSend.recipientSource;
      delete toSend.recipientDisplayName;
      if (options?.recipientSource === 'email_participant') {
        toSend.recipientSource = 'email_participant';
        const fromName = options.recipientDisplayName?.trim();
        if (fromName) toSend.recipientDisplayName = fromName;
      }
      const result = await this.dispatchOrEnqueue(toSend, () => this.dispatchEmail(toSend));
      if (result.success && !result.queued) {
        await this.promoteOrCreateRecipientContact(
          'email',
          recipientId,
          toSend.recipientSource,
          toSend.recipientDisplayName,
        );
        await this.publishDelivered({
          channel: 'email',
          recipientId,
          recipientContactId,
          content: redactedBody,
          conversationId: options?.conversationId,
          taskEventId: options?.taskEventId,
          messageId: result.messageId,
          parentEventId: options?.parentEventId,
          ...(exportAuditItems && exportAuditItems.length > 0
            ? {
              exportAudit: {
                destination: formatDestination(extractDestinationFromEmailRequest(request.to)),
                items: exportAuditItems,
                toolName: options?.exportContext?.toolName,
                agentId: options?.exportContext?.agentId,
              },
            }
            : {}),
        });
      }
      return result;
    }

    if (request.channel === 'slack') {
      const toSend = { ...request, message: redactedBody };
      const result = await this.dispatchOrEnqueue(toSend, () => this.dispatchSlack(toSend));
      // Contact resolution uses slackUserId (U…) when provided; inbound auto-creates
      // contacts from Slack user ids. Skip promoteOrCreate on conversation ids.
      if (result.success && !result.queued) {
        await this.publishDelivered({
          channel: 'slack',
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
    }

    if (request.channel === 'sms') {
      const toSend = { ...request, message: redactedBody };
      const result = await this.dispatchOrEnqueue(toSend, () => this.dispatchSms(toSend));
      if (result.success && !result.queued) {
        await this.promoteOrCreateRecipientContact('sms', request.recipient);
        await this.publishDelivered({
          channel: 'sms',
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
    }

    {
      const toSend: SignalOutboundRequest = { ...request, message: redactedBody };
      const result = await this.dispatchOrEnqueue(toSend, () => this.dispatchSignal(toSend));
      // Only promote for 1:1 Signal sends — group sends use a groupId, not an individual
      // phone number. Creating a contact for a group token would pollute the contacts table
      // and would not help with inbound replies (which come from member numbers, not the group ID).
      if (result.success && !result.queued && request.recipient) {
        await this.promoteOrCreateRecipientContact('signal', request.recipient);
      }
      // Emit the audit event for all successful Signal sends (both 1:1 and group).
      // messageId is the signal-cli send timestamp — correlates with reaction targetTimestamp (#1479).
      if (result.success && !result.queued) {
        await this.publishDelivered({
          channel: 'signal',
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
    }
  }

  /** Whether this channel is registered for durable queueing (#1380). */
  private isQueueableChannel(channel: string): boolean {
    return !!this.outboundQueue && this.outboundQueueReadiness.has(channel);
  }

  /** Transport ready for wire dispatch; unknown channels are treated as ready. */
  private isChannelOutboundReady(channel: string): boolean {
    const probe = this.outboundQueueReadiness.get(channel);
    return probe ? probe() : true;
  }

  /**
   * Dispatch immediately, or enqueue when the channel opted into outbound
   * queueing and is currently unavailable (#1380).
   */
  private async dispatchOrEnqueue(
    request: OutboundSendRequest,
    dispatch: () => Promise<OutboundSendResult>,
  ): Promise<OutboundSendResult> {
    if (this.isQueueableChannel(request.channel) && !this.isChannelOutboundReady(request.channel)) {
      return this.enqueueInsteadOfDrop(request);
    }
    const result = await dispatch();
    if (
      !result.success
      && result.queueable
      && this.isQueueableChannel(request.channel)
    ) {
      const queued = await this.enqueueInsteadOfDrop(request);
      // HTTP channels (SMS) may stay "ready" while the provider is briefly down —
      // schedule a flush retry since no socket reconnect event will fire.
      if (queued.queued && this.isChannelOutboundReady(request.channel)) {
        this.scheduleFlushRetry(request.channel);
      }
      return queued;
    }
    return result;
  }

  /** Retry flush after a transient queueable failure with no disconnect event. */
  private scheduleFlushRetry(channel: string, delayMs = 30_000): void {
    if (this.flushRetryTimers.has(channel)) return;
    const timer = setTimeout(() => {
      this.flushRetryTimers.delete(channel);
      void this.flushChannel(channel).catch((err) => {
        this.log.error({ err, channel }, 'outbound-gateway: scheduled queue flush failed');
      });
    }, delayMs);
    // Don't keep the process alive solely for a flush retry.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.flushRetryTimers.set(channel, timer);
  }

  /**
   * Persist a post-policy send for later delivery (#1380).
   * Returns success+queued so callers do not treat a durable queue as a drop.
   */
  private async enqueueInsteadOfDrop(
    request: OutboundSendRequest,
  ): Promise<OutboundSendResult> {
    if (!this.outboundQueue) {
      return { success: false, blockedReason: 'Outbound queue not configured' };
    }
    try {
      const { id } = await this.outboundQueue.enqueue(request);
      this.log.info(
        { channel: request.channel, queueId: id },
        'outbound-gateway: channel disconnected — message queued for reconnect flush',
      );
      return { success: true, queued: true, messageId: id };
    } catch (err) {
      if (err instanceof OutboundQueueFullError) {
        this.log.warn({ channel: request.channel }, err.message);
        return { success: false, blockedReason: err.message };
      }
      this.log.error({ err, channel: request.channel }, 'outbound-gateway: failed to enqueue message');
      return { success: false, blockedReason: 'Failed to queue message while channel disconnected' };
    }
  }

  /**
   * Flush pending queue rows for a channel after reconnect (#1380).
   * Delete + audit each successful send immediately — external dispatch cannot
   * roll back, so an all-or-nothing DELETE after the loop would duplicate-deliver
   * earlier rows on the next flush. Stop on first failure; later rows stay queued.
   */
  async flushChannel(channel: string): Promise<{ flushed: number; skipped: boolean }> {
    if (!this.outboundQueue) return { flushed: 0, skipped: true };
    if (this.flushInFlight.has(channel)) {
      return { flushed: 0, skipped: true };
    }
    this.flushInFlight.add(channel);
    try {
      if (!this.isChannelOutboundReady(channel)) {
        this.log.debug({ channel }, 'outbound-gateway: flush skipped — still unavailable');
        return { flushed: 0, skipped: true };
      }

      const pending = await this.outboundQueue.listPending(channel);
      if (pending.length === 0) return { flushed: 0, skipped: false };

      let flushed = 0;
      for (const row of pending) {
        let result: OutboundSendResult;
        if (row.payload.channel === 'signal') {
          result = await this.dispatchSignal(row.payload);
        } else if (row.payload.channel === 'slack') {
          result = await this.dispatchSlack(row.payload);
        } else if (row.payload.channel === 'sms') {
          result = await this.dispatchSms(row.payload);
        } else if (row.payload.channel === 'email') {
          result = await this.dispatchEmail(row.payload);
        } else {
          result = { success: false, blockedReason: `Unknown channel in queue: ${row.channel}` };
        }

        if (!result.success) {
          this.log.warn(
            { channel, queueId: row.id, blockedReason: result.blockedReason },
            'outbound-gateway: flush stopped — remaining rows stay queued for next reconnect',
          );
          // Transient provider outage — try again later without waiting for a socket event.
          if (result.queueable) {
            this.scheduleFlushRetry(channel);
          }
          break;
        }

        // External send already happened — delete this row before the next dispatch.
        await this.outboundQueue.deleteByIds([row.id]);

        const content = row.payload.channel === 'email'
          ? row.payload.body
          : row.payload.message;
        if (row.payload.channel === 'signal' && row.payload.recipient) {
          await this.promoteOrCreateRecipientContact('signal', row.payload.recipient);
        } else if (row.payload.channel === 'sms') {
          await this.promoteOrCreateRecipientContact('sms', row.payload.recipient);
        } else if (row.payload.channel === 'email') {
          const provenance = emailProvenanceFromPayload(row.payload);
          await this.promoteOrCreateRecipientContact(
            'email',
            row.payload.to,
            provenance.source,
            provenance.displayName,
          );
        }

        await this.publishDelivered({
          channel: row.payload.channel,
          recipientId: row.recipient,
          content,
          messageId: result.messageId,
        });
        flushed += 1;
      }

      this.log.info(
        { channel, flushed, pending: pending.length },
        'outbound-gateway: queue flush complete',
      );
      return { flushed, skipped: false };
    } finally {
      this.flushInFlight.delete(channel);
    }
  }

  /**
   * Publish a system notification event to the bus so it routes through the standard
   * outbound safety pipeline (content filter + blocked-contact check) via the
   * EmailAdapter's outbound.notification subscriber.
   *
   * This replaces the former direct dispatchEmail() calls that bypassed the content
   * filter. The notification body is always a hardcoded template (no LLM-generated
   * content) addressed to the principal email (which is in the content filter allowlist),
   * so the filter will always pass.
   *
   * Callers: the blocked-content path in send().
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
    channel: 'signal' | 'email' | 'slack' | 'sms';
    recipientId: string;
    recipientContactId?: string;
    content: string;
    conversationId?: string;
    taskEventId?: string;
    messageId?: string;
    parentEventId?: string;
    exportAudit?: {
      destination: string;
      items: ExportItem[];
      toolName?: string;
      agentId?: string;
    };
  }): Promise<void> {
    try {
      const { exportAudit, ...rest } = payload;
      await this.bus.publish('dispatch', createOutboundDelivered({
        ...rest,
        ...(exportAudit
          ? {
            exportAudit: {
              destination: exportAudit.destination,
              items: exportAudit.items.map((i) => ({
                nodeId: i.nodeId,
                label: i.label,
                sensitivity: i.sensitivity,
              })),
              toolName: exportAudit.toolName,
              agentId: exportAudit.agentId,
            },
          }
          : {}),
      }));
    } catch (err) {
      this.log.error(
        { err, channel: payload.channel, recipientId: redactId(payload.recipientId) },
        'outbound-gateway: failed to publish outbound.delivered event — send already succeeded, audit row is missing',
      );
    }
  }

  /**
   * Project an outbound request onto recipient identifiers for principal checks.
   *
   * Delegates to the channel's `PrincipalChannelRules.extractRecipients` (ADR-035).
   * Unregistered channels / unrecognized shapes fail closed (empty list ⇒ no
   * principal carve-out). `isPrincipalRecipient` and `buildFilterRecipients`
   * both derive from this.
   */
  private projectRecipients(request: OutboundSendRequest): ProjectedRecipient[] {
    const rules = findPrincipalChannelRules(request.channel);
    return rules?.extractRecipients(request) ?? [];
  }

  /**
   * Resolve a send skill's recipient reference — a contact UUID or the alias
   * `principal` — to the address on that contact's verified, active identity
   * for `channel` (#2033, ADR-047). `value` may carry a `#label` hint
   * (`principal#personal`); it is part of the string, so every caller resolves
   * the same identity (#2047). Fails closed with an agent-facing error.
   *
   * The principal's contact ID comes from the hot-reloaded identity snapshot
   * (verified + active rows only), so the alias has no target when the
   * principal has no verified identity at all.
   */
  async resolveRecipientReference(
    channel: string,
    value: string,
    fields: RecipientReferenceFields,
  ): Promise<RecipientResolution> {
    const result = await resolveRecipientReference(value, channel, fields, {
      contactService: this.contactService,
      principalContactId: this.principalIdentities[0]?.contactId,
    });
    if (!result.ok && result.cause !== undefined) {
      this.log.warn(
        { err: result.cause, channel },
        'outbound-gateway: recipient reference lookup failed — send refused (fail-closed)',
      );
    }
    return result;
  }

  /** Recipient identifiers that name a person (never a group or conversation id). */
  private personRecipients(request: OutboundSendRequest): string[] {
    return this.projectRecipients(request)
      .filter((r) => r.principalEligible)
      .map((r) => r.identifier);
  }

  /**
   * The identifiers among `identifiers` that match no contact on `channel` (#2033).
   * Called only on a block, so ordinary sends pay no extra lookups. A lookup
   * error leaves that identifier out: the note says "matches no contact" only
   * when the lookup confirmed it.
   */
  private async findUnmatchedRecipients(channel: string, identifiers: readonly string[]): Promise<UnmatchedRecipient[]> {
    const unmatched: UnmatchedRecipient[] = [];
    const seen = new Set<string>();
    for (const identifier of identifiers) {
      const key = identifier.toLowerCase();
      if (identifier.length === 0 || seen.has(key)) continue;
      seen.add(key);
      try {
        const contact = await this.contactService.resolveByChannelIdentity(channel, identifier);
        if (contact === null) unmatched.push({ identifier, reason: 'no-contact' });
        else if (!contact.verified) unmatched.push({ identifier, reason: 'unverified' });
      } catch (err) {
        this.log.warn(
          { err, channel, recipientId: redactId(identifier) },
          'outbound-gateway: recipient lookup for the block note failed — note omits this recipient',
        );
      }
    }
    return unmatched;
  }

  /** Append the unmatched-recipient note to a blocked result (#2033). */
  private withUnmatchedRecipientNote(
    result: OutboundSendResult,
    unmatched: readonly UnmatchedRecipient[],
  ): OutboundSendResult {
    if (unmatched.length === 0) return result;
    return {
      ...result,
      blockedReason: `${result.blockedReason ?? 'Send blocked'}\n\n${formatUnmatchedRecipientNote(unmatched)}`,
      unmatchedRecipients: unmatched.map((u) => u.identifier),
    };
  }

  /**
   * Check whether the primary recipient is the principal (the human Curia serves).
   * Uses the first principal-eligible identifier from `projectRecipients` (email
   * `to`, Signal `recipient`, Slack `slackUserId`) against verified identities.
   */
  private isPrincipalRecipient(request: OutboundSendRequest): boolean {
    const primary = this.projectRecipients(request).find((r) => r.principalEligible);
    if (!primary) return false;
    return this.isPrincipalOnChannel(request.channel, primary.identifier);
  }

  /**
   * Publish and return an unresolved-identity block, or null when the send
   * may proceed. Shared by send() and sendEmailDraft() (#1818).
   *
   * `identityGate: off` skips the check. `shadow` logs what enforce would
   * have blocked and lets the send continue. `enforce` blocks.
   */
  private async blockForUnresolvedIdentity(args: {
    request: OutboundSendRequest;
    messageBody: string;
    recipientId: string;
    options?: {
      humanApproved?: boolean;
      isSystemNotification?: boolean;
      taskEventId?: string;
      conversationId?: string;
      parentEventId?: string;
    };
    draftId?: string;
  }): Promise<OutboundSendResult | null> {
    if (this.identityGate === 'off') return null;
    const identityReason = await this.unresolvedIdentityReason(args.request, args.options);
    if (!identityReason) return null;
    if (this.identityGate === 'shadow') {
      this.log.warn(
        {
          channel: args.request.channel,
          recipientId: redactId(args.recipientId),
          draftId: args.draftId,
          identityGate: 'shadow',
        },
        'outbound-gateway: unresolved identity would have blocked this send',
      );
      return null;
    }
    this.log.warn(
      {
        channel: args.request.channel,
        recipientId: redactId(args.recipientId),
        draftId: args.draftId,
      },
      'outbound-gateway: send blocked — unresolved identity',
    );
    const blockId = `block_${randomUUID()}`;
    try {
      await this.bus.publish('dispatch', createOutboundBlocked({
        blockId,
        conversationId: args.options?.conversationId ?? '',
        channelId: args.request.channel,
        content: scrubPii(args.messageBody),
        recipientId: args.recipientId,
        reason: 'unresolved_identity',
        findings: [{
          rule: 'unresolved-identity',
          detail: 'Outbound message names a person who is not resolved to a contact ID in this turn',
        }],
        parentEventId: args.options?.parentEventId ?? '',
      }));
    } catch (publishErr) {
      this.log.warn(
        { publishErr, blockId, draftId: args.draftId },
        'outbound-gateway: failed to publish outbound.blocked event for unresolved identity — message is still blocked',
      );
    }
    return { success: false, blockedReason: identityReason, blockedRules: ['unresolved-identity'] };
  }

  /**
   * Why an external send must not go out, or null when it may proceed (#1818).
   *
   * Fail-open on three paths, on purpose:
   *   1. no conversation-entity service was wired
   *   2. the send has no taskEventId
   *   3. this task never called begin() — a specialist turn that does not
   *      track identities, or a send from outside an agent task
   * Those sends are not identity-checked. A tracked turn whose contact load
   * failed still called begin() with an empty set, so a person-shaped
   * external send on that turn fails closed. Do not flip the three skips
   * to fail-closed; that would block system and untracked sends that have
   * no resolved set.
   */
  private async unresolvedIdentityReason(
    request: OutboundSendRequest,
    options?: {
      humanApproved?: boolean;
      isSystemNotification?: boolean;
      taskEventId?: string;
    },
  ): Promise<string | null> {
    const state = this.conversationEntities;
    if (!state) return null;
    if (options?.humanApproved || options?.isSystemNotification) return null;
    if (this.isPrincipalRecipient(request)) return null;
    const taskEventId = options?.taskEventId;
    if (!taskEventId || !state.turnIdentities.has(taskEventId)) return null;

    const covered: string[] = [...state.principalNames];
    for (const card of state.turnIdentities.get(taskEventId)) {
      covered.push(card.displayName);
      if (card.preferredName) covered.push(card.preferredName);
    }

    const principalId = this.principalIdentities[0]?.contactId;
    if (principalId) {
      try {
        const principal = await this.contactService.getContact(principalId);
        if (principal) {
          covered.push(principal.displayName);
          if (principal.preferredName) covered.push(principal.preferredName);
        }
      } catch (err) {
        this.log.warn(
          { err },
          'outbound-gateway: principal name lookup failed — identity gate using startup names only',
        );
      }
    }

    try {
      for (const recipient of this.projectRecipients(request)) {
        covered.push(...emailLocalNameTokens(recipient.identifier));
        const contact = await this.contactService.resolveByChannelIdentity(request.channel, recipient.identifier);
        if (contact?.displayName) covered.push(contact.displayName);
      }
    } catch (err) {
      this.log.warn(
        { err, channel: request.channel },
        'outbound-gateway: recipient name lookup failed — identity gate continuing without recipient names',
      );
    }

    // Subject is hedges-only. A Title Case subject must not block a clean body.
    return describeUnresolvedIdentity(
      request.channel === 'email'
        ? { body: request.body, subject: request.subject }
        : { body: request.message },
      covered,
    );
  }

  /**
   * Channel-parameterized principal identity check. Must pass the channel that
   * owns the identifier (email matcher must NOT be used for Signal/Slack).
   */
  private isPrincipalOnChannel(
    channel: string,
    identifier: string | undefined | null,
  ): boolean {
    return isPrincipalIdentity(channel, identifier, this.principalIdentities);
  }

  /**
   * Build the structural recipient set for the content filter's Stage 2 judge.
   * Recipients come from `projectRecipients`; `isPrincipal` requires both
   * principalEligible and a verified identity match on that channel.
   */
  private buildFilterRecipients(request: OutboundSendRequest): {
    recipients: FilterRecipient[];
    principalIncluded: boolean;
    principalIsSoleRecipient: boolean;
  } {
    const tagged: FilterRecipient[] = this.projectRecipients(request).map((r) => ({
      email: r.identifier,
      isPrincipal:
        r.principalEligible
        && this.isPrincipalOnChannel(request.channel, r.identifier),
    }));
    return this.finalizeRecipientSet(tagged);
  }

  /**
   * Build the structural recipient set from a flat list of recipient emails.
   * `isPrincipal` is from the principal's verified email identities
   * (`isPrincipalIdentity('email', …)`), never the contact role. Used by the
   * email draft-send path (drafts are email-only).
   */
  private buildRecipientSet(emails: string[]): {
    recipients: FilterRecipient[];
    principalIncluded: boolean;
    principalIsSoleRecipient: boolean;
  } {
    const tagged: FilterRecipient[] = emails
      .filter((e) => e.length > 0)
      .map((email) => ({ email, isPrincipal: this.isPrincipalOnChannel('email', email) }));
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
    const principalIsSoleRecipient = computePrincipalIsSoleRecipient(
      recipients.map((r) => ({ identifier: r.email, isPrincipal: r.isPrincipal })),
    );
    return { recipients, principalIncluded, principalIsSoleRecipient };
  }

  /**
   * True when an `email_participant` opt-in may verify this address (#2071).
   * A taken identifier or a candidate (near-miss address, same or similar name)
   * withholds verification. A lookup error withholds it too. The send already
   * happened, so this never throws.
   */
  private async replyProvenanceClearsDuplicates(
    recipientId: string,
    displayName: string | undefined,
    excludeContactId?: string,
  ): Promise<boolean> {
    try {
      const dup = await this.contactService.findLikelyDuplicates({
        ...(displayName ? { displayName } : {}),
        identities: [{ channel: 'email', identifier: recipientId }],
        ...(excludeContactId ? { excludeContactId } : {}),
      });
      if (dup.taken.length > 0 || dup.candidates.length > 0) {
        this.log.info(
          {
            recipientId: redactId(recipientId),
            taken: dup.taken.length,
            candidates: dup.candidates.length,
          },
          'outbound-gateway: reply provenance withheld — address or name matches another contact',
        );
        return false;
      }
      return true;
    } catch (err) {
      this.log.warn(
        { err, recipientId: redactId(recipientId) },
        'outbound-gateway: duplicate check failed — recording the recipient unverified',
      );
      return false;
    }
  }

  /**
   * A later authenticated reply verifies an existing unverified `outbound_recipient`
   * identity in place and keeps that source (#2071). Other sources stay as they are.
   * Blocked contacts are not passed here.
   */
  private async verifyExistingReplyRecipient(
    contactId: string,
    channel: string,
    recipientId: string,
    displayName: string | undefined,
  ): Promise<void> {
    if (channel !== 'email') return;
    let identities: ChannelIdentity[];
    try {
      identities = await this.contactService.getIdentitiesForContact(contactId);
    } catch (err) {
      this.log.warn(
        { err, contactId, recipientId: redactId(recipientId) },
        'outbound-gateway: could not load identities to verify a reply recipient',
      );
      return;
    }
    const needle = recipientId.toLowerCase();
    const identity = identities.find((row) =>
      row.channel === channel
      && row.channelIdentifier.toLowerCase() === needle
      && row.source === 'outbound_recipient'
      && row.status === 'active'
      && !row.verified,
    );
    if (!identity) return;
    const clear = await this.replyProvenanceClearsDuplicates(recipientId, displayName, contactId);
    if (!clear) return;
    try {
      await this.contactService.verifyIdentity(identity.id);
      this.log.info(
        { contactId, identityId: identity.id, recipientId: redactId(recipientId) },
        'outbound-gateway: verified existing outbound_recipient identity from an authenticated reply',
      );
    } catch (err) {
      this.log.warn(
        { err, contactId, identityId: identity.id },
        'outbound-gateway: verifyIdentity failed after an authenticated reply — identity stays unverified',
      );
    }
  }

  /**
   * After a successful outbound send, ensure the recipient has a confirmed contact record.
   *
   * - If the contact exists and is provisional: promote to confirmed.
   * - If no contact record exists: create one at tier known, using the channel
   *   identifier as a placeholder display name (enrichment happens later).
   *   Provenance defaults to `outbound_recipient` (unverified). `email_participant`
   *   is recorded only when the caller opted in and the duplicate check is clear
   *   (#2033, #2040, #2071, ADR-047).
   * - An existing unverified `outbound_recipient` identity is verified in place
   *   when the caller opted in and the same check is clear. The source stays.
   * - If the contact is already confirmed or blocked: no tier change. Blocked
   *   contacts are not verified.
   *
   * Fail-open: the message was already sent, so a DB error here must not surface
   * as a send failure. Log at warn so anomalies are visible without alarming callers.
   */
  private async promoteOrCreateRecipientContact(
    channel: string,
    recipientId: string,
    recipientSource?: EmailRecipientSource,
    recipientDisplayName?: string,
  ): Promise<void> {
    // Callers and the queue read already narrowed this to the one opt-in or
    // undefined. Undefined is the unverified default (#2071).
    let source: EmailRecipientSource = recipientSource ?? 'outbound_recipient';
    const displayName = recipientDisplayName?.trim() || undefined;
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
      // until the contact is enriched or the principal assigns a proper name.
      // A likely duplicate, or a duplicate check that itself fails, withholds
      // verification: the contact is still created, as unverified outbound_recipient.
      if (source === 'email_participant') {
        const clear = await this.replyProvenanceClearsDuplicates(recipientId, displayName);
        if (!clear) source = 'outbound_recipient';
      }
      let created;
      try {
        // Source is the caller's provenance, never ceo_stated (#2033). ceo_stated
        // made an invented address look principal-confirmed (the 2026-10-07 contact).
        // email_participant is only set when the caller opted in and the duplicate
        // check above was clear (#2071). Every other caller stays outbound_recipient.
        //
        // Tier: known (#2040, ADR-047). Send skills address recipients by contact
        // ID (#2041), so this branch runs only for send-draft, which needs a
        // principal-originated task, and for email-reply, whose To is the From of
        // the message being answered. Neither address was typed by an agent. The
        // unknown-tier branch below promotes an existing contact on send, so a
        // new one is treated the same. At 'unknown', Gate C would escalate every
        // external send a reply led to, a relay to the principal included.
        created = await this.contactService.createContact({
          displayName: recipientId,
          fallbackDisplayName: recipientId,
          source,
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
        // outbound_recipient is not auto-verified, so that identity lands
        // unverified and a later send by contact ID fails closed until the
        // principal verifies it, an agent re-states it (#2041), or a later
        // authenticated reply verifies it in place (#2071). An inbound reply
        // does not verify it (#2040). email_participant is auto-verified, and
        // this path uses it only after the duplicate check.
        await this.contactService.linkIdentity({
          contactId: created.id,
          channel,
          channelIdentifier: recipientId,
          source,
        });
        this.log.info(
          { channel, recipientId: redactId(recipientId), contactId: created.id, source },
          source === 'email_participant'
            ? 'outbound-gateway: created known-tier contact (verified email_participant) for reply recipient'
            : 'outbound-gateway: created known-tier contact (unverified identity) for first-time outbound recipient',
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

    if (source === 'email_participant') {
      await this.verifyExistingReplyRecipient(contact.contactId, channel, recipientId, displayName);
    }

    if (contact.tier === 'unknown') {
      // tier='unknown' == old status='provisional'. The outbound send implicitly confirms
      // this contact — we know the principal's system is reaching out to them, so they're trusted
      // enough to receive replies. Promote unknown → known via elevateTierToKnown, which
      // is a no-op for already-higher tiers (so a trusted contact is never downgraded) and
      // is non-throwing (returns false on error). Uses tier for the gate check (issue #945).
      try {
        const elevated = await this.contactService.elevateTierToKnown(contact.contactId, 'correspondence');
        if (elevated) {
          this.log.info(
            { channel, recipientId: redactId(recipientId), contactId: contact.contactId },
            'outbound-gateway: promoted unknown-tier contact to known after outbound send',
          );
        }
      } catch (err) {
        this.log.warn(
          { err, channel, recipientId: redactId(recipientId), contactId: contact.contactId },
          'outbound-gateway: elevateTierToKnown failed after successful send — recipient may still receive holds on replies',
        );
        // Do not return here — fall through to confidence update so scoring still runs
        // even if the tier promotion failed (defensive: elevateTierToKnown is non-throwing
        // in normal operation, but the catch guard is kept for safety).
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
   * Reject a mailbox name that is not configured, without fetching a message.
   *
   * Gate C skips recipient resolution when both policy axes already escalate
   * (unknown/blocked tier). A misspelled `account` must still surface as
   * `UnknownEmailAccountError` instead of a generic approval (#1832).
   * No clients configured is a different failure (`getEmailMessage` throws
   * "no nylasClient is configured") and is left to that path.
   */
  requireKnownEmailAccount(accountId: string): void {
    if (this.nylasClients.size === 0) return;
    if (!this.nylasClients.has(accountId)) {
      throw new UnknownEmailAccountError(accountId, this.listAccountIds());
    }
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
      if (accountId && this.nylasClients.size > 0) {
        throw new UnknownEmailAccountError(accountId, this.listAccountIds());
      }
      throw new Error('outbound-gateway: getEmailMessage called but no nylasClient is configured');
    }
    // Always request headers. Gate C and email-reply share one cached getEmailMessage,
    // and that cache drops any extra argument, so a header-less fetch first would hide
    // Authentication-Results from the reply provenance check (#2071).
    return client.getMessage(messageId, { includeHeaders: true });
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
      // Same split as getEmailMessage: a misspelled mailbox name is named, with the
      // configured ones, so email-get-thread can tell the model what to fix (#1957).
      if (accountId && this.nylasClients.size > 0) {
        throw new UnknownEmailAccountError(accountId, this.listAccountIds());
      }
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
   * Drafts are created silently — no notification is sent. The principal discovers them
   * through the end-of-day Signal digest (see the scheduled digest job) or by checking
   * their Drafts folder directly.
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
   *   0. Autonomy gate — skipped when options.humanApproved is true (principal in the loop)
   *   1. Blocked-contact check on the primary To recipient
   *   2. Content filter on the draft body
   *   3. Nylas drafts.send() dispatch — sends the actual draft, not a reconstructed copy
   *   4. Recipient contact promotion (provisional → confirmed)
   *
   * Note: PII redaction is not applied here. The draft was created by Curia
   * (content passed through our pipeline at creation time) or authored directly
   * by the principal. Sending the stored draft as-is is intentional.
   *
   * @param draftId        Nylas draft ID to send
   * @param accountId      Which named account to use. Defaults to the primary account.
   * @param draftMeta      Draft content for safety checks — caller must pre-fetch the draft.
   * @param options        humanApproved: true skips Step 0 only (principal in the loop).
   *                       principalDirected: true lifts the Stage 2.5 disclosure gate only,
   *                       as in send() (#1870).
   */
  async sendEmailDraft(
    draftId: string,
    accountId: string | undefined,
    draftMeta: { recipientEmail: string; body: string; subject: string; allRecipients?: string[] },
    options?: { humanApproved?: boolean; principalDirected?: boolean; conversationId?: string; taskEventId?: string; parentEventId?: string },
  ): Promise<OutboundSendResult> {
    // ------------------------------------------------------------------
    // Step 0: Autonomy gate
    // ------------------------------------------------------------------
    if (this.autonomyService && options?.humanApproved) {
      this.log.info(
        { draftId },
        'outbound-gateway: autonomy gate skipped — humanApproved flag set (principal-authorized draft send, see ADR-017)',
      );
    } else if (this.autonomyService && this.isPrincipalOnChannel('email', draftMeta.recipientEmail)) {
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
          }, options?.parentEventId)).catch((err) => {
            this.log.warn(
              { err, draftId },
              'outbound-gateway: failed to publish autonomy.send_blocked event',
            );
          });
          return {
            success: false,
            blockedReason:
              `Autonomy score is ${autonomyConfig.score} — direct sends require a score of at least ${sendThreshold}. ` +
              `Use createEmailDraft() for drafts, or ask the principal to raise the score with set-autonomy.`,
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
    let recipientTierUnresolvedForDraft = false;
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
      // silently block a principal-authorized send due to a transient infrastructure error.
      recipientTierUnresolvedForDraft = true;
      this.log.warn(
        { err, draftId, recipientId: redactId(recipientEmail) },
        'outbound-gateway: contact resolution failed, proceeding without blocked check',
      );
    }

    // After Step 1, same rule as send() (#1818). A draft that leaves the
    // mailbox is an external message; humanApproved skips the gate.
    const identityBlock = await this.blockForUnresolvedIdentity({
      request: {
        channel: 'email',
        to: recipientEmail,
        subject: draftMeta.subject,
        body,
      },
      messageBody: body,
      recipientId: recipientEmail,
      options,
      draftId,
    });

    // Build the audience set from the draft's full envelope (To + CC + BCC) so a draft
    // addressed To: principal with a CC'd/BCC'd third party still runs the judge.
    // Falls back to the single primary recipient when allRecipients is not supplied.
    const draftEnvelope = (draftMeta.allRecipients && draftMeta.allRecipients.length > 0)
      ? draftMeta.allRecipients
      : [recipientEmail];

    if (identityBlock) {
      return this.withUnmatchedRecipientNote(
        identityBlock,
        await this.findUnmatchedRecipients('email', draftEnvelope),
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
    const { recipients: draftRecipients, principalIncluded: draftPrincipalIncluded, principalIsSoleRecipient: draftPrincipalSole } = this.buildRecipientSet(draftEnvelope);

    try {
      const filterResult = await this.contentFilter.check({
        content: body,
        recipientEmail,
        conversationId: '',
        channelId: 'email',
        recipientTier: recipientTierForDraft,
        recipientTierUnresolved: recipientTierUnresolvedForDraft,
        principalDirected: options?.principalDirected === true,
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
      // Full reason string (with detail) goes into the bus event for forensics/audit,
      // NOT into any user-facing or notification surface.
      const fullReason = filterFindings.map((f) => `${f.rule}: ${f.detail}`).join('; ');
      // Principal-safe reason: surfaces the judge's abstract reason but never a
      // Stage-1 finding's (potentially sensitive) detail. See buildBlockReasonSummary
      // for the per-rule policy. Mirrors the send() block path (#1051/#1158).
      const reasonSummary = buildBlockReasonSummary(filterFindings);
      const unmatched = await this.findUnmatchedRecipients('email', draftEnvelope);

      const blockedEvent = createOutboundBlocked({
        blockId,
        conversationId: options?.conversationId ?? '',
        channelId: 'email',
        content: body,
        recipientId: recipientEmail,
        reason: fullReason,
        findings: filterFindings,
        parentEventId: options?.parentEventId ?? '',
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
            // Softened from a call-to-action to informational (#1158, matching #1051):
            // the agent now receives the block reason in the skill result and may
            // self-correct and resend on its own. This alert is an FYI, not a task.
            subject: 'FYI — outbound draft blocked',
            body: [
              'A draft send was blocked by the content filter.',
              'The agent received the reason and may rewrite the draft and retry on its own.',
              '',
              `Reason: ${reasonSummary}`,
              `Time: ${blockedEvent.timestamp.toISOString()} (UTC)`,
              'Channel: email (draft)',
              ...unmatchedRecipientNotificationLines(recipientEmail, unmatched),
              '',
              `Draft ID: ${draftId}`,
              `Block ID: ${blockId}`,
              `Audit event ID: ${blockedEvent.id}`,
              '',
              'Search the audit log by the audit event ID above for the full record.',
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
      // Surface the principal-safe reason summary and rule name(s) to the caller so
      // the agent's tool loop can address the root cause and retry (#1158). reasonSummary
      // obeys buildBlockReasonSummary's per-rule contract — only an LLM-judge finding's
      // abstract detail is included, never a Stage-1 rule's matched fragment; blockedRules
      // carries rule names only. Mirrors the send() block path (#1051).
      return this.withUnmatchedRecipientNote(
        {
          success: false,
          blockedReason: reasonSummary,
          blockedRules: filterFindings.map((f) => f.rule),
        },
        unmatched,
      );
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
   * @param budget     The tool call's time budget; requests stop when it runs out.
   */
  async archiveEmailMessage(
    messageId: string,
    accountId?: string,
    budget?: CallBudget,
  ): Promise<{ success: boolean; error?: string; errorType?: ErrorType }> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      return {
        success: false,
        error: `No email client configured for account: ${accountId ?? 'primary'}`,
      };
    }

    try {
      await client.archiveMessage(messageId, budget);
      this.log.info({ messageId, accountId }, 'outbound-gateway: message archived');
      return { success: true };
    } catch (err) {
      this.log.error({ err, messageId, accountId }, 'outbound-gateway: archiveEmailMessage failed');
      return { success: false, ...nylasMessageFailure(err, messageId, 'Archive failed') };
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
    budget?: CallBudget,
  ): Promise<{ success: boolean; error?: string; errorType?: ErrorType }> {
    const client = this.getNylasClient(accountId);
    if (!client) {
      return {
        success: false,
        error: `No email client configured for account: ${accountId ?? 'primary'}`,
      };
    }

    try {
      await client.markAsRead(messageId, budget);
      this.log.info({ messageId, accountId }, 'outbound-gateway: message marked as read');
      return { success: true };
    } catch (err) {
      this.log.error({ err, messageId, accountId }, 'outbound-gateway: markEmailAsRead failed');
      return { success: false, ...nylasMessageFailure(err, messageId, 'Mark as read failed') };
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
    budget?: CallBudget,
  ): Promise<{
    success: boolean;
    applied: string[];
    created: string[];
    folders: string[];
    error?: string;
    errorType?: ErrorType;
  }> {
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
      // Step 1: List existing folders to build a name → ID lookup (cached per grant)
      const existingFolders = await client.listFolders(budget);
      const foldersByName = new Map<string, NylasFolder>(
        existingFolders.map((f) => [f.name.toUpperCase(), f]),
      );

      // Step 2: Resolve each label to a folder ID, creating if needed
      for (const label of labels) {
        const key = label.toUpperCase();
        let folder = foldersByName.get(key);

        if (!folder) {
          this.log.info({ label, accountId }, 'outbound-gateway: creating new label');
          folder = await client.createFolder(label, budget);
          foldersByName.set(key, folder);
          created.push(label);
        }

        resolvedIds.push(folder.id);
      }

      // Step 3: Read current message folders
      const msg = await client.getMessage(messageId, { budget });
      const currentFolders = new Set(msg.folders);

      // Step 4: Merge — add new folder IDs without removing existing ones
      for (const id of resolvedIds) {
        currentFolders.add(id);
      }

      const mergedFolders = [...currentFolders];

      // Step 5: Write back the merged folder set
      const result = await client.updateMessageFolders(messageId, mergedFolders, budget);
      const finalFolders = result.folders.length > 0 ? result.folders : mergedFolders;

      this.log.info(
        { messageId, applied: labels, created, accountId },
        'outbound-gateway: labels applied',
      );

      return { success: true, applied: labels, created, folders: finalFolders };
    } catch (err) {
      this.log.error({ err, messageId, labels, accountId, created }, 'outbound-gateway: labelEmailMessage failed');
      return { success: false, applied: [], created, folders: [], ...nylasMessageFailure(err, messageId, 'Label operation failed') };
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
    const htmlBody = markdownToHtml(request.body, { wrap: true }) + (request.htmlQuote ?? '');

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
      const available = [...this.nylasClients.keys()];
      const reason = request.accountId
        ? `unknown account '${request.accountId}'; available: [${available.join(', ')}]`
        : 'Email client not configured';
      return { success: false, blockedReason: reason };
    }

    // markdownToHtml is a pure function (no I/O, no realistic throw path).
    // Called outside the Nylas try-catch so that any future regression in the
    // converter is not silently misattributed as "Nylas send failed" in logs.
    // htmlQuote is appended after conversion so it is not re-escaped by markdownToHtml.
    const htmlBody = markdownToHtml(request.body, { wrap: true }) + (request.htmlQuote ?? '');

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
      // Transient network / 408 / 429 / 5xx → queueable; classify on structured
      // status/code first, then message text. Auth/grant/validation stay permanent.
      const authPermanent = /401|403|invalid.?grant|unauthorized|forbidden|invalid.?token/i.test(message);
      const queueable = !authPermanent
        && (hasTransientErrorSignal(err)
          || /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|HTTP 5\d\d|temporarily|socket|ECONNRESET/i.test(message));
      return { success: false, blockedReason: `Send failed: ${message}`, queueable };
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

    if (typeof this.signalClient.isConnected === 'function' && !this.signalClient.isConnected()) {
      return {
        success: false,
        blockedReason: 'Signal RPC client not connected',
        queueable: true,
      };
    }

    try {
      const messageId = await this.signalClient.send({
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

      return { success: true, messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log destination type only — phone numbers and group IDs are PII.
      this.log.error(
        { err, channel: 'signal', destinationType: request.groupId ? 'group' : '1:1' },
        'outbound-gateway: signal-cli send failed',
      );
      const queueable = hasTransientErrorSignal(err) || /not connected|ECONNREFUSED|EPIPE|socket/i.test(message);
      return { success: false, blockedReason: `Send failed: ${message}`, queueable };
    }
  }

  /**
   * Dispatch a send request to Slack via chat.postMessage.
   * Converts agent markdown → Slack mrkdwn before posting.
   */
  private async dispatchSlack(request: SlackOutboundRequest): Promise<OutboundSendResult> {
    if (!this.slackClient) {
      return { success: false, blockedReason: 'Slack client not configured' };
    }

    if (!request.slackChannelId.trim()) {
      this.log.warn({ channel: 'slack' }, 'outbound-gateway: Slack send missing slackChannelId');
      return { success: false, blockedReason: 'Slack send requires slackChannelId' };
    }

    if (typeof this.slackClient.isConnected === 'function' && !this.slackClient.isConnected()) {
      return {
        success: false,
        blockedReason: 'Slack Socket Mode not connected',
        queueable: true,
      };
    }

    const mrkdwn = markdownToMrkdwn(request.message);
    const result = await this.slackClient.postMessage({
      channel: request.slackChannelId,
      text: mrkdwn,
      threadTs: request.threadTs,
    });

    if (!result.ok) {
      this.log.error(
        { channel: 'slack', error: result.error },
        'outbound-gateway: Slack chat.postMessage failed',
      );
      const err = result.error ?? 'unknown_error';
      // `err` is Slack's structured error code — recognize its retryable codes
      // (rate limits, 5xx-class) alongside the network strings (#1380 review).
      const queueable = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket|network|temporarily|rate.?limited|too_many_requests|service_unavailable|internal_error|request_timeout/i.test(err);
      return { success: false, blockedReason: `Send failed: ${err}`, queueable };
    }

    this.log.info(
      { channel: 'slack', hasThread: !!request.threadTs },
      'outbound-gateway: Slack message sent successfully',
    );
    return { success: true, messageId: result.ts };
  }

  /**
   * Dispatch a send request to Telnyx Messaging for SMS delivery.
   * Carrier STOP surfaces as Telnyx error 40300 — mapped to a clear blockedReason
   * so the agent can record a KG fact instead of retrying (no app-level ledger).
   */
  private async dispatchSms(request: SmsOutboundRequest): Promise<OutboundSendResult> {
    if (!this.smsClient) {
      return { success: false, blockedReason: 'SMS client not configured' };
    }

    if (!request.recipient.trim()) {
      this.log.warn({ channel: 'sms' }, 'outbound-gateway: SMS send missing recipient');
      return { success: false, blockedReason: 'SMS send requires recipient' };
    }

    try {
      const { messageId } = await this.smsClient.sendSms({
        to: request.recipient,
        text: request.message,
      });
      this.log.info({ channel: 'sms', destinationType: '1:1' }, 'outbound-gateway: SMS sent successfully');
      return { success: true, messageId };
    } catch (err) {
      if (err instanceof TelnyxSendError && err.code === TELNYX_ERROR_OPTED_OUT) {
        // No phoneSuffix — this file's convention (see dispatchSignal) keeps
        // recipient number fragments out of the log stream.
        this.log.info(
          { channel: 'sms' },
          'outbound-gateway: SMS send blocked — recipient opted out at carrier (STOP)',
        );
        return { success: false, blockedReason: 'recipient opted out at carrier (STOP)' };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err, channel: 'sms' }, 'outbound-gateway: Telnyx SMS send failed');
      // Opt-out and validation stay non-queueable; network / 408 / 429 / 5xx-class
      // failures retry — structured status/code first, then message text.
      const queueable = !(err instanceof TelnyxSendError && err.code === TELNYX_ERROR_OPTED_OUT)
        && (hasTransientErrorSignal(err)
          || /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|HTTP 5\d\d|non-JSON|temporarily/i.test(message));
      return { success: false, blockedReason: `Send failed: ${message}`, queueable };
    }
  }
}
