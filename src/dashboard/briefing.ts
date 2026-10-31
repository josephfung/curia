// briefing.ts — pure calendar math and histogram shaping for the principal home (#2340).
//
// Day boundaries are the principal's timezone, including across DST: a local
// calendar date is never skipped or repeated. Counts that the console compares
// (hiccups tile vs histogram, done-for-you vs the same jobs) are derived from
// one shaped model so they cannot drift.

import { buildApprovalDetails } from '../autonomy/approval-notification.js';

export const HISTOGRAM_DAYS = 14;
export const STATS_WINDOW_DAYS = 7;

/** How many named agents a stacked bar keeps before the rest fold into "other". */
export const AGENT_SERIES_LIMIT = 6;

/** agent.task roots older than this are not "working right now". */
export const BULLPEN_IN_FLIGHT_MS = 20 * 60 * 1000;

/** How long stats and the histogram share one aggregate. Short enough that a new day shows up. */
export const AGGREGATE_CACHE_MS = 45_000;

export type JobOutcome = 'success' | 'partial' | 'failed';

/** One projected activity job. The same unit as a row on /api/activity. */
export interface ProjectedJob {
  ts: string;
  actor: string;
  outcome: JobOutcome;
}

export interface HistogramDay {
  key: string;
  label: string;
  weekend: boolean;
  today: boolean;
  total: number;
  hiccups: number;
  byAgent: Record<string, number>;
  byOutcome: Record<JobOutcome, number>;
}

export interface HistogramModel {
  days: HistogramDay[];
  agents: string[];
  average: number;
  max: number;
}

const WEEKDAY: Record<string, { short: string; weekend: boolean }> = {
  Sun: { short: 'Su', weekend: true },
  Mon: { short: 'M', weekend: false },
  Tue: { short: 'Tu', weekend: false },
  Wed: { short: 'W', weekend: false },
  Thu: { short: 'Th', weekend: false },
  Fri: { short: 'F', weekend: false },
  Sat: { short: 'Sa', weekend: true },
};

export function isValidTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD of `date` in `timeZone`. */
export function localDayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Calendar shift of a YYYY-MM-DD key. Independent of timezone and DST. */
export function addCalendarDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `count` consecutive keys ending on `todayKey`, oldest first. */
export function dayKeysEnding(todayKey: string, count: number): string[] {
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) keys.push(addCalendarDays(todayKey, -i));
  return keys;
}

/**
 * The first instant of the local calendar day `key`. Binary search so a DST
 * fallback (two midnights) and a spring-forward (a missing hour) both land on
 * the start of that date.
 */
export function localMidnight(key: string, timeZone: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  let lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  let hi = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDayKey(new Date(mid), timeZone) < key) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

export function dayLabel(key: string, todayKey: string): { label: string; weekend: boolean; today: boolean } {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const name = noon.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const info = WEEKDAY[name] ?? { short: name, weekend: false };
  const today = key === todayKey;
  return { label: today ? 'Today' : info.short, weekend: info.weekend, today };
}

export interface HistogramCount {
  /** Local YYYY-MM-DD. */
  day: string;
  actor: string;
  outcome: JobOutcome;
  n: number;
}

function emptyHistogramMaps(keys: string[]): {
  byDayAgent: Map<string, Map<string, number>>;
  byDayOutcome: Map<string, Record<JobOutcome, number>>;
} {
  const byDayAgent = new Map<string, Map<string, number>>();
  const byDayOutcome = new Map<string, Record<JobOutcome, number>>();
  for (const key of keys) {
    byDayAgent.set(key, new Map());
    byDayOutcome.set(key, { success: 0, partial: 0, failed: 0 });
  }
  return { byDayAgent, byDayOutcome };
}

/**
 * 14 local days ending today, stacked by agent and by outcome.
 * Agents beyond {@link AGENT_SERIES_LIMIT} fold into "other", ranked by volume.
 */
export function shapeHistogram(jobs: ProjectedJob[], now: Date, timeZone: string): HistogramModel {
  const todayKey = localDayKey(now, timeZone);
  const keys = dayKeysEnding(todayKey, HISTOGRAM_DAYS);
  const keySet = new Set(keys);
  const { byDayAgent, byDayOutcome } = emptyHistogramMaps(keys);
  const agentTotals = new Map<string, number>();
  for (const job of jobs) {
    const key = localDayKey(new Date(job.ts), timeZone);
    if (!keySet.has(key)) continue;
    addHistogramCount(byDayAgent, byDayOutcome, agentTotals, key, job.actor, job.outcome, 1);
  }
  return finishHistogram(keys, todayKey, byDayAgent, byDayOutcome, agentTotals);
}

/** Same bars as {@link shapeHistogram}, from day × actor × outcome totals. */
export function shapeHistogramFromCounts(
  counts: readonly HistogramCount[],
  now: Date,
  timeZone: string,
): HistogramModel {
  const todayKey = localDayKey(now, timeZone);
  const keys = dayKeysEnding(todayKey, HISTOGRAM_DAYS);
  const keySet = new Set(keys);
  const { byDayAgent, byDayOutcome } = emptyHistogramMaps(keys);
  const agentTotals = new Map<string, number>();
  for (const count of counts) {
    if (!keySet.has(count.day) || count.n <= 0) continue;
    addHistogramCount(byDayAgent, byDayOutcome, agentTotals, count.day, count.actor, count.outcome, count.n);
  }
  return finishHistogram(keys, todayKey, byDayAgent, byDayOutcome, agentTotals);
}

function addHistogramCount(
  byDayAgent: Map<string, Map<string, number>>,
  byDayOutcome: Map<string, Record<JobOutcome, number>>,
  agentTotals: Map<string, number>,
  key: string,
  actorName: string,
  outcome: JobOutcome,
  n: number,
): void {
  const outcomes = byDayOutcome.get(key)!;
  const agents = byDayAgent.get(key)!;
  outcomes[outcome] += n;
  const actor = actorName.length > 0 ? actorName : 'agent';
  agents.set(actor, (agents.get(actor) ?? 0) + n);
  agentTotals.set(actor, (agentTotals.get(actor) ?? 0) + n);
}

function finishHistogram(
  keys: string[],
  todayKey: string,
  byDayAgent: Map<string, Map<string, number>>,
  byDayOutcome: Map<string, Record<JobOutcome, number>>,
  agentTotals: Map<string, number>,
): HistogramModel {
  const ranked = [...agentTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const collapse = ranked.length > AGENT_SERIES_LIMIT;
  const named = (collapse ? ranked.slice(0, AGENT_SERIES_LIMIT) : ranked).map(([name]) => name);
  const namedSet = new Set(named);
  const agents = collapse ? [...named, 'other'] : named;

  const days: HistogramDay[] = keys.map((key) => {
    const outcome = byDayOutcome.get(key)!;
    const raw = byDayAgent.get(key)!;
    const byAgent: Record<string, number> = {};
    for (const name of named) byAgent[name] = 0;
    if (collapse) byAgent['other'] = 0;
    for (const [actor, count] of raw) {
      const bucket = namedSet.has(actor) ? actor : 'other';
      byAgent[bucket] = (byAgent[bucket] ?? 0) + count;
    }
    const total = outcome.success + outcome.partial + outcome.failed;
    return {
      key,
      ...dayLabel(key, todayKey),
      total,
      hiccups: outcome.partial + outcome.failed,
      byAgent,
      byOutcome: outcome,
    };
  });

  const max = days.reduce((m, day) => Math.max(m, day.total), 0);
  const average = days.reduce((s, day) => s + day.total, 0) / days.length;
  return { days, agents, average, max };
}

/** Hiccups on the last `days` histogram columns. The 7-day tile uses this. */
export function hiccupsOver(model: HistogramModel, days: number): number {
  return model.days.slice(-days).reduce((sum, day) => sum + day.hiccups, 0);
}

export function countJobs(
  jobs: ProjectedJob[],
  keys: ReadonlySet<string>,
  timeZone: string,
  outcomes?: ReadonlySet<JobOutcome>,
): number {
  let n = 0;
  for (const job of jobs) {
    if (!keys.has(localDayKey(new Date(job.ts), timeZone))) continue;
    if (outcomes && !outcomes.has(job.outcome)) continue;
    n += 1;
  }
  return n;
}

/**
 * Review text for a held approval. The same field list and length caps as the
 * chat notification, including the message body and any personal-details line.
 */
export function approvalReviewSummary(input: {
  description: string | null;
  toolName: string;
  payload: Record<string, unknown> | null;
}): string {
  const lines: string[] = [];
  const description = input.description?.trim();
  if (description) lines.push(description);
  const details = input.payload ? buildApprovalDetails(input.toolName, input.payload) : '';
  if (details) lines.push(details);
  else lines.push(input.toolName);
  return lines.join('\n');
}

/**
 * A send-draft that still needs a mailbox read before Approve.
 * Both the recipient and the body must already be on the payload. A held row
 * often stores subject and body and leaves To on the draft.
 */
export function approvalNeedsDraft(
  toolName: string,
  payload: Record<string, unknown> | null,
): boolean {
  if (!mailboxDraftRef(toolName, payload)) return false;
  const body = payload ?? {};
  const present = (key: string): boolean => {
    const value = body[key];
    return typeof value === 'string' && value.trim().length > 0;
  };
  return !(present('to') && present('body'));
}

/**
 * A mailbox draft linked onto a held `send-draft` approval.
 * `account` is the email-account name the gateway stored. Absent means the
 * owning mailbox is not known and has to be found.
 */
export function mailboxDraftRef(
  toolName: string,
  payload: Record<string, unknown> | null,
): { account?: string; draftId: string } | null {
  if (toolName !== 'send-draft' || !payload) return null;
  const draftId = payload['draft_id'];
  if (typeof draftId !== 'string' || draftId.trim().length === 0) return null;
  const account = payload['account'] ?? payload['accountId'];
  return {
    draftId: draftId.trim(),
    ...(typeof account === 'string' && account.trim().length > 0 ? { account: account.trim() } : {}),
  };
}
