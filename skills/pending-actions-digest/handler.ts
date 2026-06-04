// handler.ts — pending-actions-digest skill implementation.
//
// Daily CEO digest. Sends a single email summarizing: (1) outstanding approval
// requests awaiting a decision, and (2) the task backlog grouped by owner —
// "For you to do" (ceo), "Waiting on others" (external), and "What I'm working
// on" (curia). Body formatting lives in render.ts (pure, snapshot-tested).
//
// Send gate: the email goes out when there is at least one approval, or any
// ceo/external backlog item. "What I'm working on" alone never triggers a send.
//
// Non-fatal / graceful modes:
//   - CEO_PRIMARY_EMAIL not configured → skipped: true
//   - outboundGateway absent → skipped: true
//   - taskRepo absent OR listTasks throws → backlog treated as empty (warn),
//     approvals still send
//   - sendNotification() returns false → logged at warn, not propagated
//   - Nothing to show (no approvals, no ceo/external tasks) → skipped: true

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ActionLogRow } from '../../src/autonomy/action-log-types.js';
import type { TaskListRow } from '../../src/db/task-repo.js';
import { renderDigestBody, type ApprovalInput } from './render.js';

// Per-section fetch cap. Sections render the top 5; the extra rows feed an exact
// "+N more" footer (so N is capped at 45). Hitting the cap logs a warn so a
// runaway backlog cannot be silently truncated.
const SECTION_FETCH_LIMIT = 50;

interface Backlog {
  ceo: TaskListRow[];
  external: TaskListRow[];
  curia: TaskListRow[];
}

/**
 * Fetch the three backlog sections. Resilient by design: an absent taskRepo or a
 * failing query degrades to empty sections (with a warn) so the approvals digest
 * still goes out rather than failing wholesale.
 */
async function fetchBacklog(ctx: SkillContext): Promise<Backlog> {
  if (!ctx.taskRepo) return { ceo: [], external: [], curia: [] };
  try {
    const [ceo, external, curia] = await Promise.all([
      ctx.taskRepo.listTasks({ owner: 'ceo', statuses: ['open', 'in_progress'], limit: SECTION_FETCH_LIMIT }),
      ctx.taskRepo.listTasks({ owner: 'external', statuses: ['waiting'], limit: SECTION_FETCH_LIMIT }),
      ctx.taskRepo.listTasks({ owner: 'curia', statuses: ['open', 'in_progress'], limit: SECTION_FETCH_LIMIT }),
    ]);
    // Warn if any section hit the fetch cap so truncation is visible in logs.
    if (ceo.length >= SECTION_FETCH_LIMIT) {
      ctx.log.warn({ section: 'ceo', count: ceo.length }, 'pending-actions-digest: section hit fetch cap; +N more is a floor');
    }
    if (external.length >= SECTION_FETCH_LIMIT) {
      ctx.log.warn({ section: 'external', count: external.length }, 'pending-actions-digest: section hit fetch cap; +N more is a floor');
    }
    if (curia.length >= SECTION_FETCH_LIMIT) {
      ctx.log.warn({ section: 'curia', count: curia.length }, 'pending-actions-digest: section hit fetch cap; +N more is a floor');
    }
    return { ceo, external, curia };
  } catch (err) {
    // Non-fatal: log and fall back to empty backlog so approvals still send.
    ctx.log.warn({ err }, 'pending-actions-digest: backlog fetch failed; sending approvals-only digest');
    return { ceo: [], external: [], curia: [] };
  }
}

/** Resolve external tasks' waiting_on_contact_id values to display names. */
async function resolveContactNames(
  ctx: SkillContext,
  external: TaskListRow[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!ctx.contactService) return names;
  const ids = [...new Set(external.map((t) => t.waitingOnContactId).filter((x): x is string => x !== null))];
  for (const id of ids) {
    const contact = await ctx.contactService.getContact(id);
    if (contact) names.set(id, contact.displayName);
  }
  return names;
}

export class PendingActionsDigestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    try {
      if (!ctx.actionLogRepo) {
        return { success: false, error: 'pending-actions-digest requires actionLogRepo capability' };
      }

      // --- Step 1: Load approvals and backlog ---
      const pending: ActionLogRow[] = await ctx.actionLogRepo.findAllPending();
      const backlog = await fetchBacklog(ctx);

      const counts = {
        tasksForCeo: backlog.ceo.length,
        tasksWaiting: backlog.external.length,
        tasksWorking: backlog.curia.length,
      };

      // --- Step 2: Send gate ---
      // Send when there are approvals OR the CEO owes/awaits something. "What I'm
      // working on" (curia) alone is informational and never triggers a send.
      const shouldSend = pending.length > 0 || backlog.ceo.length > 0 || backlog.external.length > 0;
      if (!shouldSend) {
        return { success: true, data: { pending: pending.length, skipped: true, ...counts } };
      }

      // --- Step 3: Delivery preconditions ---
      // Read CEO email from env (not ctx.secret(), which throws on a missing var).
      const ceoEmail = process.env['CEO_PRIMARY_EMAIL'] ?? '';
      if (!ceoEmail) {
        ctx.log.warn({ pendingCount: pending.length }, 'pending-actions-digest: CEO_PRIMARY_EMAIL not configured, skipping digest');
        return { success: true, data: { pending: pending.length, skipped: true, ...counts } };
      }
      if (ctx.outboundGateway === undefined) {
        ctx.log.warn({ pendingCount: pending.length }, 'pending-actions-digest: outboundGateway not available, skipping digest');
        return { success: true, data: { pending: pending.length, skipped: true, ...counts } };
      }

      // --- Step 4: Build the body ---
      const nameMap = await resolveContactNames(ctx, backlog.external);
      const nowMs = Date.now();
      const approvals: ApprovalInput[] = pending.map((r) => ({
        description: r.description,
        skillName: r.skillName,
        shortRef: r.shortRef,
        expiresAt: r.expiresAt,
      }));

      const body = renderDigestBody({
        approvals,
        ceo: backlog.ceo,
        external: backlog.external,
        curia: backlog.curia,
        resolveName: (id) => nameMap.get(id),
        nowMs,
        timezone: ctx.timezone ?? 'UTC',
      });

      // --- Step 5: Adaptive subject ---
      // Approvals present → urgency-forward approvals subject (unchanged).
      // Backlog-only → daily brief framing; N counts the items that need the CEO.
      const needsCeo = backlog.ceo.length + backlog.external.length;
      const subject = pending.length > 0
        ? `Pending approvals — ${pending.length} request(s) awaiting your decision`
        : `Your daily brief — ${needsCeo} item(s) need you`;

      // --- Step 6: Send ---
      const sent = await ctx.outboundGateway.sendNotification({
        notificationType: 'pending_actions_digest',
        ceoEmail,
        subject,
        body,
      });

      if (!sent) {
        ctx.log.warn({ pendingCount: pending.length }, 'pending-actions-digest: sendNotification returned false — CEO digest not delivered');
      }

      return { success: true, data: { pending: pending.length, skipped: false, ...counts } };
    } catch (e) {
      ctx.log.error({ err: e }, 'pending-actions-digest: unexpected error');
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
