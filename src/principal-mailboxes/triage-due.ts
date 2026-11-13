// triage-due.ts — the one definition of "which mailboxes are due for triage" (#2475, R7).
// The heartbeat and ceo-inbox-list's triage mode both call this, so they cannot disagree.
import { DEFAULT_CADENCE, inWindow, isDue, parseCadence, type Cadence } from './triage-cadence.js';
import type { TriageState } from './triage-state.js';

export interface DueMailboxesInput {
  /** Live mailbox ids, in the order the result should follow. */
  mailboxIds: string[];
  /** From readTriageCadences; an id missing here uses the default cadence. */
  cadences: Record<string, Cadence>;
  state: Pick<TriageState, 'isDraining' | 'lastDrainedAt'>;
  now: Date;
  tz: string;
}

/**
 * A mailbox is due when its cadence says so, or a drain of it is still in progress (has_more) and
 * `now` is inside its window. A draining mailbox bypasses the cadence interval but not the window
 * or weekdays (R53): a drain pauses at window end and resumes when the window reopens.
 */
export async function dueMailboxes(input: DueMailboxesInput): Promise<string[]> {
  const fallback = parseCadence(DEFAULT_CADENCE)!;
  const due: string[] = [];
  for (const id of input.mailboxIds) {
    const cadence = input.cadences[id] ?? fallback;
    if (await input.state.isDraining(id)) {
      if (inWindow(cadence, input.now, input.tz)) due.push(id);
      continue;
    }
    if (isDue(cadence, await input.state.lastDrainedAt(id), input.now, input.tz)) due.push(id);
  }
  return due;
}
