// handler.ts — pending-actions-digest skill implementation.
//
// Digest skill: fetches all non-expired pending_approval rows and sends a
// single summary email to the CEO so they can see all outstanding requests
// in one place. Designed to be run on a daily schedule.
//
// Non-fatal failure modes:
//   - CEO_PRIMARY_EMAIL not configured → returns skipped: true
//   - outboundGateway absent → returns skipped: true
//   - sendNotification() returns false → logged at warn, not propagated
//   - No pending rows → returns skipped: true, no email sent

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ActionLogRow } from '../../src/autonomy/action-log-types.js';

/**
 * Format time remaining until expiry into a human-readable string.
 * Used to show the CEO how much time is left to act on each request.
 *
 * Thresholds:
 *   ms <= 0 or ms < 1h → '<1h remaining' (treat as critical, same label)
 *   else               → '<N>h remaining'
 */
function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return '<1h remaining';
  if (ms < 3_600_000) return '<1h remaining';
  return `${Math.floor(ms / 3_600_000)}h remaining`;
}

export class PendingActionsDigestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    try {
      if (!ctx.actionLogRepo) {
        return { success: false, error: 'pending-actions-digest requires actionLogRepo capability' };
      }

      // --- Step 1: Load all non-expired pending_approval rows ---
      const pending: ActionLogRow[] = await ctx.actionLogRepo.findAllPending();

      // Early return when nothing to digest — avoid sending an empty email.
      if (pending.length === 0) {
        return { success: true, data: { pending: 0, skipped: true } };
      }

      // --- Step 2: Read CEO email from env (not ctx.secret()) ---
      // ctx.secret() throws on a missing variable, which would surface as skill
      // failure rather than a clean skip. Reading from env gives us a graceful
      // fallback path when the variable is not configured.
      const ceoEmail = process.env['CEO_PRIMARY_EMAIL'] ?? '';

      if (!ceoEmail) {
        ctx.log.warn(
          { pendingCount: pending.length },
          'pending-actions-digest: CEO_PRIMARY_EMAIL not configured, skipping digest',
        );
        return { success: true, data: { pending: pending.length, skipped: true } };
      }

      // --- Step 3: Check outbound gateway is available ---
      if (ctx.outboundGateway === undefined) {
        ctx.log.warn(
          { pendingCount: pending.length },
          'pending-actions-digest: outboundGateway not available, skipping digest',
        );
        return { success: true, data: { pending: pending.length, skipped: true } };
      }

      // --- Step 4: Build bullet-list body ---
      // Each line shows the description, originating skill, time remaining, and short
      // reference (at end) so the CEO can quickly assess urgency without opening each request.
      const body = pending
        .map((r) => {
          // expiresAt is guaranteed non-null by findAllPending() (WHERE expires_at > now()),
          // but the type is Date | null — null-coalesce to avoid calling .getTime() on null.
          const msRemaining = r.expiresAt != null ? r.expiresAt.getTime() - Date.now() : 0;
          const timeRemaining = formatTimeRemaining(msRemaining);
          return `• ${r.description ?? '(no description)'} [${r.skillName}] — ${timeRemaining} [${r.shortRef ?? '—'}]`;
        })
        .join('\n');

      const subject = `Pending approvals — ${pending.length} request(s) awaiting your decision`;

      // --- Step 5: Send digest notification ---
      const sent = await ctx.outboundGateway.sendNotification({
        notificationType: 'pending_actions_digest',
        ceoEmail,
        subject,
        body,
      });

      if (!sent) {
        // Non-fatal — the pending rows are unchanged, digest can retry next cycle.
        ctx.log.warn(
          { pendingCount: pending.length },
          'pending-actions-digest: sendNotification returned false — CEO digest not delivered',
        );
      }

      return { success: true, data: { pending: pending.length, skipped: false } };
    } catch (e) {
      ctx.log.error({ err: e }, 'pending-actions-digest: unexpected error');
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
