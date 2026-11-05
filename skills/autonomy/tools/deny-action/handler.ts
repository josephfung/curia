// handler.ts — deny-action skill implementation.
//
// Denies a pending approval request: transitions the autonomy_action_log row
// to outcome = 'denied' and publishes a human.decision audit event.
// No re-execution — the originally blocked skill stays blocked. A row carrying a personal-data
// ask (#2312) records the principal's no for that thread (disclosure_decisions).
//
// SECURITY: sensitivity: "elevated" — authorization is enforced solely by the execution-layer
// live-principal gate (#1126). No handler-level re-check.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { RESOLVED_BY, approvalLabel } from '../../../../src/autonomy/action-log-types.js';
import { parseApprovalRefInput } from '../../../_shared/approval-ref.js';
import { cardUseRequestIdOf } from '../../../../src/secrets/card-use-service.js';
import { createHumanDecision } from '../../../../src/bus/events.js';
import type { TaskOriginator } from '../../../../src/contacts/types.js';

export class DenyActionHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.actionLogRepo) {
      return { success: false, error: 'deny-action requires actionLogRepo capability' };
    }
    if (!ctx.bus) {
      return { success: false, error: 'deny-action requires bus capability' };
    }

    try {
      // A short_ref that is present but unreadable, or a ref under another key, fails closed here; only an absent one may
      // fall back to the sole pending approval (#2159 Phase 3, see approval-ref.ts).
      const parsedRef = parseApprovalRefInput(ctx.input);
      if (!parsedRef.ok) {
        ctx.log.warn({ shortRefType: typeof ctx.input.short_ref, inputKeys: Object.keys(ctx.input) }, 'deny-action: unusable or mis-keyed approval reference — refusing to resolve');
        return { success: false, error: parsedRef.error };
      }

      const resolved = await ctx.actionLogRepo.resolvePending(parsedRef.ref);
      if (!resolved.found) {
        return { success: false, error: resolved.error };
      }

      const { row } = resolved;

      // An agent called this tool on its own reading of the conversation, so the row does not
      // record it as the principal's decision; only reactions do (#2159).
      const transitioned = await ctx.actionLogRepo.resolveRow(row.id, 'denied', RESOLVED_BY.coordinator);
      if (!transitioned) {
        ctx.log.warn({ rowId: row.id, shortRef: row.shortRef }, 'deny-action: row was already resolved concurrently');
        return { success: false, error: `${approvalLabel(row)} was already resolved by another action` };
      }

      // A personal-data ask (#2312): later asks on the thread become bounces. Never throws. Only
      // for a delivered ask: a deny of one the principal never saw answers no question, so it
      // resolves the row without silencing later asks.
      if (row.disclosureAsk && row.notificationSentAt === null) {
        ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'deny-action: the ask was never delivered — denied without remembering a no for the thread');
      } else if (row.disclosureAsk) {
        if (ctx.disclosureDecisions) {
          await ctx.disclosureDecisions.recordForApproval(row, 'no', 'principal_via_coordinator');
        } else {
          ctx.log.error({ rowId: row.id }, 'deny-action: disclosureDecisions not wired — the principal\'s no is not remembered for the thread');
        }
      }

      // A denied card checkout: nothing is granted, and the agent is resumed with "declined" (#1358).
      const cardRequestId = cardUseRequestIdOf(row);
      if (cardRequestId !== null) {
        if (ctx.cardUse) {
          try {
            await ctx.cardUse.decline(cardRequestId, 'denied', 'coordinator');
          } catch (err) {
            ctx.log.error({ err, rowId: row.id, cardRequestId }, 'deny-action: failed to settle the denied card-use request');
          }
        } else {
          ctx.log.error({ rowId: row.id, cardRequestId }, 'deny-action: cardUse not wired — the denied card request is not settled');
        }
      }

      // Publish human.decision audit event (best-effort).
      //
      // originator is stamped by the dispatcher on every task and carries the contactId
      // and channel of whoever initiated the task chain. For this elevated skill the
      // execution-layer live-principal gate (#1126) already guaranteed a principal originator —
      // if it is missing here, that indicates a dispatch-layer bug.
      // Log loudly but don't publish a fake audit row with placeholder IDs, as a
      // counterfeit audit trail is worse than a missing one. See ADR-017.
      const originator = ctx.taskMetadata?.originator as TaskOriginator | undefined;
      const senderId = originator?.contactId;
      const channelId = originator?.channel;

      if (!senderId || !channelId || !ctx.taskEventId) {
        ctx.log.error(
          { senderId, channelId, taskEventId: ctx.taskEventId },
          'deny-action: audit metadata incomplete — originator/taskEventId should always be present when task is principal-originated. This indicates a dispatch-layer bug.',
        );
      } else {
        try {
          await ctx.bus.publish(
            'dispatch',
            createHumanDecision({
              decision: 'deny',
              deciderId: senderId,
              deciderChannel: channelId,
              subjectEventId: row.taskId,
              subjectSummary: `principal denied: ${row.description ?? row.toolName}`,
              contextShown: ['short_ref', 'description', 'skill_name'],
              presentedAt: row.createdAt,
              decidedAt: new Date(),
              defaultAction: 'block',
              parentEventId: ctx.taskEventId,
            }),
          );
        } catch (err) {
          ctx.log.error({ err, rowId: row.id }, 'deny-action: failed to publish human.decision event');
        }
      }

      ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'deny-action: request denied');
      // Named the way the principal saw it: "Approval 3", or the reference for an unnumbered row.
      return { success: true, data: `Denied: ${row.description ?? row.toolName} (${approvalLabel(row)})` };
    } catch (err) {
      ctx.log.error({ err }, 'deny-action: unexpected failure');
      return { success: false, error: 'deny-action failed unexpectedly' };
    }
  }
}
