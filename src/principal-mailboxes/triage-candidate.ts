// triage-candidate.ts — the one keep rule for "mail triage would pick up" (#2475, BR-I3).
//
// The heartbeat's probe, the triage list and its backlog count all use it, so a message the list
// would never return (Curia's own mail, read mail, mail outside INBOX or before the start line)
// cannot make the probe wake a model run that finds nothing.

/** The fields of a listed message the rule reads (both Nylas clients' summaries carry them). */
export interface TriageCandidateFields {
  unread: boolean;
  folders: string[];
  from: Array<{ email: string }>;
  /** Unix seconds. */
  date: number;
}

/**
 * True when triage would take this message: unread, in INBOX, not from one of Curia's own
 * addresses (lowercased), and on or after the start line (Unix seconds) when there is one.
 * The start line is checked here too, so a provider that ignores received_after cannot let
 * older mail in.
 */
export function isTriageCandidate(
  m: TriageCandidateFields,
  curiaEmails: ReadonlySet<string>,
  startSec?: number,
): boolean {
  return m.unread
    && m.folders.some((f) => f.toUpperCase() === 'INBOX')
    && !m.from.some((p) => curiaEmails.has(p.email.toLowerCase()))
    && (startSec === undefined || m.date >= startSec);
}

/** Messages the heartbeat's probe reads per mailbox: enough to see past a few of Curia's own. */
export const PROBE_PAGE_SIZE = 10;

export interface UnreadProbeDeps {
  /** The mailbox's SDK client; only its first-page list is used. */
  client(mailboxId: string): Promise<{
    listMessages(o: { unread: true; folders: string[]; limit: number; receivedAfter?: number }): Promise<TriageCandidateFields[]>;
  }>;
  /** Curia's own addresses, lowercased. */
  curiaEmails(): Promise<ReadonlySet<string>>;
}

/**
 * The heartbeat's probe: true when the mailbox's first unread INBOX page holds a message triage
 * would take (isTriageCandidate). One request; the filters ride on it, so the cursor bug (#2377)
 * cannot touch it. A page of only Curia's own mail reads as no mail. May throw.
 */
export function unreadCandidateProbe(deps: UnreadProbeDeps): (mailboxId: string, since: Date | null) => Promise<boolean> {
  return async (mailboxId, since) => {
    const startSec = since ? Math.floor(since.getTime() / 1000) : undefined;
    const client = await deps.client(mailboxId);
    const messages = await client.listMessages({
      unread: true,
      folders: ['INBOX'],
      limit: PROBE_PAGE_SIZE,
      ...(startSec !== undefined ? { receivedAfter: startSec } : {}),
    });
    const curia = await deps.curiaEmails();
    return messages.some((m) => isTriageCandidate(m, curia, startSec));
  };
}
