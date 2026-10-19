// reaction-approval-mapper.ts — wire inbound.reaction → approval decisions (#1479).
//
// Channel-agnostic: Slack and Signal (and future channels) publish the same
// inbound.reaction shape. This mapper:
//   1. Honors isRemove (no-op)
//   2. Correlates targetMessageId → pending approval (skip non-approval traffic)
//   3. Authorizes principal reactors only (unknown/wrong-tier → audited no-op)
//   4. Maps emoji → approve/reject via config (no channel branching)
//   5. Unrecognized emoji on a real pending approval → hint reply (not silent)
//   6. Approves (re-exec) or denies — same outcomes as the elevated skills

import type { EventBus } from '../bus/bus.js';
import {
  createHumanDecision,
  createOutboundMessage,
  type InboundReactionEvent,
  type OutboundDeliveredEvent,
} from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { ChannelIdentity } from '../contacts/types.js';
import { isPrincipalIdentity } from '../contacts/principal-recipient.js';
import type { ActionLogRepo } from './action-log-repo.js';
import { RESOLVED_BY, type ActionLogRow } from './action-log-types.js';
import type { ExecutionLayer } from '../skills/execution.js';
import {
  DEFAULT_REACTION_INTENTS,
  mapEmojiToIntent,
  type ReactionIntentConfig,
} from './reaction-intent.js';

/**
 * The fingerprint of an approval notification (buildApprovalNotificationBody): the identifier
 * line, `Approval <n>` for numbered approvals (#2159 Phase 3) or `Reference: <8-hex>` for ones
 * raised before migration 098, directly followed by its `Expires: <ISO-8601>` line. Group 1 is
 * the short_ref, group 2 the number, group 3 the expiry exactly as rendered.
 *
 * Deliberately strict: case-sensitive, whole lines, single spaces, and the Expires line
 * required. An ordinary message that merely mentions an approval ("Sent you approval 3", a
 * spot-check line ending "for approval", "the approval 2-day window") must never bind, or a
 * principal 👍 meant as an acknowledgement would approve something they were not shown. The
 * format is a contract with approval-notification.ts, which says so where it renders it.
 *
 * Global (`g`) for matchAll, which works on a copy and never touches this regex's lastIndex.
 *
 * @internal exported so a test can pin it against buildApprovalNotificationBody's output.
 */
export const APPROVAL_FINGERPRINT_RE =
  /^(?:Reference: ([0-9a-f]{8})|Approval (\d{1,3}))\nExpires: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/gm;

/**
 * Loose look-alike of the fingerprint's identifier line: any line STARTING with `Approval <digit>` or
 * `Reference: <8-hex>`. Used only to decide how loudly to log a message that did not bind (never to
 * bind): a line shaped like this without the strict fingerprint is a mangled or forged notification
 * worth a warning, while ordinary chat stays silent.
 */
const APPROVAL_LOOKALIKE_RE = /^(?:Approval \d|Reference: [0-9a-f]{8})/m;

/**
 * The approval a delivered body identifies, taken from the LAST fingerprint. The detail block
 * (message bodies, subjects, descriptions) holds agent and third-party text and sits above the
 * real fingerprint, which only the fixed call to action follows. A body that forges a
 * fingerprint for another approval must not redirect this notification's binding to it.
 */
function lastApprovalIdentifier(
  content: string,
): ({ shortRef: string } | { approvalNumber: number }) & { expires: string } | null {
  let last: RegExpExecArray | null = null;
  for (const match of content.matchAll(APPROVAL_FINGERPRINT_RE)) last = match;
  if (!last || !last[3]) return null;
  const expires = last[3];
  if (last[1]) return { shortRef: last[1], expires };
  return last[2] ? { approvalNumber: Number(last[2]), expires } : null;
}

export const UNRECOGNIZED_REACTION_HINT =
  "That reaction isn't recognized for approvals. React 👍 to approve or 👎 to reject.";

const STALE_SEND_APPROVAL_NOTICE =
  'That approval no longer matches the address that was shown, so nothing was sent. Ask again if you still want it sent.';

export interface ReactionApprovalMapperConfig {
  bus: EventBus;
  logger: Logger;
  actionLogRepo: ActionLogRepo;
  contactService: ContactService;
  executionLayer: ExecutionLayer;
  principalIdentities: readonly ChannelIdentity[];
  reactionIntents?: ReactionIntentConfig;
}

export class ReactionApprovalMapper {
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly actionLogRepo: ActionLogRepo;
  private readonly contactService: ContactService;
  private readonly executionLayer: ExecutionLayer;
  private readonly principalIdentities: readonly ChannelIdentity[];
  private readonly reactionIntents: ReactionIntentConfig;

  constructor(config: ReactionApprovalMapperConfig) {
    this.bus = config.bus;
    this.log = config.logger.child({ component: 'reaction-approval-mapper' });
    this.actionLogRepo = config.actionLogRepo;
    this.contactService = config.contactService;
    this.executionLayer = config.executionLayer;
    this.principalIdentities = config.principalIdentities;
    this.reactionIntents = config.reactionIntents ?? DEFAULT_REACTION_INTENTS;
  }

  register(): void {
    this.bus.subscribe('inbound.reaction', 'dispatch', async (event) => {
      await this.handleReaction(event as InboundReactionEvent);
    });

    // Secondary binding path: when an outbound approval message is delivered
    // with a body that embeds `Approval <n>` or `Reference: <short_ref>`, bind its provider
    // message id so a later reaction can correlate without channel branching.
    this.bus.subscribe('outbound.delivered', 'dispatch', async (event) => {
      await this.handleDelivered(event as OutboundDeliveredEvent);
    });

    this.log.info('ReactionApprovalMapper registered (inbound.reaction + outbound.delivered)');
  }

  /** @internal exported for tests */
  async handleReaction(event: InboundReactionEvent): Promise<void> {
    const { channelId, senderId, emoji, targetMessageId, conversationId, metadata } = event.payload;

    if (metadata?.['isRemove'] === true) {
      this.log.info(
        { channelId, senderId, targetMessageId },
        'reaction-approval: ignoring isRemove reaction',
      );
      return;
    }

    // Correlate first — reactions on non-approval messages exit before
    // principal checks or emoji mapping (keeps flood cheap).
    // conversationId is advisory only (logging) — never used for correlation.
    const row = await this.actionLogRepo.findPendingByDeliveryMessage(channelId, targetMessageId);
    if (!row) {
      this.log.debug(
        { channelId, targetMessageId, conversationId },
        'reaction-approval: no pending approval bound to targetMessageId',
      );
      return;
    }

    if (!isPrincipalIdentity(channelId, senderId, this.principalIdentities)) {
      this.log.warn(
        { channelId, senderId, targetMessageId, shortRef: row.shortRef },
        'reaction-approval: ignoring reaction from non-principal sender (audited)',
      );
      return;
    }

    const intent = mapEmojiToIntent(emoji, this.reactionIntents);
    if (!intent) {
      this.log.info(
        { channelId, emoji, targetMessageId, shortRef: row.shortRef },
        'reaction-approval: unrecognized emoji on pending approval — sending hint',
      );
      await this.sendUnrecognizedHint(event);
      return;
    }

    this.log.debug(
      { channelId, senderId, targetMessageId, conversationId, intent },
      'reaction-approval: correlating via targetMessageId',
    );

    const resolved = await this.contactService.resolveByChannelIdentity(channelId, senderId);
    const deciderId = resolved?.contactId ?? senderId;

    if (intent === 'approve') {
      await this.approve(row, deciderId, channelId, event.id);
    } else {
      await this.deny(row, deciderId, channelId, event.id);
    }
  }

  /** @internal exported for tests */
  async handleDelivered(event: OutboundDeliveredEvent): Promise<void> {
    const { channel, messageId, content, recipientId } = event.payload;
    if (!messageId || !content) return;

    // Approvals are delivered only to the principal's own identities. A notification-shaped
    // message sent anywhere else (a group, a third party) is not one the principal answers by
    // reaction, so it never binds.
    if (!isPrincipalIdentity(channel, recipientId, this.principalIdentities)) {
      if (APPROVAL_LOOKALIKE_RE.test(content)) {
        this.log.debug(
          { channel, messageId },
          'reaction-approval: approval-shaped message delivered to a recipient that is not a principal identity — not binding',
        );
      }
      return;
    }

    const identifier = lastApprovalIdentifier(content);
    if (!identifier) {
      // Real notifications always carry the strict fingerprint. A line that looks like one without
      // it means the renderer and this regex drifted apart (reactions silently stop working) or
      // someone is imitating a notification; either way it should be seen.
      if (APPROVAL_LOOKALIKE_RE.test(content)) {
        this.log.warn(
          { channel, messageId },
          'reaction-approval: approval-shaped message to the principal lacks the strict notification fingerprint — not binding',
        );
      }
      return;
    }

    try {
      // A number resolves only among live approvals of the last 7 days, where it is unique.
      const row = 'approvalNumber' in identifier
        ? await this.actionLogRepo.findPendingByApprovalNumber(identifier.approvalNumber)
        : await this.actionLogRepo.findPendingByShortRef(identifier.shortRef);
      if (!row) {
        // Normal for a notification about an approval that was resolved or expired before delivery.
        this.log.debug(
          { ...identifier, channel, messageId },
          'reaction-approval: no live approval matches the delivered fingerprint — not binding',
        );
        return;
      }

      // The fingerprint must carry THIS approval's own expiry, exactly as the notification renders
      // it (approval-delivery passes row.expiresAt to buildApprovalNotificationBody, which prints
      // toISOString()). Numbers are small and reused, so "Approval 1" with any well-formed Expires
      // line would otherwise bind whichever live approval holds 1 today: forged or echoed text
      // sent to the principal could then turn a habitual 👍 into approving something they never
      // saw. A row with no expiry cannot be matched and never binds.
      if (row.expiresAt?.toISOString() !== identifier.expires) {
        this.log.warn(
          {
            ...identifier,
            rowExpiresAt: row.expiresAt?.toISOString() ?? null,
            actionLogId: row.id,
            channel,
            messageId,
          },
          'reaction-approval: fingerprint expiry does not match the live approval — not binding',
        );
        return;
      }

      await this.actionLogRepo.bindDeliveryMessage(row.id, channel, messageId);
      this.log.info(
        { actionLogId: row.id, shortRef: row.shortRef, approvalNumber: row.approvalNumber, channel, messageId },
        'reaction-approval: bound delivered message to pending approval',
      );
    } catch (err) {
      // A failed lookup or bind leaves the message unbound: a reaction on it is then ignored,
      // and the principal can still answer by reply.
      this.log.warn(
        { err, ...identifier, channel, messageId },
        'reaction-approval: failed to bind delivered message',
      );
    }
  }

  /** The hinted identity changed after the approval was filed. Nothing was sent. */
  private async sendStaleSendNotice(
    channelId: string,
    recipientId: string,
    conversationId: string | null,
    parentEventId: string,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      await this.bus.publish(
        'dispatch',
        createOutboundMessage({
          conversationId,
          channelId,
          recipientId,
          content: STALE_SEND_APPROVAL_NOTICE,
          parentEventId,
        }),
      );
    } catch (err) {
      this.log.warn({ err, channelId }, 'reaction-approval: failed to publish stale-approval notice');
    }
  }

  /**
   * Tell the principal how to approve/reject when they used an unmapped emoji
   * on a real pending-approval message. Routes through outbound.message so
   * channel adapters deliver without mapper-side Slack/Signal branching.
   */
  private async sendUnrecognizedHint(event: InboundReactionEvent): Promise<void> {
    const { conversationId, channelId, senderId } = event.payload;
    try {
      await this.bus.publish(
        'dispatch',
        createOutboundMessage({
          conversationId,
          channelId,
          recipientId: senderId,
          content: UNRECOGNIZED_REACTION_HINT,
          parentEventId: event.id,
        }),
      );
    } catch (err) {
      this.log.warn(
        { err, channelId, senderId },
        'reaction-approval: failed to publish unrecognized-reaction hint',
      );
    }
  }

  private async approve(
    row: ActionLogRow,
    deciderId: string,
    channelId: string,
    parentEventId: string,
  ): Promise<void> {
    if (!row.payload) {
      // A pending approval with no stored payload can't be re-executed. Rather
      // than leave the row stuck in pending_approval forever (silent dead end),
      // fail closed: resolve it as denied. The action never ran, so "denied"
      // accurately reflects the outcome even though the principal reacted approve.
      this.log.error({ rowId: row.id }, 'reaction-approval: cannot approve — null payload; failing closed to deny');
      await this.deny(row, deciderId, channelId, parentEventId);
      return;
    }

    const pins = row.sendResolution;
    if (pins && pins.length > 0) {
      const still = await this.executionLayer.confirmPinnedSendResolution(row.toolName, pins);
      if (!still.ok) {
        this.log.info(
          { rowId: row.id, shortRef: row.shortRef },
          'reaction-approval: hinted recipient changed — refusing the approved send',
        );
        await this.actionLogRepo.rejectStaleApproval(row.id);
        await this.sendStaleSendNotice(channelId, deciderId, row.conversationId, parentEventId);
        return;
      }
    }

    const transitioned = await this.actionLogRepo.resolveRow(row.id, 'approved', RESOLVED_BY.principal);
    if (!transitioned) {
      this.log.warn(
        { rowId: row.id, shortRef: row.shortRef },
        'reaction-approval: row already resolved — aborting approve',
      );
      return;
    }

    const reResult = await this.executionLayer.invoke(
      row.toolName,
      row.payload,
      { contactId: deciderId, role: 'ceo', channel: channelId },
      {
        humanApproved: true,
        sendResolution: pins ?? undefined,
        taskEventId: row.taskId,
        conversationId: row.conversationId ?? undefined,
        liveTurn: true,
        taskMetadata: {
          originator: { contactId: deciderId, channel: channelId },
        },
      },
    );

    try {
      await this.actionLogRepo.insert({
        taskId: row.taskId,
        conversationId: row.conversationId ?? undefined,
        toolName: row.toolName,
        actionRisk: row.actionRisk,
        outcome: reResult.success ? 'success' : 'failure',
        taskSummary: reResult.success ? undefined : (reResult as { error: string }).error,
        parentActionId: row.id,
      });
    } catch (err) {
      this.log.error({ err, rowId: row.id }, 'reaction-approval: failed to insert child action_log row');
    }

    await this.publishDecision('approve', row, deciderId, channelId, parentEventId);

    this.log.info(
      { rowId: row.id, shortRef: row.shortRef, reExecutionSuccess: reResult.success },
      'reaction-approval: approved via reaction',
    );
  }

  private async deny(
    row: ActionLogRow,
    deciderId: string,
    channelId: string,
    parentEventId: string,
  ): Promise<void> {
    const transitioned = await this.actionLogRepo.resolveRow(row.id, 'denied', RESOLVED_BY.principal);
    if (!transitioned) {
      this.log.warn(
        { rowId: row.id, shortRef: row.shortRef },
        'reaction-approval: row already resolved — aborting deny',
      );
      return;
    }

    await this.publishDecision('deny', row, deciderId, channelId, parentEventId);

    this.log.info(
      { rowId: row.id, shortRef: row.shortRef },
      'reaction-approval: denied via reaction',
    );
  }

  private async publishDecision(
    decision: 'approve' | 'deny',
    row: ActionLogRow,
    deciderId: string,
    channelId: string,
    parentEventId: string,
  ): Promise<void> {
    try {
      await this.bus.publish(
        'dispatch',
        createHumanDecision({
          decision,
          deciderId,
          deciderChannel: channelId,
          subjectEventId: row.taskId,
          subjectSummary:
            decision === 'approve'
              ? `principal approved: ${row.description ?? row.toolName}`
              : `principal denied: ${row.description ?? row.toolName}`,
          contextShown: ['reaction', 'short_ref', 'description', 'skill_name'],
          presentedAt: row.createdAt,
          decidedAt: new Date(),
          defaultAction: 'block',
          parentEventId,
        }),
      );
    } catch (err) {
      this.log.error({ err, rowId: row.id }, 'reaction-approval: failed to publish human.decision');
    }
  }
}
