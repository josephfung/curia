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
import type { ActionLogRow } from './action-log-types.js';
import type { ExecutionLayer } from '../skills/execution.js';
import {
  DEFAULT_REACTION_INTENTS,
  mapEmojiToIntent,
  type ReactionIntentConfig,
} from './reaction-intent.js';

/** Matches `Reference: <8-hex>` from approval notification bodies. */
const REFERENCE_RE = /\bReference:\s*([0-9a-f]{8})\b/i;

export const UNRECOGNIZED_REACTION_HINT =
  "That reaction isn't recognized for approvals. React 👍 to approve or 👎 to reject.";

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
    // with a body that embeds `Reference: <short_ref>`, bind its provider
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
    const { channel, messageId, content } = event.payload;
    if (!messageId || !content) return;

    const match = REFERENCE_RE.exec(content);
    if (!match?.[1]) return;

    const shortRef = match[1]!.toLowerCase();
    const row = await this.actionLogRepo.findPendingByShortRef(shortRef);
    if (!row) return;

    try {
      await this.actionLogRepo.bindDeliveryMessage(row.id, channel, messageId);
      this.log.info(
        { actionLogId: row.id, shortRef, channel, messageId },
        'reaction-approval: bound delivered message to pending approval',
      );
    } catch (err) {
      this.log.warn(
        { err, actionLogId: row.id, channel, messageId },
        'reaction-approval: failed to bind delivered message',
      );
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

    const transitioned = await this.actionLogRepo.resolveRow(row.id, 'approved', 'ceo');
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
    const transitioned = await this.actionLogRepo.resolveRow(row.id, 'denied', 'ceo');
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
              ? `CEO approved: ${row.description ?? row.toolName}`
              : `CEO denied: ${row.description ?? row.toolName}`,
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
