// constants.ts — tunables for agendas tied to calendar events (#2360).

/** Minutes past a session's end before it counts as a no-show. */
export const NO_SHOW_GRACE_MINUTES = 30;
/** Minutes before a session when the principal gets a nudge. */
export const SESSION_NUDGE_LEAD_MINUTES = 15;
/** How often the agenda event sync sweeps, in minutes. */
export const AGENDA_EVENT_SYNC_INTERVAL_MINUTES = 15;
