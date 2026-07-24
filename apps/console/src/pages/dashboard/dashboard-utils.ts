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

// ── Attention (jobs + channels + email accounts) ──────────────────────────────

// Minimal mirror of the Job shape (src/scheduler; GET /api/jobs).
export interface DashboardJob {
  id: string;
  agentId: string;
  status: string;
}

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

export type AttentionTone = 'warn' | 'danger';
// Deep-link targets are constrained to real routes so <Link to> stays type-safe.
export type AttentionTarget = '/jobs' | '/channels';

export interface AttentionItem {
  key: string;
  title: string;
  detail: string;
  tone: AttentionTone;
  to: AttentionTarget;
}

// Distinct agent ids, joined for a compact detail line. Caps at 3 to avoid an
// unbounded line, appending "+N more" when truncated.
function summariseAgents(jobs: DashboardJob[]): string {
  const ids = [...new Set(jobs.map(j => j.agentId))];
  if (ids.length <= 3) return ids.join(' · ');
  return `${ids.slice(0, 3).join(' · ')} +${ids.length - 3} more`;
}

// Aggregate the four attention sources into a flat, deep-linkable list.
// Empty result → the card renders its green "nothing needs your attention" state.
//
// Channels: we flag toggleable channels that are INSTALLED but not enabled —
// a half-finished setup the operator can complete with one click. Uninstalled
// optional channels are "not started", not "needs attention"; flagging them
// would make a fresh install never reach the clean state.
export function aggregateAttention(input: {
  failedJobs: DashboardJob[];
  suspendedJobs: DashboardJob[];
  channels: DashboardChannel[];
  emailAccounts: DashboardEmailAccount[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (input.failedJobs.length > 0) {
    const n = input.failedJobs.length;
    items.push({
      key: 'jobs-failed',
      title: `${n} job${n === 1 ? '' : 's'} failed`,
      detail: summariseAgents(input.failedJobs) || 'last run failed',
      tone: 'danger',
      to: '/jobs',
    });
  }

  if (input.suspendedJobs.length > 0) {
    const n = input.suspendedJobs.length;
    items.push({
      key: 'jobs-suspended',
      title: `${n} job${n === 1 ? '' : 's'} suspended`,
      detail: summariseAgents(input.suspendedJobs) || 'awaiting action',
      tone: 'warn',
      to: '/jobs',
    });
  }

  for (const ch of input.channels) {
    if (ch.isToggleable && ch.state === 'installed') {
      items.push({
        key: `channel-${ch.name}`,
        title: `${ch.name} channel not enabled`,
        detail: 'Configured but not enabled',
        tone: 'warn',
        to: '/channels',
      });
    }
  }

  for (const acct of input.emailAccounts) {
    if (!acct.hasGrant) {
      items.push({
        key: `email-${acct.name}`,
        title: `${acct.selfEmail || acct.name} missing grant`,
        detail: 'No mail grant connected',
        tone: 'danger',
        to: '/channels',
      });
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

// Fetch all four attention sources concurrently, then aggregate. A failure in
// any one rejects the whole card (scoped to this card only, never the page).
export async function fetchAttention(signal?: AbortSignal): Promise<AttentionItem[]> {
  const [failed, suspended, channels, emails] = await Promise.all([
    fetchJson<{ jobs: DashboardJob[] }>('/api/jobs?status=failed', signal),
    fetchJson<{ jobs: DashboardJob[] }>('/api/jobs?status=suspended', signal),
    fetchJson<{ channels: DashboardChannel[] }>('/api/registry/channels', signal),
    fetchJson<{ accounts: DashboardEmailAccount[] }>('/api/registry/email-accounts', signal),
  ]);
  return aggregateAttention({
    failedJobs: requireArray<DashboardJob>(failed.jobs, '/api/jobs?status=failed'),
    suspendedJobs: requireArray<DashboardJob>(suspended.jobs, '/api/jobs?status=suspended'),
    channels: requireArray<DashboardChannel>(channels.channels, '/api/registry/channels'),
    emailAccounts: requireArray<DashboardEmailAccount>(emails.accounts, '/api/registry/email-accounts'),
  });
}

// ── Activity (interpreted Ant Farm timeline) ──────────────────────────────────

// Minimal mirror of @curia/shared-types SceneDirective (the console isn't a
// shared-types consumer; we mirror only the fields we render). The timeline
// returns interpreted directives, not raw audit rows — see the issue's
// documented tradeoff.
export interface SceneDirective {
  id: string;
  logicalTs: number;
  kind: string;
  agentId?: string;
  targetAgentId?: string;
  state?: string;
  phase?: string;
  toolName?: string;
  content?: string;
  jobId?: string;
  taskId?: string | null;
  title?: string;
  badgeKind?: string;
  label?: string;
  channelId?: string;
  conversationId?: string;
}

export interface ActivityLine {
  id: string;
  logicalTs: number;
  actor: string;
  text: string;
}

function truncate(text: string, max = 80): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// Map one interpreted directive to a readable "<actor> <text>" line. Returns
// null for kinds we don't surface (they're dropped from the feed).
export function mapDirective(d: SceneDirective): ActivityLine | null {
  const base = { id: d.id, logicalTs: d.logicalTs };
  const agent = d.agentId ?? 'an agent';

  switch (d.kind) {
    case 'claw.deliver':
      return { ...base, actor: agent, text: 'delivered a completed job.' };
    case 'agent.state':
      return { ...base, actor: agent, text: d.state === 'error' ? 'ran into an error.' : 'started working.' };
    case 'agent.walk':
      return { ...base, actor: agent, text: `handed off to ${d.targetAgentId ?? 'another agent'}.` };
    case 'agent.speak':
      return {
        ...base,
        actor: agent,
        text: d.content ? `said “${truncate(d.content)}”.` : 'sent a message.',
      };
    case 'agent.think':
      if (d.phase === 'start') {
        return { ...base, actor: agent, text: d.toolName ? `started using ${d.toolName}.` : 'started thinking.' };
      }
      return { ...base, actor: agent, text: d.toolName ? `finished using ${d.toolName}.` : 'finished thinking.' };
    case 'tube.in':
      return { ...base, actor: 'inbound', text: 'a message arrived.' };
    case 'tube.out':
      return { ...base, actor: d.agentId ?? 'outbound', text: 'sent a reply out.' };
    case 'task.appear':
      return { ...base, actor: 'tasks', text: d.title ? `new task: ${truncate(d.title)}.` : 'a new task appeared.' };
    case 'task.trash':
      return { ...base, actor: 'tasks', text: 'a task was cleared.' };
    case 'badge':
      return {
        ...base,
        actor: d.badgeKind === 'autonomy.blocked' ? 'autonomy' : 'operator',
        text: d.label ? truncate(d.label) : 'flagged an event.',
      };
    default:
      return null;
  }
}

// GET /api/antfarm/timeline?limit=20 → interpreted lines, newest first.
export async function fetchActivity(signal?: AbortSignal): Promise<ActivityLine[]> {
  const data = await fetchJson<{ directives?: SceneDirective[] }>(
    '/api/antfarm/timeline?limit=20',
    signal,
  );
  const directives = requireArray<SceneDirective>(data.directives, '/api/antfarm/timeline');
  const lines: ActivityLine[] = [];
  for (const d of directives) {
    const line = mapDirective(d);
    if (line) lines.push(line);
  }
  // Newest first regardless of the endpoint's ordering.
  return lines.sort((a, b) => b.logicalTs - a.logicalTs);
}

// ── Greeting ──────────────────────────────────────────────────────────────────

// Time-of-day greeting for the page header. Pure (hour is injected) so it's
// deterministic in tests.
export function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
