// handler.ts — approve-action skill implementation.
//
// Approves a pending approval request: transitions the row to 'approved',
// re-executes the originally blocked skill with humanApproved: true,
// writes a child autonomy_action_log row for the re-execution result,
// and publishes a human.decision audit event. A row carrying a personal-data ask (#2312)
// first records the principal's yes for that thread (disclosure_decisions).
//
// SECURITY: sensitivity: "elevated" — authorization is enforced solely by the execution-layer
// live-principal gate (#1126). No handler-level re-check: the gate already guarantees this skill
// only runs in a live principal turn. executionLayer capability is restricted to this skill.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { RESOLVED_BY, approvalLabel } from '../../../../src/autonomy/action-log-types.js';
import { parseApprovalRefInput } from '../../../_shared/approval-ref.js';
import { STALE_SEND_APPROVAL_ERROR } from '../../../../src/skills/_shared/recipient-reference.js';
import { createHumanDecision } from '../../../../src/bus/events.js';
import type { TaskOriginator } from '../../../../src/contacts/types.js';
import { hasPersonalDetails, UNSHOWN_PERSONAL_DETAILS_ERROR } from '../../../../src/autonomy/approval-notification.js';
import { cardUseRequestIdOf, CARD_USE_CONFIRM_TOOL, SAME_TURN_CARD_USE_ERROR, UNSHOWN_CARD_USE_ERROR } from '../../../../src/secrets/card-use-service.js';

export { UNSHOWN_PERSONAL_DETAILS_ERROR };

export class ApproveActionHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.actionLogRepo) {
      return { success: false, error: 'approve-action requires actionLogRepo capability' };
    }
    if (!ctx.bus) {
      return { success: false, error: 'approve-action requires bus capability' };
    }
    if (!ctx.executionLayer) {
      return { success: false, error: 'approve-action requires executionLayer capability' };
    }

    try {
      // Resolve the pending row
      // A short_ref that is present but unreadable, or a ref under another key, fails closed here; only an absent one may
      // fall back to the sole pending approval (#2159 Phase 3, see approval-ref.ts).
      const parsedRef = parseApprovalRefInput(ctx.input);
      if (!parsedRef.ok) {
        ctx.log.warn({ shortRefType: typeof ctx.input.short_ref, inputKeys: Object.keys(ctx.input) }, 'approve-action: unusable or mis-keyed approval reference — refusing to resolve');
        return { success: false, error: parsedRef.error };
      }

      const resolved = await ctx.actionLogRepo.resolvePending(parsedRef.ref);
      if (!resolved.found) {
        return { success: false, error: resolved.error };
      }

      const { row } = resolved;

      // Validate payload exists — re-execution needs the original skill input
      if (!row.payload) {
        ctx.log.error({ rowId: row.id }, 'approve-action: row has null payload — cannot re-execute');
        return { success: false, error: `Cannot approve ${approvalLabel(row)}: no stored payload for re-execution` };
      }

      // An approved send replays as written (#2312). The approval message lists every personal
      // detail it carries; one never delivered showed the principal none of them (a digest
      // line or list-pending-actions names only the description). Refused, not resolved: it
      // stays pending until delivered.
      // A personal-data ask too, whatever its payload holds yet: approving records a lasting yes
      // for the thread, and only the delivered approval asked the question.
      if (row.notificationSentAt === null && (row.disclosureAsk || hasPersonalDetails(row.toolName, row.payload))) {
        ctx.log.info(
          { rowId: row.id, shortRef: row.shortRef, toolName: row.toolName },
          'approve-action: undelivered approval carries personal details — refusing until it is delivered',
        );
        return { success: false, error: UNSHOWN_PERSONAL_DETAILS_ERROR };
      }

      // A card checkout is the principal's call alone (#1358). The coordinator can neither approve
      // one the principal was never shown, nor one it filed in this very turn, even when the
      // principal's message already said "buy it with my Visa". Refused, not resolved: the row
      // stays pending for a later message.
      if (row.toolName === CARD_USE_CONFIRM_TOOL) {
        if (row.notificationSentAt === null) {
          ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'approve-action: undelivered card-use approval — refusing until it is delivered');
          return { success: false, error: UNSHOWN_CARD_USE_ERROR };
        }
        if (row.taskId === ctx.taskEventId) {
          ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'approve-action: card-use approval requested in this turn — refusing');
          return { success: false, error: SAME_TURN_CARD_USE_ERROR };
        }
      }

      const pins = row.sendResolution;
      if (pins && pins.length > 0) {
        const still = await ctx.executionLayer.confirmPinnedSendResolution(row.toolName, pins);
        if (!still.ok) {
          ctx.log.info(
            { rowId: row.id, shortRef: row.shortRef },
            'approve-action: hinted recipient changed — refusing the approved send',
          );
          await ctx.actionLogRepo.rejectStaleApproval(row.id);
          return { success: false, error: STALE_SEND_APPROVAL_ERROR };
        }
      }

      // Step 1: Transition to approved — returns false if another actor resolved first.
      // We MUST check this before re-executing to prevent running a skill that was
      // concurrently denied or dismissed.
      // An agent called this tool on its own reading of the conversation, so the row does not
      // record it as the principal's decision; only reactions do (#2159).
      const transitioned = await ctx.actionLogRepo.resolveRow(row.id, 'approved', RESOLVED_BY.coordinator);
      if (!transitioned) {
        ctx.log.warn({ rowId: row.id, shortRef: row.shortRef }, 'approve-action: row was already resolved concurrently — aborting re-execution');
        return { success: false, error: `${approvalLabel(row)} was already resolved by another action — approval aborted` };
      }
      ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'approve-action: row transitioned to approved');

      // A personal-data ask (#2312): the yes is recorded before the replay, so a reply drafted
      // on the thread in the meantime already sees it. The recorder never throws. Only a delivered
      // approval records one: a yes to a message the principal never received is no consent
      // (the refusal above already stops every undelivered ask; this is the belt to those
      // braces).
      if (row.disclosureAsk && row.notificationSentAt !== null) {
        if (ctx.disclosureDecisions) {
          await ctx.disclosureDecisions.recordForApproval(row, 'yes', 'principal_via_coordinator');
        } else {
          ctx.log.error({ rowId: row.id }, 'approve-action: disclosureDecisions not wired — the principal\'s yes is not remembered for the thread');
        }
      }

      // Step 2: Re-execute the original skill with humanApproved bypass.
      // humanApproved skips the autonomy + caller gates (ADR-018). taskMetadata is forwarded so
      // the re-executed handler reads the originating live-principal standing for its own audit /
      // standing-continuity needs (the queued skill is always `normal` — elevated skills are
      // autonomy-exempt and so are never blocked into the queue in the first place).
      const reResult = await ctx.executionLayer.invoke(
        row.toolName,
        row.payload,
        ctx.caller,
        {
          humanApproved: true,
          approvalVia: 'coordinator',
          sendResolution: pins ?? undefined,
          taskEventId: ctx.taskEventId,
          // A card-use replay compares the approving conversation with the requesting one to
          // decide whether this turn continues the checkout or the originator is resumed (#1358).
          conversationId: row.toolName === CARD_USE_CONFIRM_TOOL
            ? ctx.conversationId
            : row.conversationId ?? undefined,
          taskMetadata: ctx.taskMetadata,
        },
      );

      // A card checkout whose replay failed would leave the request pending and the agent waiting:
      // settle it as expired so the conversation is resumed (#1358).
      const failedCardRequestId = reResult.success ? null : cardUseRequestIdOf(row);
      if (failedCardRequestId !== null) {
        if (ctx.cardUse) {
          try {
            await ctx.cardUse.decline(failedCardRequestId, 'expired');
          } catch (err) {
            ctx.log.error({ err, rowId: row.id, failedCardRequestId }, 'approve-action: failed to settle the card-use request after a failed replay');
          }
        } else {
          ctx.log.error({ rowId: row.id, failedCardRequestId }, 'approve-action: cardUse not wired — the failed card request is not settled');
        }
      }

      // Step 3: Write child row for the re-execution result
      const childOutcome = reResult.success ? 'success' : 'failure';
      try {
        await ctx.actionLogRepo.insert({
          taskId: row.taskId,
          conversationId: row.conversationId ?? undefined,
          toolName: row.toolName,
          actionRisk: row.actionRisk,
          outcome: childOutcome,
          // taskSummary is `string | undefined`; insert() maps undefined → NULL, so
          // use undefined (not null) for the success case to satisfy the field type.
          taskSummary: reResult.success ? undefined : (reResult as { error: string }).error,
          parentActionId: row.id,
        });
      } catch (err) {
        // Child row failure is non-fatal — the re-execution already happened.
        ctx.log.error({ err, rowId: row.id }, 'approve-action: failed to insert child action_log row');
      }

      // Step 4: Publish human.decision audit event (best-effort).
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
          'approve-action: audit metadata incomplete — originator/taskEventId should always be present when task is principal-originated. This indicates a dispatch-layer bug.',
        );
      } else {
        try {
          await ctx.bus.publish(
            'dispatch',
            createHumanDecision({
              decision: 'approve',
              deciderId: senderId,
              deciderChannel: channelId,
              subjectEventId: row.taskId,
              subjectSummary: `principal approved: ${row.description ?? row.toolName}`,
              contextShown: ['short_ref', 'description', 'skill_name', 'payload'],
              presentedAt: row.createdAt,
              decidedAt: new Date(),
              defaultAction: 'block',
              parentEventId: ctx.taskEventId,
            }),
          );
        } catch (err) {
          ctx.log.error({ err, rowId: row.id }, 'approve-action: failed to publish human.decision event');
        }
      }

      ctx.log.info(
        { rowId: row.id, shortRef: row.shortRef, reExecutionSuccess: reResult.success },
        'approve-action: completed',
      );

      return {
        success: true,
        data: {
          // Named the way the principal saw it: "Approval 3", or the reference for an unnumbered row.
          approved: approvalLabel(row),
          description: row.description,
          reExecutionSuccess: reResult.success,
          reExecutionResult: reResult.success ? reResult.data : (reResult as { error: string }).error,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'approve-action: unexpected failure');
      return { success: false, error: 'approve-action failed unexpectedly' };
    }
  }
}
