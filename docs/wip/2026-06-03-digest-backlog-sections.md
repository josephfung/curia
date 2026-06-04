# pending-actions-digest Backlog Sections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `pending-actions-digest` skill so the daily CEO email also lists the task backlog in three owner-grouped sections (For you to do / Waiting on others / What I'm working on).

**Architecture:** Body construction moves into a new pure module `render.ts` (snapshot-testable, no I/O). The handler fetches three task lists via the existing `taskRepo.listTasks`, resolves `waiting_on_contact_id` to display names via the ambient `contactService`, applies an expanded send gate, builds an adaptive subject, and delegates body formatting to `render.ts`. The approvals block is reproduced byte-for-byte. Backlog fetch is resilient: a task-query failure or absent `taskRepo` degrades to an approvals-only email rather than failing the digest.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Vitest, Luxon (via `toLocalIso`), Postgres-backed `TaskRepo`.

**Reference spec:** [2026-06-03-digest-backlog-sections-design.md](2026-06-03-digest-backlog-sections-design.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `skills/pending-actions-digest/render.ts` (**new**) | Pure formatting: `humanizeAge`, `formatDueDate`, `formatTimeRemaining`, `renderDigestBody`. No I/O, no clock reads — time is injected as `nowMs`. |
| `skills/pending-actions-digest/render.test.ts` (**new**) | Unit + snapshot tests for the pure functions. |
| `skills/pending-actions-digest/handler.ts` (**modify**) | Orchestration: fetch approvals + backlog, resolve names, send gate, adaptive subject, send. Imports formatters from `render.ts`. |
| `skills/pending-actions-digest/handler.test.ts` (**modify**) | Update existing `toEqual(result.data)` assertions for the new count fields; add backlog-path tests. |
| `skills/pending-actions-digest/skill.json` (**modify**) | Add `taskRepo` capability, bump version, add output fields. |
| `CHANGELOG.md` (**modify**) | `[Unreleased] → Added` entry. |

**Key types (already defined in the codebase, do not redefine):**
- `TaskListRow` from `src/db/task-repo.ts` — extends `TaskRow` (`src/db/queries/tasks.ts`). Note: `createdAt`, `dueAt`, `updatedAt` are **ISO strings**, not `Date`. `waitingOnContactId: string | null`, `waitingOnText: string | null`, `title: string`.
- `TaskRepo.listTasks(filters: { owner?, statuses?, limit? }): Promise<TaskListRow[]>` — already orders by `priority DESC, due_at ASC NULLS LAST`.
- `ctx.contactService?.getContact(id): Promise<Contact | undefined>` — `Contact.displayName: string`.
- `ctx.taskRepo?` and `ctx.timezone?: string` on `SkillContext`.
- `toLocalIso(unixSeconds, timezone)` from `src/time/timestamp.ts` → e.g. `"2026-06-06T13:00:00.000+00:00"`.

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections` (branch `feat/digest-backlog-sections`). All `git` uses `git -C <worktree>`; all `pnpm` uses `pnpm --prefix <worktree>`.

**One-time setup before Task 1:** install deps in the worktree.

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections install`
Expected: completes; `node_modules/` populated.

---

## Task 1: `humanizeAge` helper

**Files:**
- Create: `skills/pending-actions-digest/render.ts`
- Test: `skills/pending-actions-digest/render.test.ts`

- [ ] **Step 1: Write the failing test**

Create `skills/pending-actions-digest/render.test.ts`:

```ts
// render.test.ts — unit + snapshot tests for the pure digest renderer.
import { describe, it, expect } from 'vitest';
import { humanizeAge } from './render.js';

// Fixed clock for deterministic spans. 2026-06-03T12:00:00.000Z.
const NOW_MS = Date.parse('2026-06-03T12:00:00.000Z');

describe('humanizeAge', () => {
  it('renders <1h for spans under an hour', () => {
    expect(humanizeAge('2026-06-03T11:30:00.000Z', NOW_MS)).toBe('<1h');
  });

  it('renders hours under a day', () => {
    expect(humanizeAge('2026-06-03T07:00:00.000Z', NOW_MS)).toBe('5h');
  });

  it('renders days under two weeks', () => {
    expect(humanizeAge('2026-05-31T12:00:00.000Z', NOW_MS)).toBe('3d');
  });

  it('renders weeks at and beyond 14 days', () => {
    expect(humanizeAge('2026-05-20T12:00:00.000Z', NOW_MS)).toBe('2w');
  });

  it('clamps future/zero spans to <1h', () => {
    expect(humanizeAge('2026-06-03T13:00:00.000Z', NOW_MS)).toBe('<1h');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/pending-actions-digest/render.test.ts`
Expected: FAIL — `Failed to resolve import "./render.js"` / `humanizeAge is not exported`.

- [ ] **Step 3: Write minimal implementation**

Create `skills/pending-actions-digest/render.ts`:

```ts
// render.ts — pure formatting for the pending-actions-digest email body.
//
// No I/O and no clock reads: the current time is injected as `nowMs` so every
// function is deterministic and snapshot-testable. The handler supplies
// `Date.now()` at call time (which test suites pin via vi.spyOn).

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/pending-actions-digest/render.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections add skills/pending-actions-digest/render.ts skills/pending-actions-digest/render.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections commit -m "feat: add humanizeAge helper for digest backlog sections"
```

---

## Task 2: `formatDueDate` helper

**Files:**
- Modify: `skills/pending-actions-digest/render.ts`
- Test: `skills/pending-actions-digest/render.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `skills/pending-actions-digest/render.test.ts`:

```ts
import { formatDueDate } from './render.js';

describe('formatDueDate', () => {
  it('renders the local date portion in the given timezone', () => {
    expect(formatDueDate('2026-06-06T13:00:00.000Z', 'UTC')).toBe('2026-06-06');
  });

  it('renders an em-dash placeholder for null', () => {
    expect(formatDueDate(null, 'UTC')).toBe('—');
  });

  it('shifts the date across timezone boundaries', () => {
    // 00:30 UTC on the 7th is still 20:30 on the 6th in Toronto (UTC-4 in June).
    expect(formatDueDate('2026-06-07T00:30:00.000Z', 'America/Toronto')).toBe('2026-06-06');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/pending-actions-digest/render.test.ts`
Expected: FAIL — `formatDueDate is not exported`.

- [ ] **Step 3: Write minimal implementation**

Add to `skills/pending-actions-digest/render.ts` (imports at top, function below `humanizeAge`):

```ts
import { toLocalIso } from '../../src/time/timestamp.js';
```

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/pending-actions-digest/render.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections add skills/pending-actions-digest/render.ts skills/pending-actions-digest/render.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections commit -m "feat: add formatDueDate helper for digest backlog sections"
```

---

## Task 3: `formatTimeRemaining` + `renderDigestBody`

This task moves the approvals-line formatting into `render.ts` (byte-identical) and adds the three backlog sections with `+N more` truncation.

**Files:**
- Modify: `skills/pending-actions-digest/render.ts`
- Test: `skills/pending-actions-digest/render.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `skills/pending-actions-digest/render.test.ts`:

```ts
import { renderDigestBody, type ApprovalInput } from './render.js';
import type { TaskListRow } from '../../src/db/task-repo.js';

// Minimal TaskListRow factory — only the fields renderDigestBody reads matter.
function task(overrides: Partial<TaskListRow>): TaskListRow {
  return {
    id: 'id', agentId: 'a', intentAnchor: 'i', status: 'open',
    progress: {}, errorBudget: {}, conversationId: null,
    createdAt: '2026-06-01T12:00:00.000Z', updatedAt: '2026-06-01T12:00:00.000Z',
    title: 'Untitled', description: null, owner: 'curia',
    waitingOnContactId: null, waitingOnText: null, parentTaskId: null,
    blockedByTaskId: null, priority: 50, dueAt: null, source: 'agent',
    sourceAgentId: null, createdBy: 'system', tags: [], nextWakeAt: null,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalInput>): ApprovalInput {
  return {
    description: 'Create event: Lunch', skillName: 'create-calendar-event',
    shortRef: 'cal-1', expiresAt: new Date(NOW_MS + 7_200_000), ...overrides,
  };
}

describe('renderDigestBody', () => {
  it('renders approvals only, byte-identical to the legacy format, when backlog empty', () => {
    const body = renderDigestBody({
      approvals: [approval({}), approval({ description: 'Send weekly update', skillName: 'send-email', shortRef: 'email-2' })],
      ceo: [], external: [], curia: [],
      resolveName: () => undefined, nowMs: NOW_MS, timezone: 'UTC',
    });
    expect(body).toBe(
      '• Create event: Lunch [create-calendar-event] — 2h remaining [cal-1]\n' +
      '• Send weekly update [send-email] — 2h remaining [email-2]',
    );
  });

  it('renders all three sections after the approvals block', () => {
    const body = renderDigestBody({
      approvals: [approval({})],
      ceo: [task({ owner: 'ceo', title: 'Review the Acme deck', dueAt: '2026-06-06T13:00:00.000Z', createdAt: '2026-05-31T12:00:00.000Z' })],
      external: [task({ owner: 'external', status: 'waiting', title: 'Signed NDA', waitingOnContactId: 'c1', createdAt: '2026-06-02T12:00:00.000Z' })],
      curia: [task({ owner: 'curia', title: 'Draft the board email', createdAt: '2026-06-03T07:00:00.000Z' })],
      resolveName: (id) => (id === 'c1' ? 'Steve Jobs' : undefined),
      nowMs: NOW_MS, timezone: 'UTC',
    });
    expect(body).toBe(
      '• Create event: Lunch [create-calendar-event] — 2h remaining [cal-1]\n' +
      '\n' +
      'For you to do:\n' +
      '• Review the Acme deck · due 2026-06-06 · age 3d\n' +
      '\n' +
      'Waiting on others:\n' +
      '• Signed NDA · waiting on Steve Jobs · since 1d\n' +
      '\n' +
      "What I'm working on:\n" +
      '• Draft the board email · age 5h',
    );
  });

  it('falls back to waiting_on_text then (unknown) for unresolved counterparties', () => {
    const body = renderDigestBody({
      approvals: [],
      ceo: [], curia: [],
      external: [
        task({ owner: 'external', status: 'waiting', title: 'A', waitingOnContactId: 'gone', waitingOnText: 'the lawyer' }),
        task({ owner: 'external', status: 'waiting', title: 'B', waitingOnContactId: null, waitingOnText: null }),
      ],
      resolveName: () => undefined, nowMs: NOW_MS, timezone: 'UTC',
    });
    expect(body).toContain('• A · waiting on the lawyer · since');
    expect(body).toContain('• B · waiting on (unknown) · since');
  });

  it('caps a section at 5 bullets and appends a +N more footer', () => {
    const ceo: TaskListRow[] = Array.from({ length: 9 }, (_, i) =>
      task({ owner: 'ceo', title: `T${i}`, createdAt: '2026-06-03T07:00:00.000Z' }),
    );
    const body = renderDigestBody({
      approvals: [], ceo, external: [], curia: [],
      resolveName: () => undefined, nowMs: NOW_MS, timezone: 'UTC',
    });
    const lines = body.split('\n').filter((l) => l.startsWith('• '));
    expect(lines).toHaveLength(5);
    expect(body).toContain('+4 more');
  });

  it('returns an empty string when there is nothing to render', () => {
    expect(renderDigestBody({
      approvals: [], ceo: [], external: [], curia: [],
      resolveName: () => undefined, nowMs: NOW_MS, timezone: 'UTC',
    })).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/pending-actions-digest/render.test.ts`
Expected: FAIL — `renderDigestBody is not exported`.

- [ ] **Step 3: Write minimal implementation**

Add to `skills/pending-actions-digest/render.ts`:

```ts
import type { TaskListRow } from '../../src/db/task-repo.js';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/pending-actions-digest/render.test.ts`
Expected: PASS (all render tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections add skills/pending-actions-digest/render.ts skills/pending-actions-digest/render.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections commit -m "feat: add renderDigestBody with backlog sections and +N more truncation"
```

---

## Task 4: Wire the handler to fetch backlog and send adaptively

**Files:**
- Modify: `skills/pending-actions-digest/handler.ts`
- Modify: `skills/pending-actions-digest/handler.test.ts`

- [ ] **Step 1: Write the failing tests (backlog path + updated data shape)**

In `skills/pending-actions-digest/handler.test.ts`:

(a) Extend `makeCtx`'s options and context to support a task repo and contact service. Replace the `overrides` destructuring and the `ctx` object with:

```ts
function makeCtx(overrides: {
  pendingRows?: ActionLogRow[];
  sendResult?: boolean;
  ceoEmail?: string;
  noOutboundGateway?: boolean;
  ceoTasks?: unknown[];
  externalTasks?: unknown[];
  curiaTasks?: unknown[];
  listTasksError?: boolean;
  contactName?: string;
  noTaskRepo?: boolean;
} = {}) {
  const {
    pendingRows = [],
    sendResult = true,
    ceoEmail = 'ceo@example.com',
    noOutboundGateway = false,
    ceoTasks = [],
    externalTasks = [],
    curiaTasks = [],
    listTasksError = false,
    contactName = 'Steve Jobs',
    noTaskRepo = false,
  } = overrides;

  process.env['CEO_PRIMARY_EMAIL'] = ceoEmail;

  const findAllPendingMock = vi.fn().mockResolvedValue(pendingRows);
  const sendNotificationMock = vi.fn().mockResolvedValue(sendResult);
  const logWarnMock = vi.fn();
  const logErrorMock = vi.fn();

  // listTasks routes by the `owner` filter so each section gets its own fixture.
  const listTasksMock = vi.fn().mockImplementation(async (filters: { owner?: string }) => {
    if (listTasksError) throw new Error('tasks query failed');
    if (filters.owner === 'ceo') return ceoTasks;
    if (filters.owner === 'external') return externalTasks;
    if (filters.owner === 'curia') return curiaTasks;
    return [];
  });
  const getContactMock = vi.fn().mockResolvedValue({ displayName: contactName });

  const ctx: SkillContext = {
    input: {},
    secret: vi.fn().mockImplementation((name: string) => {
      throw new Error(`secret ${name} not configured`);
    }),
    log: { info: vi.fn(), warn: logWarnMock, error: logErrorMock, debug: vi.fn() } as unknown as SkillContext['log'],
    timezone: 'UTC',
    actionLogRepo: { findAllPending: findAllPendingMock } as unknown as ActionLogRepo,
    outboundGateway: noOutboundGateway
      ? undefined
      : ({ sendNotification: sendNotificationMock } as unknown as OutboundGateway),
    taskRepo: noTaskRepo ? undefined : ({ listTasks: listTasksMock } as unknown as SkillContext['taskRepo']),
    contactService: { getContact: getContactMock } as unknown as SkillContext['contactService'],
  } as SkillContext;

  return { ctx, findAllPendingMock, sendNotificationMock, logWarnMock, logErrorMock, listTasksMock, getContactMock };
}
```

(b) Update the five existing `result.data` assertions to include the new count fields (all zero when no tasks are seeded). Apply these exact replacements:

- "no pending rows" test → `expect(result.data).toEqual({ pending: 0, skipped: true, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });`
- "sends a single digest notification" test → `expect(result.data).toEqual({ pending: 2, skipped: false, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });`
- "CEO_PRIMARY_EMAIL is not set" test → `expect(result.data).toEqual({ pending: 1, skipped: true, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });`
- "outboundGateway is not available" test → `expect(result.data).toEqual({ pending: 1, skipped: true, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });`
- "sendNotification returning false" test → `expect(result.data).toEqual({ pending: 1, skipped: false, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });`

(c) Add a task-row factory and new tests at the end of the `describe` block:

```ts
function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'id', agentId: 'a', intentAnchor: 'i', status: 'open',
    progress: {}, errorBudget: {}, conversationId: null,
    createdAt: new Date(FIXED_NOW - 3_600_000).toISOString(),
    updatedAt: new Date(FIXED_NOW - 3_600_000).toISOString(),
    title: 'A task', description: null, owner: 'curia',
    waitingOnContactId: null, waitingOnText: null, parentTaskId: null,
    blockedByTaskId: null, priority: 50, dueAt: null, source: 'agent',
    sourceAgentId: null, createdBy: 'system', tags: [], nextWakeAt: null,
    ...overrides,
  };
}

it('sends a backlog-only digest with an adaptive subject when there are no approvals', async () => {
  const handler = new PendingActionsDigestHandler();
  const { ctx, sendNotificationMock } = makeCtx({
    pendingRows: [],
    ceoTasks: [makeTask({ owner: 'ceo', title: 'Review the Acme deck' })],
    externalTasks: [makeTask({ owner: 'external', status: 'waiting', title: 'Signed NDA', waitingOnContactId: 'c1' })],
  });

  const result = await handler.execute(ctx);

  expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  const payload = sendNotificationMock.mock.calls[0][0];
  expect(payload.subject).toBe('Your daily brief — 2 item(s) need you');
  expect(payload.body).toContain('For you to do:');
  expect(payload.body).toContain('• Review the Acme deck');
  expect(payload.body).toContain('Waiting on others:');
  expect(payload.body).toContain('• Signed NDA · waiting on Steve Jobs · since');
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('unreachable');
  expect(result.data).toEqual({ pending: 0, skipped: false, tasksForCeo: 1, tasksWaiting: 1, tasksWorking: 0 });
});

it('keeps the approvals subject and appends backlog when approvals are present', async () => {
  const handler = new PendingActionsDigestHandler();
  const { ctx, sendNotificationMock } = makeCtx({
    pendingRows: [makeRow({ id: 1, shortRef: 'cal-1' })],
    curiaTasks: [makeTask({ owner: 'curia', title: 'Draft the board email' })],
  });

  await handler.execute(ctx);

  const payload = sendNotificationMock.mock.calls[0][0];
  expect(payload.subject).toBe('Pending approvals — 1 request(s) awaiting your decision');
  expect(payload.body).toContain('cal-1');
  expect(payload.body).toContain("What I'm working on:");
  expect(payload.body).toContain('• Draft the board email');
});

it('does NOT send when only "what I\'m working on" is non-empty', async () => {
  const handler = new PendingActionsDigestHandler();
  const { ctx, sendNotificationMock } = makeCtx({
    pendingRows: [],
    curiaTasks: [makeTask({ owner: 'curia', title: 'Internal cleanup' })],
  });

  const result = await handler.execute(ctx);

  expect(sendNotificationMock).not.toHaveBeenCalled();
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('unreachable');
  expect(result.data).toEqual({ pending: 0, skipped: true, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 1 });
});

it('degrades to an approvals-only digest when the task query fails', async () => {
  const handler = new PendingActionsDigestHandler();
  const { ctx, sendNotificationMock, logWarnMock } = makeCtx({
    pendingRows: [makeRow({ id: 1, shortRef: 'cal-1' })],
    listTasksError: true,
  });

  const result = await handler.execute(ctx);

  expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  expect(logWarnMock).toHaveBeenCalled();
  const payload = sendNotificationMock.mock.calls[0][0];
  expect(payload.body).toContain('cal-1');
  expect(payload.body).not.toContain('For you to do:');
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('unreachable');
  expect(result.data).toEqual({ pending: 1, skipped: false, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/pending-actions-digest/handler.test.ts`
Expected: FAIL — new tests fail (subject/body/data mismatches) and the updated `toEqual` assertions fail against the current handler's `{ pending, skipped }`-only data.

- [ ] **Step 3: Rewrite the handler**

Replace the entire body of `skills/pending-actions-digest/handler.ts` with:

```ts
// handler.ts — pending-actions-digest skill implementation.
//
// Daily CEO digest. Sends a single email summarizing: (1) outstanding approval
// requests awaiting a decision, and (2) the task backlog grouped by owner —
// "For you to do" (ceo), "Waiting on others" (external), and "What I'm working
// on" (curia). Body formatting lives in render.ts (pure, snapshot-tested).
//
// Send gate: the email goes out when there is at least one approval, or any
// ceo/external backlog item. "What I'm working on" alone never triggers a send.
//
// Non-fatal / graceful modes:
//   - CEO_PRIMARY_EMAIL not configured → skipped: true
//   - outboundGateway absent → skipped: true
//   - taskRepo absent OR listTasks throws → backlog treated as empty (warn),
//     approvals still send
//   - sendNotification() returns false → logged at warn, not propagated
//   - Nothing to show (no approvals, no ceo/external tasks) → skipped: true

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ActionLogRow } from '../../src/autonomy/action-log-types.js';
import type { TaskListRow } from '../../src/db/task-repo.js';
import { renderDigestBody, type ApprovalInput } from './render.js';

// Per-section fetch cap. Sections render the top 5; the extra rows feed an exact
// "+N more" footer (so N is capped at 45). Hitting the cap logs a warn so a
// runaway backlog cannot be silently truncated.
const SECTION_FETCH_LIMIT = 50;

interface Backlog {
  ceo: TaskListRow[];
  external: TaskListRow[];
  curia: TaskListRow[];
}

/**
 * Fetch the three backlog sections. Resilient by design: an absent taskRepo or a
 * failing query degrades to empty sections (with a warn) so the approvals digest
 * still goes out rather than failing wholesale.
 */
async function fetchBacklog(ctx: SkillContext): Promise<Backlog> {
  if (!ctx.taskRepo) return { ceo: [], external: [], curia: [] };
  try {
    const [ceo, external, curia] = await Promise.all([
      ctx.taskRepo.listTasks({ owner: 'ceo', statuses: ['open', 'in_progress'], limit: SECTION_FETCH_LIMIT }),
      ctx.taskRepo.listTasks({ owner: 'external', statuses: ['waiting'], limit: SECTION_FETCH_LIMIT }),
      ctx.taskRepo.listTasks({ owner: 'curia', statuses: ['open', 'in_progress'], limit: SECTION_FETCH_LIMIT }),
    ]);
    for (const [label, list] of [['ceo', ceo], ['external', external], ['curia', curia]] as const) {
      if (list.length >= SECTION_FETCH_LIMIT) {
        ctx.log.warn({ section: label, count: list.length }, 'pending-actions-digest: section hit fetch cap; +N more is a floor');
      }
    }
    return { ceo, external, curia };
  } catch (err) {
    // Non-fatal: log and fall back to empty backlog so approvals still send.
    ctx.log.warn({ err }, 'pending-actions-digest: backlog fetch failed; sending approvals-only digest');
    return { ceo: [], external: [], curia: [] };
  }
}

/** Resolve external tasks' waiting_on_contact_id values to display names. */
async function resolveContactNames(
  ctx: SkillContext,
  external: TaskListRow[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!ctx.contactService) return names;
  const ids = [...new Set(external.map((t) => t.waitingOnContactId).filter((x): x is string => x !== null))];
  for (const id of ids) {
    const contact = await ctx.contactService.getContact(id);
    if (contact) names.set(id, contact.displayName);
  }
  return names;
}

export class PendingActionsDigestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    try {
      if (!ctx.actionLogRepo) {
        return { success: false, error: 'pending-actions-digest requires actionLogRepo capability' };
      }

      // --- Step 1: Load approvals and backlog ---
      const pending: ActionLogRow[] = await ctx.actionLogRepo.findAllPending();
      const backlog = await fetchBacklog(ctx);

      const counts = {
        tasksForCeo: backlog.ceo.length,
        tasksWaiting: backlog.external.length,
        tasksWorking: backlog.curia.length,
      };

      // --- Step 2: Send gate ---
      // Send when there are approvals OR the CEO owes/awaits something. "What I'm
      // working on" (curia) alone is informational and never triggers a send.
      const shouldSend = pending.length > 0 || backlog.ceo.length > 0 || backlog.external.length > 0;
      if (!shouldSend) {
        return { success: true, data: { pending: pending.length, skipped: true, ...counts } };
      }

      // --- Step 3: Delivery preconditions ---
      // Read CEO email from env (not ctx.secret(), which throws on a missing var).
      const ceoEmail = process.env['CEO_PRIMARY_EMAIL'] ?? '';
      if (!ceoEmail) {
        ctx.log.warn({ pendingCount: pending.length }, 'pending-actions-digest: CEO_PRIMARY_EMAIL not configured, skipping digest');
        return { success: true, data: { pending: pending.length, skipped: true, ...counts } };
      }
      if (ctx.outboundGateway === undefined) {
        ctx.log.warn({ pendingCount: pending.length }, 'pending-actions-digest: outboundGateway not available, skipping digest');
        return { success: true, data: { pending: pending.length, skipped: true, ...counts } };
      }

      // --- Step 4: Build the body ---
      const nameMap = await resolveContactNames(ctx, backlog.external);
      const nowMs = Date.now();
      const approvals: ApprovalInput[] = pending.map((r) => ({
        description: r.description,
        skillName: r.skillName,
        shortRef: r.shortRef,
        expiresAt: r.expiresAt,
      }));

      const body = renderDigestBody({
        approvals,
        ceo: backlog.ceo,
        external: backlog.external,
        curia: backlog.curia,
        resolveName: (id) => nameMap.get(id),
        nowMs,
        timezone: ctx.timezone ?? 'UTC',
      });

      // --- Step 5: Adaptive subject ---
      // Approvals present → urgency-forward approvals subject (unchanged).
      // Backlog-only → daily brief framing; N counts the items that need the CEO.
      const needsCeo = backlog.ceo.length + backlog.external.length;
      const subject = pending.length > 0
        ? `Pending approvals — ${pending.length} request(s) awaiting your decision`
        : `Your daily brief — ${needsCeo} item(s) need you`;

      // --- Step 6: Send ---
      const sent = await ctx.outboundGateway.sendNotification({
        notificationType: 'pending_actions_digest',
        ceoEmail,
        subject,
        body,
      });

      if (!sent) {
        ctx.log.warn({ pendingCount: pending.length }, 'pending-actions-digest: sendNotification returned false — CEO digest not delivered');
      }

      return { success: true, data: { pending: pending.length, skipped: false, ...counts } };
    } catch (e) {
      ctx.log.error({ err: e }, 'pending-actions-digest: unexpected error');
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/pending-actions-digest/`
Expected: PASS (all handler + render tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections add skills/pending-actions-digest/handler.ts skills/pending-actions-digest/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections commit -m "feat: surface task backlog in pending-actions-digest (#838)"
```

---

## Task 5: Manifest + CHANGELOG

**Files:**
- Modify: `skills/pending-actions-digest/skill.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the manifest**

In `skills/pending-actions-digest/skill.json`: bump `version` to `"1.1.0"`, add the `taskRepo` capability, and add the three count outputs. The result:

```json
{
  "name": "pending-actions-digest",
  "description": "Send a daily digest of open approval requests and the task backlog awaiting CEO attention.",
  "version": "1.1.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {},
  "outputs": {
    "pending": "number — count of open approval requests included in digest",
    "skipped": "boolean — true if digest was not sent (nothing to show, or CEO_PRIMARY_EMAIL / outboundGateway not configured)",
    "tasksForCeo": "number — open/in_progress tasks owned by the CEO",
    "tasksWaiting": "number — external tasks in 'waiting' status",
    "tasksWorking": "number — open/in_progress tasks owned by Curia"
  },
  "permissions": [],
  "secrets": ["CEO_PRIMARY_EMAIL"],
  "timeout": 30000,
  "capabilities": ["actionLogRepo", "outboundGateway", "taskRepo"]
}
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added` (create the `### Added` subsection if it does not exist), add:

```markdown
- **`pending-actions-digest`** — daily digest now surfaces the task backlog: for-you-to-do, waiting-on-others, and what-I'm-working-on. (#838)
```

- [ ] **Step 3: Verify the manifest parses**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec node -e "JSON.parse(require('fs').readFileSync('skills/pending-actions-digest/skill.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections add skills/pending-actions-digest/skill.json CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections commit -m "chore: bump pending-actions-digest to 1.1.0; changelog for #838"
```

---

## Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections run typecheck`
Expected: no errors. (If `result.rows[0]` / array-access strictness bites in test fixtures, apply `!` per the codebase convention.)

- [ ] **Step 2: Run the skill's full test suite**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/pending-actions-digest/`
Expected: PASS — all render + handler tests green, including the legacy approvals tests (proof the approvals block is unchanged).

- [ ] **Step 3: Run lint (if configured)**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections run lint`
Expected: no errors in the changed files. (No `console.log`; pino/`ctx.log` only.)

- [ ] **Step 4: Confirm no migration-ordering or unrelated breakage**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-digest-backlog-sections exec vitest run skills/ src/skills/`
Expected: PASS — no regressions in neighbouring skill tests.

---

## Self-Review Notes (author checklist — completed)

- **Spec coverage:** §3 data sources → Tasks 3–4; §4 send gate + adaptive subject → Task 4; §5 line formats + `+N more` → Task 3; §6 pure-function refactor → Task 3; §7 manifest/version/changelog → Task 5. AC owner-resolution fallback (`contact → text → (unknown)`) → Task 3 test. AC "approvals block unchanged" → legacy `handler.test.ts` kept green (Task 4 / Task 6 Step 2).
- **Out of scope confirmed:** no change to `digest.yaml`, task skills, scheduler, or coordinator.
- **Type consistency:** `ApprovalInput`, `RenderDigestInput`, `renderDigestBody`, `humanizeAge`, `formatDueDate`, `formatTimeRemaining`, `fetchBacklog`, `resolveContactNames` referenced consistently across tasks; `TaskListRow.createdAt`/`dueAt` treated as ISO strings throughout.
- **Manual / staging verification** (AC item, post-merge, not automatable here): confirm the next day's staging digest email contains populated sections.
```
