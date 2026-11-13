// triage-services.ts — what ceo-inbox-list's triage mode gets as ctx.triageServices (#2475, D4).
// Cadences, per-mailbox triage state, the cross-mailbox dedupe store and the start-line setter.
// No credentials, clients or grant ids.
import type { Cadence } from './triage-cadence.js';
import type { TriageState } from './triage-state.js';
import type { TriageDedupe } from './triage-dedupe.js';

export interface TriageServices {
  /** Cadences for the given live mailbox ids, read fresh (a console edit applies at once). */
  cadences(mailboxIds: string[]): Promise<Record<string, Cadence>>;
  state: TriageState;
  /** Only the claim, bound: skills never hold the store or its pool. */
  dedupe: Pick<TriageDedupe, 'claim'>;
  /** The principal's timezone: the one source the heartbeat and TriageState also use. */
  tz(): string;
  /** Move a live mailbox's start line (principal-directed sweep). Unknown or removed ids throw. */
  setTriageStart(id: string, at: Date): Promise<void>;
}
