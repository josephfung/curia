// handler.ts — ceo-backlog-sweep skill implementation.
//
// Operational backstop sweep (#1467). Finds CEO-owned tasks that are overdue or
// due today and still open, and sends the CEO ONE terse nudge when any exist.
// Fires only when count > 0 — silent otherwise.
//
// This is the system-owned safety net that guarantees an overdue CEO task never
// rots silently. It replaces the "lead with overdue/due-today CEO tasks" behaviour
// that used to live only in the declarative daily digest (removed in #1464). It is
// operational, not personalized: the body is a hardcoded template of counts plus
// how to get detail ("reply 'what's open'"), never an LLM-generated presentation.
// Modeled on skills/approval-expiry-sweep — same shape, same notification path.
//
// Non-fatal failure modes (mirror approval-expiry-sweep):
//   - no principal email on file → nudge skipped (notified stays 0)
//   - outboundGateway absent → nudge skipped
//   - sendNotification() returns false → logged at warn, not propagated

import { DateTime } from 'luxon';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { TaskListRow } from '../../src/db/task-repo.js';

// Non-terminal statuses: a task in any of these is still "open" and can rot.
// Terminal statuses (done, cancelled) are excluded — a completed/cancelled task
// with a past due date is not a backlog item.
const OPEN_STATUSES = ['open', 'in_progress', 'blocked', 'waiting'];

// Upper bound on how many candidate rows we pull for the count. A CEO with more
// than this many overdue/due-today tasks has bigger problems than an exact count;
// the nudge says "review for the full list" regardless, so an approximate ceiling
// is fine. Kept well above any realistic backlog.
const MAX_CANDIDATES = 100;

/**
 * Resolve the principal's email address from the contacts store.
 *
 * Identical strategy to approval-expiry-sweep: findContactBySystemRole('principal')
 * is the single source of truth for principal identity, restricted to a verified +
 * ACTIVE email. Returns null — a silent skip — when there is no contactService, no
 * principal, no verified+active email, or the lookup itself fails. Never throws:
 * a notification-path lookup failure must not fail the sweep and trigger retry churn.
 */
async function resolvePrincipalEmail(ctx: SkillContext): Promise<string | null> {
  if (!ctx.contactService) {
    ctx.log.warn('ceo-backlog-sweep: contactService capability unavailable — cannot resolve principal email');
    return null;
  }
  try {
    const principal = await ctx.contactService.findContactBySystemRole('principal');
    if (!principal) return null;
    const withIdentities = await ctx.contactService.getContactWithIdentities(principal.id);
    const identities = withIdentities?.identities ?? [];
    const email = identities.find((id) => id.channel === 'email' && id.verified && id.status === 'active');
    return email?.channelIdentifier ?? null;
  } catch (err) {
    ctx.log.warn({ err }, 'ceo-backlog-sweep: failed to resolve principal email — skipping nudge');
    return null;
  }
}

/**
 * Build the terse nudge subject + body from the two counts.
 *
 * Deliberately NOT a personalized presentation — hardcoded template of counts plus
 * how to get detail. Three shapes: overdue only, due-today only, or both.
 */
function buildNudge(overdue: number, dueToday: number): { subject: string; body: string } {
  const total = overdue + dueToday;
  const taskWord = total === 1 ? 'task' : 'tasks';
  const subject = `${total} CEO ${taskWord} overdue or due today`;

  let counts: string;
  if (overdue > 0 && dueToday > 0) {
    counts = `${overdue} overdue, ${dueToday} due today`;
  } else if (overdue > 0) {
    counts = `${overdue} overdue`;
  } else {
    counts = `${dueToday} due today`;
  }

  const body = `${total} CEO ${taskWord} need attention (${counts}). Reply "what's open" for the full list.`;
  return { subject, body };
}

export class CeoBacklogSweepHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    try {
      if (!ctx.taskRepo) {
        return { success: false, error: 'ceo-backlog-sweep requires taskRepo capability' };
      }

      // --- Step 1: Compute the "end of today" boundary in the CEO's timezone ---
      // listTasks filters `due_at < dueBefore`, so passing the start of tomorrow
      // (local midnight) captures everything due today and earlier. Day boundaries
      // are timezone-sensitive, so we anchor on ctx.timezone (falling back to UTC).
      const tz = ctx.timezone ?? 'UTC';
      const now = DateTime.now().setZone(tz);
      const startOfToday = now.startOf('day');
      const startOfTomorrow = startOfToday.plus({ days: 1 });

      // --- Step 2: Query open CEO tasks that are overdue or due today ---
      const rows: TaskListRow[] = await ctx.taskRepo.listTasks({
        statuses: OPEN_STATUSES,
        owner: 'ceo',
        dueBefore: startOfTomorrow.toJSDate(),
        limit: MAX_CANDIDATES,
      });

      // --- Step 3: Split into overdue (before today) vs due-today ---
      // The query already bounds due_at below start-of-tomorrow, so any row here is
      // either overdue (before today) or due today. Rows with a null due_at are
      // excluded by the `due_at < dueBefore` filter, so every row has a due date.
      const startOfTodayMs = startOfToday.toMillis();
      let overdue = 0;
      let dueToday = 0;
      for (const row of rows) {
        // dueAt is guaranteed non-null here (see above), but guard defensively.
        if (row.dueAt && new Date(row.dueAt).getTime() < startOfTodayMs) {
          overdue += 1;
        } else {
          dueToday += 1;
        }
      }

      const total = overdue + dueToday;

      // --- Step 4: Silent when nothing is overdue or due today ---
      if (total === 0) {
        return { success: true, data: { overdue: 0, dueToday: 0, notified: 0 } };
      }

      ctx.log.info({ overdue, dueToday }, 'ceo-backlog-sweep: open CEO tasks overdue or due today');

      // --- Step 5: Send the single terse nudge ---
      let notified = 0;

      if (ctx.outboundGateway === undefined) {
        ctx.log.warn(
          { overdue, dueToday },
          'ceo-backlog-sweep: outboundGateway not available — skipping CEO nudge',
        );
      } else {
        const ceoEmail = await resolvePrincipalEmail(ctx);
        if (!ceoEmail) {
          ctx.log.warn(
            { overdue, dueToday },
            'ceo-backlog-sweep: no principal email on file — skipping CEO nudge',
          );
        } else {
          const { subject, body } = buildNudge(overdue, dueToday);
          const sent = await ctx.outboundGateway.sendNotification({
            notificationType: 'ceo_backlog_nudge',
            ceoEmail,
            subject,
            body,
          });

          if (sent) {
            notified = total;
          } else {
            // Non-fatal — the CEO won't get this cycle's nudge, but the next sweep
            // will re-surface the same still-open tasks. Nothing is lost permanently.
            ctx.log.warn(
              { overdue, dueToday },
              'ceo-backlog-sweep: sendNotification returned false — CEO nudge not delivered',
            );
          }
        }
      }

      return { success: true, data: { overdue, dueToday, notified } };
    } catch (e) {
      ctx.log.error({ err: e }, 'ceo-backlog-sweep: unexpected error');
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
