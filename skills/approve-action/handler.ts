// handler.ts — approve-action skill implementation.
//
// Approves a pending approval request: transitions the row to 'approved',
// re-executes the originally blocked skill with humanApproved: true,
// writes a child autonomy_action_log row for the re-execution result,
// and publishes a human.decision audit event.
//
// SECURITY: sensitivity: "elevated" + ceoInitiated check.
// executionLayer capability is restricted to this skill.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';

export class ApproveActionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // CEO-origin check
    if (ctx.taskMetadata?.ceoInitiated !== true) {
      ctx.log.warn('approve-action: rejected — ceoInitiated flag absent or false');
      return { success: false, error: 'This skill requires direct CEO authorization.' };
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

    // Step 1: Transition to approved
    await ctx.actionLogRepo.resolveRow(row.id, 'approved', 'ceo');
    ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'approve-action: row transitioned to approved');

    // Step 2: Re-execute the original skill with humanApproved bypass
    const reResult = await ctx.executionLayer.invoke(
      row.skillName,
      row.payload,
      ctx.caller,
      {
        humanApproved: true,
        taskEventId: ctx.taskEventId,
        conversationId: row.conversationId ?? undefined,
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
        taskSummary: reResult.success ? null : (reResult as { error: string }).error,
        parentActionId: row.id,
      });
    } catch (err) {
      // Child row failure is non-fatal — the re-execution already happened.
      ctx.log.error({ err, rowId: row.id }, 'approve-action: failed to insert child action_log row');
    }

    // Step 4: Publish human.decision audit event (best-effort)
    const senderId = typeof ctx.taskMetadata?.senderId === 'string' ? ctx.taskMetadata.senderId : 'unknown';
    const channelId = typeof ctx.taskMetadata?.channelId === 'string' ? ctx.taskMetadata.channelId : 'unknown';
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
          parentEventId: ctx.taskEventId ?? '',
        }),
      );
    } catch (err) {
      ctx.log.error({ err, rowId: row.id }, 'approve-action: failed to publish human.decision event');
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
  }
}
