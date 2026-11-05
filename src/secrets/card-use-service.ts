/**
 * CardUseService — the "principal confirms every checkout" flow for saved cards (#1358, ADR-059).
 *
 * Wraps CardUseRepo, SecretsService.getCardPublic, ApprovalTriggerService and the bus:
 *  - request(): records a card-use request and files a critical approval for the internal
 *    card-use-confirm tool. It never writes a grant.
 *  - confirm(): runs only as an approval replay (the tool refuses without humanApproved). It
 *    writes the grant, and tells the originating conversation how to continue.
 *  - decline(): the no / expiry path, called by the deny and expiry code directly.
 *
 * Events carry brand and last four only, never the card number.
 */

import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import { createCardUseDecided, createCardUseRequested } from '../bus/events.js';
import type { ApprovalTriggerService } from '../autonomy/approval-trigger.js';
import type { ApprovalVia } from '../skills/types.js';
import type { CardUseRepo } from './card-use-repo.js';
import type { SecretsService } from './secrets-service.js';
import type { CaptureOrigin } from './secret-capture-service.js';
import { describeCard } from './structured-secret-schema.js';

/** A card-use approval is good for 30 minutes, not the usual 24 hours. */
export const CARD_USE_APPROVAL_TTL_MS = 30 * 60_000;

/** The name of the internal tool a card-use approval replays. */
export const CARD_USE_CONFIRM_TOOL = 'card-use-confirm';

/**
 * The card-use request an approval row answers, or null for any other row. The deny, dismiss
 * and expiry paths use it to settle the request and resume the conversation.
 */
export function cardUseRequestIdOf(row: { toolName: string; payload: Record<string, unknown> | null }): string | null {
  if (row.toolName !== CARD_USE_CONFIRM_TOOL) return null;
  const id = row.payload?.['request_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export interface CardUseConfirmResult {
  outcome: 'approved' | 'expired' | 'already_resolved';
  /** True when a card_use.decided event asked the bus to re-enter the originating conversation. */
  resumed: boolean;
  /** For the agent that ran the approval, when it gets the result. */
  message: string;
}

export interface CardUseRequestInput {
  secretName: string;
  siteUrl: string;
  amount: string;
  purpose: string;
}

export interface CardUseRequestContext {
  taskEventId: string;
  conversationId: string;
  origin: CaptureOrigin;
}

export interface CardUseRequestResult {
  shortRef: string;
  /** Null only when all 999 numbers are in use; the reference still works. */
  approvalNumber: number | null;
  expiresAt: Date;
  card: string;
}

/** Surface exposed to skills as `ctx.cardUse`. `decline` is for dismiss-action. */
export interface CardUseCapability {
  request(input: CardUseRequestInput, ctx: CardUseRequestContext): Promise<CardUseRequestResult>;
  confirm(requestId: string, via?: ApprovalVia, approvingConversationId?: string): Promise<CardUseConfirmResult>;
  decline(requestId: string, status?: 'denied' | 'expired' | 'failed'): Promise<void>;
}

/** approve-action refuses a card-use row the principal was never shown (#1358). */
export const UNSHOWN_CARD_USE_ERROR =
  "This card confirmation hasn't reached the principal yet; deliver it first.";

/** approve-action refuses a card-use row filed in the same turn (#1358). */
export const SAME_TURN_CARD_USE_ERROR =
  'The principal has to answer this confirmation themselves in a later message — ask them to reply "approve N" again or react 👍.';

/** approve-action refuses a card-use row when the message it answers predates the confirmation (#1358). */
export const PREDATING_CARD_USE_ERROR =
  'That message was sent before the confirmation reached the principal. Ask them to reply "approve N" again or react 👍.';

export const CARD_USE_CONTINUE_MESSAGE = 'Approved. Continue the checkout now in the same browser session.';
export const CARD_USE_EXPIRED_MESSAGE =
  'The approval came after the 30 minutes ran out, so no grant was written. Ask again with card-use-request if the principal still wants this purchase.';
export const CARD_USE_ALREADY_RESOLVED_MESSAGE = 'This card-use request was already resolved; nothing changed.';
export const CARD_USE_APPROVED_RESUMING_MESSAGE =
  'Approved. The conversation that asked is being resumed to continue the checkout.';

export class CardUseService implements CardUseCapability {
  constructor(
    private readonly deps: {
      repo: CardUseRepo;
      secrets: Pick<SecretsService, 'getCardPublic'>;
      approvalTrigger: Pick<ApprovalTriggerService, 'request'>;
      bus: Pick<EventBus, 'publish'>;
      logger: Logger;
    },
  ) {}

  async request(input: CardUseRequestInput, ctx: CardUseRequestContext): Promise<CardUseRequestResult> {
    const { repo, secrets, approvalTrigger, bus, logger } = this.deps;
    const pub = await secrets.getCardPublic(input.secretName);
    if (!pub) throw new Error(`\`${input.secretName}\` is not a saved card.`);
    const card = describeCard(pub.publicFields, pub.label);

    const { id, siteDomain } = await repo.create({
      secretName: input.secretName,
      siteUrl: input.siteUrl,
      conversationId: ctx.conversationId,
      taskId: ctx.taskEventId,
      amount: input.amount,
      purpose: input.purpose,
      origin: ctx.origin,
    });

    // Read just before filing, so it matches the row's own expiry to within the call.
    const expiresAt = new Date(Date.now() + CARD_USE_APPROVAL_TTL_MS);
    const filed = await approvalTrigger.request({
      toolName: CARD_USE_CONFIRM_TOOL,
      input: { request_id: id },
      // What the principal sees: the masked card, never the number.
      displayInput: { card, site: siteDomain, amount: input.amount, purpose: input.purpose },
      actionRisk: 'critical',
      reason:
        `Curia wants to pay ${input.amount} at ${siteDomain} with ${card} for: ${input.purpose}. ` +
        'The amount is what Curia read on the page.',
      expiresInMs: CARD_USE_APPROVAL_TTL_MS,
      taskId: ctx.taskEventId,
      conversationId: ctx.conversationId,
      // Unused: the reason above replaces the score-based preamble.
      currentScore: 0,
      requiredScore: 90,
    });
    if (!filed.created) {
      // The input carries a fresh request id, so a duplicate means something is badly wrong.
      throw new Error('The card-use approval could not be filed.');
    }
    if (filed.approvalNumber === null) {
      logger.warn({ requestId: id }, 'card-use: approval has no number; the principal answers by reference');
    }
    try {
      await repo.setShortRef(id, filed.shortRef);

      await bus.publish('execution', createCardUseRequested({
        requestId: id,
        secretName: input.secretName,
        siteDomain,
        conversationId: ctx.conversationId,
        amount: input.amount,
        brand: pub.publicFields.brand,
        last4: pub.publicFields.last4,
        ...(pub.label ? { label: pub.label } : {}),
      }, ctx.taskEventId));
    } catch (err) {
      // Settle the request so approving the orphaned approval later returns already_resolved and writes no grant.
      try {
        await repo.decide(id, 'expired');
      } catch (settleErr) {
        logger.error({ err: settleErr, requestId: id }, 'card-use: could not settle a request whose filing failed');
      }
      throw err;
    }

    logger.info({ requestId: id, siteDomain, shortRef: filed.shortRef }, 'card-use: request filed');
    return {
      shortRef: filed.shortRef,
      approvalNumber: filed.approvalNumber,
      expiresAt,
      card,
    };
  }

  async confirm(
    requestId: string,
    via?: ApprovalVia,
    approvingConversationId?: string,
  ): Promise<CardUseConfirmResult> {
    const { repo, logger } = this.deps;
    const row = await repo.get(requestId);
    if (!row) throw new Error('Unknown card-use request.');

    const outcome = await repo.approve(requestId);
    if (outcome === 'already_resolved') {
      return { outcome, resumed: false, message: CARD_USE_ALREADY_RESOLVED_MESSAGE };
    }

    // approve-action answered in the requesting conversation: its result tells the agent to
    // continue, so two turns never drive the same browser session.
    const inline = via === 'coordinator' && approvingConversationId !== undefined
      && approvingConversationId === row.conversationId;
    const resume = !inline;
    const published = await this.publishDecided(row, outcome, via, resume);
    const resumed = resume && published;
    logger.info({ requestId, outcome, via, resume }, 'card-use: confirmation processed');

    if (outcome === 'expired') {
      return { outcome, resumed, message: CARD_USE_EXPIRED_MESSAGE };
    }
    return {
      outcome,
      resumed,
      message: inline ? CARD_USE_CONTINUE_MESSAGE : CARD_USE_APPROVED_RESUMING_MESSAGE,
    };
  }

  /** Resolve a pending request as denied (default), expired, or failed (the principal approved
   *  but the replay broke), and resume the conversation. A failed request is stored as expired. */
  async decline(requestId: string, status: 'denied' | 'expired' | 'failed' = 'denied'): Promise<void> {
    const { repo, logger } = this.deps;
    const row = await repo.get(requestId);
    if (!row) {
      logger.warn({ requestId }, 'card-use: decline for an unknown request');
      return;
    }
    const changed = await repo.decide(requestId, status === 'failed' ? 'expired' : status);
    if (!changed) return;
    await this.publishDecided(row, status, undefined, true);
    logger.info({ requestId, status }, 'card-use: request declined');
  }

  private async publishDecided(
    row: NonNullable<Awaited<ReturnType<CardUseRepo['get']>>>,
    decision: 'approved' | 'denied' | 'expired' | 'failed',
    via:ApprovalVia | undefined,
    resume: boolean,
  ): Promise<boolean> {
    // The resolution is already committed, so a failed publish can't undo it. Log it loudly:
    // the conversation will not be resumed.
    try {
      await this.deps.bus.publish('execution', createCardUseDecided({
        requestId: row.id,
        secretName: row.secretName,
        siteDomain: row.siteDomain,
        conversationId: row.conversationId,
        decision,
        ...(via ? { via } : {}),
        resume,
        origin: row.origin,
        purpose: row.purpose,
      }, row.taskId));
      return true;
    } catch (err) {
      this.deps.logger.error({ err, requestId: row.id, decision }, 'card-use: failed to publish card_use.decided; the conversation is not resumed');
      return false;
    }
  }
}
