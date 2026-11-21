// constants.ts — tunables for the onboarding program (#2360).

/** Greeting follow-ups sent after the first greeting goes unanswered. */
export const GREETING_FOLLOWUPS = 2;
/** Gap between greeting follow-ups, in hours. */
export const GREETING_FOLLOWUP_GAP_HOURS = 48;
/** Hours of chat silence before the idle nudge. */
export const CHAT_IDLE_NUDGE_HOURS = 4;
/** Minutes past a session's start before it counts as a no-show. */
export const NO_SHOW_GRACE_MINUTES = 30;
/** Minutes before a session when the principal gets a nudge. */
export const SESSION_NUDGE_LEAD_MINUTES = 15;
/** How often the onboarding watcher sweeps, in minutes. */
export const WATCHER_INTERVAL_MINUTES = 15;
/** Autonomy bands offered during onboarding. */
export const ONBOARDING_BANDS = [65, 75, 85] as const;

/**
 * When Start enables registry entries it restarts the process; its task wakes are set this far
 * ahead so they fire on the new process, not in the moments before the exit.
 */
export const RESTART_WAKE_DELAY_SECONDS = 60;

/** created_by of the parent onboarding task. A tag alone is spoofable by the model; this is not. */
export const ONBOARDING_CREATED_BY = 'onboarding';

/** The session id of the first conversation (the playbook's opening session). */
export const FIRST_CONVERSATION_SESSION = 'first-conversation';
