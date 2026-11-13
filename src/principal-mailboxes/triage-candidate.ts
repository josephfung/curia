// triage-candidate.ts — the one keep rule for "mail triage would pick up" (#2475, BR-I3).
//
// The heartbeat's probe, the triage list and its backlog count all use it, so a message the list
// would never return (Curia's own mail, read mail, mail outside INBOX or before the start line)
// cannot make the probe wake a model run that finds nothing.
import type { Logger } from '../logger.js';

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

/** Messages per probe page. */
export const PROBE_PAGE_SIZE = 10;
/** Pages the probe reads before it gives up looking and counts the mailbox as having mail (R71). */
export const PROBE_MAX_PAGES = 5;

export interface UnreadProbeDeps {
  /** The mailbox's SDK client; only its unread-INBOX page listing is used. */
  client(mailboxId: string): Promise<{
    listUnreadInboxPage(o: { limit: number; receivedAfter?: number; pageToken?: string }): Promise<{ messages: TriageCandidateFields[]; nextCursor?: string }>;
  }>;
  /** Curia's own addresses, lowercased. */
  curiaEmails(): Promise<ReadonlySet<string>>;
  logger: Pick<Logger, 'warn'>;
}

/**
 * The heartbeat's probe: true when the mailbox's unread INBOX holds a message triage would take
 * (isTriageCandidate). A page of only filtered mail (Curia's own, by the From header) reads on to
 * the next, so it cannot hide real mail behind it. The From header can be spoofed, so a mailbox
 * whose first PROBE_MAX_PAGES pages hold nothing but filtered mail FAILS OPEN: it counts as having
 * mail, and an occasional empty drain run is the price (R71). When filtered mail outnumbers real
 * mail in what was read, a warning is logged at most once a day per mailbox. May throw.
 */
export function unreadCandidateProbe(deps: UnreadProbeDeps): (mailboxId: string, since: Date | null) => Promise<boolean> {
  const warnedOn = new Map<string, string>();
  const warnOncePerDay = (mailboxId: string, fields: Record<string, unknown>, msg: string): void => {
    const day = new Date().toISOString().slice(0, 10);
    if (warnedOn.get(mailboxId) === day) return;
    warnedOn.set(mailboxId, day);
    deps.logger.warn({ mailboxId, ...fields }, msg);
  };
  return async (mailboxId, since) => {
    const startSec = since ? Math.floor(since.getTime() / 1000) : undefined;
    const client = await deps.client(mailboxId);
    const curia = await deps.curiaEmails();
    let filtered = 0;
    let pageToken: string | undefined;
    for (let page = 0; page < PROBE_MAX_PAGES; page++) {
      const { messages, nextCursor } = await client.listUnreadInboxPage({
        limit: PROBE_PAGE_SIZE,
        ...(startSec !== undefined ? { receivedAfter: startSec } : {}),
        ...(pageToken ? { pageToken } : {}),
      });
      const kept = messages.filter((m) => isTriageCandidate(m, curia, startSec)).length;
      filtered += messages.length - kept;
      if (kept > 0) {
        if (filtered > kept && filtered >= PROBE_PAGE_SIZE) {
          warnOncePerDay(mailboxId, { filtered, kept }, 'InboxHeartbeat: unread mail filtered as Curia\'s own outnumbers real mail in this mailbox; its From headers may be spoofed');
        }
        return true;
      }
      if (!nextCursor || messages.length === 0) return false;
      pageToken = nextCursor;
    }
    warnOncePerDay(mailboxId, { filtered, pages: PROBE_MAX_PAGES }, 'InboxHeartbeat: the probe read only filtered unread mail up to its page bound; treating the mailbox as having mail');
    return true;
  };
}
