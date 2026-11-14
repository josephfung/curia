// dashboard-utils.ts — pure logic + data-fetching for the operator home.
//
// Everything the dashboard cards need that isn't JSX lives here so it can be
// unit-tested in the node vitest env (no jsdom). Each fetch function is
// independent, so one dead endpoint degrades a single card rather than the
// whole page. Response shapes mirror the backend routes (cited per-type);
// the console has no shared/generated API-types module, so we declare local
// mirrors following the existing per-page convention.

import { apiFetch } from '../../api.js';

// ── Health (mirrors src/health/types.ts HealthResponse + GET /api/health) ─────

export type CheckResult = 'ok' | 'fail' | 'skipped';
export type HealthStatus = 'ok' | 'degraded' | 'down';

// checks is intentionally typed loosely: top-level entries are either a
// CheckResult or a nested object of CheckResults (today only `mcp.*`). Keeping
// it generic means new MCP servers — or any future nested group — flatten into
// pills without a code change.
export interface HealthResponse {
  status: HealthStatus;
  uptime_s: number;
  checks: Record<string, CheckResult | Record<string, CheckResult>>;
}

export interface HealthCheckPill {
  name: string;
  result: CheckResult;
}

// Runtime shape guard — a 503 body is only "data" (a red health card) if it is
// actually health-shaped; anything else is a genuine transport error.
function isCheckResult(v: unknown): v is CheckResult {
  return v === 'ok' || v === 'fail' || v === 'skipped';
}

export function isHealthResponse(body: unknown): body is HealthResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b['status'] !== 'ok' && b['status'] !== 'degraded' && b['status'] !== 'down') return false;
  if (typeof b['uptime_s'] !== 'number') return false;
  if (typeof b['checks'] !== 'object' || b['checks'] === null) return false;
  return true;
}

// Flatten the fixed checks object into a flat pill list, expanding nested
// groups (e.g. `mcp: { google_workspace: 'ok' }` → `mcp.google_workspace`).
export function flattenHealthChecks(checks: HealthResponse['checks']): HealthCheckPill[] {
  const pills: HealthCheckPill[] = [];
  for (const [name, value] of Object.entries(checks)) {
    if (isCheckResult(value)) {
      pills.push({ name, result: value });
    } else if (typeof value === 'object' && value !== null) {
      for (const [sub, subValue] of Object.entries(value)) {
        if (isCheckResult(subValue)) pills.push({ name: `${name}.${sub}`, result: subValue });
      }
    }
  }
  return pills;
}

// Map a per-check result to one of the EXISTING .status-pill modifier classes
// (app.css) — no new health-specific pill classes, per the issue.
//   ok → confirmed (green) · fail → blocked (red) · skipped → neutral (no modifier)
export function healthCheckPillClass(result: CheckResult): string {
  switch (result) {
    case 'ok':      return 'confirmed';
    case 'fail':    return 'blocked';
    case 'skipped': return '';
  }
}

export type HealthTone = 'ok' | 'warn' | 'danger';

export interface HealthStatusMeta {
  label: string;
  tone: HealthTone;
}

// Overall traffic-light status → human label + tone (drives the big dot colour).
export function healthStatusMeta(status: HealthStatus): HealthStatusMeta {
  switch (status) {
    case 'ok':       return { label: 'All systems nominal', tone: 'ok' };
    case 'degraded': return { label: 'Degraded', tone: 'warn' };
    case 'down':     return { label: 'Down', tone: 'danger' };
  }
}

// "6d 14h 22m". uptime_s of -1 (the health route's internal-error sentinel)
// or any negative value renders as "unknown" rather than a nonsense duration.
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const total = Math.floor(seconds);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// GET /api/health — 200 normally, 503 when status==='down'. A 503 with a
// health-shaped JSON body is DATA: the operator must see the red "Down" card,
// not a generic error state. Only a non-health body (or other status) is an error.
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await apiFetch('/api/health', signal ? { signal } : undefined);
  const contentType = res.headers.get('content-type') ?? '';
  const healthShaped503 = res.status === 503 && contentType.includes('application/json');
  if (res.ok || healthShaped503) {
    const body = (await res.json()) as unknown;
    if (isHealthResponse(body)) return body;
    // 2xx/503 but not health-shaped (e.g. an SPA-fallback HTML body parsed as
    // an object, or a schema drift) — real error, just not a transport one.
    throw new Error('health check returned an unexpected response');
  }
  throw new Error(`health check failed: HTTP ${res.status}`);
}

// ── Setup gaps (channels + email grants the operator still has to finish) ────
// Failed jobs used to live here too. They are not the principal's to unblock,
// so they stay in Recent Activity (red) and off this list (#2340).

// Mirror of ChannelEntry (src/registry/channel-registry-types.ts; GET /api/registry/channels).
export interface DashboardChannel {
  name: string;
  state: 'uninstalled' | 'installed' | 'enabled';
  isToggleable: boolean;
}

// Mirror of the email-accounts registry entry (GET /api/registry/email-accounts).
export interface DashboardEmailAccount {
  name: string;
  selfEmail: string;
  hasGrant: boolean;
}

export interface SetupGap {
  key: string;
  title: string;
}

// Channels installed but not enabled, and email accounts with no grant.
// Uninstalled optional channels are "not started", not a gap.
export function setupGaps(input: {
  channels: DashboardChannel[];
  emailAccounts: DashboardEmailAccount[];
}): SetupGap[] {
  const items: SetupGap[] = [];
  for (const ch of input.channels) {
    if (ch.isToggleable && ch.state === 'installed') {
      items.push({ key: `channel-${ch.name}`, title: `${ch.name} channel not enabled` });
    }
  }
  for (const acct of input.emailAccounts) {
    if (!acct.hasGrant) {
      items.push({ key: `email-${acct.name}`, title: `${acct.selfEmail || acct.name} missing grant` });
    }
  }
  return items;
}

// Small typed JSON reader — throws on non-2xx with the backend error message
// when present (mirrors the per-page errorMessage idiom).
async function readErrorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      // Non-JSON / malformed body — the status code below is still a useful
      // message, but log so a broken error payload isn't lost (matches the
      // sibling errorMessage helpers across the console pages).
      console.error('[dashboard readErrorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await apiFetch(path, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as T;
}

// These endpoints contractually return an array (empty when there's nothing),
// so a missing/non-array field on a 200 is a shape violation — NOT an empty
// result. Surfacing it as an error keeps the attention card honest: a broken
// jobs/channels endpoint must never silently read as a clean "all clear".
function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} returned an unexpected response`);
  }
  return value as T[];
}

// Setup gaps for the health card. A missing array is an error, never "no gaps".
export async function fetchSetupGaps(signal?: AbortSignal): Promise<SetupGap[]> {
  const [channels, emails] = await Promise.all([
    fetchJson<{ channels: DashboardChannel[] }>('/api/registry/channels', signal),
    fetchJson<{ accounts: DashboardEmailAccount[] }>('/api/registry/email-accounts', signal),
  ]);
  return setupGaps({
    channels: requireArray<DashboardChannel>(channels.channels, '/api/registry/channels'),
    emailAccounts: requireArray<DashboardEmailAccount>(emails.accounts, '/api/registry/email-accounts'),
  });
}

// ── Activity (job-level feed, GET /api/activity) ─────────────────────────────

// Mirrors src/activity/types.ts. One item per job, already in words; the
// backend never puts tool names or message bodies in it (#2251).
export type ActivityLink =
  | { kind: 'job'; jobId: string }
  | { kind: 'conversation'; conversationId: string; from: string; to: string };

export interface ActivityItem {
  id: string;
  ts: string;
  actor: string;
  headline: string;
  details: string[];
  outcome: 'success' | 'partial' | 'failed';
  autonomy: 'autonomous' | 'approved' | null;
  link: ActivityLink | null;
}

export interface ActivityFeedData {
  items: ActivityItem[];
  /** True when the window held more than the card shows. */
  hasMore: boolean;
  /** IANA timezone the backend wrote dates in — the principal's. Times use it too. */
  timezone: string;
}

// Lookback window for the home Recent Activity card.
const ACTIVITY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// The column scrolls, so the card can hold more than the old fixed 20 (#2340).
const ACTIVITY_LIMIT = '50';

// GET /api/activity?from=<now-24h>&limit=50 → newest first.
export async function fetchActivity(signal?: AbortSignal): Promise<ActivityFeedData> {
  const from = new Date(Date.now() - ACTIVITY_LOOKBACK_MS).toISOString();
  const params = new URLSearchParams({ from, limit: ACTIVITY_LIMIT });
  const data = await fetchJson<{ items?: ActivityItem[]; hasMore?: unknown; timezone?: unknown }>(
    `/api/activity?${params.toString()}`,
    signal,
  );
  const items = requireArray<ActivityItem>(data.items, '/api/activity');
  const timezone = typeof data.timezone === 'string' && data.timezone.length > 0
    ? data.timezone
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { items, hasMore: data.hasMore === true, timezone };
}

// Where a click on an item goes: the job's page, or an Ant Farm replay of the
// conversation's window (Ant Farm is its own SPA at /antfarm/, so a plain href).
export function activityHref(link: ActivityLink | null): string | null {
  if (!link) return null;
  if (link.kind === 'job') return `/jobs/${encodeURIComponent(link.jobId)}`;
  const params = new URLSearchParams({ conversationId: link.conversationId, from: link.from, to: link.to });
  return `/antfarm/?${params.toString()}`;
}

// Run a formatter in the principal's timezone; a bad zone name falls back to the browser's.
function inZone<T>(timezone: string, fn: (opts: { timeZone?: string }) => T): T {
  try {
    return fn({ timeZone: timezone });
  } catch {
    return fn({});
  }
}

// Clock time of an item in the principal's timezone. The day goes on the group row above.
export function formatActivityTime(ts: string, timezone: string): string {
  const d = new Date(ts);
  return inZone(timezone, (opts) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...opts }));
}

export interface ActivityDayGroup {
  /** YYYY-MM-DD in the principal's timezone. */
  key: string;
  /** "Yesterday", "Oct 21", or null for today (today's items need no day row). */
  label: string | null;
  items: ActivityItem[];
}

// Split newest-first items into runs of the same day in the principal's timezone.
export function groupActivityByDay(items: ActivityItem[], timezone: string, now: Date = new Date()): ActivityDayGroup[] {
  return inZone(timezone, (opts) => {
    const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...opts });
    const today = dayKey(now);
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    // Calendar arithmetic on the date itself, so a DST change cannot skip or repeat a day.
    const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);

    const groups: ActivityDayGroup[] = [];
    for (const item of items) {
      const date = new Date(item.ts);
      const key = dayKey(date);
      let group = groups[groups.length - 1];
      if (!group || group.key !== key) {
        const label = key === today
          ? null
          : key === yesterday
            ? 'Yesterday'
            : date.toLocaleDateString([], { month: 'short', day: 'numeric', ...opts });
        group = { key, label, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  });
}

// "ceo-inbox" → "ceo inbox": the muted agent name beside each item.
export function agentLabel(agentId: string): string {
  return agentId.replace(/[-_]+/g, ' ').trim() || 'agent';
}

// ── Greeting ──────────────────────────────────────────────────────────────────

// Time-of-day greeting for the page header. Pure (hour is injected) so it's
// deterministic in tests.
export function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Hour 0–23 in an IANA zone. A bad zone name falls back to the runtime's local hour. */
export function hourInTimeZone(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const raw = Number(parts.find((p) => p.type === 'hour')?.value);
    if (!Number.isFinite(raw)) return date.getHours();
    return raw === 24 ? 0 : raw;
  } catch {
    return date.getHours();
  }
}

// ── Principal home: copy, numbers, undo (#2340) ──────────────────────────────

export const UNDO_WINDOW_MS = 5_000;
export const ACT_DONE_MS = 650;

/**
 * Subtitle under the greeting. A null count is "not loaded" — never rendered
 * as zero, so a failed card cannot say the plate is clear or that nothing was done.
 */
export function greetingSubtitle(waiting: number | null, handled: number | null): string {
  const parts: string[] = [];
  if (waiting !== null) {
    parts.push(waiting === 0
      ? 'Nothing is waiting on you.'
      : `${waiting} ${waiting === 1 ? 'thing is' : 'things are'} waiting on you.`);
  }
  if (handled !== null) {
    parts.push(`Curia handled ${handled} ${handled === 1 ? 'thing' : 'things'} since yesterday.`);
  }
  return parts.join(' ');
}

/** True only for a loaded, error-free empty list. */
export function showCaughtUp(input: { loaded: boolean; error: string | null; count: number }): boolean {
  return input.loaded && input.error === null && input.count === 0;
}

/** Detail after "All caught up". The cleared clause is omitted at zero. */
export function caughtUpDetail(clearedToday: number, curiaHandling: number): string {
  const handling = `Curia is handling ${curiaHandling} ${curiaHandling === 1 ? 'thing' : 'things'}`;
  if (clearedToday <= 0) return handling;
  return `${clearedToday} cleared today · ${handling}`;
}

function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function roundedMinutes(minutes: number): number {
  return Math.round(minutes * 10) / 10;
}

/**
 * Principal-minutes. An empty week is `0m`. Otherwise under an hour the tenths
 * stay visible (`≈5m`, `≈0.5m`); from an hour up, hours, with the same rule
 * for a trailing zero (`≈1h`, `≈3.6h`).
 */
export function formatTimeSaved(minutes: number): string {
  const rounded = roundedMinutes(minutes);
  if (rounded === 0) return '0m';
  if (rounded < 60) return `≈${oneDecimal(rounded)}m`;
  return `≈${oneDecimal(rounded / 60)}h`;
}

export interface SignedDelta {
  direction: 'up' | 'down' | 'flat';
  text: string;
}

export function formatCountDelta(current: number, previous: number): SignedDelta {
  if (previous === 0 && current === 0) return { direction: 'flat', text: '0%' };
  if (previous === 0) return { direction: 'up', text: '▲ new' };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { direction: 'flat', text: '0%' };
  if (pct > 0) return { direction: 'up', text: `▲ ${pct}%` };
  return { direction: 'down', text: `▼ ${Math.abs(pct)}%` };
}

/**
 * Week-over-week change for the time-saved tile. The unit follows the tile,
 * which is chosen from `current` alone: 45 minutes beside a 65-minute last
 * week stays in minutes. Once the tile is in hours, a change under 3 minutes
 * rounds to 0h and shows as flat. That matches the tenths the tile itself shows.
 */
export function formatTimeSavedDelta(currentMinutes: number, previousMinutes: number): SignedDelta {
  const diff = currentMinutes - previousMinutes;
  const absMinutes = roundedMinutes(Math.abs(diff));
  const tileHours = roundedMinutes(currentMinutes) >= 60;
  if (!tileHours) {
    if (absMinutes === 0) return { direction: 'flat', text: '0m vs last wk' };
    const direction = diff > 0 ? 'up' : 'down';
    const arrow = diff > 0 ? '▲' : '▼';
    return { direction, text: `${arrow} ${oneDecimal(absMinutes)}m vs last wk` };
  }
  const hours = roundedMinutes(absMinutes / 60);
  if (hours === 0) return { direction: 'flat', text: '0h vs last wk' };
  const direction = diff > 0 ? 'up' : 'down';
  const arrow = diff > 0 ? '▲' : '▼';
  return { direction, text: `${arrow} ${oneDecimal(hours)}h vs last wk` };
}

function localDayKey(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function calendarDaysBetween(earlierKey: string, laterKey: string): number {
  const [y1, m1, d1] = earlierKey.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = laterKey.split('-').map(Number) as [number, number, number];
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86_400_000);
}

export function overdueMeta(dueAtIso: string, now: Date, timeZone: string): string {
  const due = new Date(dueAtIso);
  let day = 'due';
  try {
    day = due.toLocaleDateString('en-US', { weekday: 'short', timeZone });
  } catch {
    day = due.toLocaleDateString('en-US', { weekday: 'short' });
  }
  const overdueDays = calendarDaysBetween(localDayKey(due, timeZone), localDayKey(now, timeZone));
  if (overdueDays >= 1) {
    return `Your task · due ${day}, ${overdueDays} ${overdueDays === 1 ? 'day' : 'days'} overdue`;
  }
  const hours = Math.max(1, Math.round((now.getTime() - due.getTime()) / 3_600_000));
  return `Your task · due ${day}, ${hours}h overdue`;
}

export function heldMeta(createdAtIso: string, now: Date, draft: boolean): string {
  const ms = Math.max(0, now.getTime() - new Date(createdAtIso).getTime());
  const hours = Math.floor(ms / 3_600_000);
  const label = draft ? 'Draft held for approval' : 'Held for approval';
  if (hours < 1) {
    const mins = Math.max(1, Math.round(ms / 60_000));
    return `${label} · ${mins}m`;
  }
  if (hours < 48) return `${label} · ${hours}h`;
  const days = Math.round(hours / 24);
  return `${label} · ${days}d`;
}

export interface WaitingTask {
  id: string;
  title: string;
  dueAt: string;
}

export interface WaitingApproval {
  id: number;
  title: string;
  createdAt: string;
  toolName: string;
  summary: string;
  /** The stored payload has a draft id and no recipient or body yet. */
  needsDraft?: boolean;
}

export type WaitingRow =
  | (WaitingTask & { kind: 'task' })
  | (WaitingApproval & { kind: 'approval' });

/** Overdue tasks first (most overdue at the top), then held approvals, oldest first. */
export function orderWaitingItems(tasks: WaitingTask[], approvals: WaitingApproval[]): WaitingRow[] {
  const taskRows: WaitingRow[] = [...tasks]
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .map((task) => ({ ...task, kind: 'task' }));
  const approvalRows: WaitingRow[] = [...approvals]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((approval) => ({ ...approval, kind: 'approval' }));
  return [...taskRows, ...approvalRows];
}

export type PendingUndoKind = 'dismissed' | 'marked done';

/**
 * One toast covers every change still inside the undo window.
 * A single change keeps its own verb. Several read "N changes", and the Undo
 * button on that toast cancels all of them.
 */
export function pendingUndoMessage(pending: readonly PendingUndoKind[]): string | null {
  if (pending.length === 0) return null;
  if (pending.length === 1) return pending[0] === 'dismissed' ? 'Dismissed' : 'Marked done';
  return `${pending.length} changes`;
}

export interface ApprovalPreview {
  summary: string;
  canApprove: boolean;
  blockReason: string | null;
}

export async function fetchApprovalPreview(id: number, signal?: AbortSignal): Promise<ApprovalPreview> {
  const data = await fetchJson<Record<string, unknown>>(`/api/dashboard/approvals/${id}/preview`, signal);
  const summary = data['summary'];
  if (typeof summary !== 'string' || typeof data['canApprove'] !== 'boolean') {
    throw new Error('/api/dashboard/approvals/preview returned an unexpected response');
  }
  const blockReason = data['blockReason'];
  return {
    summary,
    canApprove: data['canApprove'],
    blockReason: typeof blockReason === 'string' ? blockReason : null,
  };
}

export interface UndoCommit {
  /** Drop the pending commit. The server is not contacted. */
  cancel: () => void;
  /** Commit now. Used when the page is going away inside the undo window. */
  flush: () => void;
}

export function scheduleUndoCommit(commit: () => void, delayMs: number = UNDO_WINDOW_MS): UndoCommit {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    commit();
  }, delayMs);
  return {
    cancel() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    },
    flush() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      commit();
    },
  };
}

export interface WaitingData {
  timezone: string;
  tasks: WaitingTask[];
  approvals: WaitingApproval[];
  clearedToday: number;
  curiaHandling: number;
}

export interface StatsData {
  timezone: string;
  /** Principal-minutes in the current and previous 7 days, plus the tile's explanation. */
  minutesSaved: { current: number; previous: number; help: string; detail: string };
  done: { current: number; previous: number };
  /** Open principal-owned tasks, any open status, and how many are past due. */
  openTasks: { total: number; overdue: number };
  hiccups: { current: number; byDay: number[] };
  /** Jobs in the last 7 days where a policy guard held something for the principal (#2587). Not hiccups. */
  held: { current: number };
  handledSinceYesterday: number;
}

export interface HiccupsData {
  timezone: string;
  /** The local day asked for, or null for the tile's 7-day window. */
  day: string | null;
  /** Hiccups the tile counts; more than items.length when the list is capped. */
  total: number;
  items: ActivityItem[];
}

export interface HistogramDay {
  key: string;
  label: string;
  weekend: boolean;
  today: boolean;
  total: number;
  hiccups: number;
  byAgent: Record<string, number>;
  byOutcome: { success: number; partial: number; failed: number };
}

export interface HistogramData {
  timezone: string;
  days: HistogramDay[];
  agents: string[];
  average: number;
  max: number;
}

export interface BullpenData {
  available: boolean;
  count: number;
  agents: string[];
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} returned an unexpected response`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} returned an unexpected response`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} returned an unexpected response`);
  return value as Record<string, unknown>;
}

export async function fetchWaiting(signal?: AbortSignal): Promise<WaitingData> {
  const data = await fetchJson<Record<string, unknown>>('/api/dashboard/waiting', signal);
  const tasks = requireArray<WaitingTask>(data['tasks'], '/api/dashboard/waiting tasks');
  const approvals = requireArray<WaitingApproval>(data['approvals'], '/api/dashboard/waiting approvals');
  const timezone = data['timezone'];
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new Error('/api/dashboard/waiting returned an unexpected response');
  }
  return {
    timezone,
    tasks,
    approvals,
    clearedToday: requireNumber(data['clearedToday'], '/api/dashboard/waiting'),
    curiaHandling: requireNumber(data['curiaHandling'], '/api/dashboard/waiting'),
  };
}

export async function fetchStats(signal?: AbortSignal): Promise<StatsData> {
  const data = await fetchJson<Record<string, unknown>>('/api/dashboard/stats', signal);
  const minutesSaved = requireRecord(data['minutesSaved'], '/api/dashboard/stats minutes');
  const done = requireRecord(data['done'], '/api/dashboard/stats done');
  const openTasks = requireRecord(data['openTasks'], '/api/dashboard/stats open tasks');
  const hiccups = requireRecord(data['hiccups'], '/api/dashboard/stats hiccups');
  const held = requireRecord(data['held'], '/api/dashboard/stats held');
  const byDay = requireArray<number>(hiccups['byDay'], '/api/dashboard/stats hiccups');
  if (byDay.some((n) => typeof n !== 'number')) {
    throw new Error('/api/dashboard/stats hiccups returned an unexpected response');
  }
  const timezone = data['timezone'];
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new Error('/api/dashboard/stats returned an unexpected response');
  }
  return {
    timezone,
    minutesSaved: {
      current: requireNumber(minutesSaved['current'], '/api/dashboard/stats minutes'),
      previous: requireNumber(minutesSaved['previous'], '/api/dashboard/stats minutes'),
      help: requireText(minutesSaved['help'], '/api/dashboard/stats minutes'),
      detail: requireText(minutesSaved['detail'], '/api/dashboard/stats minutes'),
    },
    done: {
      current: requireNumber(done['current'], '/api/dashboard/stats done'),
      previous: requireNumber(done['previous'], '/api/dashboard/stats done'),
    },
    openTasks: {
      total: requireNumber(openTasks['total'], '/api/dashboard/stats open tasks'),
      overdue: requireNumber(openTasks['overdue'], '/api/dashboard/stats open tasks'),
    },
    hiccups: { current: requireNumber(hiccups['current'], '/api/dashboard/stats hiccups'), byDay },
    held: { current: requireNumber(held['current'], '/api/dashboard/stats held') },
    handledSinceYesterday: requireNumber(data['handledSinceYesterday'], '/api/dashboard/stats'),
  };
}

// GET /api/dashboard/hiccups[?day=YYYY-MM-DD] → the jobs behind the Hiccups tile (#2350).
export async function fetchHiccups(day?: string, signal?: AbortSignal): Promise<HiccupsData> {
  const query = day ? `?${new URLSearchParams({ day }).toString()}` : '';
  const data = await fetchJson<Record<string, unknown>>(`/api/dashboard/hiccups${query}`, signal);
  const items = requireArray<ActivityItem>(data['items'], '/api/dashboard/hiccups');
  return {
    timezone: requireText(data['timezone'], '/api/dashboard/hiccups'),
    day: typeof data['day'] === 'string' ? data['day'] : null,
    total: requireNumber(data['total'], '/api/dashboard/hiccups'),
    items,
  };
}

// The Tasks page with the Open tasks tile's filters applied: the principal's, every open status.
export const OPEN_TASKS_SEARCH = { owner: 'ceo', status: 'all_open' } as const;

export async function fetchHistogram(signal?: AbortSignal): Promise<HistogramData> {
  const data = await fetchJson<Record<string, unknown>>('/api/dashboard/histogram', signal);
  const days = requireArray<HistogramDay>(data['days'], '/api/dashboard/histogram');
  const agents = requireArray<string>(data['agents'], '/api/dashboard/histogram');
  const timezone = data['timezone'];
  if (typeof timezone !== 'string' || days.length === 0) {
    throw new Error('/api/dashboard/histogram returned an unexpected response');
  }
  return {
    timezone,
    days,
    agents,
    average: requireNumber(data['average'], '/api/dashboard/histogram'),
    max: requireNumber(data['max'], '/api/dashboard/histogram'),
  };
}

export async function fetchBullpen(signal?: AbortSignal): Promise<BullpenData> {
  const data = await fetchJson<Record<string, unknown>>('/api/dashboard/bullpen', signal);
  if (typeof data['available'] !== 'boolean') {
    throw new Error('/api/dashboard/bullpen returned an unexpected response');
  }
  return {
    available: data['available'],
    count: requireNumber(data['count'], '/api/dashboard/bullpen'),
    agents: requireArray<string>(data['agents'], '/api/dashboard/bullpen'),
  };
}

/** POST that survives a refresh inside the undo window (`keepalive`). Returns the JSON body. */
export async function postDashboard(
  path: string,
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await apiFetch(path, {
    method: 'POST',
    keepalive: true,
    ...(payload
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
  });
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return {};
  const body = (await res.json()) as unknown;
  if (typeof body !== 'object' || body === null) return {};
  return body as Record<string, unknown>;
}

const AGENT_COLORS = [
  'var(--app-teal)',
  'var(--app-blue)',
  'var(--app-amber)',
  'var(--app-violet)',
  'var(--app-green)',
  'var(--app-blue-soft)',
];

/** Stable for a given set of agents: alphabetical order, "other" always muted. */
export function agentColor(name: string, agents: readonly string[]): string {
  if (name === 'other') return 'var(--app-fg-subtle)';
  const named = agents.filter((agent) => agent !== 'other').slice().sort();
  const index = Math.max(0, named.indexOf(name));
  return AGENT_COLORS[index % AGENT_COLORS.length] ?? AGENT_COLORS[0]!;
}

export const OUTCOME_COLORS: Record<'success' | 'partial' | 'failed', string> = {
  success: 'var(--app-teal)',
  partial: 'var(--app-amber)',
  failed: 'var(--app-destructive)',
};

export function histogramDateLabel(key: string, today: boolean): string {
  if (today) return 'Today (so far)';
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  return noon.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
