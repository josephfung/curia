// history-summary.ts — the deterministic history summary for the onboarding deep dive (#2362).
//
// `summarise` turns what the scan read (mail summaries, a few sent bodies, calendar events) into a
// stored summary that every later step reads instead of the mailbox: correspondents, unopened and
// handed-off mail, recurring meetings, meeting shape, where time went, and a writing-voice sample.
// Every item carries the message or event ids it came from. It is pure: no I/O, no clock (the
// window's end stands in for "now"), and every list is sorted with explicit tie-breakers, so the
// same input always gives the same summary. The heuristics are documented in ./README.md; the
// calendar half lives in ./history-calendar.ts and the voice sample in ./voice-sample.ts.
import type { NylasMessageFull, NylasMessageSummary } from '../../channels/email/ceo-nylas-client.js';
import type { NylasCalendarEvent } from '../../channels/calendar/nylas-calendar-client.js';
import { classifyEmailSender } from '../../contacts/contact-service.js';
import { isNonOrgDomain } from '../../contacts/non-org-domains.js';
import { isValidTimezone } from '../../time/timezone-normalize.js';
import { TWO_WAY_MIN_MESSAGES, VOICE_SAMPLE_SIZE } from './limits.js';
import { summariseCalendar, type KeptClearBlock, type RecurringMeeting } from './history-calendar.js';
import {
  compareStrings,
  domainOf,
  median,
  messageEvidence,
  normaliseAddress,
  roundHours,
  type Dated,
  type Evidence,
} from './summary-util.js';
import { firstOutsideRecipient, isForward, pickVoiceCandidates, voiceBody } from './voice-sample.js';

export type { Evidence } from './summary-util.js';

export type Correspondent = {
  email: string;
  name: string | null;
  domain: string;
  kind: 'person' | 'organization' | 'automated';
  received: number;
  sent: number;
  twoWay: boolean;
  medianReplyMinutes: number | null;
  evidence: Evidence;
};

export type HistorySummary = {
  version: 1;
  generatedAt: string;
  window: { from: string; to: string };
  coverage: {
    messagesRead: number;
    eventsRead: number;
    requests: number;
    rateLimited: number;
    /** Scan steps ended early by a Nylas server error or a failed fetch (429s are in rateLimited). */
    errors: number;
    truncated: boolean;
  };
  principalAddresses: string[];
  correspondents: Correspondent[]; // sorted by received+sent desc
  unopened: { fromDomain: string; count: number; evidence: Evidence }[];
  handedOff: { threadId: string; to: string; evidence: Evidence }[];
  recurringMeetings: RecurringMeeting[];
  meetingShape: {
    medianMinutes: number;
    bufferMinutesMedian: number;
    keptClearBlocks: KeptClearBlock[];
    declinedOrMoved: number;
    evidence: Evidence;
  };
  timeSpent: { by: 'person' | 'organization' | 'series'; key: string; calendarHours: number; messages: number }[];
  voiceSample: { messageId: string; to: string; subject: string; body: string }[];
};

export interface SummariseInput {
  messages: NylasMessageSummary[];
  sentBodies: NylasMessageFull[];
  events: NylasCalendarEvent[];
  principalAddresses: string[];
  window: { from: Date; to: Date };
  coverage: HistorySummary['coverage'];
  /** The principal's IANA timezone: kept-clear blocks and buffers are read in local time. */
  timezone: string;
}

/** Unread mail older than this (before the window's end) counts as unopened. */
export const UNOPENED_AFTER_DAYS = 7;
/** Most `timeSpent` rows kept per grouping (person, organization, series). */
export const TIME_SPENT_TOP = 25;

const SENT_FOLDER = 'SENT';
const INBOX_FOLDER = 'INBOX';

interface CorrespondentAcc {
  email: string;
  name: string | null;
  received: number;
  sent: number;
  evidence: Dated[];
  latencies: number[];
}

function senderOf(m: NylasMessageSummary): string {
  return normaliseAddress(m.from[0]?.email);
}

function dedupeMessages<T extends NylasMessageSummary>(messages: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const m of messages) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.date - b.date || compareStrings(a.id, b.id));
}

/** The principal's addresses: those given, plus every sender of a Sent-folder message (aliases). */
function principalSet(given: readonly string[], messages: readonly NylasMessageSummary[]): Set<string> {
  const set = new Set(given.map((a) => normaliseAddress(a)).filter((a) => a !== ''));
  for (const m of messages) {
    if (!m.folders.includes(SENT_FOLDER)) continue;
    const from = senderOf(m);
    if (from !== '') set.add(from);
  }
  return set;
}

function correspondentsOf(messages: readonly NylasMessageSummary[], principal: ReadonlySet<string>): Map<string, CorrespondentAcc> {
  const accs = new Map<string, CorrespondentAcc>();
  const acc = (email: string, name: string | undefined): CorrespondentAcc => {
    let a = accs.get(email);
    if (!a) {
      a = { email, name: null, received: 0, sent: 0, evidence: [], latencies: [] };
      accs.set(email, a);
    }
    const trimmed = (name ?? '').trim();
    if (a.name === null && trimmed !== '') a.name = trimmed;
    return a;
  };

  // Principal-sent times per thread, ascending, for reply latency.
  const sentByThread = new Map<string, number[]>();
  for (const m of messages) {
    if (!principal.has(senderOf(m))) continue;
    const list = sentByThread.get(m.threadId) ?? [];
    list.push(m.date);
    sentByThread.set(m.threadId, list);
  }

  for (const m of messages) {
    const from = senderOf(m);
    if (from === '') continue;
    if (principal.has(from)) {
      const seen = new Set<string>();
      for (const p of [...m.to, ...m.cc]) {
        const email = normaliseAddress(p.email);
        if (email === '' || principal.has(email) || seen.has(email)) continue;
        seen.add(email);
        const a = acc(email, p.name);
        a.sent++;
        a.evidence.push({ id: m.id, at: m.date });
      }
      continue;
    }
    const a = acc(from, m.from[0]?.name);
    a.received++;
    a.evidence.push({ id: m.id, at: m.date });
    const reply = (sentByThread.get(m.threadId) ?? []).find((t) => t > m.date);
    if (reply !== undefined) a.latencies.push((reply - m.date) / 60);
  }
  return accs;
}

function toCorrespondent(a: CorrespondentAcc): Correspondent {
  return {
    email: a.email,
    name: a.name,
    domain: domainOf(a.email),
    kind: classifyEmailSender(a.email),
    received: a.received,
    sent: a.sent,
    twoWay: a.received >= 1 && a.sent >= 1 && a.received + a.sent >= TWO_WAY_MIN_MESSAGES,
    medianReplyMinutes: median(a.latencies),
    evidence: messageEvidence(a.evidence),
  };
}

function unopenedOf(messages: readonly NylasMessageSummary[], principal: ReadonlySet<string>, to: Date): HistorySummary['unopened'] {
  const cutoff = to.getTime() / 1000 - UNOPENED_AFTER_DAYS * 86_400;
  const byDomain = new Map<string, Dated[]>();
  for (const m of messages) {
    const from = senderOf(m);
    // Unread archived mail was dealt with (filed unread), so only the inbox counts as unopened.
    if (from === '' || principal.has(from) || !m.unread || m.date >= cutoff || !m.folders.includes(INBOX_FOLDER)) continue;
    const domain = domainOf(from);
    const list = byDomain.get(domain) ?? [];
    list.push({ id: m.id, at: m.date });
    byDomain.set(domain, list);
  }
  return [...byDomain.entries()]
    .map(([fromDomain, items]) => ({ fromDomain, count: items.length, evidence: messageEvidence(items) }))
    .sort((a, b) => b.count - a.count || compareStrings(a.fromDomain, b.fromDomain));
}

function handedOffOf(messages: readonly NylasMessageSummary[], principal: ReadonlySet<string>): HistorySummary['handedOff'] {
  const groups = new Map<string, { threadId: string; to: string; items: Dated[] }>();
  for (const m of messages) {
    if (!principal.has(senderOf(m)) || !isForward(m.subject)) continue;
    const to = firstOutsideRecipient(m, principal);
    if (to === '') continue; // forwarded to themself: not a hand-off
    const key = `${m.threadId}\u0000${to}`;
    const g = groups.get(key) ?? { threadId: m.threadId, to, items: [] };
    g.items.push({ id: m.id, at: m.date });
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, latest: Math.max(...g.items.map((i) => i.at)) }))
    .sort((a, b) => b.latest - a.latest || compareStrings(a.threadId, b.threadId) || compareStrings(a.to, b.to))
    .map((g) => ({ threadId: g.threadId, to: g.to, evidence: messageEvidence(g.items) }));
}

function timeSpentOf(
  correspondents: readonly Correspondent[],
  messages: readonly NylasMessageSummary[],
  principal: ReadonlySet<string>,
  calendar: ReturnType<typeof summariseCalendar>,
): HistorySummary['timeSpent'] {
  type Row = HistorySummary['timeSpent'][number];
  const people = new Map<string, Row>();
  const orgs = new Map<string, Row>();
  const row = (map: Map<string, Row>, by: Row['by'], key: string): Row => {
    let r = map.get(key);
    if (!r) {
      r = { by, key, calendarHours: 0, messages: 0 };
      map.set(key, r);
    }
    return r;
  };
  const isPerson = (email: string): boolean => classifyEmailSender(email) === 'person';
  const orgDomain = (email: string): string | null => {
    const d = domainOf(email);
    return d !== '' && classifyEmailSender(email) !== 'automated' && !isNonOrgDomain(d) ? d : null;
  };

  for (const c of correspondents) if (c.kind === 'person') row(people, 'person', c.email).messages = c.received + c.sent;
  // Organisation mail volume counts each message once per domain, whoever at the domain was on it.
  const domainMessages = new Map<string, Set<string>>();
  for (const m of messages) {
    const from = senderOf(m);
    const parties = principal.has(from) ? [...m.to, ...m.cc].map((p) => normaliseAddress(p.email)) : [from];
    for (const email of parties) {
      if (email === '' || principal.has(email)) continue;
      const d = orgDomain(email);
      if (d === null) continue;
      const set = domainMessages.get(d) ?? new Set<string>();
      set.add(m.id);
      domainMessages.set(d, set);
    }
  }
  for (const [d, ids] of domainMessages) row(orgs, 'organization', d).messages = ids.size;

  for (const [email, hours] of calendar.attendeeHours) if (isPerson(email)) row(people, 'person', email).calendarHours += hours;
  for (const [domain, hours] of calendar.domainHours) {
    if (isNonOrgDomain(domain)) continue;
    row(orgs, 'organization', domain).calendarHours += hours;
  }
  const series = [...calendar.seriesHours].map(([key, hours]): Row => ({ by: 'series', key, calendarHours: hours, messages: 0 }));

  const top = (rows: Iterable<Row>): Row[] =>
    [...rows]
      .map((r) => ({ ...r, calendarHours: roundHours(r.calendarHours) }))
      .sort((a, b) => b.calendarHours - a.calendarHours || b.messages - a.messages || compareStrings(a.key, b.key))
      .slice(0, TIME_SPENT_TOP);
  return [...top(people.values()), ...top(orgs.values()), ...top(series)];
}

function voiceSampleOf(sentBodies: readonly NylasMessageFull[], principal: ReadonlySet<string>): HistorySummary['voiceSample'] {
  const own = sentBodies.filter((m) => principal.has(senderOf(m)));
  const out: HistorySummary['voiceSample'] = [];
  for (const m of pickVoiceCandidates(own, principal, own.length)) {
    const body = voiceBody(m.body);
    if (body === '') continue;
    out.push({ messageId: m.id, to: firstOutsideRecipient(m, principal), subject: m.subject, body });
    if (out.length === VOICE_SAMPLE_SIZE) break;
  }
  return out;
}

export function summarise(input: SummariseInput): HistorySummary {
  // An unusable zone would silently yield no kept-clear blocks; the caller resolves it with
  // usableTimezone() first, so this only fires on a wiring bug.
  if (!isValidTimezone(input.timezone)) throw new Error(`summarise: not a usable IANA timezone: ${input.timezone}`);
  const messages = dedupeMessages(input.messages);
  const sentBodies = dedupeMessages(input.sentBodies);
  const principal = principalSet(input.principalAddresses, [...messages, ...sentBodies]);

  const correspondents = [...correspondentsOf(messages, principal).values()]
    .map(toCorrespondent)
    .sort((a, b) => b.received + b.sent - (a.received + a.sent) || compareStrings(a.email, b.email));
  const calendar = summariseCalendar(input.events, principal, input.window, input.timezone);

  return {
    version: 1,
    generatedAt: input.window.to.toISOString(),
    window: { from: input.window.from.toISOString(), to: input.window.to.toISOString() },
    coverage: { ...input.coverage },
    principalAddresses: [...principal].sort(compareStrings),
    correspondents,
    unopened: unopenedOf(messages, principal, input.window.to),
    handedOff: handedOffOf(messages, principal),
    recurringMeetings: calendar.recurringMeetings,
    meetingShape: calendar.meetingShape,
    timeSpent: timeSpentOf(correspondents, messages, principal, calendar),
    voiceSample: voiceSampleOf(sentBodies, principal),
  };
}
