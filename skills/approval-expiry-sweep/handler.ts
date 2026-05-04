// handler.ts — approval-expiry-sweep skill implementation.
//
// Background sweep skill: finds all pending_approval rows whose expires_at has
// passed, batch-transitions them to 'expired', and sends a single batched email
// notification to the CEO for any high/critical-risk expirations.
//
// This skill is designed to be called by the system scheduler on a regular
// interval (e.g. every 15 minutes). It is idempotent — calling it multiple
// times with no new expired rows returns early with { expired: 0, notified: 0 }.
//
// Non-fatal failure modes:
//   - CEO_PRIMARY_EMAIL not configured → expiry still happens, notification skipped
//   - outboundGateway absent → expiry still happens, notification skipped
//   - sendNotification() returns false → logged at warn, not propagated (expiry is done)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ActionLogRow } from '../../src/autonomy/action-log-types.js';

// Tiers that warrant a CEO notification on expiry.
// 'none' and 'low' expirations are recorded in the log but not surfaced as alerts —
// they represent low-stakes actions the CEO didn't need to weigh in on urgently.
const NOTIFIABLE_TIERS = new Set(['high', 'critical']);

export class ApprovalExpirySweepHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    try {
      if (!ctx.actionLogRepo) {
        return { success: false, error: 'approval-expiry-sweep requires actionLogRepo capability' };
      }

      // --- Step 1: Find all stale pending_approval rows ---
      const expired: ActionLogRow[] = await ctx.actionLogRepo.findExpired();

      // Early return when nothing to do — avoids unnecessary DB writes and noise.
      if (expired.length === 0) {
        return { success: true, data: { expired: 0, notified: 0 } };
      }

      // --- Step 2: Batch-transition all stale rows to 'expired' ---
      // expireRows() uses WHERE outcome = 'pending_approval' for idempotency —
      // any row concurrently resolved will simply be skipped (rowCount < ids.length).
      await ctx.actionLogRepo.expireRows(expired.map((r) => r.id));

      // Log each expired row individually for auditability and debugging.
      for (const r of expired) {
        ctx.log.info(
          { id: r.id, shortRef: r.shortRef, skillName: r.skillName, actionRisk: r.actionRisk },
          'approval-expiry-sweep: row expired',
        );
      }

      // --- Step 3: Filter to notifiable (high/critical) tiers ---
      const notifiable = expired.filter((r) => NOTIFIABLE_TIERS.has(r.actionRisk));

      // --- Step 4: Send batched notification if warranted ---
      // Track whether the notification was actually delivered so we can return
      // an accurate `notified` count. Defaults to 0 — only set when sendNotification()
      // returns true.
      let notifiedCount = 0;

      if (notifiable.length > 0 && ctx.outboundGateway !== undefined) {
        // Read directly from process.env rather than ctx.secret() — ctx.secret()
        // throws on a missing variable, which would surface as skill failure even
        // though expiry already committed. A missing email should be a silent skip.
        const ceoEmail = process.env['CEO_PRIMARY_EMAIL'] ?? '';

        if (!ceoEmail) {
          // Not configured — expiry is already done, just skip the notification.
          ctx.log.warn(
            { notifiableCount: notifiable.length },
            'approval-expiry-sweep: CEO_PRIMARY_EMAIL not configured — skipping expiry notification',
          );
        } else {
          const subject = `Approval expired — ${notifiable.length} request(s) expired without response`;

          // Bullet list: one line per expired request so the CEO can quickly scan.
          // shortRef and description are nullable — fall back to readable placeholders.
          const body = notifiable
            .map((r) => `• ${r.shortRef ?? '(no ref)'}: ${r.description ?? '(no description)'} [${r.skillName}]`)
            .join('\n');

          const sent = await ctx.outboundGateway.sendNotification({
            notificationType: 'approval_expired',
            ceoEmail,
            subject,
            body,
          });

          if (sent) {
            notifiedCount = notifiable.length;
          } else {
            // Non-fatal — the expiry rows are already transitioned. A failure here means
            // the CEO won't receive the alert for this sweep cycle, but the audit log
            // (via individual row logs above) still has the full record.
            ctx.log.warn(
              { notifiableCount: notifiable.length },
              'approval-expiry-sweep: sendNotification returned false — CEO notification not delivered (expiry committed)',
            );
          }
        }
      }

      return { success: true, data: { expired: expired.length, notified: notifiedCount } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}
