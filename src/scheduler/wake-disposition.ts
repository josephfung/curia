// wake-disposition.ts — a successful task wake must leave the task in an end state (#1951).
//
// The scheduler closes the job on success. Only the agent can close the task. When a
// wake run succeeds and the task is still open, BacklogHeartbeat treats that idle row
// as new work and wakes it again. These helpers decide whether the run already
// disposed the task, and they word the one follow-up turn and the review notice.

/** Tag that excludes a task from selectHeartbeatCandidates. */
export const NEEDS_DISPOSITION_TAG = 'needs-disposition';

/** The only tools a disposition follow-up may call. Side-effect tools stay off. */
export const DISPOSITION_TURN_TOOLS = ['task-complete', 'task-update'] as const;

/**
 * Framed into every ordinary task-wake `agent.task` body. Delegation-retry wakes
 * use their own content and are closed at fire time instead.
 */
export const WAKE_DISPOSITION_INSTRUCTION =
  'You were woken to advance this task. Before you finish, leave it in a deliberate end state: ' +
  'call task-complete with a note if the goal is achieved, ' +
  'call task-update with status cancelled if it should stop, ' +
  'or park it with task-update status waiting or blocked, a progress note, and wake_at ' +
  '(wake_at is optional only when the task waits on a contact or a blocking task). ' +
  'scheduler-report records this job run and does not close the task. ' +
  'Ending while the task is still open with no new note and no wake, or parked with nothing to wake it, is a bug.';

const ACTIVE_STATUSES = new Set(['open', 'in_progress']);
const PARKED_STATUSES = new Set(['waiting', 'blocked']);

/** A parked status: waiting or blocked. Undisposed only when nothing will wake it. */
export function isParkedStatus(status: string): boolean {
  return PARKED_STATUSES.has(status);
}

/** Stable snapshot of progress.notes. Other progress blocks (active skills, plans) do not count. */
export function progressNotesSnapshot(progress: unknown): string {
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) return '[]';
  const notes = (progress as Record<string, unknown>)['notes'];
  return Array.isArray(notes) ? JSON.stringify(notes) : '[]';
}

export interface WakeDispositionView {
  status: string;
  progress: unknown;
  /** progress.notes as of the run that just finished (or of fire, for the first check). */
  notesAtStart: string;
  /** The running wake stored a future time on deferred_wake_at during this run. */
  deferredWake: boolean;
  /** Some other task-wake row for this task is pending or running. */
  otherActiveWake: boolean;
  /** The task waits on a contact (waiting_on_contact_id) or a blocking task (blocked_by_task_id). */
  waitsOnDependency: boolean;
}

/**
 * Done and cancelled are always dispositions. Open or in progress is undisposed
 * unless the run added a progress note or scheduled a wake. Parked (waiting /
 * blocked) is undisposed only when nothing will wake it: no wake and no contact
 * or task it waits on. A note does not count there — a parked loop with a fresh
 * note and no wake_at is exactly how a re-arming loop stops (#2084).
 */
export function isUndisposedWake(view: WakeDispositionView): boolean {
  if (view.deferredWake || view.otherActiveWake) return false;
  if (isParkedStatus(view.status)) return !view.waitsOnDependency;
  if (!ACTIVE_STATUSES.has(view.status)) return false;
  return progressNotesSnapshot(view.progress) === view.notesAtStart;
}

function taskLabel(taskId: string, title: string | null): string {
  if (!title) return taskId;
  const flat = title.replace(/[\r\n]/g, ' ').trim().slice(0, 200);
  return flat.length > 0 ? `"${flat}" (${taskId})` : taskId;
}

/** User-message for the single disposition follow-up. Same conversation as the wake. */
export function dispositionTurnPrompt(taskId: string, title: string | null, status: string): string {
  if (isParkedStatus(status)) {
    return [
      `Task ${taskLabel(taskId, title)} is parked as ${status}, but nothing will wake it: it has no wake_at and does not wait on a contact or another task.`,
      'Call task-update with wake_at for when it should next run or be checked. If the work is finished, task-complete it, or set status cancelled if it should stop.',
      'Do not repeat the task\'s actions.',
    ].join(' ');
  }
  return [
    `Task ${taskLabel(taskId, title)} is still open after this run.`,
    'Based on what you just did, choose one: task-complete (with a note), task-update status to cancelled, or park it with status waiting or blocked, a progress note, and wake_at.',
    'Do not repeat the task\'s actions.',
  ].join(' ');
}

/**
 * Review-only notice for the coordinator. Names the task. Does not repeat the
 * wake payload — that text is what the coordinator previously re-executed.
 */
export function dispositionReviewNotice(taskId: string, title: string | null): string {
  const titleLine = title
    ? title.replace(/[\r\n]/g, ' ').trim().slice(0, 200)
    : taskId;
  return [
    'A woken task finished without a disposition and needs review.',
    `Task: ${taskId}`,
    `Title: ${titleLine}`,
    '',
    'This is a review notice only. Do not re-run the task, re-send its messages, or mark it done.',
    'Tell the principal it is waiting for them to close, cancel, or reschedule it.',
  ].join('\n');
}
