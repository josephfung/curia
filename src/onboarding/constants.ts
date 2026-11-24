// constants.ts — tunables for the onboarding program (#2360).

/** Greeting follow-ups sent after the first greeting goes unanswered. */
export const GREETING_FOLLOWUPS = 2;
/** Gap between greeting follow-ups, in hours. */
export const GREETING_FOLLOWUP_GAP_HOURS = 48;
/** Hours of chat silence before the idle nudge. */
export const CHAT_IDLE_NUDGE_HOURS = 4;
// General meetings infrastructure: any calendar-tied agenda uses these, so they live with meetings.
export { NO_SHOW_GRACE_MINUTES, SESSION_NUDGE_LEAD_MINUTES } from '../meetings/constants.js';
/** How often the onboarding watcher sweeps, in minutes. */
export const WATCHER_INTERVAL_MINUTES = 15;
/** Autonomy bands offered during onboarding. */
export const ONBOARDING_BANDS = [65, 75, 85] as const;

/**
 * When Start enables registry entries it restarts the process; its task wakes are set this far
 * ahead so they fire on the new process, not in the moments before the exit.
 */
export const RESTART_WAKE_DELAY_SECONDS = 60;

/**
 * A principal start that restarts Curia exits this long after the tool returns, so the turn that
 * called it can tell the principal it will be back. Shorter than RESTART_WAKE_DELAY_SECONDS, so
 * the resume wake still fires on the new process.
 */
export const PRINCIPAL_RESTART_EXIT_DELAY_SECONDS = 15;

/** created_by of the parent onboarding task. A tag alone is spoofable by the model; this is not. */
export const ONBOARDING_CREATED_BY = 'onboarding';
/** Tag of the onboarding task and its subtasks. */
export const ONBOARDING_TASK_TAG = 'onboarding';
/** Tag of the standalone deep-dive review task, made when no onboarding is open (#2362). */
export const DEEP_DIVE_TASK_TAG = 'deep-dive';
/** The playbook session whose topics review the deep-dive drafts. */
export const REVIEW_SESSION = 'review';
/** The Review topics that each review one deep-dive draft; a standalone review task completes on these. */
export const REVIEW_DOCUMENT_TOPICS = ['review-rules', 'review-priorities', 'review-voice'] as const;

/**
 * A note added while the task's wake runs with a booked time already parked waits for that run to
 * finish, then pulls the booked wake forward (runTaskWakeEarly): retried this often, this many times.
 */
export const BUSY_WAKE_RETRY_SECONDS = 60;
export const BUSY_WAKE_RETRIES = 10;

/** The session id of the first conversation (the playbook's opening session). */
export const FIRST_CONVERSATION_SESSION = 'first-conversation';
