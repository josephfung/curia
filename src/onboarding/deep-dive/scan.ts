// scan.ts — the deep dive's one read of the principal's mail and calendar (#2362).
//
// Reads WINDOW_DAYS of history from the given mailboxes, slowly and within a shared budget
// (MAX_MESSAGES, MAX_REQUESTS), and returns the raw material for `summarise`. Order matters
// because the budget is shared: calendars first (about 14 requests a mailbox), then every Sent
// folder, then the voice-sample bodies, then all received mail (the bulk: every folder but Sent,
// Drafts, Spam and Trash, so archived mail counts). So a busy mailbox can use up the budget
// without starving the parts the two-way and voice heuristics need.
//
// Hitting a cap ends that step early with `coverage.truncated = true`. So does a transient Nylas
// failure that outlasts the retries: a 429, a 5xx, or status 0 (the fetch itself failed: DNS, a
// reset, a timeout). The listing keeps the pages it read before the failure; `coverage.errors`
// counts the steps a 5xx or failed fetch ended. Later steps still run, what was read is kept, and
// the summary says how much it covers. A scan that read nothing at all and had a step end on an
// error throws (an outage, not an empty mailbox). Any other error (auth, a bad grant) propagates:
// the run fails rather than summarising nothing.
import type { Logger } from '../../logger.js';
import type { PrincipalMailboxes } from '../../principal-mailboxes/service.js';
import {
  transientEndKind,
  type CeoNylasClient,
  type ListingEndKind,
  type NylasMessageFull,
  type NylasMessageSummary,
} from '../../channels/email/ceo-nylas-client.js';
import {
  LIST_EVENTS_MAX_TOTAL,
  NYLAS_MAX_PAGE_SIZE,
  type NylasCalendarEvent,
} from '../../channels/calendar/nylas-calendar-client.js';
import { nylasStatus } from '../../channels/email/nylas-message-id.js';
import type { HistorySummary } from './history-summary.js';
import {
  CALENDAR_WINDOW_DAYS,
  MAX_MESSAGES,
  MAX_REQUESTS,
  PAGE_DELAY_MS,
  VOICE_SAMPLE_SIZE,
  WINDOW_DAYS,
} from './limits.js';
import { compareStrings, normaliseAddress } from './summary-util.js';
import { pickVoiceCandidates } from './voice-sample.js';

/** Nylas folder ids, as the Sent-folder sweep and triage listing name them. */
const SENT_FOLDER = 'SENT';
/** Not received mail: a message in any of these is left out of the received listing. */
const NOT_RECEIVED_FOLDERS: ReadonlySet<string> = new Set([SENT_FOLDER, 'DRAFT', 'SPAM', 'TRASH']);
const DAY_MS = 86_400_000;

export interface ScanDeps {
  mailboxes: Pick<PrincipalMailboxes, 'list' | 'ceoClient' | 'calendarClient'>;
  logger: Logger;
  now: Date;
  /** Pause between calendar listings and body fetches. Defaults to a real timer; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ScanResult {
  messages: NylasMessageSummary[];
  sentBodies: NylasMessageFull[];
  events: NylasCalendarEvent[];
  principalAddresses: string[];
  coverage: HistorySummary['coverage'];
}

/** A calendar error worth one paced retry: a 429, or status 0. */
function isRateLimitEnd(err: unknown): boolean {
  const status = nylasStatus(err);
  return status === 429 || status === 0;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function scanHistory(deps: ScanDeps, mailboxIds: string[]): Promise<ScanResult> {
  const { logger, now } = deps;
  const sleep = deps.sleep ?? realSleep;
  const from = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const receivedAfter = Math.floor(from.getTime() / 1000);
  const receivedBefore = Math.floor(now.getTime() / 1000);

  const coverage: HistorySummary['coverage'] = { messagesRead: 0, eventsRead: 0, requests: 0, rateLimited: 0, errors: 0, truncated: false };
  /** Steps ended by a transient error of any kind (429 included); a total outage throws on it. */
  let stepsEndedOnError = 0;
  const messages: NylasMessageSummary[] = [];
  const sentBodies: NylasMessageFull[] = [];
  const events = new Map<string, NylasCalendarEvent>();
  const mailboxOf = new Map<string, string>();
  const started = Date.now();

  const views = await deps.mailboxes.list();
  const wanted = new Set(mailboxIds);
  const selected = views.filter((v) => wanted.has(v.id));
  const missing = mailboxIds.filter((id) => !views.some((v) => v.id === id));
  if (missing.length > 0) {
    logger.warn({ missing }, 'deep-dive scan: mailboxes no longer connected; scanning the rest');
  }
  const principal = new Set(selected.map((v) => normaliseAddress(v.address)).filter((a) => a !== ''));

  const clients = new Map<string, CeoNylasClient>();
  const ceo = async (id: string): Promise<CeoNylasClient> => {
    let c = clients.get(id);
    if (!c) {
      c = await deps.mailboxes.ceoClient(id, logger);
      clients.set(id, c);
    }
    return c;
  };

  // A cap skips the rest of that step (and any later step that needs requests) and marks the
  // scan truncated; it does not throw, so the steps after it still get their reserved share.
  const capped = (reason: string, fields: Record<string, unknown> = {}): void => {
    logger.warn({ reason, requests: coverage.requests, ...fields }, 'deep-dive scan: cap reached; summarising what was read');
    coverage.truncated = true;
  };
  const haveBudget = (limit: number, what: string): boolean => {
    if (coverage.requests < limit) return true;
    capped(`request cap before ${what}`);
    return false;
  };

  // A transient end (429, 5xx, failed fetch) is scoped to the step it happened in: that step
  // stops, the scan is marked truncated, and the remaining steps still run.
  const endedOnError = (kind: ListingEndKind, what: string, fields: Record<string, unknown>, err?: unknown): void => {
    coverage.truncated = true;
    stepsEndedOnError++;
    if (kind !== 'rate_limited') coverage.errors++;
    logger.warn(
      { ...(err !== undefined ? { err } : {}), kind, what, ...fields, requests: coverage.requests, rateLimited: coverage.rateLimited },
      'deep-dive scan: Nylas failed past its retries; ending this step early and moving on',
    );
  };
  // Any other error propagates (the run fails).
  async function step(what: string, fields: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      const kind = transientEndKind(nylasStatus(err));
      if (kind === null) throw err;
      endedOnError(kind, what, fields, err);
    }
  }

  // The calendar client (Nylas SDK) does not retry a 429, so give each calendar call one retry
  // after a pause that doubles with every 429 this scan has seen on the calendar side.
  let calendarDelayMs = PAGE_DELAY_MS;
  async function calendarCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!isRateLimitEnd(err)) throw err;
      coverage.rateLimited++;
      calendarDelayMs *= 2;
      await sleep(calendarDelayMs);
      coverage.requests++;
      return run();
    }
  }

  async function readCalendar(id: string): Promise<void> {
    if (!haveBudget(MAX_REQUESTS, 'listCalendars')) return;
    const client = await deps.mailboxes.calendarClient(id);
    coverage.requests++;
    const primary = (await calendarCall(() => client.listCalendars())).find((c) => c.isPrimary);
    if (!primary) {
      // Nothing read from this calendar: the coverage must not read as complete.
      logger.warn({ mailboxId: id }, 'deep-dive scan: no primary calendar; skipping this calendar');
      coverage.truncated = true;
      return;
    }
    for (let start = from.getTime(), first = true; start < now.getTime(); start += CALENDAR_WINDOW_DAYS * DAY_MS, first = false) {
      if (!haveBudget(MAX_REQUESTS, 'listEvents')) return;
      if (!first) await sleep(PAGE_DELAY_MS);
      const end = Math.min(start + CALENDAR_WINDOW_DAYS * DAY_MS, now.getTime());
      let incomplete = false;
      const batch = await calendarCall(() =>
        client.listEvents(primary.id, new Date(start).toISOString(), new Date(end).toISOString(), {
          limit: LIST_EVENTS_MAX_TOTAL,
          expandRecurring: true,
          onIncomplete: () => {
            incomplete = true;
          },
        }),
      );
      // listEvents pages internally at 200 events; count each page it must have taken.
      coverage.requests += Math.max(1, Math.ceil(batch.length / NYLAS_MAX_PAGE_SIZE));
      for (const e of batch) if (!events.has(e.id)) events.set(e.id, e);
      if (incomplete || batch.length >= LIST_EVENTS_MAX_TOTAL) {
        capped('calendar window listing incomplete', { mailboxId: id, windowStart: new Date(start).toISOString() });
      }
    }
  }

  /** List one mailbox's mail: the Sent folder (`folder` set), or all received mail (`folder` null). */
  async function readFolder(id: string, folder: string | null, requestLimit: number): Promise<void> {
    const what = folder ?? 'received';
    const maxScan = MAX_MESSAGES - messages.length;
    if (maxScan <= 0) {
      capped(`message cap before ${what}`);
      return;
    }
    if (!haveBudget(requestLimit, what)) return;
    const client = await ceo(id);
    const result = await client.listAllMessages({
      ...(folder !== null ? { folder } : {}),
      receivedAfter,
      receivedBefore,
      maxScan,
      pageDelayMs: PAGE_DELAY_MS,
      onPage: ({ requests, rateLimited }) => {
        coverage.requests += requests;
        if (rateLimited) coverage.rateLimited++;
        return coverage.requests < requestLimit;
      },
    });
    for (const m of result.messages) {
      // A message can sit in both listings (self-sent mail is labelled INBOX and SENT): count it once.
      if (mailboxOf.has(m.id)) continue;
      if (folder === null && m.folders.some((f) => NOT_RECEIVED_FOLDERS.has(f))) continue;
      messages.push(m);
      mailboxOf.set(m.id, id);
      if (folder === SENT_FOLDER) {
        const sender = normaliseAddress(m.from[0]?.email);
        if (sender !== '') principal.add(sender);
      }
    }
    if (result.endedOn !== undefined) endedOnError(result.endedOn, what, { mailboxId: id, kept: result.messages.length });
    else if (result.truncated) capped(`${what} listing hit a cap`, { mailboxId: id });
  }

  async function readVoiceBodies(): Promise<void> {
    const sent = messages.filter((m) => m.folders.includes(SENT_FOLDER));
    for (const [i, m] of pickVoiceCandidates(sent, principal, VOICE_SAMPLE_SIZE).entries()) {
      if (!haveBudget(MAX_REQUESTS, 'getMessage')) return;
      if (i > 0) await sleep(PAGE_DELAY_MS);
      coverage.requests++;
      try {
        sentBodies.push(await (await ceo(mailboxOf.get(m.id)!)).getMessage(m.id));
      } catch (err) {
        // Deleted since it was listed: one fewer sample, not a failed scan.
        if (nylasStatus(err) !== 404) throw err;
        logger.warn({ messageId: m.id }, 'deep-dive scan: sent message gone before its body was read; skipping it');
      }
    }
  }

  for (const v of selected) await step('calendar', { mailboxId: v.id }, () => readCalendar(v.id));
  // Leave room for the voice bodies after Sent.
  for (const v of selected) {
    await step(SENT_FOLDER, { mailboxId: v.id }, () => readFolder(v.id, SENT_FOLDER, MAX_REQUESTS - VOICE_SAMPLE_SIZE));
  }
  await step('voice bodies', {}, readVoiceBodies);
  for (const v of selected) await step('received', { mailboxId: v.id }, () => readFolder(v.id, null, MAX_REQUESTS));

  coverage.messagesRead = messages.length;
  coverage.eventsRead = events.size;
  if (messages.length === 0 && events.size === 0 && stepsEndedOnError > 0) {
    // Nothing read and Nylas kept failing: an outage, not an empty mailbox. Fail the run rather
    // than store a summary that says there is no history.
    logger.error({ ...coverage, stepsEndedOnError }, 'deep-dive scan: read nothing and every source failed');
    throw new Error(`deep-dive scan: read nothing; ${stepsEndedOnError} step(s) ended on a Nylas error`);
  }
  logger.info(
    { ...coverage, mailboxes: selected.length, durationMs: Date.now() - started },
    'deep-dive scan: finished',
  );
  return {
    messages,
    sentBodies,
    events: [...events.values()],
    principalAddresses: [...principal].sort(compareStrings),
    coverage,
  };
}
