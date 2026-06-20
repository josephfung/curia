// handler.ts — approve-action skill implementation.
//
// Approves a pending approval request: transitions the row to 'approved',
// re-executes the originally blocked skill with humanApproved: true,
// writes a child autonomy_action_log row for the re-execution result,
// and publishes a human.decision audit event.
//
// SECURITY: sensitivity: "elevated" + isPrincipalOriginated check.
// executionLayer capability is restricted to this skill.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';
import { isPrincipalOriginated } from '../../src/contacts/principal.js';
import type { TaskOriginator } from '../../src/contacts/types.js';

export class ApproveActionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // Principal-origin check
    if (!isPrincipalOriginated(ctx.taskMetadata)) {
      ctx.log.warn('approve-action: rejected — task not originated by principal');
      return { success: false, error: 'This skill requires principal authorization.' };
    }

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
      const shortRef = typeof ctx.input.short_ref === 'string' && ctx.input.short_ref.trim()
        ? ctx.input.short_ref.trim()
        : undefined;

      const resolved = await ctx.actionLogRepo.resolvePending(shortRef);
      if (!resolved.found) {
        return { success: false, error: resolved.error };
      }

      const { row } = resolved;

      // Validate payload exists — re-execution needs the original skill input
      if (!row.payload) {
        ctx.log.error({ rowId: row.id }, 'approve-action: row has null payload — cannot re-execute');
        return { success: false, error: `Cannot approve request '${row.shortRef}': no stored payload for re-execution` };
      }

      // Step 1: Transition to approved — returns false if another actor resolved first.
      // We MUST check this before re-executing to prevent running a skill that was
      // concurrently denied or dismissed.
      const transitioned = await ctx.actionLogRepo.resolveRow(row.id, 'approved', 'ceo');
      if (!transitioned) {
        ctx.log.warn({ rowId: row.id, shortRef: row.shortRef }, 'approve-action: row was already resolved concurrently — aborting re-execution');
        return { success: false, error: `Request '${row.shortRef}' was already resolved by another action — approval aborted` };
      }
      ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'approve-action: row transitioned to approved');

      // Step 2: Re-execute the original skill with humanApproved bypass.
      // Pass taskMetadata so that elevated-sensitivity skills pass the isPrincipalOriginated
      // gate — the approval itself is already a principal-originated action (checked above).
      const reResult = await ctx.executionLayer.invoke(
        row.skillName,
        row.payload,
        ctx.caller,
        {
          humanApproved: true,
          taskEventId: ctx.taskEventId,
          conversationId: row.conversationId ?? undefined,
          taskMetadata: ctx.taskMetadata,
        },
      );

      // Step 3: Write child row for the re-execution result
      const childOutcome = reResult.success ? 'success' : 'failure';
      try {
        await ctx.actionLogRepo.insert({
          taskId: row.taskId,
          conversationId: row.conversationId ?? undefined,
          skillName: row.skillName,
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
      // and channel of whoever initiated the task chain. Must be present if we passed the
      // principal-origin check above — if missing, that indicates a dispatch-layer bug.
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
              subjectSummary: `CEO approved: ${row.description ?? row.skillName}`,
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
          approved: row.shortRef,
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
