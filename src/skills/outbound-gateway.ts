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
import type { NylasClient, NylasMessage, ListMessagesOptions, SendEmailOptions } from '../channels/email/nylas-client.js';
import type { SignalRpcClient } from '../channels/signal/signal-rpc-client.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { TrustLevel } from '../contacts/types.js';
import type { OutboundContentFilter } from '../dispatch/outbound-filter.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createOutboundBlocked, createOutboundNotification } from '../bus/events.js';
import type { OutboundNotificationPayload } from '../bus/events.js';
import { markdownToHtml } from '../channels/email/markdown-to-html.js';

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
}

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
   * CEO's own email — used as the allowlist entry in the content filter's contact-data-leak
   * rule and as the To address for blocked-content CEO notifications.
   *
   * Required when nylasClient is present (notifications are sent via email).
   * When email is absent (Signal-only), blocked messages are logged and audited
   * but no CEO notification is sent. A future version may add a Signal notification path.
   *
   * TODO: add a Signal-based blocked-content notification path so the CEO is informed
   * even without email configured. For now log.error + audit trail is the fallback.
   */
  ceoEmail?: string;

  logger: Logger;
}

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
  /** Account name that owns primaryNylasClient (first key in nylasClients). */
  private readonly primaryAccountId: string | undefined;
  private readonly signalClient?: SignalRpcClient;
  private readonly signalPhoneNumber?: string;
  private readonly contactService: ContactService;
  private readonly contentFilter: OutboundContentFilter;
  private readonly bus: EventBus;
  private readonly ceoEmail: string;
  private readonly log: Logger;

  constructor(config: OutboundGatewayConfig) {
    this.nylasClients = config.nylasClients ?? new Map();
    this.primaryNylasClient = this.nylasClients.values().next().value;
    this.primaryAccountId = this.nylasClients.keys().next().value;
    this.signalClient = config.signalClient;
    this.signalPhoneNumber = config.signalPhoneNumber;
    this.contactService = config.contactService;
    this.contentFilter = config.contentFilter;
    this.bus = config.bus;
    this.ceoEmail = config.ceoEmail ?? '';
    this.log = config.logger.child({ component: 'outbound-gateway' });
  }

  /**
   * Send an outbound message through the gateway pipeline.
   *
   * Pipeline steps (channel-agnostic):
   *   1. Contact blocked check
   *   2. Content filter (fail-closed)
   *   3. Channel dispatch (email → Nylas, signal → signal-cli RPC)
   *
   * @param options.skipNotificationOnBlock  When true, suppress the CEO notification
   *   if the content filter blocks this message. Used by the EmailAdapter's
   *   outbound.notification subscriber to break the recursion cycle: without this
   *   guard, a broken content filter (crash → fail-closed) would trigger
   *   send → block → sendNotification → EmailAdapter → send → block → ... infinitely.
   */
  async send(
    request: OutboundSendRequest,
    options?: { skipNotificationOnBlock?: boolean },
  ): Promise<OutboundSendResult> {
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
    let recipientTrustLevel: TrustLevel | null = null;
    try {
      const contact = await this.contactService.resolveByChannelIdentity(request.channel, recipientId);
      if (contact !== null) {
        if (contact.status === 'blocked') {
          this.log.warn(
            { channel: request.channel, recipientId: redactId(recipientId), contactId: contact.contactId },
            'outbound-gateway: send blocked — recipient is blocked',
          );
          return { success: false, blockedReason: 'Recipient is blocked' };
        }
        // Capture trust level for the content filter — used to allow contact data
        // in user-initiated responses to explicitly trusted recipients (e.g. CEO's EA).
        recipientTrustLevel = contact.trustLevel;
      }
    } catch (err) {
      // DB or service error — log at warn and proceed.
      // recipientTrustLevel stays null, which is the safe/conservative fallback.
      this.log.warn(
        { err, channel: request.channel, recipientId: redactId(recipientId) },
        'outbound-gateway: contact resolution failed, proceeding without blocked check',
      );
    }

    // ------------------------------------------------------------------
    // Step 2: Content filter
    // ------------------------------------------------------------------
    // Fail-closed: if the filter throws for any reason, treat the message as blocked.
    // A crashing filter is a security anomaly — better to miss a send than let
    // potentially dangerous content through an unchecked pipeline.
    let filterPassed = false;
    let filterFindings: Array<{ rule: string; detail: string }> = [];

    try {
      const filterResult = await this.contentFilter.check({
        content: messageBody,
        // For Signal sends: passing the phone number/groupId as recipientEmail is intentional.
        // The contact-data-leak rule scans for *email addresses* in the content — a phone
        // number passed here will never match an email pattern, so any leaked email address
        // in the Signal message body is still correctly flagged. The field name is email-centric
        // but the semantics are "the intended recipient identifier".
        recipientEmail: recipientId,
        conversationId: '',
        channelId: request.channel,
        recipientTrustLevel,
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

      // Publish the blocked event for audit logging and downstream consumers.
      // Capture the event so we can link the outbound.notification to it via parentEventId.
      const blockedEvent = createOutboundBlocked({
        blockId,
        conversationId: '',
        channelId: request.channel,
        content: messageBody,
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
      if (this.ceoEmail && !options?.skipNotificationOnBlock) {
        // sendNotification() catches errors internally — await is safe and ensures
        // the bus.publish call completes before we return the blocked result.
        await this.sendNotification(
          {
            notificationType: 'blocked_content',
            ceoEmail: this.ceoEmail,
            subject: 'Action needed — blocked outbound reply',
            body: [
              'An outbound message was blocked by the content filter.',
              '',
              `Block ID: ${blockId}`,
              `Channel: ${request.channel}`,
              `Intended recipient: ${recipientId}`,
              '',
              'Please review the audit log for details.',
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
      } else {
        this.log.error(
          { blockId, channel: request.channel, recipientId: redactId(recipientId) },
          'outbound-gateway: CEO notification skipped — ceoEmail not configured. Block recorded in audit log only.',
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
    if (request.channel === 'email') {
      const result = await this.dispatchEmail(request);
      if (result.success) {
        await this.promoteOrCreateRecipientContact('email', recipientId);
      }
      return result;
    } else {
      const result = await this.dispatchSignal(request);
      // Only promote for 1:1 Signal sends — group sends use a groupId, not an individual
      // phone number. Creating a contact for a group token would pollute the contacts table
      // and would not help with inbound replies (which come from member numbers, not the group ID).
      if (result.success && request.recipient) {
        await this.promoteOrCreateRecipientContact('signal', request.recipient);
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
  ): Promise<void> {
    try {
      await this.bus.publish(
        'dispatch',
        createOutboundNotification({ ...payload, parentEventId }),
      );
    } catch (err) {
      // Non-fatal — the original block/hold is already recorded. Log so the anomaly
      // is visible in alerting but do not throw; the caller's primary operation (block
      // or hold) has already completed successfully.
      this.log.error(
        { err, notificationType: payload.notificationType },
        'outbound-gateway: failed to publish outbound.notification event',
      );
    }
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
        created = await this.contactService.createContact({
          displayName: recipientId,
          fallbackDisplayName: recipientId,
          status: 'confirmed',
          source: 'ceo_stated',
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

      // Set trustLevel: 'high' so replies from this contact score above the trust floor.
      // contactConfidence starts at 0 for new contacts (enriched later via KG), so without
      // a trustLevel override the dispatcher's trust score formula produces ~0.12 — below the
      // default floor of 0.2 — and the reply gets re-held even though the contact is confirmed.
      // Failure is non-fatal: the contact was created and linked; warn so it's visible.
      try {
        await this.contactService.setTrustLevel(created.id, 'high');
      } catch (err) {
        this.log.warn(
          { err, channel, recipientId: redactId(recipientId), contactId: created.id },
          'outbound-gateway: setTrustLevel failed after contact creation — replies may still fall below trust floor',
        );
      }
      return;
    }

    if (contact.status === 'blocked') {
      // Anomalous: the send proceeded despite the contact being blocked. This indicates
      // either a race (contact was blocked between the initial check and the send) or
      // a DB error on the earlier blocked-contact check that caused fail-open.
      // Log at error so this is visible in alerting — a message reached a blocked recipient.
      this.log.error(
        { channel, recipientId: redactId(recipientId), contactId: contact.contactId },
        'outbound-gateway: sent message to blocked contact — blocked-contact check may have been bypassed due to DB error',
      );
      return;
    }

    if (contact.status === 'provisional') {
      try {
        await this.contactService.setStatus(contact.contactId, 'confirmed');
        this.log.info(
          { channel, recipientId: redactId(recipientId), contactId: contact.contactId },
          'outbound-gateway: promoted provisional contact to confirmed after outbound send',
        );
      } catch (err) {
        this.log.warn(
          { err, channel, recipientId: redactId(recipientId), contactId: contact.contactId },
          'outbound-gateway: setStatus failed after successful send — recipient may still receive holds on replies',
        );
        return;
      }
      // Set trustLevel: 'high' so replies score above the trust floor (same reason as
      // the new-contact path above — contactConfidence defaults to 0 after promotion).
      try {
        await this.contactService.setTrustLevel(contact.contactId, 'high');
      } catch (err) {
        this.log.warn(
          { err, channel, recipientId: redactId(recipientId), contactId: contact.contactId },
          'outbound-gateway: setTrustLevel failed after promotion — replies may still fall below trust floor',
        );
      }
      return;
    }

    // Already confirmed — no action needed.
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
   * Create a Nylas draft without sending it — used by the draft_gate outbound policy.
   *
   * Runs the same blocked-contact check as send() but skips the content filter
   * (the filter is designed for messages leaving Curia's control; drafts stay in the
   * mailbox until explicitly sent). The reply goes through the full pipeline when the
   * draft is eventually approved and sent.
   *
   * After a successful draft creation, notifies the CEO via email so they know a reply
   * is waiting in their Drafts folder. The CEO reviews and clicks send from their email
   * client when ready (approval + send is intentionally human-operated for draft_gate).
   *
   * TODO(#278): approval interface and send-on-approval remain deferred — see issue for
   * future options (CLI command, Signal reply, webhook). The notification + Gmail flow
   * is the first piece of the three-part plan described in issue #278.
   */
  async createEmailDraft(request: EmailSendRequest): Promise<OutboundDraftResult> {
    const recipientId = request.to;

    // ------------------------------------------------------------------
    // Blocked contact check
    // ------------------------------------------------------------------
    try {
      const contact = await this.contactService.resolveByChannelIdentity('email', recipientId);
      if (contact !== null && contact.status === 'blocked') {
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

    const result = await this.dispatchEmailDraft(request);

    // Notify the CEO that a draft is waiting for their review. Non-fatal — the draft
    // was created successfully regardless of whether the notification sends.
    // Use .catch() (not await) so any unexpected throw inside notifyCeoDraftCreated
    // cannot propagate here and break the returned draft result.
    if (result.success && result.draftId) {
      this.notifyCeoDraftCreated(request, result.draftId).catch((err) => {
        this.log.error(
          { err, draftId: result.draftId },
          'outbound-gateway: notifyCeoDraftCreated threw unexpectedly — draft result unaffected',
        );
      });
    }

    return result;
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
      return { success: false, blockedReason: 'Email client not configured' };
    }

    const htmlBody = markdownToHtml(request.body);

    try {
      const sendOptions: SendEmailOptions = {
        to: [{ email: request.to }],
        cc: request.cc?.map((email) => ({ email })),
        subject: request.subject ?? '',
        body: htmlBody,
        replyToMessageId: request.replyToMessageId,
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
   * Send the CEO a brief email letting them know a draft reply is waiting in their
   * Drafts folder. Called immediately after a successful draft creation.
   *
   * Uses dispatchEmail() directly (bypasses send() to avoid infinite recursion and the
   * content filter — the notification body is a hardcoded template, not user content).
   * Uses the primary email account regardless of which account created the draft, so
   * the notification always lands in the same inbox (consistent with the blocked-content
   * alert pattern). Non-fatal: errors are logged but do not affect the draft result.
   *
   * Future: if a CEO Signal phone number is added to OutboundGatewayConfig, this method
   * can be extended to notify via Signal instead of (or in addition to) email.
   */
  private async notifyCeoDraftCreated(request: EmailSendRequest, draftId: string): Promise<void> {
    if (!this.ceoEmail) {
      this.log.warn(
        { accountId: request.accountId, draftId },
        'outbound-gateway: draft-created notification skipped — ceoEmail not configured',
      );
      return;
    }
    if (!this.primaryNylasClient) {
      this.log.warn(
        { accountId: request.accountId, draftId },
        'outbound-gateway: draft-created notification skipped — no primary email client configured',
      );
      return;
    }

    const subject = request.subject ?? '(no subject)';
    // Resolve the drafting account name for the notification body. Falls back to the
    // primary account name (cached at construction time), not the string literal
    // 'primary' which has no meaning to the CEO reading the notification email.
    const accountId = request.accountId ?? this.primaryAccountId ?? 'unknown';

    // Wrap interpolated values in backticks so markdownToHtml renders them as
    // literal code spans. Subject and recipient come from inbound thread metadata
    // which could contain markdown-significant characters (links, emphasis, etc.).
    const body = [
      `There is a draft email reply to \`${request.to}\` about \`${subject}\` waiting in your Drafts folder on account \`${accountId}\`.`,
      '',
      'Please review it and click send when you are ready.',
      '',
      `Draft ID: \`${draftId}\``,
    ].join('\n');

    try {
      const result = await this.dispatchEmail({
        channel: 'email',
        to: this.ceoEmail,
        subject: `Draft reply awaiting review — ${subject}`,
        body,
      });
      if (!result.success) {
        this.log.error(
          { draftId, accountId, ceoEmail: redactId(this.ceoEmail), reason: result.blockedReason },
          'outbound-gateway: failed to send CEO draft-created notification',
        );
      }
    } catch (err) {
      this.log.error(
        { err, draftId, accountId },
        'outbound-gateway: unexpected error sending CEO draft-created notification',
      );
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
    const htmlBody = markdownToHtml(request.body);

    try {
      const sendOptions: SendEmailOptions = {
        to: [{ email: request.to }],
        cc: request.cc?.map((email) => ({ email })),
        subject: request.subject ?? '',
        body: htmlBody,
        replyToMessageId: request.replyToMessageId,
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
