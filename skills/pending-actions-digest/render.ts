// render.ts — pure formatting for the pending-actions-digest email body.
//
// No I/O and no clock reads: the current time is injected as `nowMs` so every
// function is deterministic and snapshot-testable. The handler supplies
// `Date.now()` at call time (which test suites pin via vi.spyOn).

import { toLocalIso } from '../../src/time/timestamp.js';
import type { TaskListRow } from '../../src/db/task-repo.js';

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;
const MS_WEEK = 604_800_000;
const MS_TWO_WEEKS = 14 * MS_DAY;

/**
 * Short humanized age of an ISO timestamp relative to nowMs.
 * Buckets: <1h, Nh (<1 day), Nd (<2 weeks), Nw (>=2 weeks).
 * Future or zero spans clamp to '<1h'.
 */
export function humanizeAge(sinceIso: string, nowMs: number): string {
  const diff = nowMs - Date.parse(sinceIso);
  if (!Number.isFinite(diff) || diff < MS_HOUR) return '<1h';
  if (diff < MS_DAY) return `${Math.floor(diff / MS_HOUR)}h`;
  if (diff < MS_TWO_WEEKS) return `${Math.floor(diff / MS_DAY)}d`;
  return `${Math.floor(diff / MS_WEEK)}w`;
}

/**
 * Render a task's CEO-facing due date (date only) in the user's timezone.
 * Returns '—' for a null due date or an unrepresentable timestamp.
 */
export function formatDueDate(dueIso: string | null, timezone: string): string {
  if (dueIso === null) return '—';
  const ms = Date.parse(dueIso);
  if (!Number.isFinite(ms)) return '—';
  const local = toLocalIso(Math.floor(ms / 1000), timezone);
  return local ? local.slice(0, 10) : '—';
}

// Approval line shape — the handler maps ActionLogRow → ApprovalInput.
export interface ApprovalInput {
  description: string | null;
  skillName: string;
  shortRef: string | null;
  expiresAt: Date | null;
}

export interface RenderDigestInput {
  approvals: ApprovalInput[];
  ceo: TaskListRow[];
  external: TaskListRow[];
  curia: TaskListRow[];
  /** Resolve a contact id to a display name; undefined if unknown/unresolved. */
  resolveName: (contactId: string) => string | undefined;
  nowMs: number;
  timezone: string;
}

/**
 * Time remaining until an approval expires. Preserves the legacy thresholds
 * exactly: <=0 or <1h both render '<1h remaining'.
 */
export function formatTimeRemaining(expiresAt: Date | null, nowMs: number): string {
  const ms = expiresAt != null ? expiresAt.getTime() - nowMs : 0;
  if (ms <= 0 || ms < MS_HOUR) return '<1h remaining';
  return `${Math.floor(ms / MS_HOUR)}h remaining`;
}

function approvalLine(a: ApprovalInput, nowMs: number): string {
  return `• ${a.description ?? '(no description)'} [${a.skillName}] — ${formatTimeRemaining(a.expiresAt, nowMs)} [${a.shortRef ?? '—'}]`;
}

// Render a backlog section: heading, up to 5 bullets, optional "+N more" footer.
// `lines` are pre-formatted bullet bodies (without the leading "• ").
function section(heading: string, lines: string[]): string {
  const shown = lines.slice(0, 5).map((l) => `• ${l}`);
  if (lines.length > 5) shown.push(`+${lines.length - 5} more`);
  return `${heading}:\n${shown.join('\n')}`;
}

/**
 * Build the full digest email body: the approvals block (byte-identical to the
 * legacy format) followed by each non-empty backlog section. Sections are
 * separated by a blank line. Returns '' when there is nothing to render.
 */
export function renderDigestBody(input: RenderDigestInput): string {
  const { approvals, ceo, external, curia, resolveName, nowMs, timezone } = input;
  const blocks: string[] = [];

  if (approvals.length > 0) {
    blocks.push(approvals.map((a) => approvalLine(a, nowMs)).join('\n'));
  }

  if (ceo.length > 0) {
    blocks.push(section('For you to do', ceo.map((t) =>
      `${t.title} · due ${formatDueDate(t.dueAt, timezone)} · age ${humanizeAge(t.createdAt, nowMs)}`,
    )));
  }

  if (external.length > 0) {
    blocks.push(section('Waiting on others', external.map((t) => {
      const name = (t.waitingOnContactId ? resolveName(t.waitingOnContactId) : undefined)
        ?? t.waitingOnText ?? '(unknown)';
      return `${t.title} · waiting on ${name} · since ${humanizeAge(t.createdAt, nowMs)}`;
    })));
  }

  if (curia.length > 0) {
    blocks.push(section("What I'm working on", curia.map((t) =>
      `${t.title} · age ${humanizeAge(t.createdAt, nowMs)}`,
    )));
  }

  return blocks.join('\n\n');
}
