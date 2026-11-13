// Per-mailbox sent-observe and learning-state key names (#2475, D8, R60).
// Shared by the skills' state accessors (skills/_shared/mailbox-state.ts) and the boot migration.

export const STATE_NAMESPACE = 'ceo_inbox';

/** Names of the per-mailbox keys (the global key was `sent_observe.<name>`). */
export const PER_MAILBOX_STATE_NAMES = [
  'last_seen_at',
  'last_run_found_nothing_at',
  'backfill_before',
  'backfill_target',
  'held_since',
  'matched_draft_ids',
  'completion_candidates',
  'asked_task_ids',
] as const;
export type MailboxStateName = (typeof PER_MAILBOX_STATE_NAMES)[number];

export const GLOBAL_STATE_PREFIX = 'sent_observe.';

/** The pre-#2475 global key for a per-mailbox name. */
export function globalStateKey(name: MailboxStateName): string {
  return `${GLOBAL_STATE_PREFIX}${name}`;
}

/** The per-mailbox key. Mailbox ids match `^[a-z][a-z0-9-]*$`, so they never contain a dot. */
export function mailboxStateKey(mailboxId: string, name: MailboxStateName): string {
  return `${GLOBAL_STATE_PREFIX}${mailboxId}.${name}`;
}


/** Id of the in-memory mailbox served while the flat-grant migration is deferred (R61). */
export const FALLBACK_MAILBOX_ID = 'mailbox';

/** Consecutive sent-observe runs that failed for a mailbox (#2475, R67); reset by a clean run. */
export function sentObserveFailedRunsKey(mailboxId: string): string {
  return `${GLOBAL_STATE_PREFIX}${mailboxId}.failed_runs`;
}

/** Consecutive failed runs at which a mailbox fails the sent-observe job and the health check. */
export const SENT_OBSERVE_FAILED_RUNS_LIMIT = 3;
