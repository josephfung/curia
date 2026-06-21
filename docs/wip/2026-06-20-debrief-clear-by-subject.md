# Reliable Multi-Meeting Debrief Clear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the coordinator release *all* active `outbound_context` entries for one or more named debrief meetings at once, and confirm strictly from what was actually released.

**Architecture:** The meeting-debrief agent stamps a structured `{subject, eventId}` key onto every debrief outbound-context row. A new conversation-agnostic `clearBySubjects()` store method releases every active row matching a subject (exact, case-insensitive) — scanning the whole active table, not just the injected window. A new coordinator-only `context-bridge-clear` skill exposes it and returns the actual released set; the coordinator prompt is updated to report from that result and surface any unmatched names.

**Tech Stack:** TypeScript (ESM, Node 24+), PostgreSQL 16 (JSONB), Vitest, pino. Agent/skill config in YAML/JSON.

Design spec: `docs/wip/2026-06-20-debrief-clear-by-subject-design.md`. Issue: [#975](https://github.com/josephfung/curia/issues/975).

## Global Constraints

- **Worktree:** all work happens in `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-debrief-clear-975` on branch `fix/debrief-clear-975`. All commands below run from this directory.
- **ESM only:** `.js` extensions on all relative imports; named imports, no `require`.
- **No `any`:** proper types/discriminated unions. Array element access from query rows is `T | undefined` under strict null checks — use `!` when guaranteed (e.g. `result.rows[0]!`).
- **Parameterized SQL only** — never interpolate variables into SQL strings.
- **Skills never throw** — return `{ success: true, data }` or `{ success: false, error }`. No empty catch blocks; every catch logs.
- **pino logging only**, no `console.log`.
- **Typecheck before every commit touching `.ts`:** `pnpm run typecheck` (not bare `tsc`).
- **Run a single test file:** `pnpm exec vitest run <path>`.
- **Commits:** conventional style (`fix:` / `feat:` / `test:` / `docs:`); one logical change per commit. **No `Co-Authored-By` trailers and no Claude/AI attribution anywhere.**
- **CHANGELOG:** add an entry under `## [Unreleased]` before the PR (done in Task 4).
- **Versioning:** new pinned skill / new field → minor bump (see Task 4).

---

### Task 1: `clearBySubjects` store method + capability surface

Add a conversation-agnostic bulk clear to the outbound-context service, expose it on the narrow capability interface, and delegate from the scoped wrapper.

**Files:**
- Modify: `src/dispatch/outbound-context.ts`
- Test: `src/dispatch/outbound-context.test.ts`

**Interfaces:**
- Consumes: nothing new (uses existing `this.pool`, `this.logger`).
- Produces:
  - `interface SubjectClearResult { totalReleased: number; perSubject: { subject: string; released: number }[]; unmatched: string[] }`
  - `OutboundContextService.clearBySubjects(subjects: string[]): Promise<SubjectClearResult>`
  - `OutboundContextCapability.clearBySubjects(subjects: string[]): Promise<SubjectClearResult>`
  - `ScopedOutboundContext.clearBySubjects(subjects: string[]): Promise<SubjectClearResult>`

- [ ] **Step 1: Write the failing tests**

Add this block at the end of the top-level `describe('OutboundContextService', ...)` in `src/dispatch/outbound-context.test.ts` (before its closing `});`):

```ts
  describe('clearBySubjects', () => {
    it('releases all active entries matching each subject (case-insensitive) and returns per-subject counts', async () => {
      // Subject "Sean Brownlee" → 4 rows; "Khanjan Desai" → 2 rows.
      (pool.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rowCount: 4, rows: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] })
        .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: '5' }, { id: '6' }] });

      const result = await service.clearBySubjects(['Sean Brownlee', 'khanjan desai']);

      expect(result.totalReleased).toBe(6);
      expect(result.perSubject).toEqual([
        { subject: 'Sean Brownlee', released: 4 },
        { subject: 'khanjan desai', released: 2 },
      ]);
      expect(result.unmatched).toEqual([]);

      // First statement: releases by case-insensitive metadata subject, active rows only.
      const first = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(first[0]).toContain('UPDATE outbound_context');
      expect(first[0]).toContain('released = false');
      expect(first[0]).toContain("expires_at > now()");
      expect(first[0]).toContain("lower(metadata->>'subject') = lower($1)");
      expect(first[0]).toContain('RETURNING id');
      expect(first[1]).toEqual(['Sean Brownlee']);
    });

    it('reports subjects that matched zero active entries as unmatched', async () => {
      (pool.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rowCount: 3, rows: [{ id: '1' }, { id: '2' }, { id: '3' }] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await service.clearBySubjects(['Walk and Ice cream', 'Nonexistent Meeting']);

      expect(result.totalReleased).toBe(3);
      expect(result.perSubject).toEqual([{ subject: 'Walk and Ice cream', released: 3 }]);
      expect(result.unmatched).toEqual(['Nonexistent Meeting']);
    });

    it('trims, drops blank subjects, and de-duplicates case-insensitively before querying', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 1, rows: [{ id: '1' }] });

      const result = await service.clearBySubjects(['  Peter Lenardon  ', '', '   ', 'peter lenardon']);

      // Only one query runs — blanks dropped, the duplicate (case-insensitive) collapsed.
      expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[1]).toEqual(['Peter Lenardon']); // trimmed, first-seen casing preserved
      expect(result.totalReleased).toBe(1);
    });

    it('returns an empty result without querying when given no usable subjects', async () => {
      const result = await service.clearBySubjects(['', '   ']);

      expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
      expect(result).toEqual({ totalReleased: 0, perSubject: [], unmatched: [] });
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/dispatch/outbound-context.test.ts`
Expected: FAIL — `service.clearBySubjects is not a function`.

- [ ] **Step 3: Add the `SubjectClearResult` interface**

In `src/dispatch/outbound-context.ts`, in the `// ── Types ──` section (after the `OutboundContextRow` interface, around line 61), add:

```ts
/** Result of a bulk clear-by-subject operation (see clearBySubjects). */
export interface SubjectClearResult {
  /** Total active entries released across all matched subjects. */
  totalReleased: number;
  /** Per-subject release counts — only subjects that matched ≥1 active entry. */
  perSubject: { subject: string; released: number }[];
  /** Requested subjects that matched zero active entries. */
  unmatched: string[];
}
```

- [ ] **Step 4: Add `clearBySubjects` to the capability interface**

In the `OutboundContextCapability` interface (around line 64-69), add the method after `release`:

```ts
export interface OutboundContextCapability {
  readonly defaultExpiryHours: number;
  readonly explicitExpiryHours: number;
  register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string>;
  release(entryId: string): Promise<void>;
  /** Release every active entry whose metadata subject matches one of `subjects`. */
  clearBySubjects(subjects: string[]): Promise<SubjectClearResult>;
}
```

- [ ] **Step 5: Implement `clearBySubjects` on the service**

In `OutboundContextService`, add this method after `release()` (after line 213, before `cleanupExpired()`):

```ts
  /**
   * Release every active (non-released, non-expired) entry whose metadata
   * `subject` equals one of the given subjects (exact, case-insensitive).
   *
   * Intentionally conversation-agnostic — unlike release(entryId), the subject
   * IS the scope. Debrief prompts and their replies can span Signal and email
   * (different conversation_ids), so scoping by conversation would miss entries.
   * It scans the whole active table, so entries that fell outside the
   * coordinator's bounded [ACTIVE OUTBOUND CONTEXT] injection window are still
   * released — this is the core of the #975 fix.
   *
   * Blank subjects are dropped and duplicates collapsed (case-insensitive). A
   * subject matching no active entry is returned in `unmatched` so callers can
   * report it instead of claiming a clear they cannot substantiate.
   */
  async clearBySubjects(subjects: string[]): Promise<SubjectClearResult> {
    // Normalize: trim, drop blanks, de-dup case-insensitively (preserve first casing).
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const s of subjects) {
      const trimmed = typeof s === 'string' ? s.trim() : '';
      if (trimmed.length === 0) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(trimmed);
    }

    const perSubject: { subject: string; released: number }[] = [];
    const unmatched: string[] = [];
    let totalReleased = 0;

    for (const subject of cleaned) {
      const result = await this.pool.query<{ id: string }>(
        `UPDATE outbound_context
           SET released = true
         WHERE released = false
           AND expires_at > now()
           AND lower(metadata->>'subject') = lower($1)
         RETURNING id`,
        [subject],
      );
      const released = result.rowCount ?? 0;
      if (released > 0) {
        perSubject.push({ subject, released });
        totalReleased += released;
      } else {
        unmatched.push(subject);
      }
    }

    this.logger.debug(
      { totalReleased, matched: perSubject.length, unmatched: unmatched.length },
      'clearBySubjects completed',
    );
    return { totalReleased, perSubject, unmatched };
  }
```

- [ ] **Step 6: Implement `clearBySubjects` on the scoped wrapper**

In `ScopedOutboundContext` (end of class, after `release()` around line 308), add:

```ts
  async clearBySubjects(subjects: string[]): Promise<SubjectClearResult> {
    // Intentionally conversation-agnostic — see OutboundContextService.clearBySubjects.
    // The subject is the scope, not this.conversationId, so we delegate without scoping.
    return this.service.clearBySubjects(subjects);
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/dispatch/outbound-context.test.ts`
Expected: PASS (all clearBySubjects tests plus the pre-existing suite).

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/dispatch/outbound-context.ts src/dispatch/outbound-context.test.ts
git commit -m "feat: add clearBySubjects bulk release to outbound context (#975)"
```

---

### Task 2: `context-bridge-clear` skill

A coordinator-only skill that takes meeting subjects and returns the actual released set.

**Files:**
- Create: `skills/context-bridge-clear/skill.json`
- Create: `skills/context-bridge-clear/handler.ts`
- Test: `skills/context-bridge-clear/handler.test.ts`

**Interfaces:**
- Consumes: `ctx.outboundContext.clearBySubjects(subjects: string[]): Promise<SubjectClearResult>` (Task 1).
- Produces: `ContextBridgeClearHandler` implementing `SkillHandler`; success data shape `{ released: number, cleared: { subject: string; count: number }[], unmatched: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `skills/context-bridge-clear/handler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ContextBridgeClearHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import pino from 'pino';

const handler = new ContextBridgeClearHandler();

function makeCtx(
  input: Record<string, unknown>,
  clearResult: unknown = { totalReleased: 0, perSubject: [], unmatched: [] },
): SkillContext {
  return {
    input,
    secret: vi.fn((name: string) => { throw new Error(`Missing secret: ${name}`); }),
    log: pino({ level: 'silent' }),
    outboundContext: {
      register: vi.fn(),
      release: vi.fn(),
      clearBySubjects: vi.fn().mockResolvedValue(clearResult),
    },
  } as unknown as SkillContext;
}

describe('ContextBridgeClearHandler', () => {
  it('clears by a subjects array and returns the actual released set', async () => {
    const ctx = makeCtx({ subjects: ['Sean Brownlee', 'Khanjan Desai'] }, {
      totalReleased: 6,
      perSubject: [
        { subject: 'Sean Brownlee', released: 4 },
        { subject: 'Khanjan Desai', released: 2 },
      ],
      unmatched: [],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.clearBySubjects).toHaveBeenCalledWith(['Sean Brownlee', 'Khanjan Desai']);
    if (result.success) {
      expect(result.data).toEqual({
        released: 6,
        cleared: [
          { subject: 'Sean Brownlee', count: 4 },
          { subject: 'Khanjan Desai', count: 2 },
        ],
        unmatched: [],
      });
    }
  });

  it('accepts a single subject string', async () => {
    const ctx = makeCtx({ subject: 'Peter Lenardon' }, {
      totalReleased: 2,
      perSubject: [{ subject: 'Peter Lenardon', released: 2 }],
      unmatched: [],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.clearBySubjects).toHaveBeenCalledWith(['Peter Lenardon']);
  });

  it('surfaces unmatched subjects in the result', async () => {
    const ctx = makeCtx({ subjects: ['Walk and Ice cream', 'Ghost Meeting'] }, {
      totalReleased: 3,
      perSubject: [{ subject: 'Walk and Ice cream', released: 3 }],
      unmatched: ['Ghost Meeting'],
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { unmatched: string[] }).unmatched).toEqual(['Ghost Meeting']);
    }
  });

  it('returns an error when no subjects are provided', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/subjects/);
  });

  it('returns an error when all subjects are blank', async () => {
    const ctx = makeCtx({ subjects: ['', '  '] });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('returns an error when outboundContext capability is missing', async () => {
    const ctx = makeCtx({ subjects: ['Sean Brownlee'] });
    (ctx as Record<string, unknown>).outboundContext = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundContext/);
  });

  it('returns an error when clearBySubjects throws', async () => {
    const ctx = makeCtx({ subjects: ['Sean Brownlee'] });
    (ctx.outboundContext!.clearBySubjects as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Failed to clear/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run skills/context-bridge-clear/handler.test.ts`
Expected: FAIL — cannot find module `./handler.js`.

- [ ] **Step 3: Create the handler**

Create `skills/context-bridge-clear/handler.ts`:

```ts
//
// Bulk-release outbound context bridge entries by meeting subject. Given one or
// more subjects (meeting names), releases EVERY active entry whose metadata
// subject matches — not just the ones visible in the turn's [ACTIVE OUTBOUND
// CONTEXT] block — and returns the actual released set so the coordinator can
// confirm exactly what was cleared. Coordinator-only (allowed_callers).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContextBridgeClearHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const input = ctx.input as { subjects?: unknown; subject?: unknown };

    // Accept either `subjects: string[]` or a single `subject: string`.
    const raw: unknown[] = Array.isArray(input.subjects)
      ? input.subjects
      : input.subject != null
        ? [input.subject]
        : [];

    const subjects = raw
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s) => s.length > 0);

    if (subjects.length === 0) {
      return {
        success: false,
        error: 'Missing required input: subjects (non-empty string[]) or subject (string)',
      };
    }

    if (!ctx.outboundContext) {
      return {
        success: false,
        error: 'context-bridge-clear requires outboundContext capability.',
      };
    }

    try {
      const result = await ctx.outboundContext.clearBySubjects(subjects);
      ctx.log.info(
        {
          released: result.totalReleased,
          matched: result.perSubject.length,
          unmatched: result.unmatched.length,
        },
        'Context bridge entries cleared by subject',
      );
      return {
        success: true,
        data: {
          released: result.totalReleased,
          cleared: result.perSubject.map((p) => ({ subject: p.subject, count: p.released })),
          unmatched: result.unmatched,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to clear context bridge entries by subject');
      return { success: false, error: `Failed to clear context bridge entries: ${message}` };
    }
  }
}
```

- [ ] **Step 4: Create the manifest**

Create `skills/context-bridge-clear/skill.json`:

```json
{
  "name": "context-bridge-clear",
  "description": "Release ALL active outbound context bridge entries for one or more named meetings/subjects at once. Use when the CEO asks to clear, dismiss, or 'clear out' named debrief items. Matches every active entry whose meeting subject equals a given name (case-insensitive), regardless of whether its entry_id appeared in the [ACTIVE OUTBOUND CONTEXT] block. Returns the actual released count per subject and any names that matched nothing — confirm to the CEO from this result, not from the names requested. Accepts `subjects` (array) or a single `subject`.",
  "version": "0.1.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "inputs": {
    "subjects": "string[]"
  },
  "outputs": {
    "released": "number",
    "cleared": "object[]",
    "unmatched": "string[]"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000,
  "allowed_callers": ["coordinator"],
  "capabilities": [
    "outboundContext"
  ]
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run skills/context-bridge-clear/handler.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add skills/context-bridge-clear/
git commit -m "feat: add context-bridge-clear skill for bulk debrief clear (#975)"
```

---

### Task 3: Integration test — clear across the injection window

Real-Postgres test proving the headline scenario: several meetings, some entries past a `LIMIT 10` window, clear a subset, assert the exact released set and unmatched reporting.

**Files:**
- Create: `tests/integration/debrief-clear-by-subject.test.ts`

**Interfaces:**
- Consumes: `OutboundContextService` (`register`, `getActive`, `clearBySubjects`) against a real pool.

- [ ] **Step 1: Write the test**

Create `tests/integration/debrief-clear-by-subject.test.ts`:

```ts
// tests/integration/debrief-clear-by-subject.test.ts
//
// Integration test for #975: clearBySubjects releases EVERY active entry for a
// named meeting, including entries that fall outside the bounded getActive()
// injection window — the bug was that only injected entry_ids got released.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('clearBySubjects across the injection window (#975)', () => {
  let pool: pg.Pool;
  let service: OutboundContextService;
  let runId: string;

  // Register N entries for one subject in the same conversation, spaced so the
  // most recent push older ones out of any small getActive() window.
  async function registerForSubject(subject: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await service.register({
        conversationId: `conv-${runId}`,
        channelId: 'signal',
        agentId: 'meeting-debrief',
        content: `Debrief nudge for ${subject} (#${i})`,
        expectedReply: `CEO's takeaways for ${subject}`,
        delegationHint: 'meeting-debrief',
        metadata: { subject, eventId: `evt-${runId}-${subject}-${i}` },
        expiresInHours: 48,
      });
    }
  }

  beforeAll(async () => {
    runId = randomUUID();
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM outbound_context LIMIT 0');
    service = new OutboundContextService(pool, createSilentLogger());

    // 12 active entries total across 3 meetings — more than getActive()'s LIMIT 10.
    await registerForSubject('Sean Brownlee', 4);
    await registerForSubject('Khanjan Desai', 2);
    await registerForSubject('Walk and Ice cream', 3);
    await registerForSubject('Drinks & AI', 3); // intentionally NOT cleared
  });

  afterAll(async () => {
    try {
      await pool.query(`DELETE FROM outbound_context WHERE conversation_id = $1`, [`conv-${runId}`]);
    } finally {
      await pool.end();
    }
  });

  it('releases every matching active entry even though the injection window is bounded', async () => {
    // Sanity: the bounded view cannot see all of this run's entries at once.
    const active = await service.getActive(10);
    const mineActive = active.filter((e) => e.conversationId === `conv-${runId}`);
    expect(mineActive.length).toBeLessThanOrEqual(10); // window is the trap the bug fell into

    const result = await service.clearBySubjects([
      'Sean Brownlee',
      'khanjan desai', // case-insensitive
      'Walk and Ice cream',
      'Nonexistent Meeting', // unmatched
    ]);

    expect(result.totalReleased).toBe(9);
    expect(result.perSubject).toEqual(
      expect.arrayContaining([
        { subject: 'Sean Brownlee', released: 4 },
        { subject: 'khanjan desai', released: 2 },
        { subject: 'Walk and Ice cream', released: 3 },
      ]),
    );
    expect(result.unmatched).toEqual(['Nonexistent Meeting']);

    // Verify directly in the DB: 0 active rows remain for the three cleared subjects,
    // and the un-cleared "Drinks & AI" subject is untouched (3 still active).
    const remaining = await pool.query<{ subject: string; n: string }>(
      `SELECT metadata->>'subject' AS subject, count(*)::text AS n
         FROM outbound_context
        WHERE conversation_id = $1 AND released = false
        GROUP BY metadata->>'subject'`,
      [`conv-${runId}`],
    );
    const bySubject = new Map(remaining.rows.map((r) => [r.subject, Number(r.n)]));
    expect(bySubject.get('Sean Brownlee')).toBeUndefined();
    expect(bySubject.get('Khanjan Desai')).toBeUndefined();
    expect(bySubject.get('Walk and Ice cream')).toBeUndefined();
    expect(bySubject.get('Drinks & AI')).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm exec vitest run tests/integration/debrief-clear-by-subject.test.ts`
Expected: PASS if `DATABASE_URL` points at a reachable Postgres with the schema migrated; otherwise the suite **skips** (`describe.skip`) — that is expected locally without Docker. CI provides the database and runs it for real. If it skips locally, note that in the task summary; do not treat a skip as a pass.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/debrief-clear-by-subject.test.ts
git commit -m "test: integration coverage for clear-by-subject across window (#975)"
```

---

### Task 4: Producer key, coordinator wiring, versions, CHANGELOG

Stamp the subject key on debrief sends, teach the coordinator to use the new skill and report from its result, pin the skill, bump versions, and update the changelog. This task is config/prompt only — verified by typecheck and the app's config loader at startup (no new unit test).

**Files:**
- Modify: `agents/meeting-debrief.yaml`
- Modify: `agents/coordinator.yaml`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the `context-bridge-clear` skill (Task 2).

- [ ] **Step 1: Add the subject key to the debrief Bullpen request format**

In `agents/meeting-debrief.yaml`, in the `### Bullpen request format` block (the `context_bridge` JSON inside the fenced code, ~lines 268-274), add the `metadata` field. Replace:

```
  Use context_bridge with these parameters:
  {
    "agent_id": "meeting-debrief",
    "delegation_hint": "meeting-debrief",
    "expected_reply": "CEO's meeting takeaways and follow-up instructions for [meeting title]",
    "expires_in_hours": <debrief.contextBridgeTtlHours>
  }
```

with:

```
  Use context_bridge with these parameters:
  {
    "agent_id": "meeting-debrief",
    "delegation_hint": "meeting-debrief",
    "expected_reply": "CEO's meeting takeaways and follow-up instructions for [meeting title]",
    "metadata": { "subject": "[meeting title]", "eventId": "<eventId>" },
    "expires_in_hours": <debrief.contextBridgeTtlHours>
  }
```

(Step 7's reminder reuses "the same request format as Step 6", so this single block covers both the prompt and the reminder.)

- [ ] **Step 2: Bump the meeting-debrief version**

In `agents/meeting-debrief.yaml` line 2, change `version: "0.1.0"` to `version: "0.2.0"` (new structured field carried on every debrief send → minor bump).

- [ ] **Step 3: Add the clear rule to the coordinator prompt**

In `agents/coordinator.yaml`, in the `### Active outbound context` section, immediately after the `- **Sweep on close.** ...` bullet (which ends ~line 171), add a new bullet:

```
  - **Clearing named debrief items.** When the CEO asks to clear, dismiss, or
    "clear out" one or more named debrief items/meetings, call
    `context-bridge-clear` with `subjects` set to the exact meeting names they
    listed. This releases **every** active entry for each named meeting, not just
    the ones shown in this turn's [ACTIVE OUTBOUND CONTEXT] block. Report strictly
    from the skill's result: state the released count and the meetings actually
    cleared (`cleared`), and for any name in `unmatched` tell the CEO it was not
    found among active debrief items rather than implying it was cleared. Never
    report a blanket "all cleared" keyed to the names the CEO listed — only to what
    `context-bridge-clear` reports released. Use this instead of firing individual
    `context-bridge-release` calls for a multi-item clear.
```

- [ ] **Step 4: Pin the new skill to the coordinator**

In `agents/coordinator.yaml`, in `pinned_skills`, add `context-bridge-clear` immediately after the `- context-bridge-release` line (~line 585):

```
  - context-bridge-release
  - context-bridge-clear
```

- [ ] **Step 5: Bump the coordinator version**

In `agents/coordinator.yaml` line 2, change `version: "0.8.5"` to `version: "0.9.0"` (new pinned skill + capability → minor bump).

- [ ] **Step 6: Update CHANGELOG**

In `CHANGELOG.md`, under `## [Unreleased]`, add under a `### Fixed` section (create it if absent):

```
- **Debrief clear** — "clear meeting X" now releases *all* active outbound-context entries for each named meeting via the new coordinator-only `context-bridge-clear` skill, and the coordinator confirms from what was actually released (surfacing any names it couldn't match) instead of reporting blanket success. meeting-debrief now stamps a `{subject, eventId}` key on every debrief send. (#975)
```

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck`
Expected: no errors (no `.ts` changed here, but confirms nothing regressed).

- [ ] **Step 8: Run the full unit suite**

Run: `pnpm test`
Expected: PASS (integration tests skip without `DATABASE_URL`). Confirm no regressions in `outbound-context`, `context-bridge`, and skill-loader suites.

- [ ] **Step 9: Commit**

```bash
git add agents/meeting-debrief.yaml agents/coordinator.yaml CHANGELOG.md
git commit -m "feat: wire context-bridge-clear into coordinator + debrief subject key (#975)"
```

---

## Self-Review

**Spec coverage:**
- Producer stamps `{subject, eventId}` → Task 4 Step 1. ✓
- `clearBySubjects` conversation-agnostic, exact ci match, `{totalReleased, perSubject, unmatched}` → Task 1. ✓
- Capability + scoped delegation → Task 1 Steps 4, 6. ✓
- New coordinator-only `context-bridge-clear` skill, grounded result, errors → Task 2. ✓
- Coordinator reports from result + surfaces unmatched; not blanket success → Task 4 Step 3. ✓
- Pin skill + version bumps → Task 4 Steps 2, 4, 5. ✓
- Tests: store (window scenario), skill, integration → Tasks 1, 2, 3. ✓
- CHANGELOG → Task 4 Step 6. ✓
- Acceptance criteria 1-4 all map to tasks. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**Type consistency:** `SubjectClearResult { totalReleased, perSubject: {subject, released}[], unmatched }` defined in Task 1 and consumed identically in Task 2 (mapped to `{released, cleared: {subject, count}[], unmatched}` output). Method name `clearBySubjects` consistent across service, capability, scoped wrapper, skill, and tests. ✓
