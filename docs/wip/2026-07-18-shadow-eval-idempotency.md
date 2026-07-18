# Shadow-eval idempotency + replay coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shadow reconciliation durably idempotent with a DB unique constraint so a marker-write failure can't double-score, and lock in items 2–3's already-shipped self-healing with replay tests (#1432).

**Architecture:** A partial unique index on `autonomy_action_log((payload->>'source_message_id')) WHERE outcome='shadow_evaluated'` becomes the correctness backstop; a new `insertShadowEvaluated()` repo method uses `ON CONFLICT DO NOTHING`; the sent-observe handler swaps to it and treats a conflict as "already recorded." The `reconciled_at` marker + watermark-hold stay as the efficiency guard. Items 2–3 get replay tests only (fix minimally if one surfaces a real gap).

**Tech Stack:** TypeScript (ESM, Node 24), Postgres 16 (node-pg-migrate, plain SQL), Vitest, pino.

## Global Constraints

- ESM only; `.js` extensions on all relative imports; no `any`. (curia CLAUDE.md)
- Parameterized SQL only — never interpolate variables into SQL strings.
- Skills return `{ success: true, data }` / `{ success: false, error }` — never throw.
- Migrations: node-pg-migrate plain SQL, `-- Up Migration` / `-- Down Migration` sections; next free prefix is **074** (073 is highest — verify with `ls src/db/migrations/ | sort | tail -3` before writing).
- Type-check with `pnpm -C <worktree> run typecheck` before every commit touching `.ts`.
- Array element access on `rows[0]`/`mock.calls[0]` is `T | undefined` under strict null — use `!` when guaranteed.
- Commits: conventional (`fix:`/`test:`/`docs:`), signed off (`-s`), no Co-Authored-By, no Claude credit.
- Worktree: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-shadow-idempotency-1432`. Run all `pnpm`/`git` via `-C <worktree>`.
- Integration tests are `DATABASE_URL`-gated (skip locally without it). Throwaway Postgres = container `curia-test-pg` on port **5433** (never prod's 5432).

## File map

- Create: `src/db/migrations/074_shadow_eval_idempotency.sql` — dedup + partial unique index (Up) / drop index (Down).
- Create: `tests/integration/migrate-shadow-eval-idempotency.test.ts` — runs the Up SQL against live PG; asserts dedup + conflict.
- Modify: `src/autonomy/action-log-repo.ts` — extract shared INSERT builder; add `insertShadowEvaluated()`.
- Modify: `src/autonomy/action-log-repo.test.ts` — unit tests for `insertShadowEvaluated` (mock pool).
- Modify: `skills/ceo-inbox-sent-observe/handler.ts` — swap `insert` → `insertShadowEvaluated`; comment update.
- Modify: `skills/ceo-inbox-sent-observe/handler.test.ts` — dedup mock + cross-run replay test.
- Modify: `skills/ceo-inbox-sent-observe/skill.json` — patch version bump.
- Modify: `skills/resolve-learning-digest/handler.test.ts` — replay tests (soft-reject on clear).
- Modify: `skills/task-completion-from-sent/handler.test.ts` — replay tests (digest soft-reject; completeTask throw; clean replay).
- Modify: `CHANGELOG.md` — one `Fixed` bullet.

---

## Task 1: Migration 074 — dedup existing shadow rows, then add the partial unique index

**Files:**
- Create: `src/db/migrations/074_shadow_eval_idempotency.sql`
- Test: `tests/integration/migrate-shadow-eval-idempotency.test.ts`

**Interfaces:**
- Produces: unique index `idx_aal_shadow_source` on `autonomy_action_log ((payload->>'source_message_id')) WHERE outcome = 'shadow_evaluated'`. Consumed by Task 2's `ON CONFLICT` clause.

- [ ] **Step 1: Confirm the next migration number**

Run: `ls src/db/migrations/ | sort | tail -3`
Expected: highest is `073_shadow_evaluated_outcome.sql` → use prefix `074`. (If something else landed, bump to the next free slot and use it everywhere below.)

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/migrate-shadow-eval-idempotency.test.ts`. It runs ONLY the Up half of the migration (split on `-- Down Migration`, so the Down's `DROP INDEX` doesn't undo the Up), against a live PG. Uses a unique `source_message_id` prefix so it only ever touches its own rows, and drops its own index in cleanup. Mirrors the DATABASE_URL gating of `tests/integration/migrate-signal-phone-consolidation.test.ts`.

```typescript
// Integration test — runs migration 074's Up SQL against a live Postgres and asserts the
// shadow-eval dedup + partial-unique-index idempotency guard. Skips without DATABASE_URL.
// Scopes every mutation to a test-only source_message_id prefix and drops its own index, so a
// mispointed DATABASE_URL cannot corrupt real shadow rows or a real production index.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const MIGRATION_SQL_URL = new URL(
  '../../src/db/migrations/074_shadow_eval_idempotency.sql',
  import.meta.url,
);
const INDEX = 'idx_aal_shadow_source';
// Test rows use source_message_id values under this prefix so cleanup never deletes real rows.
const PFX = 'itest-shadow-idem-';

/** Insert a pre-scored shadow row directly (bypassing the repo) with a scoped source id. */
async function insertShadow(pool: pg.Pool, src: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO autonomy_action_log
       (task_id, skill_name, action_risk, outcome, payload, competence_flag, scored_by)
     VALUES ($1, 'shadow-draft-eval', 'none', 'shadow_evaluated', $2::jsonb, 1, 'shadow-reconciler')
     RETURNING id`,
    [`shadow:${src}`, JSON.stringify({ shadow: true, source_message_id: src })],
  );
  return rows[0]!.id;
}

describeIf('migration 074: shadow-eval idempotency', () => {
  let pool: pg.Pool;
  let upSql: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const full = await readFile(MIGRATION_SQL_URL, 'utf8');
    // Run only the Up half — the Down's DROP INDEX would otherwise remove what we assert.
    upSql = full.split('-- Down Migration')[0]!;
  });

  // Clean slate: drop the index and delete only our scoped rows before each case.
  beforeEach(async () => {
    await pool.query(`DROP INDEX IF EXISTS ${INDEX}`);
    await pool.query(`DELETE FROM autonomy_action_log WHERE payload->>'source_message_id' LIKE $1`, [`${PFX}%`]);
  });

  afterAll(async () => {
    await pool.query(`DROP INDEX IF EXISTS ${INDEX}`);
    await pool.query(`DELETE FROM autonomy_action_log WHERE payload->>'source_message_id' LIKE $1`, [`${PFX}%`]);
    await pool.end();
  });

  it('deletes duplicate shadow rows (keeping the lowest id) before creating the index', async () => {
    const src = `${PFX}dup`;
    const id1 = await insertShadow(pool, src);
    const id2 = await insertShadow(pool, src);
    expect(id2).toBeGreaterThan(id1);

    await pool.query(upSql); // dedup + CREATE UNIQUE INDEX; must not abort on the pre-existing dup

    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM autonomy_action_log WHERE payload->>'source_message_id' = $1`,
      [src],
    );
    expect(rows.map((r) => r.id)).toEqual([id1]); // only the lowest-id row survives
  });

  it('rejects a duplicate shadow insert once the index exists', async () => {
    await pool.query(upSql);
    const src = `${PFX}unique`;
    await insertShadow(pool, src);
    await expect(insertShadow(pool, src)).rejects.toThrow(/duplicate key|unique/i);
  });

  it('allows two shadow rows with different source ids', async () => {
    await pool.query(upSql);
    const a = await insertShadow(pool, `${PFX}a`);
    const b = await insertShadow(pool, `${PFX}b`);
    expect(a).not.toBe(b); // no false conflict across distinct source ids
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `DATABASE_URL=postgres://curia:curia@localhost:5433/curia_test pnpm -C <worktree> exec vitest run tests/integration/migrate-shadow-eval-idempotency.test.ts`
Expected: FAIL — the migration file does not exist yet (`ENOENT` on readFile), or all three cases error. (Without DATABASE_URL the suite SKIPS — that is not a pass; set the URL for the throwaway container.)

- [ ] **Step 4: Write the migration**

Create `src/db/migrations/074_shadow_eval_idempotency.sql`:

```sql
-- Up Migration

-- 074_shadow_eval_idempotency.sql
--
-- #1432: durable idempotency for shadow-draft competence reconciliation.
-- sent-observe inserts a pre-scored 'shadow_evaluated' row and THEN marks the shadow doc
-- reconciled_at. If the mark fails after the insert, the watermark is held and the next run
-- re-judges and re-inserts a DUPLICATE row (the marker was the only idempotency record, written
-- after the insert). This adds a DB-level backstop: one 'shadow_evaluated' row per
-- source_message_id, enforced by a partial unique index. The insert path uses ON CONFLICT DO
-- NOTHING (see ActionLogRepo.insertShadowEvaluated), so a re-run is a no-op.
--
-- Prod may already hold duplicates produced by the bug this fixes, so we DEDUP FIRST — otherwise
-- CREATE UNIQUE INDEX would abort on the pre-existing violating rows (the same class of failure
-- as migration 070, which only detonated against prod data).

-- NOTE ON LOCKING (mirrors migrations 044 / 073): node-pg-migrate wraps each SQL file in a single
-- transaction, so CREATE INDEX CONCURRENTLY is unavailable here. Building this partial index takes
-- a brief lock/scan on autonomy_action_log during deploy — acceptable at the current single-tenant
-- table size. If the table grows large enough that this stalls writes, split into a
-- non-transactional migration using CREATE INDEX CONCURRENTLY.

-- Remove all but the lowest-id row per source_message_id among existing shadow rows.
DELETE FROM autonomy_action_log a
USING autonomy_action_log b
WHERE a.outcome = 'shadow_evaluated'
  AND b.outcome = 'shadow_evaluated'
  AND a.payload->>'source_message_id' = b.payload->>'source_message_id'
  AND a.payload->>'source_message_id' IS NOT NULL
  AND a.id > b.id;

-- One shadow_evaluated row per source_message_id. `payload->>'source_message_id'` is immutable, so
-- it is legal in an index expression; the partial predicate scopes the constraint to shadow rows
-- only, so no other outcome/caller can ever collide with it. NULL source ids are naturally distinct
-- in a unique index and are not constrained (there should be none — the writer always sets it).
CREATE UNIQUE INDEX idx_aal_shadow_source
  ON autonomy_action_log ((payload->>'source_message_id'))
  WHERE outcome = 'shadow_evaluated';

-- Down Migration

-- Symmetric, non-aborting: just drop the index. The dedup DELETE above is deliberately NOT
-- reversed — the rows it removed were erroneous duplicates with no meaning to restore.
DROP INDEX IF EXISTS idx_aal_shadow_source;
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `DATABASE_URL=postgres://curia:curia@localhost:5433/curia_test pnpm -C <worktree> exec vitest run tests/integration/migrate-shadow-eval-idempotency.test.ts`
Expected: PASS (3 tests). If the throwaway container isn't running, start it per the `curia-test-pg` reference (port 5433, run migrations), then re-run.

- [ ] **Step 6: Verify migration prefixes are unique**

Run: `ls src/db/migrations/ | sort | tail -3`
Expected: `074_shadow_eval_idempotency.sql` present, no duplicate `074` prefix.

- [ ] **Step 7: Commit**

```bash
git -C <worktree> add src/db/migrations/074_shadow_eval_idempotency.sql tests/integration/migrate-shadow-eval-idempotency.test.ts
git -C <worktree> commit -s -m "fix(autonomy): partial unique index dedups shadow_evaluated rows (#1432)"
```

---

## Task 2: `insertShadowEvaluated()` repo method

**Files:**
- Modify: `src/autonomy/action-log-repo.ts`
- Test: `src/autonomy/action-log-repo.test.ts`

**Interfaces:**
- Consumes: the `idx_aal_shadow_source` partial unique index from Task 1 (as the `ON CONFLICT` inference target).
- Produces: `insertShadowEvaluated(row: ActionLogInsert): Promise<number | null>` on `ActionLogRepo` — returns the new row id, or `null` when a row for that `source_message_id` already exists. Consumed by Task 3.

- [ ] **Step 1: Write the failing unit tests**

Add to `src/autonomy/action-log-repo.test.ts`, inside the top-level `describe('ActionLogRepo', ...)`:

```typescript
describe('insertShadowEvaluated', () => {
  it('inserts with ON CONFLICT DO NOTHING and returns the id', async () => {
    const { pool, queries } = makePool([{ id: 7 }]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const id = await repo.insertShadowEvaluated({
      taskId: 'shadow:src-1',
      skillName: 'shadow-draft-eval',
      actionRisk: 'none',
      outcome: 'shadow_evaluated',
      payload: { shadow: true, source_message_id: 'src-1' },
      competenceFlag: 1,
      scoredBy: 'shadow-reconciler',
    });
    expect(id).toBe(7);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('ON CONFLICT');
    expect(queries[0]!.sql).toContain("payload->>'source_message_id'");
    expect(queries[0]!.sql).toContain('DO NOTHING');
  });

  it('returns null when the insert is a no-op (conflict — row already exists)', async () => {
    // ON CONFLICT DO NOTHING returns zero rows when the row already exists.
    const { pool } = makePool([], 0);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const id = await repo.insertShadowEvaluated({
      taskId: 'shadow:src-1',
      skillName: 'shadow-draft-eval',
      actionRisk: 'none',
      outcome: 'shadow_evaluated',
      payload: { shadow: true, source_message_id: 'src-1' },
      competenceFlag: 1,
      scoredBy: 'shadow-reconciler',
    });
    expect(id).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C <worktree> exec vitest run src/autonomy/action-log-repo.test.ts -t insertShadowEvaluated`
Expected: FAIL — `repo.insertShadowEvaluated is not a function`.

- [ ] **Step 3: Refactor the shared INSERT and add the method**

In `src/autonomy/action-log-repo.ts`, replace the existing `insert()` method (lines ~23-54) with a shared column/values builder plus the two public methods. Keep `insert()`'s external signature (`Promise<number>`) unchanged.

```typescript
  /** Column list + positional VALUES tuple shared by insert() and insertShadowEvaluated().
   *  Kept in one place so the two insert paths cannot drift. */
  private insertColumnsAndParams(row: ActionLogInsert): { columns: string; values: string; params: unknown[] } {
    return {
      columns:
        '(task_id, conversation_id, skill_name, action_risk, outcome, task_summary, ' +
        'payload, expires_at, short_ref, description, parent_action_id, ' +
        'competence_flag, commitment_flag, compatibility, scored_by)',
      values: 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
      params: [
        row.taskId,
        row.conversationId ?? null,
        row.skillName,
        row.actionRisk,
        row.outcome,
        row.taskSummary ?? null,
        row.payload ? JSON.stringify(row.payload) : null,
        row.expiresAt ?? null,
        row.shortRef ?? null,
        row.description ?? null,
        row.parentActionId ?? null,
        row.competenceFlag ?? null,
        // commitment_flag / compatibility are never set at insert time — the Phase 3
        // scoring-pass update populates them later. Pre-scored shadow rows leave them null.
        null,
        null,
        row.scoredBy ?? null,
      ],
    };
  }

  /** Insert a new row and return the generated id. */
  async insert(row: ActionLogInsert): Promise<number> {
    const { columns, values, params } = this.insertColumnsAndParams(row);
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO autonomy_action_log ${columns} ${values} RETURNING id`,
      params,
    );
    this.logger.debug({ id: result.rows[0]!.id, skillName: row.skillName, outcome: row.outcome }, 'action-log-repo: inserted row');
    return result.rows[0]!.id;
  }

  /**
   * Insert a pre-scored shadow-eval row idempotently (#1432). The partial unique index
   * idx_aal_shadow_source (migration 074) enforces one 'shadow_evaluated' row per
   * source_message_id, so ON CONFLICT DO NOTHING makes a re-run a no-op instead of a duplicate.
   * Returns the new id, or `null` when a row for this source_message_id already exists — the
   * caller treats null as "already durably recorded", NOT an error.
   */
  async insertShadowEvaluated(row: ActionLogInsert): Promise<number | null> {
    const { columns, values, params } = this.insertColumnsAndParams(row);
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO autonomy_action_log ${columns} ${values}
       ON CONFLICT ((payload->>'source_message_id')) WHERE outcome = 'shadow_evaluated'
       DO NOTHING
       RETURNING id`,
      params,
    );
    const id = result.rows[0]?.id ?? null;
    this.logger.debug({ id, skillName: row.skillName, deduped: id === null }, 'action-log-repo: shadow insert');
    return id;
  }
```

- [ ] **Step 4: Run the repo tests to verify they pass**

Run: `pnpm -C <worktree> exec vitest run src/autonomy/action-log-repo.test.ts`
Expected: PASS — the new `insertShadowEvaluated` cases plus all pre-existing `insert` cases (the refactor is behavior-preserving).

- [ ] **Step 5: Typecheck**

Run: `pnpm -C <worktree> run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C <worktree> add src/autonomy/action-log-repo.ts src/autonomy/action-log-repo.test.ts
git -C <worktree> commit -s -m "fix(autonomy): insertShadowEvaluated does idempotent ON CONFLICT insert (#1432)"
```

---

## Task 3: Wire the handler to the idempotent insert + cross-run replay test

**Files:**
- Modify: `skills/ceo-inbox-sent-observe/handler.ts:494-541`
- Modify: `skills/ceo-inbox-sent-observe/handler.test.ts`
- Modify: `skills/ceo-inbox-sent-observe/skill.json`

**Interfaces:**
- Consumes: `ActionLogRepo.insertShadowEvaluated(row): Promise<number | null>` (Task 2).

- [ ] **Step 1: Add a deduping mock + write the failing replay test**

In `skills/ceo-inbox-sent-observe/handler.test.ts`, first extend the `actionLogRepo` mock (currently at ~line 189) so it models the DB dedup. Replace the `insert`-only mock with both methods sharing the `actionLog` array:

```typescript
    ...(overrides.withActionLogRepo
      ? {
          actionLogRepo: {
            insert: vi.fn(async (row: ActionLogInsert) => {
              actionLog.push(row);
              return actionLog.length;
            }),
            // Mirror the migration-074 partial unique index: one row per source_message_id.
            // Returns null on a duplicate (ON CONFLICT DO NOTHING), just like the real method.
            insertShadowEvaluated: vi.fn(async (row: ActionLogInsert) => {
              const src = (row.payload as { source_message_id?: string } | undefined)?.source_message_id;
              if (src !== undefined && actionLog.some(
                (r) => (r.payload as { source_message_id?: string } | undefined)?.source_message_id === src,
              )) {
                return null; // already recorded — dedup
              }
              actionLog.push(row);
              return actionLog.length;
            }),
          },
        }
      : {}),
```

Then add the replay test (place it after the "holds the watermark when the shadow-judge LLM batch fails (F2)" test). It runs the handler twice on the SAME ctx: run 1's reconciled_at mark is forced to fail (holding the watermark), run 2 re-observes and must NOT create a second row.

```typescript
  it('does not double-insert a shadow row when the reconciled_at mark fails, then re-runs (#1432)', async () => {
    // Run 1: judge succeeds, insert lands, but the reconciled_at mark FAILS → watermark held.
    // Run 2: the same Sent message is re-observed and re-judged, but insertShadowEvaluated dedups
    // on source_message_id, so exactly one shadow row exists across both runs.
    const listResponse = {
      data: [
        {
          id: 'msg-sent-1',
          thread_id: 'thread-1',
          subject: 'Re: Hello',
          from: [{ email: 'ceo@example.com' }],
          to: [{ email: 'alice@example.com' }],
          cc: [],
          snippet: 'Thanks Alice',
          date: 1_720_000_500,
          unread: false,
          folders: ['SENT'],
          attachments: [],
        },
      ],
    };
    const fullResponse = {
      data: { ...listResponse.data[0], body: '<p>Thanks Alice, Tuesday works.</p>', bcc: [], labels: [] },
    };
    mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('/messages/msg-sent-1')) return new Response(JSON.stringify(fullResponse), { status: 200 });
      if (u.includes('/messages?')) return new Response(JSON.stringify(listResponse), { status: 200 });
      throw new Error(`unexpected ${u}`);
    });
    const extract = vi.fn(async () => ({
      ok: true as const,
      text: '[{"source_message_id":"src-1","same_decision":true,"reason":"same"}]',
    }));

    const ctx = buildCtx({
      force: true,
      nowMs: 1_720_100_000_000,
      infraLlm: { extract, classify: vi.fn() },
      withActionLogRepo: true,
      snapshots: [
        {
          path: shadowDraftPath('src-1'),
          type: SHADOW_DOC_TYPE,
          frontmatter: {
            source_message_id: 'src-1',
            thread_id: 'thread-1',
            subject: 'Re: Hello',
            recipients: ['alice@example.com'],
            created_at: '2024-07-03T00:00:00.000Z',
          },
          body: 'Thanks Alice, how about Wednesday?',
        },
      ],
      tasks: [],
    });

    // Force the reconciled_at mark to fail on run 1 only (shadow-doc path), then restore.
    const realUpdate = ctx.workingDocs!.update;
    let failMark = true;
    ctx.workingDocs!.update = vi.fn(async (path: string, params: { frontmatter?: Record<string, unknown>; body?: string; expectedVersion: number }) => {
      if (failMark && path.startsWith(`${SHADOW_SCRATCH_PREFIX}/`)) {
        const cur = ctx.__docs.get(path)!;
        return { ok: false as const, conflict: true as const, document: cur };
      }
      return realUpdate(path, params);
    }) as typeof realUpdate;

    // Run 1 — insert lands, mark fails, watermark held.
    const r1 = await handler.execute(ctx);
    expect(r1.success).toBe(true);
    expect((r1 as { data: { watermark_advanced_to: number | null } }).data.watermark_advanced_to).toBeNull();
    expect(ctx.__actionLog).toHaveLength(1);
    expect(ctx.__docs.get(shadowDraftPath('src-1'))?.frontmatter.reconciled_at).toBeUndefined();

    // Run 2 — mark now succeeds; the re-judged shadow must NOT create a second row.
    failMark = false;
    const r2 = await handler.execute(ctx);
    expect(r2.success).toBe(true);
    expect(ctx.__actionLog).toHaveLength(1); // deduped — no double-score
    expect(ctx.__docs.get(shadowDraftPath('src-1'))?.frontmatter.reconciled_at).toBeTruthy();
    expect((r2 as { data: { watermark_advanced_to: number | null } }).data.watermark_advanced_to).toBe(1_720_000_501);
  });
```

Confirm the imports at the top of the test file include `SHADOW_SCRATCH_PREFIX` (from `../_shared/shadow-draft.js`) and the existing `shadowDraftPath` / `SHADOW_DOC_TYPE` helpers; add `SHADOW_SCRATCH_PREFIX` to the import if it is missing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C <worktree> exec vitest run skills/ceo-inbox-sent-observe/handler.test.ts -t "double-insert"`
Expected: FAIL — the handler still calls `insert` (not `insertShadowEvaluated`), so the mock's dedup never triggers and run 2 pushes a 2nd row → `expect(ctx.__actionLog).toHaveLength(1)` fails with length 2.

- [ ] **Step 3: Swap the handler to the idempotent insert**

In `skills/ceo-inbox-sent-observe/handler.ts`, in the per-pair loop (~lines 494-515), replace the `ctx.actionLogRepo.insert({...})` call with `insertShadowEvaluated`, and update the surrounding comment. The `try/catch` stays — a THROWN error still holds the watermark; a `null` return (dedup) is not an error and falls through to the reconciled_at mark.

Replace:

```typescript
          try {
            await ctx.actionLogRepo.insert({
              taskId: ctx.taskEventId ?? `shadow:${j.sourceMessageId}`,
```

with:

```typescript
          try {
            // Idempotent insert (#1432): the migration-074 partial unique index guarantees one
            // 'shadow_evaluated' row per source_message_id, so a re-run after a failed mark can't
            // double-score. A null return means the row already exists (recorded on a prior run) —
            // that's not an error; we still fall through to mark reconciled_at so the re-run
            // converges. Only a THROW holds the watermark.
            await ctx.actionLogRepo.insertShadowEvaluated({
              taskId: ctx.taskEventId ?? `shadow:${j.sourceMessageId}`,
```

The rest of the `insert({...})` argument object and the `catch` block are unchanged.

Also update the comment block just above the per-pair loop (~lines 490-493) that says "per-pair insert + durable reconciled_at mark" to note the DB constraint is now the durable idempotency record and reconciled_at is the efficiency guard:

```typescript
        // Clean response — per-pair idempotent insert (#1432: migration-074 unique index is the
        // durable dedup) + reconciled_at mark (the efficiency guard that lets the watermark advance
        // and skips re-judging next run). A per-pair insert/mark failure holds the watermark for
        // that pair (it re-judges next run) without discarding the pairs that did land.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C <worktree> exec vitest run skills/ceo-inbox-sent-observe/handler.test.ts`
Expected: PASS — the new replay test plus all pre-existing sent-observe tests (the happy-path shadow test still asserts `__actionLog` length 1 and reconciled_at truthy; behavior is unchanged on the success path).

- [ ] **Step 5: Patch-bump the skill version**

In `skills/ceo-inbox-sent-observe/skill.json`, bump the `version` patch field (e.g. `0.x.Y` → `0.x.(Y+1)`). Read the current value first.

- [ ] **Step 6: Typecheck**

Run: `pnpm -C <worktree> run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C <worktree> add skills/ceo-inbox-sent-observe/handler.ts skills/ceo-inbox-sent-observe/handler.test.ts skills/ceo-inbox-sent-observe/skill.json
git -C <worktree> commit -s -m "fix(sent-observe): idempotent shadow insert so a failed mark can't double-score (#1432)"
```

---

## Task 4: resolve-learning-digest replay tests

**Files:**
- Modify: `skills/resolve-learning-digest/handler.test.ts`

**Interfaces:** none new — this task only adds tests proving AC #2 holds post-#1438.

- [ ] **Step 1: Read the existing test file to find the mock harness and avoid duplicating coverage**

Read `skills/resolve-learning-digest/handler.test.ts` in full. Identify: how `ctx` / `ConfigStore` / `executiveProfileService` / `taskRepo` are mocked, and whether a `writeVoiceProposal`/`writeCompletionDigest` soft-reject (`stored:false`) replay case already exists for each action. Only add the cases below that are missing.

- [ ] **Step 2: Write the failing replay tests**

Add tests covering the mid-saga failure for each action. The mechanism: the config-store `set` returns `{ stored: false }` on the FIRST call (so the clear soft-rejects), then `{ stored: true }` on replay. Assert: (a) the primary mutation still happened, (b) run 1 returns `success:false` (item still actionable), (c) the replay converges (`success:true`, item cleared) and the mutation is not harmfully re-applied. Use the file's existing mock style; illustrative shape:

```typescript
  it('approve_voice: a soft-rejected clear surfaces failure, replay converges without re-corrupting the profile (#1432)', async () => {
    // First clear soft-rejects (stored:false), second succeeds.
    const setResults = [{ stored: false }, { stored: true }];
    const ctx = makeResolveCtx({
      voiceProposal: { status: 'pending', generatedAt: '2026-07-18T00:00:00.000Z', guide: 'Be concise.' },
      setImpl: () => setResults.shift() ?? { stored: true },
    });
    const profileUpdate = ctx.executiveProfileService.update as ReturnType<typeof vi.fn>;

    // Run 1 — profile updated, but the clear soft-rejects → success:false, proposal still pending.
    const r1 = await handler.execute({ ...ctx, input: { action: 'approve_voice' } });
    expect(r1.success).toBe(false);
    expect(profileUpdate).toHaveBeenCalledTimes(1);

    // Run 2 (replay) — clear now lands → success:true; the guide write is identical (content-
    // idempotent), so no harmful double-apply even though update() runs again.
    const r2 = await handler.execute({ ...ctx, input: { action: 'approve_voice' } });
    expect(r2.success).toBe(true);
    expect((r2 as { data: { resolved: boolean } }).data.resolved).toBe(true);
    // The guide written on replay equals the guide written on run 1 — content-idempotent.
    const firstGuide = profileUpdate.mock.calls[0]![0].writingVoice.guide;
    const secondGuide = profileUpdate.mock.calls[1]![0].writingVoice.guide;
    expect(secondGuide).toBe(firstGuide);
  });

  it('confirm_completion: soft-rejected clear surfaces failure, replay does not re-complete an already-done task (#1432)', async () => {
    const setResults = [{ stored: false }, { stored: true }];
    // getTask returns status 'open' on run 1, then 'done' after the first completeTask.
    const ctx = makeResolveCtx({
      digest: { 't1': { kind: 'confirm', taskId: 't1', taskTitle: 'Ship it', note: 'n' } },
      taskStatusSequence: ['open', 'done'],
      setImpl: () => setResults.shift() ?? { stored: true },
    });
    const completeTask = ctx.taskRepo.completeTask as ReturnType<typeof vi.fn>;

    const r1 = await handler.execute({ ...ctx, input: { action: 'confirm_completion', task_id: 't1' } });
    expect(r1.success).toBe(false);
    expect(completeTask).toHaveBeenCalledTimes(1);

    const r2 = await handler.execute({ ...ctx, input: { action: 'confirm_completion', task_id: 't1' } });
    expect(r2.success).toBe(true);
    // Task was already 'done' on replay → the status guard skips completeTask; no double-complete.
    expect(completeTask).toHaveBeenCalledTimes(1);
  });

  it('undo_completion: soft-rejected clear surfaces failure, replay reopens idempotently (#1432)', async () => {
    const setResults = [{ stored: false }, { stored: true }];
    const ctx = makeResolveCtx({
      digest: { 't1': { kind: 'undo', taskId: 't1', taskTitle: 'Ship it', note: 'n' } },
      reopenReturns: { id: 't1' }, // non-null → reopen succeeded
      setImpl: () => setResults.shift() ?? { stored: true },
    });
    const r1 = await handler.execute({ ...ctx, input: { action: 'undo_completion', task_id: 't1' } });
    expect(r1.success).toBe(false);
    const r2 = await handler.execute({ ...ctx, input: { action: 'undo_completion', task_id: 't1' } });
    expect(r2.success).toBe(true);
    expect((r2 as { data: { resolved: boolean } }).data.resolved).toBe(true);
  });
```

Adapt `makeResolveCtx` / option names to the file's actual harness (Step 1). If the harness lacks a `setImpl` / `taskStatusSequence` seam, extend it minimally — a per-call queue for `store.set` results and a status sequence for `getTask` — following the existing mock shape rather than rewriting it.

- [ ] **Step 3: Run to verify they fail (or reveal the harness gap)**

Run: `pnpm -C <worktree> exec vitest run skills/resolve-learning-digest/handler.test.ts -t "#1432"`
Expected: FAIL — either an assertion fails (revealing a genuine residual gap to fix minimally in `handler.ts`, then version-bump that skill), or the harness lacks the seam (extend it, then the tests should pass, proving #1438 already closed the gap). Most likely: they pass once the harness supports soft-reject sequencing.

- [ ] **Step 4: Run the full file to confirm no regressions**

Run: `pnpm -C <worktree> exec vitest run skills/resolve-learning-digest/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C <worktree> run typecheck
git -C <worktree> add skills/resolve-learning-digest/handler.test.ts
git -C <worktree> commit -s -m "test(resolve-learning-digest): replay coverage for mid-saga clear failures (#1432)"
```

(If Step 3 surfaced a real gap and you edited `handler.ts` + `skill.json`, add those to the commit.)

---

## Task 5: task-completion-from-sent replay tests

**Files:**
- Modify: `skills/task-completion-from-sent/handler.test.ts`

**Interfaces:** none new — tests proving AC #3 holds post-#1438.

- [ ] **Step 1: Read the existing test file**

Read `skills/task-completion-from-sent/handler.test.ts` in full. #1438 already added some coverage (e.g. "assert candidate survives a completeTask failure for retry"). Identify the mock harness (`readCompletionCandidates`/`writeCompletionDigest`/`writeCompletionCandidates`/`completeTask` mocking) and which of the three scenarios below already exist. Only add the missing ones.

- [ ] **Step 2: Write the failing/verification replay tests**

Cover the three partial-failure shapes. Adapt to the file's harness:

```typescript
  it('digest write soft-rejects → nothing completed, nothing consumed, all retry next run (#1432)', async () => {
    const ctx = makeCompletionCtx({
      candidates: { 't1': highConfidenceCandidate('t1') }, // resolves to auto_complete
      task: { id: 't1', owner: 'ceo', status: 'open', title: 'Ship it' },
      writeDigestReturns: false, // soft-reject
    });
    const completeTask = ctx.taskRepo.completeTask as ReturnType<typeof vi.fn>;
    const writeCandidates = getWriteCandidatesSpy(ctx);

    const r = await handler.execute(ctx);
    expect(r.success).toBe(true);
    expect((r as { data: { auto_completed: number } }).data.auto_completed).toBe(0);
    expect(completeTask).not.toHaveBeenCalled();       // no completion without a durable undo note
    expect(writeCandidates).not.toHaveBeenCalled();    // candidate queue untouched → full retry
  });

  it('completeTask throws after the digest write lands → candidate retained, note durable, self-heals (#1432)', async () => {
    const ctx = makeCompletionCtx({
      candidates: { 't1': highConfidenceCandidate('t1') },
      task: { id: 't1', owner: 'ceo', status: 'open', title: 'Ship it' },
      writeDigestReturns: true,
      completeTaskThrows: true,
    });
    const writeDigest = getWriteDigestSpy(ctx);
    const writeCandidates = getWriteCandidatesSpy(ctx);

    const r = await handler.execute(ctx);
    expect(r.success).toBe(true);
    // Undo note was written durably BEFORE the (failed) completion.
    const digestArg = writeDigest.mock.calls.at(-1)![1];
    expect(digestArg['t1']).toMatchObject({ kind: 'undo', taskId: 't1' });
    // Candidate 't1' is retained (not consumed) so it retries next run.
    if (writeCandidates.mock.calls.length > 0) {
      const remaining = writeCandidates.mock.calls.at(-1)![1];
      expect(remaining['t1']).toBeDefined();
    }
  });

  it('clean replay after a successful run consumes candidates and does not re-complete (#1432)', async () => {
    // Run 1 completes t1 and consumes the candidate; run 2 sees an empty candidate map.
    const state = mutableCandidateState({ 't1': highConfidenceCandidate('t1') });
    const ctx = makeCompletionCtx({
      candidateState: state, // read/write against a shared, mutating map
      task: { id: 't1', owner: 'ceo', status: 'open', title: 'Ship it' },
      writeDigestReturns: true,
    });
    const completeTask = ctx.taskRepo.completeTask as ReturnType<typeof vi.fn>;

    const r1 = await handler.execute(ctx);
    expect((r1 as { data: { auto_completed: number } }).data.auto_completed).toBe(1);
    expect(completeTask).toHaveBeenCalledTimes(1);

    const r2 = await handler.execute(ctx); // candidate map now empty
    expect((r2 as { data: { auto_completed: number } }).data.auto_completed).toBe(0);
    expect(completeTask).toHaveBeenCalledTimes(1); // no re-completion
  });
```

`highConfidenceCandidate(taskId)` returns a `CompletionCandidate` whose risk classification yields `auto_complete` (high confidence, no subtasks, low-risk title) — reuse the file's existing fixture if one exists; otherwise build one matching the `CompletionCandidate` shape in `skills/_shared/learning-state.ts`. Adapt `makeCompletionCtx` / helper names to the file's real harness; extend the harness minimally (a `writeDigestReturns` boolean, a `completeTaskThrows` flag, and a shared mutable candidate map) only if the seams don't already exist.

- [ ] **Step 3: Run to verify behavior**

Run: `pnpm -C <worktree> exec vitest run skills/task-completion-from-sent/handler.test.ts -t "#1432"`
Expected: PASS (proving #1438's digest-first ordering satisfies AC #3), or a genuine failure to fix minimally in `handler.ts` (+ version bump) if one surfaces.

- [ ] **Step 4: Run the full file + typecheck**

Run: `pnpm -C <worktree> exec vitest run skills/task-completion-from-sent/handler.test.ts`
Then: `pnpm -C <worktree> run typecheck`
Expected: PASS / no errors.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add skills/task-completion-from-sent/handler.test.ts
git -C <worktree> commit -s -m "test(task-completion-from-sent): replay coverage for partial-write scenarios (#1432)"
```

---

## Task 6: CHANGELOG + full verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Fixed` (create the section if absent), add ONE bullet (≤15 words after the em-dash — but no em-dash in body per house style; use a period):

```markdown
- **`sent-observe`** — shadow reconciliation now dedups on a DB unique index, so a failed marker write can't double-score. (#1432)
```

- [ ] **Step 2: Run the full affected test set**

Run: `pnpm -C <worktree> exec vitest run skills/ceo-inbox-sent-observe skills/resolve-learning-digest skills/task-completion-from-sent src/autonomy/action-log-repo.test.ts`
Expected: all PASS.

- [ ] **Step 3: Run the migration integration test (throwaway DB)**

Run: `DATABASE_URL=postgres://curia:curia@localhost:5433/curia_test pnpm -C <worktree> exec vitest run tests/integration/migrate-shadow-eval-idempotency.test.ts`
Expected: PASS (3). Start `curia-test-pg` first if needed.

- [ ] **Step 4: Full typecheck + verify migration ordering**

Run: `pnpm -C <worktree> run typecheck`
Run: `ls src/db/migrations/ | sort | tail -3`
Expected: no type errors; `074_` prefix unique.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add CHANGELOG.md
git -C <worktree> commit -s -m "docs(changelog): shadow-eval idempotency fix (#1432)"
```

---

## Self-review notes

- **Spec coverage:** AC#1 → Task 1 (integration) + Task 3 (handler replay). AC#2 → Task 4. AC#3 → Task 5. AC#4 (symmetric down) → Task 1 Step 4 Down section + comment. AC#5 (unit/integration tests per scenario) → Tasks 1,3,4,5.
- **Type consistency:** `insertShadowEvaluated(row: ActionLogInsert): Promise<number | null>` is used identically in Tasks 2 and 3; the mock in Task 3 matches the same signature. `ActionLogInsert` fields used (`payload.source_message_id`, `competenceFlag`, `scoredBy`, `outcome: 'shadow_evaluated'`) match `action-log-types.ts` and the existing insert call.
- **Verification is real:** DB-level idempotency is proven against live Postgres (mocks can't validate SQL); handler-level and repo-level via unit tests. This is deliberate — raw SQL only fails in CI/real-DB.
