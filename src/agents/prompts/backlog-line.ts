// The backlog line on principal turns (prompt trim PR 7).
//
// The coordinator prompt used to ask the model to keep an eye on decay warnings, pending
// approvals and tasks waiting on the principal, and raise the oldest at a natural pause.
// Nothing told it whether anything was waiting, so it had to go and look. The dispatcher
// now counts them on each principal turn (src/dispatch/principal-backlog.ts) and the runtime
// renders this line with the turn guidance, only when something is waiting.
//
// The counts sentence varies by turn. The instruction lines are fixed, so they are a
// prompt-exfiltration marker source (trigger-guidance-sources.ts).

/** What is waiting on the principal. Each count is a non-negative integer. */
export interface PrincipalBacklogCounts {
  /** Stored knowledge flagged for re-confirmation before it is archived (decay-warnings-list). */
  decayWarnings: number;
  /** Actions held for the principal's approval, not yet expired (list-pending-actions). */
  pendingApprovals: number;
  /** Open tasks the principal owns: owner `ceo`, not done or cancelled (task-list). */
  principalTasks: number;
}

/**
 * Task statuses that still need the owner to act: every status but `done` and `cancelled`.
 * The count uses them, and the line passes them to task-list, which has no default filter.
 */
export const OPEN_TASK_STATUSES: readonly string[] = ['open', 'in_progress', 'blocked', 'waiting'];

/** Follows the counts. Fixed text, hard-wrapped for marker extraction. */
export const BACKLOG_INSTRUCTION_LINES: readonly string[] = [
  'Once this message is handled, at a natural pause, raise the oldest of these in one clause,',
  'unless you already raised it earlier in this conversation.',
];

/**
 * Follows the counts when the principal owns an open task. A specialist that needs the
 * principal's answer on a turn nobody receives (a task wake, a scheduled job) hands the
 * question over on a task they own (#2129); this is how the answer gets back to it.
 * Fixed text, hard-wrapped for marker extraction.
 */
export const PRINCIPAL_TASK_ANSWER_LINES: readonly string[] = [
  'A task of theirs a specialist filed (source_agent_id) holds its question in the last note.',
  'Delegate their answer to that specialist with the task id; it acts and closes the task.',
];

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** True when any count is positive. */
export function hasBacklog(counts: PrincipalBacklogCounts): boolean {
  return counts.decayWarnings > 0 || counts.pendingApprovals > 0 || counts.principalTasks > 0;
}

/**
 * Narrow an untrusted value (a bus payload field) to counts. Anything that is not three
 * non-negative integers is dropped whole: a partial line would misstate the backlog.
 */
export function parsePrincipalBacklog(raw: unknown): PrincipalBacklogCounts | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  const decayWarnings = count(r['decayWarnings']);
  const pendingApprovals = count(r['pendingApprovals']);
  const principalTasks = count(r['principalTasks']);
  if (decayWarnings === null || pendingApprovals === null || principalTasks === null) return null;
  return { decayWarnings, pendingApprovals, principalTasks };
}

/** The line, or null when nothing is waiting. Each kind names the tool that lists it. */
export function renderBacklogLine(counts: PrincipalBacklogCounts): string | null {
  const parts: string[] = [];
  if (counts.pendingApprovals > 0) {
    parts.push(`${plural(counts.pendingApprovals, 'action awaiting', 'actions awaiting')} their approval (list-pending-actions)`);
  }
  if (counts.decayWarnings > 0) {
    parts.push(`${plural(counts.decayWarnings, 'stored fact', 'stored facts')} to re-confirm before archiving (decay-warnings-list)`);
  }
  if (counts.principalTasks > 0) {
    parts.push(
      `${plural(counts.principalTasks, 'open task', 'open tasks')} they own (task-list: owner ceo, status ${OPEN_TASK_STATUSES.join(',')})`,
    );
  }
  if (parts.length === 0) return null;
  return [
    `Waiting on the principal: ${parts.join('; ')}.`,
    ...(counts.principalTasks > 0 ? PRINCIPAL_TASK_ANSWER_LINES : []),
    ...BACKLOG_INSTRUCTION_LINES,
  ].join('\n');
}
