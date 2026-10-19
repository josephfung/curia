# Band-driven autonomy, Phase 3 (sampling and feedback): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The principal sees up to three of Curia's recent autonomous actions in each digest, as a numbered list. A reply such as "2 bad, that was a renewal notice" becomes the scorer's strongest signal. Learning-digest commands and emailed approvals also switch to short numbers instead of IDs.

**Architecture:** Four PRs, stacked in this order.

- **PR A (the pool and the scorer):**
  - Autonomous consequential actions start writing `autonomy_action_log` rows. Every send goes through the gateway; other actions go through the execution layer.
  - The rows are marked `scored_by = 'sample-pool'`, so the nightly LLM judge skips them, and they carry no score until the principal gives a verdict.
  - The scorer weights principal verdicts above everything else and stops counting `expired` approvals.
- **PR B (samples in the digest):**
  - A sampler draws up to three weighted samples and stores the number-to-action map in the config store.
  - The `list-spot-checks` tool hands the block to the debrief job. The weekly fallback digest includes it too.
  - A delivered-message binder records which message (and, for email, which thread) carried each set.
- **PR C (verdicts):**
  - `record-spot-check` resolves the numbers against the right set and writes the verdicts.
  - A per-turn trigger tells the coordinator when a principal message looks like a verdict.
  - Spec 14 is updated, and a query is added to the weekly learning checkup.
- **PR D (numbers everywhere else):**
  - Task-completion learning items get stable numbers ("confirm 2").
  - Approvals get an approval number ("approve 3"). This needs a new column; see *Needs approval*.

**Tech Stack:** TypeScript (ESM, Node 24), Vitest, pino, and Postgres through the existing repos. The config store is a KG anchor with one fact per key.

**Spec:** `docs/wip/2026-10-15-band-driven-autonomy-design.md` (the "Phase 3: sampling and feedback" section). Issue #2159.

**Decisions taken with the principal (2026-10-19):**
- **Only the principal's verdicts score sampled rows.** The LLM judge never grades them.
- **The pool:**
  - every send to someone other than the principal, including dispatcher-relayed replies but not system notices;
  - mail triage (archive, label, move);
  - any other tool rated `medium` risk or higher.
- **Numbering for learning items and approvals ships in this phase.**

**Needs approval before PR D starts:**
- Migration `098_approval_number.sql` adds a nullable `approval_number SMALLINT` column, plus a partial index on pending rows, to `autonomy_action_log`.
- The spec does not name a column. A stable, small, reusable number needs a place to live, though. The existing `short_ref` is unique across the whole table's history, so it cannot hold small numbers.

**Out of scope:**
- **Behavior scenarios.** They are still deferred to their own plan, as in Phase 2.
- **Inferring corrections from chat.** The spec excludes this explicitly.
- **The "mail from a known contact" weight for triage.** The triage tools receive only a message ID, so finding the sender needs a lookup. Every triage action is weighted high instead; see *Rulings*.
- **The "financial or personal details shared" weight.** No send-time signal records it. The necessity verdict covers only flagged items.

## Global Constraints

- **Pool rows:**
  - written with `outcome = 'success'`, `scored_by = 'sample-pool'` and all three flags null;
  - `findUnscoredTerminal` and the LLM judge never see them;
  - `countScored` and `findAllScored` exclude them until a verdict is recorded.
- **Verdicts:** a principal verdict sets `competence_flag` (good = 1, bad = 0), `scored_by = 'principal'` and the reason. `commitment_flag` and `compatibility` stay null.
- **Silence records nothing.**
- **Sample block format** (spec, verbatim header). IDs are never shown:
  ```
  Spot check (optional, reply with a number):
  1. <summary>
  ```
- **At most 3 samples per digest.** Weighted random selection without replacement. High weight is 3, low weight is 1, and no weight is ever zero.
- **Reply resolution:**
  - An email reply on the digest's thread resolves against that digest.
  - A reply anywhere else resolves against the most recent delivered digest, and only within 24 hours.
  - Unknown numbers or no matching digest: the tool fails with a message telling the coordinator to ask the principal. It never guesses, and it makes no partial writes.
- **Who can record verdicts:** only a live principal turn. A non-principal message containing "2 good" must not score anything.
- **`expired` approvals carry no signal.** That covers new rows (all-null flags) and old rows (excluded from the computation). The `weakExpiredWeight` setting is removed.
- **Coordinator tool budget** (`tests/unit/agents/prompt-budget.test.ts`, 78,300 bytes):
  - New tools live in the `reports` bundle, not as coordinator pins.
  - A tool.json change on a pinned tool that pushes past the budget raises the budget by the measured delta, with a comment.
- **Wording:** say "principal", never "CEO", in prose, comments, tool descriptions and user-facing text.
- **Code conventions:**
  - no `any`; `.js` extensions on relative imports;
  - no empty `catch {}`: every catch logs;
  - skills return `{ success, data | error }` and never throw;
  - parameterized SQL only.
- **CHANGELOG:**
  - each PR adds its own entries under `## [Unreleased]`, at most 15 words after the em-dash;
  - `src/bus/events.ts` and the `tool.json` schema are public surfaces, so call changes to them out.
- **Versions:** new tools start at `0.1.0`; touched tools get a minor bump for a new input or output field and a patch bump otherwise.
- **Before every commit:** `pnpm -C <wt> run typecheck` and the touched tests. The full `pnpm -C <wt> test` runs before each PR. Commits use `git commit -s`, with no Co-Authored-By line.
- **Fixtures:** made-up names (Dana, Sam, Priya) and `example.com` addresses. The repo is public.

## Review Focus

1. **A non-principal message that reads like a verdict** ("1 good" in a thread with a counterparty). `record-spot-check` refuses it, and the trigger never fires for it. Covered by Tasks C1 and C2.
2. **A late approval reply that reuses a number** ("approve 2" after approval 2 resolved and a new approval was raised). Numbers are not reused for 7 days, and approvals expire within 48 hours, so the old number cannot point at a new action. Covered by Task D3.
3. **A digest job that drops or reformats the block, or never sends.** The set is stored but never bound to a delivered message, so a chat "2 bad" must not resolve against it. Covered by Tasks B4 and C1.
4. **Two digests in one day** (the debrief and the weekly fallback). An email-thread reply resolves to its own set; a chat reply resolves to the most recent one. Covered by Task C1.
5. **Old `expired` rows** (scored before this change with compatibility = 0). They stop pulling the score down once PR A ships, and the minimum-evidence count stops including them. Covered by Task A3.

---

## PR A: The pool and the scorer

Branch `feat/band-sampling-a` from `main`.

### Task A1: Pool policy and repo methods

**Files:**
- Create: `src/autonomy/sample-pool.ts`
- Modify: `src/autonomy/action-log-repo.ts`, `src/autonomy/action-log-types.ts`, `src/autonomy/autonomy-service.ts:294-298`
- Test: `tests/unit/autonomy/sample-pool.test.ts`, `tests/unit/autonomy/action-log-repo.test.ts`, `tests/integration/action-log-sample-pool.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/autonomy/sample-pool.ts
  export const SAMPLE_POOL_SCORED_BY = 'sample-pool';
  export const PRINCIPAL_SCORED_BY = 'principal';
  export const TRIAGE_SKILLS: ReadonlySet<string>;
  export interface SampleSignals {
    speaksAsPrincipal?: boolean;   // band review said the send speaks for the principal
    firstContact?: boolean;        // no contact existed for the recipient at send time
    review?: 'bounced' | 'trimmed' | 'unreviewed';
    gateProceeded?: boolean;       // band Gate C let it through where tier would have asked
    triage?: boolean;
  }
  export interface SampledActionInsert {
    taskId: string; conversationId?: string; toolName: string;
    actionRisk: string; summary: string; signals: SampleSignals;
    input?: Record<string, unknown>;   // kept on the row when its JSON is at most 2000 chars
  }
  export function isSampledTool(toolName: string, actionRisk: string | number): boolean;
  // ActionLogRepo
  insertSampled(row: SampledActionInsert): Promise<number>;
  findSampleCandidates(since: Date, limit: number): Promise<ActionLogRow[]>;
  markSampled(ids: readonly number[], at: Date): Promise<number>;   // pool rows only; returns the count stamped
  recordPrincipalVerdict(id: number, good: boolean, reason: string | null): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing pool-policy test** (`tests/unit/autonomy/sample-pool.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { isSampledTool, TRIAGE_SKILLS } from '../../../src/autonomy/sample-pool.js';

describe('isSampledTool', () => {
  it('leaves sends to the gateway, which records them itself', () => {
    for (const t of ['email-send', 'email-reply', 'send-draft', 'signal-send', 'sms-send', 'slack-send', 'dispatcher-relay']) {
      expect(isSampledTool(t, 'medium')).toBe(false);
    }
  });
  it('samples triage at low risk', () => {
    for (const t of TRIAGE_SKILLS) expect(isSampledTool(t, 'low')).toBe(true);
  });
  it('samples medium risk and up, by label or number', () => {
    expect(isSampledTool('calendar-create-event', 'high')).toBe(true);
    expect(isSampledTool('calendar-respond-to-invite', 'medium')).toBe(true);
    expect(isSampledTool('some-tool', 75)).toBe(true);
  });
  it('skips low and none risk outside triage', () => {
    expect(isSampledTool('contact-update', 'low')).toBe(false);
    expect(isSampledTool('activity-log', 'none')).toBe(false);
    expect(isSampledTool('some-tool', 65)).toBe(false);
  });
  it('skips medium-risk reads', () => {
    expect(isSampledTool('file-parse', 'medium')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it.** `pnpm -C <wt> exec vitest run tests/unit/autonomy/sample-pool.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/autonomy/sample-pool.ts`**

```ts
// sample-pool.ts — which autonomous actions the principal may be asked to spot-check (#2159 Phase 3).
//
// Pool rows are ordinary autonomy_action_log rows with outcome 'success'. They are written
// with scored_by = 'sample-pool' so the nightly LLM judge (findUnscoredTerminal) never grades
// them, and with every flag null so the scorer ignores them until the principal gives a
// verdict. Only the principal's verdict scores a sampled action (decision of 2026-10-19).

import { AutonomyService } from './autonomy-service.js';
import { HUMAN_SEND_SKILLS } from './band-policy.js';

export const SAMPLE_POOL_SCORED_BY = 'sample-pool';
export const PRINCIPAL_SCORED_BY = 'principal';

/** Mail triage: archiving, labelling or moving the principal's mail. Sampled at any risk. */
export const TRIAGE_SKILLS: ReadonlySet<string> = new Set([
  'ceo-inbox-archive', 'ceo-inbox-label', 'ceo-inbox-update-folders', 'email-archive', 'email-label',
]);

// Medium-risk tools with no effect outside Curia: reading a file is not an action to check.
const NOT_SAMPLED: ReadonlySet<string> = new Set(['file-parse']);

// The gateway records every send (skill or relay) with the review's signals; the
// execution layer must not record them a second time.
const RECORDED_BY_GATEWAY: ReadonlySet<string> = new Set([...HUMAN_SEND_SKILLS, 'dispatcher-relay']);

export interface SampleSignals {
  speaksAsPrincipal?: boolean;
  firstContact?: boolean;
  review?: 'bounced' | 'trimmed' | 'unreviewed';
  gateProceeded?: boolean;
  triage?: boolean;
}

export interface SampledActionInsert {
  taskId: string;
  conversationId?: string;
  toolName: string;
  actionRisk: string;
  /** What the principal reads in the spot check, e.g. 'Emailed dana@example.com: "Re: Payment schedule"'. */
  summary: string;
  signals: SampleSignals;
  /** The tool's input, kept on the row when its JSON is at most 2000 characters. */
  input?: Record<string, unknown>;
}

/** Whether the execution layer records a successful autonomous call of this tool in the pool. */
export function isSampledTool(toolName: string, actionRisk: string | number): boolean {
  if (RECORDED_BY_GATEWAY.has(toolName) || NOT_SAMPLED.has(toolName)) return false;
  if (TRIAGE_SKILLS.has(toolName)) return true;
  return AutonomyService.minScoreForActionRisk(actionRisk) >= AutonomyService.minScoreForActionRisk('medium');
}
```

  Check `AutonomyService.minScoreForActionRisk`'s signature first. If it takes only the manifest union type, widen the parameter here to that type rather than casting.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Write the failing repo tests** (append to `tests/unit/autonomy/action-log-repo.test.ts`, using its `makePool` helper)

```ts
describe('sample pool (#2159 Phase 3)', () => {
  it('insertSampled writes a success row the LLM judge will skip', async () => {
    const { pool, calls } = makePool([{ id: '42' }]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const id = await repo.insertSampled({
      taskId: 't1', conversationId: 'email:th1', toolName: 'email-send', actionRisk: 'medium',
      summary: 'Emailed dana@example.com: "Re: Payment schedule"', signals: { firstContact: true },
    });
    expect(id).toBe(42);
    const params = calls[0]!.params as unknown[];
    expect(params[4]).toBe('success');                     // outcome
    expect(params[9]).toBe('Emailed dana@example.com: "Re: Payment schedule"'); // description
    expect(params[11]).toBeNull();                         // competence_flag
    expect(params[14]).toBe('sample-pool');                // scored_by
    expect(JSON.parse(params[6] as string)).toEqual({ sample: { signals: { firstContact: true } } });
  });

  it('insertSampled keeps a tool input up to 2000 characters of JSON and drops a longer one', async () => {
    const { pool, calls } = makePool([{ id: '43' }]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const base = { taskId: 't1', toolName: 'ceo-inbox-archive', actionRisk: 'low', summary: 'Archived', signals: {} };
    await repo.insertSampled({ ...base, input: { message_id: 'm-1' } });
    await repo.insertSampled({ ...base, input: { note: 'x'.repeat(2001) } });
    expect(JSON.parse(calls[0]!.params[6] as string)).toEqual({ sample: { signals: {}, input: { message_id: 'm-1' } } });
    expect(JSON.parse(calls[1]!.params[6] as string)).toEqual({ sample: { signals: {} } });
  });

  it('findSampleCandidates reads unsampled pool rows since a date', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const since = new Date('2026-10-12T00:00:00Z');
    await repo.findSampleCandidates(since, 200);
    expect(calls[0]!.sql).toContain("scored_by = 'sample-pool'");
    expect(calls[0]!.sql).toContain("payload->'sample'->>'sampledAt' IS NULL");
    expect(calls[0]!.params).toEqual([since, 200]);
  });

  it('recordPrincipalVerdict sets competence only, and only on pool rows', async () => {
    const { pool, calls } = makePool([{ id: '7' }]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    expect(await repo.recordPrincipalVerdict(7, false, 'that was a renewal notice')).toBe(true);
    expect(calls[0]!.sql).toContain("scored_by IN ('sample-pool', 'principal')");
    expect(calls[0]!.params).toEqual([7, 0, JSON.stringify({ good: false, reason: 'that was a renewal notice' })]);
  });

  it('countScored and findAllScored leave out expired rows', async () => {
    const { pool, calls } = makePool([{ count: '0' }]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    await repo.countScored();
    await repo.findAllScored();
    expect(calls[0]!.sql).toContain("outcome <> 'expired'");
    expect(calls[1]!.sql).toContain("outcome <> 'expired'");
  });

  it('maps ids to numbers', async () => {
    const { pool } = makePool([{ id: '9', task_id: 't', skill_name: 'x', action_risk: 'low', outcome: 'success', created_at: new Date().toISOString() }]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const rows = await repo.findSampleCandidates(new Date(0), 10);
    expect(rows[0]!.id).toBe(9);
  });
});
```

  Adjust `makePool`'s call shape to the helper's actual fields (`calls[n].sql`, `calls[n].params`). The `countScored`/`findAllScored` expectation belongs to Task A3's rule change. It sits here because both edits touch the same SQL; implement it in this task.

- [ ] **Step 6: Run them.** Expected: FAIL, because the methods don't exist and `mapRow` returns the string `'9'`.

- [ ] **Step 7: Implement the repo methods** in `ActionLogRepo`. Import `SAMPLE_POOL_SCORED_BY` and `SampledActionInsert` from `./sample-pool.js`.

```ts
  /** Record an autonomous action in the spot-check pool (#2159 Phase 3). Never LLM-scored. */
  async insertSampled(row: SampledActionInsert): Promise<number> {
    return this.insert({
      taskId: row.taskId,
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      toolName: row.toolName,
      actionRisk: row.actionRisk,
      outcome: 'success',
      description: row.summary,
      payload: { sample: { signals: row.signals, ...sampleInput(row.input) } },
      scoredBy: SAMPLE_POOL_SCORED_BY,
    });
  }

// Module scope, beside mapRow:
const SAMPLE_INPUT_MAX_CHARS = 2000;
function sampleInput(input: Record<string, unknown> | undefined): { input?: Record<string, unknown> } {
  if (!input) return {};
  return JSON.stringify(input).length <= SAMPLE_INPUT_MAX_CHARS ? { input } : {};
}

  /** Pool rows not yet shown in a spot check, newest first. */
  async findSampleCandidates(since: Date, limit: number): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE outcome = 'success'
         AND scored_by = 'sample-pool'
         AND created_at >= $1
         AND payload->'sample'->>'sampledAt' IS NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [since, limit],
    );
    return result.rows.map(mapRow);
  }

  /**
   * Mark pool rows as shown, so the next digest draws different ones. Returns the number
   * stamped and warns when it is short. The pool predicate matches recordPrincipalVerdict's,
   * so a non-pool id is neither counted nor touched.
   */
  async markSampled(ids: readonly number[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{sample,sampledAt}', to_jsonb($2::text), true)
       WHERE id = ANY($1::bigint[])
         AND outcome = 'success'
         AND scored_by IN ('sample-pool', 'principal')`,
      [ids, at.toISOString()],
    );
    const updated = result.rowCount ?? 0;
    if (updated !== ids.length) {
      this.logger.warn({ requested: ids.length, updated, ids }, 'action-log: markSampled stamped fewer rows than requested');
    }
    return updated;
  }

  /**
   * The principal's spot-check verdict (#2159 Phase 3): competence only, scored_by 'principal'.
   * A second verdict on the same row replaces the first. False when the id is not a pool row.
   */
  async recordPrincipalVerdict(id: number, good: boolean, reason: string | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET competence_flag = $2,
           scored_by = 'principal',
           payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{sample,verdict}', $3::jsonb, true)
       WHERE id = $1
         AND outcome = 'success'
         AND scored_by IN ('sample-pool', 'principal')
       RETURNING id`,
      [id, good ? 1 : 0, JSON.stringify({ good, reason })],
    );
    return result.rows.length > 0;
  }
```

  Make three more edits:
  - In `countScored` and `findAllScored`, add `AND outcome <> 'expired'` to the WHERE clause, with a comment: "expired approvals carry no signal (#2159 Phase 3), including rows scored before the rule changed".
  - In `mapRow`, change `id: row.id as number` to `id: Number(row.id)`, and `parentActionId` to `row.parent_action_id == null ? null : Number(row.parent_action_id)`. pg returns int8 as a string, and the spot-check map stores these ids.
  - In `AutonomyService.getScoredActionCount`, change the WHERE to `scored_by IS NOT NULL AND scored_by <> 'sample-pool'`.

  Add a test for that last edit in `tests/unit/autonomy/autonomy-service.test.ts` asserting the SQL contains `scored_by <> 'sample-pool'`.

- [ ] **Step 8: Write the integration test** `tests/integration/action-log-sample-pool.test.ts`. Use the `describeIf`/`requireCuriaTestDatabase` pattern from `tests/integration/audit-log-tool-results.test.ts`, and clean up rows by a `task_id` prefix `test-sample-pool-`. Cover:
  - insertSampled → `findUnscoredTerminal(100)` does not return it;
  - `findSampleCandidates` does;
  - after `markSampled`, it no longer does;
  - after `recordPrincipalVerdict(id, false, 'x')`, `findAllScored()` includes it with `competenceFlag: 0`;
  - `countScored()` grew by 1.

- [ ] **Step 9: Run** the unit tests and `pnpm -C <wt> run typecheck`. Expected: PASS. The integration test runs in CI only (no local Docker).

- [ ] **Step 10: Commit.** `feat(autonomy): spot-check pool rows and principal verdicts in the action log (#2159)`

### Task A2: Writers: the gateway records sends, the execution layer records other actions

**Files:**
- Modify: `src/dispatch/band-send-review.ts`, `src/skills/outbound-gateway.ts`, `src/skills/execution.ts`
- Test: `tests/unit/dispatch/band-send-review.test.ts`, `tests/unit/skills/outbound-gateway.test.ts`, `tests/unit/skills/execution.test.ts` (or the execution test file that covers band Gate C; find it with `grep -ln runBandGateC tests/unit`)

**Interfaces:**
- Consumes: `ActionLogRepo.insertSampled`, `isSampledTool`, `TRIAGE_SKILLS`, `SampleSignals` (Task A1).
- Produces:
  - `BandReviewDecision`'s send variant gains `signals?: { speaksAsPrincipal?: boolean; bounced?: boolean }`.
  - `runBandGateC` returns `{ blocked: ToolResult } | { blocked: null; gateProceeded: boolean }`.

- [ ] **Step 1: Failing test: band review reports its signals on a send.** In `band-send-review.test.ts`, using the file's existing judge fake:
  - (a) A verdict with `speaksAsPrincipal: true` at score 85 returns `{ kind: 'send', signals: { speaksAsPrincipal: true } }`.
  - (b) A draft that bounced once and passes on the recheck returns `signals.bounced === true`.
  - (c) A trimmed send returns `signals.bounced === true` alongside its `claim_trimmed` report.

- [ ] **Step 2: Run it.** Expected: FAIL (`signals` undefined).

- [ ] **Step 3: Implement.**
  - In `BandSendReview.review`, the clean-pass return becomes:
    ```ts
    return { kind: 'send', content: input.content, signals: { ...(verdict.speaksAsPrincipal === true ? { speaksAsPrincipal: true } : {}), ...(prior ? { bounced: true } : {}) } };
    ```
  - The trimmed return adds `signals: { bounced: true, ...(verdict.speaksAsPrincipal === true ? { speaksAsPrincipal: true } : {}) }`.
  - The fail-open return gets no signals (its report says `sent_without_review`).
  - Update the `BandReviewDecision` type, and extend the gateway's `runBandReview` return type with `signals?`, passing `decision.signals` through on send.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Failing gateway tests.** In `outbound-gateway.test.ts`, build a gateway with a fake `actionLogRepo` whose `insertSampled` is a `vi.fn()`.
  1. An `email` send to `dana@example.com` with `taskEventId: 't1'` and no `recipientContactId` match records one row with:
     - `toolName: 'email-send'` (the gateway's `options.exportContext?.toolName ?? \`${channel}-send\``);
     - `signals.firstContact: true`;
     - summary `Emailed dana@example.com: "<subject>"`.
  2. Nothing is recorded for each of these:
     - `isSystemNotification: true`;
     - `humanApproved: true`;
     - `principalDirected: true`;
     - a send whose only recipient is the principal;
     - a queued send (`result.queued`).
  3. Under band, a `claim_trimmed` send records `signals.review: 'trimmed'`; a fail-open send records `'unreviewed'`; a speaks-as-principal send records `speaksAsPrincipal: true`.
  4. When `insertSampled` rejects, `send()` still returns success and logs a warning.

  Also add `sendEmailDraft` cases: a successful autonomous draft send records `toolName: 'send-draft'`, and a `principalDirected` one does not.

- [ ] **Step 6: Run them.** Expected: FAIL.

- [ ] **Step 7: Implement `recordSentAction` in `OutboundGateway`.**

```ts
  /**
   * Put an autonomous send in the spot-check pool (#2159 Phase 3). Not for system notices,
   * principal-approved or principal-directed sends, or the principal alone: those are not
   * Curia acting on its own. Never throws; the send has already gone out.
   */
  private async recordSentAction(args: {
    channel: OutboundSendRequest['channel'];
    toolName: string;
    recipientLabel: string;
    preview: string;
    firstContact: boolean;
    band: { report?: BandReviewReport; signals?: { speaksAsPrincipal?: boolean; bounced?: boolean } } | undefined;
    options: { taskEventId?: string; parentEventId?: string; conversationId?: string | null } | undefined;
  }): Promise<void> {
    if (!this.actionLogRepo) return;
    const { band } = args;
    const review = band?.report?.source === 'claim_trimmed' ? 'trimmed'
      : band?.report?.source === 'sent_without_review' ? 'unreviewed'
        : band?.signals?.bounced ? 'bounced' : undefined;
    try {
      await this.actionLogRepo.insertSampled({
        taskId: args.options?.taskEventId ?? args.options?.parentEventId ?? 'system',
        ...(args.options?.conversationId ? { conversationId: args.options.conversationId } : {}),
        toolName: args.toolName,
        actionRisk: 'medium',
        summary: `${SENT_VERB[args.channel]} ${args.recipientLabel}: "${truncatePreview(args.preview)}"`,
        signals: {
          ...(args.firstContact ? { firstContact: true } : {}),
          ...(band?.signals?.speaksAsPrincipal ? { speaksAsPrincipal: true } : {}),
          ...(review ? { review } : {}),
        },
      });
    } catch (err) {
      this.log.warn({ err, channel: args.channel }, 'outbound-gateway: could not record the send for spot checks — it went out, but will not be sampled');
    }
  }
```

  Module-level helpers:

```ts
const SENT_VERB: Record<OutboundSendRequest['channel'], string> = {
  email: 'Emailed', signal: 'Sent a Signal message to', sms: 'Texted', slack: 'Sent a Slack message to',
};
/** First line, at most 80 characters: enough to recognise the message on a phone. */
function truncatePreview(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
```

  Call it once per channel branch of `send()`, after `publishDelivered`, under the same `result.success && !result.queued` guard. Only call it when this is true:

  ```ts
  const sampled = !options?.isSystemNotification && !options?.humanApproved
    && options?.principalDirected !== true && !principalIsSoleRecipient;
  ```

  Pass these arguments:
  - **preview:** email uses `toSend.subject || toSend.body`; chat uses the sent message.
  - **recipientLabel:** `this.personRecipients(request).join(', ') || recipientId`.
  - **firstContact:** `recipientContactId === undefined`.
  - **band:** `{ report: bandReport, signals: bandSignals }`, where `bandSignals` is captured from `outcome.signals` next to `bandReport`.

  In `sendEmailDraft`, record with `toolName: 'send-draft'` after its `publishDelivered`. Use the same guard, with `principalDirected` and `draftPrincipalSole`.

- [ ] **Step 8: Run them.** Expected: PASS.

- [ ] **Step 9: Failing execution-layer tests.** Use the existing harness that builds an `ExecutionLayer` with a fake registry and handler (copy the setup from the band Gate C tests) and a fake `actionLogRepo.insertSampled`.
  1. A successful `calendar-create-event` (`high`) on an agent turn records one row with:
     - `toolName: 'calendar-create-event'`, `actionRisk: 'high'`;
     - summary from `buildDescription(toolName, input)`;
     - `signals: {}`.
  2. A successful `ceo-inbox-archive` (`low`) records `signals.triage: true`.
  3. Nothing is recorded for:
     - `contact-update` (`low`);
     - a failed handler result;
     - `humanApproved: true`;
     - a live principal turn (`liveTurn: true` with principal originator metadata, the same fixture the principal-directed tests use);
     - `email-send`.
  4. Under band gating at score 85, an `executive-profile-update` from a `known` contact that the tier policy would have escalated records `signals.gateProceeded: true`.
  5. When `insertSampled` rejects, the tool result is still `success: true`.

- [ ] **Step 10: Run them.** Expected: FAIL.

- [ ] **Step 11: Implement in `ExecutionLayer`.**
  - **Change `runBandGateC`'s return type** to `Promise<{ blocked: ToolResult } | { blocked: null; gateProceeded: boolean }>`:
    - each `return this.escalateBandGateC(...)` becomes `return { blocked: await this.escalateBandGateC(...) }`;
    - an audit failure returns `{ blocked: auditFail }`;
    - the end returns `{ blocked: null, gateProceeded }`, where `gateProceeded` is true exactly when `publishGateProceeded` was called.
  - **At the call site in `invoke`**, declare `let gateProceeded = false;` before the gate block, then:
    ```ts
    const gate = await this.runBandGateC({ ... });
    if (gate.blocked) return gate.blocked;
    gateProceeded = gate.gateProceeded;
    ```
  - **Right after** `const result = await Promise.race([handler.execute(ctx), timeoutPromise]);`, add:

```ts
      if (result.success) {
        await this.recordSampledAction(toolName, manifest.action_risk, input, options, gateProceeded, skillLogger);
      }
```

  and the method:

```ts
  /**
   * Put a successful autonomous action in the spot-check pool (#2159 Phase 3). Sends are
   * recorded by the gateway. Not for principal-approved re-executions (they have their own
   * approved row) or live principal turns (the principal asked for it). Never throws.
   */
  private async recordSampledAction(
    toolName: string,
    actionRisk: string | number,
    input: Record<string, unknown>,
    options: InvokeOptions | undefined,
    gateProceeded: boolean,
    skillLogger: Logger,
  ): Promise<void> {
    if (!this.actionLogRepo || !isSampledTool(toolName, actionRisk)) return;
    if (options?.humanApproved || isLivePrincipalTurn(options?.liveTurn, options?.taskMetadata)) return;
    try {
      await this.actionLogRepo.insertSampled({
        taskId: options?.taskEventId ?? options?.parentEventId ?? 'system',
        ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
        toolName,
        actionRisk: String(actionRisk),
        summary: buildDescription(toolName, input),
        signals: {
          ...(TRIAGE_SKILLS.has(toolName) ? { triage: true } : {}),
          ...(gateProceeded ? { gateProceeded: true } : {}),
        },
      });
    } catch (err) {
      skillLogger.warn({ err, toolName }, 'execution: could not record the action for spot checks — it ran, but will not be sampled');
    }
  }
```

  Import `buildDescription` from `../autonomy/approval-trigger.js` (already exported) and `isLivePrincipalTurn` from wherever `isPrincipalDirectedSend` imports it. Check `buildDescription`'s signature and pass what it takes.

- [ ] **Step 12: Run** the touched test files, then the full unit suite and typecheck. Expected: PASS. Under `tier` gating, every existing test passes unchanged apart from the `runBandGateC` return shape.

- [ ] **Step 13: Commit.** `feat(autonomy): autonomous sends and actions enter the spot-check pool (#2159)`

### Task A3: The scorer: principal verdicts weigh most, expired approvals carry no signal

**Files:**
- Modify: `src/autonomy/action-log-types.ts:115`, `src/autonomy/scoring-pass.ts`, `src/config.ts:628,1250-1252`, `src/index.ts:2160`, `config/default.yaml:369`, `schemas/default-config.schema.json:288`
- Test: `tests/unit/autonomy/scoring-pass.test.ts`, `tests/unit/config*.test.ts` (whichever covers `dreaming.autonomy_scoring`)

- [ ] **Step 1: Failing tests** in `scoring-pass.test.ts`. Use `makeRow` and drive `computeCapabilityScore` through `run()`, as the `adjustment formula` block does.
  1. `DETERMINISTIC_SCORES.expired` equals `{ competenceFlag: null, commitmentFlag: null, compatibility: null, scoredBy: 'deterministic' }`.
  2. **Principal verdicts outweigh the judge.** Score these rows, all created today:
     - one `scoredBy: 'principal'` row, `competenceFlag: 0`;
     - two `scoredBy: 'llm-judge'` rows, `competenceFlag: 1`.

     Competence averages (1+1+0×3)/(1+1+3) = 0.4, below 0.5, so the competence dimension contributes 0.45 × 0.4. Assert the computed capability score equals `0.45*0.4 + 0.35*0.5 + 0.20*0.5` within 1e-9.
  3. **An old expired row is ignored.** A row with `outcome: 'expired'`, `commitmentFlag: 1`, `compatibility: 0` and `scoredBy: 'deterministic'` leaves the capability score at the neutral 0.5 when it is the only row.
  4. Delete `weakExpiredWeight` from `defaultConfig`; the file must compile without it.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `DETERMINISTIC_SCORES.expired` becomes all null, with the comment: "An approval that lapsed says nothing about Curia's judgement: the principal may simply not have seen it (#2159 Phase 3)."
  - In `computeCapabilityScore`:
    - start the loop with `if (row.outcome === 'expired') continue;` and the comment "rows scored before #2159 Phase 3 still carry flags";
    - delete the weak-expired block;
    - after the decay line, add `if (row.scoredBy === PRINCIPAL_SCORED_BY) weight *= PRINCIPAL_VERDICT_WEIGHT;`, with `const PRINCIPAL_VERDICT_WEIGHT = 3;` and a comment: "The principal's own verdict on a sampled action is the strongest evidence the scorer gets (spec: principal-scored rows above llm-judge rows)."
  - Remove `weakExpiredWeight` from:
    - `ScoringPassConfig`;
    - `src/index.ts`;
    - the `config.ts` type and validation;
    - `config/default.yaml`;
    - the schema.

    An existing `local.yaml` that still sets it is ignored: the key is no longer read.

- [ ] **Step 4: Run** `pnpm -C <wt> exec vitest run tests/unit/autonomy tests/unit/config*` and typecheck. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(autonomy): principal verdicts weigh most; expired approvals carry no signal (#2159)`

### Task A4: CHANGELOG and PR

- [ ] Add under `## [Unreleased]`:
  - **Added:** `- **Spot-check pool** — autonomous sends and actions are logged for sampling; never graded by the LLM judge. (#2159)`
  - **Changed:** `- **Autonomy scoring** — principal verdicts weigh triple; expired approvals no longer count against the score. (#2159)`
  - **Removed:** `- **\`weakExpiredWeight\`** — scoring setting retired; expired approvals carry no signal now. (#2159)`
- [ ] Run the full suite, the code-reviewer and the silent-failure-hunter, then open the PR against `main` with `Refs #2159`.

---

## PR B: Samples in the digest

Branch `feat/band-sampling-b`, stacked on A.

### Task B1: Weighted selection

**Files:**
- Modify: `src/autonomy/sample-pool.ts`
- Test: `tests/unit/autonomy/sample-pool.test.ts`

**Interfaces:**
- Produces:
  - `export function sampleWeight(signals: SampleSignals): number`, returning 3 or 1;
  - `export function selectSamples<T>(candidates: readonly T[], weightOf: (c: T) => number, cap: number, random: () => number): T[]`.

- [ ] **Step 1: Failing tests**

```ts
describe('sampleWeight', () => {
  it('weighs speaking for the principal, first contact, a judge intervention, a proceeded gate and triage high', () => {
    for (const s of [{ speaksAsPrincipal: true }, { firstContact: true }, { review: 'trimmed' as const }, { review: 'bounced' as const }, { review: 'unreviewed' as const }, { gateProceeded: true }, { triage: true }]) {
      expect(sampleWeight(s)).toBe(3);
    }
  });
  it('weighs routine actions low but never zero', () => {
    expect(sampleWeight({})).toBe(1);
  });
});

describe('selectSamples', () => {
  it('returns at most the cap, without repeats', () => {
    const picked = selectSamples([1, 2, 3, 4, 5], () => 1, 3, () => 0.5);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
  });
  it('returns everything when there are fewer candidates than the cap', () => {
    expect(selectSamples(['a'], () => 1, 3, Math.random)).toEqual(['a']);
  });
  it('favours heavy candidates', () => {
    let heavy = 0;
    let seed = 1;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 2000; i++) {
      if (selectSamples(['light', 'heavy'], (c) => (c === 'heavy' ? 3 : 1), 1, rand)[0] === 'heavy') heavy++;
    }
    expect(heavy / 2000).toBeGreaterThan(0.7);
    expect(heavy / 2000).toBeLessThan(0.8);
  });
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/** High (3): what the spec asks to check most. Low (1): routine logistics. Never zero. */
export function sampleWeight(signals: SampleSignals): number {
  const high = signals.speaksAsPrincipal === true || signals.firstContact === true
    || signals.review !== undefined || signals.gateProceeded === true || signals.triage === true;
  return high ? 3 : 1;
}

/** Weighted random selection without replacement. */
export function selectSamples<T>(candidates: readonly T[], weightOf: (c: T) => number, cap: number, random: () => number): T[] {
  const pool = candidates.map((c) => ({ c, w: Math.max(weightOf(c), Number.MIN_VALUE) }));
  const picked: T[] = [];
  while (picked.length < cap && pool.length > 0) {
    const total = pool.reduce((sum, p) => sum + p.w, 0);
    let r = random() * total;
    let i = 0;
    while (i < pool.length - 1 && r >= pool[i]!.w) { r -= pool[i]!.w; i++; }
    picked.push(pool[i]!.c);
    pool.splice(i, 1);
  }
  return picked;
}
```

- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(autonomy): weighted spot-check selection (#2159)`

### Task B2: The spot-check store

**Files:**
- Create: `src/reports/spot-check-store.ts`
- Test: `tests/unit/reports/spot-check-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SpotCheckItem { n: number; actionLogId: number; summary: string }
  export interface SpotCheckDelivery { channel: string; messageId: string; threadId?: string; at: string }
  export interface SpotCheckSet { id: string; createdAt: string; conversationId: string; items: SpotCheckItem[]; deliveries: SpotCheckDelivery[] }
  export class SpotCheckStore {
    constructor(configStore: Pick<ConfigStore, 'get' | 'set'>, logger: Logger, now?: () => number);
    add(set: SpotCheckSet): Promise<boolean>;                       // false on soft reject
    bindDelivery(conversationId: string, delivery: SpotCheckDelivery): Promise<boolean>;
    findByEmailThread(threadId: string): Promise<SpotCheckSet | null>;
    findLatestDelivered(withinMs: number): Promise<SpotCheckSet | null>;
  }
  export const SPOT_CHECK_NAMESPACE = 'reports';
  export const SPOT_CHECK_KEY = 'spot_checks';
  ```

- [ ] **Step 1: Failing tests.** Use an in-memory fake `{ get, set }` like the one in `tests/unit/reports/report-queue.test.ts`.
  1. `add` then `findLatestDelivered(24h)` returns null: the set is not delivered yet.
  2. After `bindDelivery(set.conversationId, { channel: 'email', messageId: 'm1', threadId: 'th1', at })`:
     - `findByEmailThread('th1')` returns the set;
     - `findLatestDelivered(24h)` returns it.
  3. **Two delivered sets:** `findLatestDelivered` returns the one with the later delivery `at`, and `findByEmailThread` returns each by its own thread.
  4. **Expiry:** a set delivered 25 hours ago is not returned by `findLatestDelivered(24h)`, but is still found by its thread.
  5. **Pruning:** sets created more than 14 days ago are dropped on the next `add`, and at most 30 sets are kept.
  6. **Malformed stored JSON:** reads return null with a warning, and `add` starts a fresh list.
  7. **Soft reject:** `set` returning `{ stored: false }` makes `add` return false.
  8. **Unknown conversation:** `bindDelivery` returns false and does not write.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Storage:** one JSON value `{ sets: SpotCheckSet[] }` under `reports` / `spot_checks`.
    - Read with `get`, then `JSON.parse` inside try/catch (log a warning and treat it as empty).
    - Validate each entry's shape, dropping and logging bad entries, as `skills/_shared/learning-state.ts` does.
    - Write with `set`.
  - **Pruning on every write:**
    - drop sets with `createdAt` older than 14 days;
    - keep the newest 30.

    The comment should say why: the config store has no delete or TTL, and a reply older than the 24-hour window or a two-week-old thread is not worth matching.
  - **`bindDelivery`:**
    - finds the newest set with that `conversationId`, created within the last 2 hours;
    - appends the delivery unless the same `messageId` is already there;
    - writes.
  - **`findLatestDelivered`:** the set whose latest delivery `at` is newest and within the window.

- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(reports): spot-check sets in the config store (#2159)`

### Task B3: The sampler and `list-spot-checks`

**Files:**
- Create: `src/reports/spot-check-sampler.ts`, `skills/reports/tools/list-spot-checks/{tool.json,handler.ts,handler.test.ts}`
- Modify: `skills/reports/SKILL.md` (add the tool; bump to `0.2.0`)
- Test: `tests/unit/reports/spot-check-sampler.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SPOT_CHECK_HEADER = 'Spot check (optional, reply with a number):';
  export class SpotCheckSampler {
    constructor(deps: { actionLogRepo: Pick<ActionLogRepo, 'findSampleCandidates' | 'markSampled'>; store: Pick<SpotCheckStore, 'add'>; logger: Logger; random?: () => number; now?: () => number });
    /** The block to put in a digest, or null when there is nothing to check or the map could not be stored. */
    draw(conversationId: string): Promise<{ block: string; count: number } | null>;
  }
  ```

- [ ] **Step 1: Failing sampler tests.**
  1. With 5 candidates, `random` fixed and a fake store, `draw('scheduler:job1:run1')`:
     - returns a block whose first line is `SPOT_CHECK_HEADER`, followed by `1. <summary>` to `3. <summary>`;
     - stores one set with those 3 `actionLogId`s and `conversationId: 'scheduler:job1:run1'`;
     - calls `markSampled` with those 3 ids.
  2. **No candidates:** returns null, and nothing is stored or marked.
  3. **Store soft-rejects:** returns null and does not mark (the numbers could not be resolved later), with a warning logged.
  4. **`findSampleCandidates` throws:** returns null with an error logged. A digest must still go out without samples.
  5. **A summary with a line break:** rendered on one line.
  6. **The candidate window:** `since` is 7 days before `now`.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement `SpotCheckSampler.draw`.**
  1. Read candidates: `findSampleCandidates(new Date(now - 7d), 200)`.
  2. Select: `selectSamples(rows, (r) => sampleWeight(readSignals(r.payload)), 3, random)`. `readSignals` reads `payload.sample.signals` defensively and returns `{}` on anything malformed.
  3. Number the picks 1..N. Each summary is `row.description ?? row.toolName`, collapsed to one line.
  4. Store the set with `store.add({ id: randomUUID(), createdAt, conversationId, items, deliveries: [] })`.
  5. Only if `add` returned true, mark the rows: `markSampled(ids, now)`.
  6. Return `{ block: [SPOT_CHECK_HEADER, ...items.map((i) => \`${i.n}. ${i.summary}\`)].join('\n'), count }`.

  Wrap the whole method in try/catch and log at error level: the digest goes out without samples rather than failing.

- [ ] **Step 4: Run them.** Expected: PASS.

- [ ] **Step 5: The tool.** `tool.json`:

```json
{
  "name": "list-spot-checks",
  "description": "Up to three of Curia's recent autonomous actions for the principal to spot-check, as a ready-made numbered block. Put the block in the digest exactly as returned. Returns block null when there is nothing to check.",
  "version": "0.1.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {},
  "outputs": {
    "block": "string? (the 'Spot check' block, verbatim)",
    "count": "number"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000,
  "capabilities": ["actionLogRepo", "entityMemory"],
  "allowed_callers": ["coordinator"]
}
```

  The handler:
  - checks `ctx.actionLogRepo`, `ctx.entityMemory` and `ctx.conversationId`, failing with a clear error if any is missing;
  - builds `new SpotCheckSampler({ actionLogRepo: ctx.actionLogRepo, store: new SpotCheckStore(new ConfigStore(ctx.entityMemory, ctx.log), ctx.log), logger: ctx.log })`;
  - returns `{ success: true, data: { block: drawn?.block ?? null, count: drawn?.count ?? 0 } }`.

  Its `handler.test.ts` covers:
  - each missing-capability error;
  - a drawn block passed through;
  - null when there is nothing to draw.

  Add `list-spot-checks` to `skills/reports/SKILL.md` and bump the bundle version.

- [ ] **Step 6: Run** the tests and typecheck. Also run `tests/unit/skills/*manifest*` and `tests/unit/agents/prompt-budget.test.ts`. Expected: PASS; the budget is unchanged, because the tool is not pinned.
- [ ] **Step 7: Commit.** `feat(reports): list-spot-checks draws the digest's spot-check block (#2159)`

### Task B4: The debrief carries the block, and delivery binds it

**Files:**
- Modify: `src/agents/prompts/debrief-recap-instruction.ts`
- Create: `src/reports/spot-check-binder.ts`
- Modify: `src/index.ts` (wiring)
- Test: `tests/unit/agents/prompts/trigger-guidance.test.ts` (marker coverage, unchanged mechanics), `tests/unit/scheduler/scheduler.test.ts`, `tests/unit/reports/spot-check-binder.test.ts`

**Interfaces:**
- Consumes: `SpotCheckStore.bindDelivery` (B2).
- Produces:
  ```ts
  export class SpotCheckBinder {
    constructor(deps: { bus: EventBus; store: Pick<SpotCheckStore, 'bindDelivery'>; gateway: Pick<OutboundGateway, 'getEmailMessage'>; principalIdentities: readonly ChannelIdentity[]; logger: Logger });
    register(): void;
  }
  ```
  Copy the identity type from `ReactionApprovalMapper`'s constructor.

- [ ] **Step 1: Failing binder tests.**
  1. An `outbound.delivered` event for `channel: 'email'` to the principal's address, with `conversationId: 'scheduler:job1:run1'` and `messageId: 'm1'`, and `getEmailMessage('m1')` resolving `{ threadId: 'th1' }`:
     - calls `bindDelivery('scheduler:job1:run1', { channel: 'email', messageId: 'm1', threadId: 'th1', at })`.
  2. A Signal delivery to the principal binds without a `threadId`, and without calling `getEmailMessage`.
  3. **No bind** when the recipient is not the principal, when there is no `conversationId`, or when there is no `messageId`.
  4. When `getEmailMessage` throws, it still binds without a `threadId` and logs a warning. The chat-style 24-hour match still works.
  5. When `bindDelivery` throws, the error is logged and the handler does not throw.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Subscription:** subscribe `'outbound.delivered'` on the `'dispatch'` layer, as `ReactionApprovalMapper.register` does, and use `isPrincipalIdentity(channel, recipientId, principalIdentities)`.
  - **Cost:** it calls `bindDelivery` for every principal-bound delivery that has a conversation. `bindDelivery` itself returns false for conversations without a set. That is one config-store read per principal-bound message.
  - **Header guard:** only bind when `payload.content.includes(SPOT_CHECK_HEADER)`. That also skips the read for every other message. Comment it: "a digest that lost the block cannot be answered by number, so it must not be bound".
  - **Wiring:** in `src/index.ts`, next to the `ReactionApprovalMapper` wiring, construct it with:
    - `new SpotCheckStore(new ConfigStore(entityMemory, logger), logger)`;
    - the outbound gateway;
    - the principal identities.

    Only construct it when those exist.

- [ ] **Step 4: Run them.** Expected: PASS. Add one more case: a delivery without the header is not bound.

- [ ] **Step 5: Update the recap steps.** In `recapLines`, insert a step before "Compose", and renumber:

```ts
    '3. Call `skill-activate` with skill `reports`, then `list-spot-checks`. If it returns a',
    '   block, end the recap with it exactly as given; the principal answers it by number.',
```

  The compose step becomes 4. The delivery step becomes 5, and reads: "Skip sending when activity-log and list-pending-actions both return empty." The skip rule is unchanged; samples come from activity.

  Re-run `trigger-guidance.test.ts` to confirm the marker coverage still holds: each line stays under the wrap width the file uses.

- [ ] **Step 6: Run** `tests/unit/scheduler tests/unit/agents/prompts tests/unit/reports`. Expected: PASS.
- [ ] **Step 7: Commit.** `feat(reports): the debrief ends with the spot-check block, and delivery binds it (#2159)`

### Task B5: The weekly fallback digest carries the block

**Files:**
- Modify: `src/reports/report-fallback-digest.ts`, `src/index.ts`
- Test: `tests/unit/reports/report-fallback-digest.test.ts`

- [ ] **Step 1: Failing tests.**
  1. With a fake `spotChecks: { draw }` returning `{ block, count: 2 }`:
     - the sent body ends with a blank line and the block;
     - `draw` was called with the fallback's conversation id `report-fallback:<ISO time>`;
     - the gateway `send` got `conversationId` set to that id, so the binder can bind it.
  2. When `draw` returns null, the body is unchanged.
  3. With no `spotChecks` dependency wired, the body is unchanged.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Add an optional `spotChecks?: Pick<SpotCheckSampler, 'draw'>` dependency.
  - In `tick()`, before sending: `const conversationId = \`report-fallback:${new Date(now).toISOString()}\``, then call `draw(conversationId)`, append the block to the rendered body, and pass `{ conversationId }` in the send options next to the existing ones.
  - Wire it in `src/index.ts` with the same sampler construction as the tool.

- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(reports): the weekly fallback digest includes spot checks (#2159)`

### Task B6: CHANGELOG and PR

- [ ] Add under **Added**:
  - `- **Spot checks in the digest** — up to three weighted samples of autonomous actions, numbered, never IDs. (#2159)`
  - `- **\`list-spot-checks\`** — returns the digest's spot-check block and remembers which number means which action. (#2159)`
- [ ] Run the full suite and the two reviewers, then open the PR, stacked on A.

---

## PR C: Verdicts

Branch `feat/band-sampling-c`, stacked on B.

### Task C1: `record-spot-check`

**Files:**
- Create: `skills/reports/tools/record-spot-check/{tool.json,handler.ts,handler.test.ts}`, `src/reports/spot-check-verdicts.ts`
- Modify: `skills/reports/SKILL.md` (add the tool; bump to `0.3.0`)
- Test: `tests/unit/reports/spot-check-verdicts.test.ts`

**Interfaces:**
- Consumes: `SpotCheckStore.findByEmailThread` and `findLatestDelivered` (B2); `ActionLogRepo.recordPrincipalVerdict` (A1).
- Produces:
  ```ts
  export interface SpotCheckVerdictInput { n: number; verdict: 'good' | 'bad'; reason?: string }
  export type ResolveSetResult = { ok: true; set: SpotCheckSet } | { ok: false; error: string };
  export function resolveSpotCheckSet(store: Pick<SpotCheckStore, 'findByEmailThread' | 'findLatestDelivered'>, where: { channelId?: string; conversationId?: string }): Promise<ResolveSetResult>;
  export function matchVerdicts(set: SpotCheckSet, verdicts: readonly SpotCheckVerdictInput[]): { ok: true; matched: Array<SpotCheckVerdictInput & { item: SpotCheckItem }> } | { ok: false; error: string };
  ```

- [ ] **Step 1: Failing resolver and matcher tests.**
  1. **`resolveSpotCheckSet` on an email thread.** Called with `{ channelId: 'email', conversationId: 'email:th1' }`, it returns the set bound to thread `th1`, even when a newer set was delivered elsewhere.
  2. **Fallback to the latest delivered set.** An email on an unbound thread, or `{ channelId: 'signal', conversationId: 'signal:+15550100' }`, falls back to the latest delivered set within 24 hours.
  3. **Nothing delivered within 24 hours.** Returns `ok: false`, with an error containing "Ask the principal which action they mean".
  4. **A set stored but never delivered** (the block was dropped) is not resolvable. This is Review Focus 3.
  5. **Every number exists.** `matchVerdicts` on items 1–3 with `[{ n: 2, verdict: 'bad', reason: 'that was a renewal notice' }]` matches item 2.
  6. **An unknown number fails the whole call:** `[{ n: 2, … }, { n: 5, … }]` returns `ok: false`. The error lists the valid numbers (1, 2, 3) with their summaries. Nothing is written.
  7. **The same number twice with different verdicts** returns `ok: false` (ambiguous).

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement** `src/reports/spot-check-verdicts.ts`:
  - **Thread lookup:** for `channelId === 'email'` and `conversationId?.startsWith('email:')`, try `findByEmailThread(conversationId.slice('email:'.length))` first.
  - **Fallback:** `findLatestDelivered(24 * 3_600_000)`.
  - **Error text:** `"No spot check in the last 24 hours matches this reply. Ask the principal which action they mean; do not guess."`

- [ ] **Step 4: Run them.** Expected: PASS.

- [ ] **Step 5: The tool.** `tool.json`:

```json
{
  "name": "record-spot-check",
  "description": "Record the principal's verdicts on a digest's spot check, e.g. '2 bad, that was a renewal notice' or '1 good 3 good'. Pass each number with good or bad and any reason they gave. Only for the principal's own reply. If it reports no matching spot check or an unknown number, ask the principal which action they mean.",
  "version": "0.1.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {
    "verdicts": "array ({ n: number, verdict: 'good' | 'bad', reason?: string }, at least one)"
  },
  "outputs": {
    "recorded": "array ({ n, summary, verdict })"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000,
  "capabilities": ["actionLogRepo", "entityMemory"],
  "allowed_callers": ["coordinator"]
}
```

  The handler, in order:
  1. **Validates input:** the array is non-empty; `n` is a positive integer; `verdict` is `good` or `bad`; `reason` is a string or absent, at most 500 characters and trimmed.
  2. **Requires a live principal turn:** `isLivePrincipalTurn(ctx.liveTurn, ctx.taskMetadata)` must be true, otherwise it fails with `'record-spot-check only records the principal\'s own reply'`. This is Review Focus 1.
  3. **Resolves the set** with `resolveSpotCheckSet(store, { channelId: ctx.channelId, conversationId: ctx.conversationId })`.
  4. **Matches the numbers** with `matchVerdicts`.
  5. **Writes each verdict** with `recordPrincipalVerdict(item.actionLogId, verdict === 'good', reason ?? null)`. If one returns false (the row was deleted or is not a pool row), it logs a warning and leaves that number out of `recorded`.
  6. **Returns** `{ recorded }`.

  Wrap the handler in try/catch, returning `success: false`.

  Handler tests (`handler.test.ts`) cover:
  - a non-principal turn is refused and writes nothing;
  - a happy path writes `recordPrincipalVerdict(id, false, 'that was a renewal notice')`;
  - an unknown number writes nothing;
  - malformed input;
  - a `recordPrincipalVerdict` false result.

- [ ] **Step 6: Run** the tests and typecheck. Expected: PASS.
- [ ] **Step 7: Commit.** `feat(reports): record-spot-check writes the principal's verdicts (#2159)`

### Task C2: The verdict trigger

**Files:**
- Modify: `src/agents/prompts/turn-guidance.ts`, `src/dispatch/turn-guidance-triggers.ts`, `src/dispatch/dispatcher.ts` (near line 1024)
- Test: `tests/unit/dispatch/turn-guidance-triggers.test.ts`, `tests/unit/agents/prompts/trigger-guidance.test.ts`, `tests/unit/dispatch/dispatcher.test.ts`

**Interfaces:**
- Produces:
  - `InboundGuidanceFacts.spotCheckReply: boolean`;
  - `TurnGuidanceKey` gains `'spot-check-reply'`;
  - `export function looksLikeSpotCheckReply(text: string): boolean`, in `turn-guidance-triggers.ts`.

- [ ] **Step 1: Failing tests.**
  1. `looksLikeSpotCheckReply`:
     - **true** for `'2 bad, that was a renewal notice'`, `'1 good 3 good'`, `'3 Good'` and `'#2 bad'`;
     - **false** for `'I have 2 good ideas'`, `'Meet at 2'`, `'good morning'` and `'bad news: 3 of them left'`.

     The rule: the trimmed message is under 400 characters and starts with `/^#?\d{1,2}\s+(good|bad)\b/i`. It covers both spec examples. It doesn't match "I have 2 good ideas", which a looser "number followed by good/bad anywhere" rule would. See ruling 10.
  2. **When it fires:** `inboundTurnGuidance` includes `'spot-check-reply'` when `liveTurn && spotCheckReply`, and never when `liveTurn` is false. This is Review Focus 1.
  3. **Wording:** the guidance text for the key names `skill-activate` with skill `reports`, then `record-spot-check`, and says to ask rather than guess.
  4. **Dispatcher:** for a principal email whose body starts with "2 bad", the published `agent.task`'s `turnGuidance` includes `'spot-check-reply'`. Use the existing dispatcher test harness for live principal turns.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **The guidance block:**

```ts
const SPOT_CHECK_REPLY = [
  'The principal\'s message looks like a spot-check verdict on a digest ("2 bad, that was a',
  'renewal notice"). Call skill-activate with skill `reports`, then record-spot-check with each',
  'number, good or bad, and any reason they gave. If it finds no matching spot check or an',
  'unknown number, ask the principal which action they meant. Never guess.',
];
```

  - **Registration:** register it in `TURN_GUIDANCE` and `TURN_GUIDANCE_ORDER` right after the reply-shaped keys.
  - **Facts:** add `spotCheckReply` to the facts, and the key in `inboundTurnGuidance` when `facts.liveTurn && facts.spotCheckReply`.
  - **Dispatcher:** compute `spotCheckReply: looksLikeSpotCheckReply(<the inbound text the dispatcher already passes to parseEmailMetadata / the task content>)`. For email, use the reply body above the quoted part, if the dispatcher already has it; otherwise use the whole content. The start-of-message rule then still works, because replies put new text first.
  - **Marker coverage:** add the new lines to `TRIGGER_GUIDANCE_MARKER_SOURCES`, or wherever the marker test collects guidance blocks.

- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(dispatch): a spot-check verdict turn points the coordinator at record-spot-check (#2159)`

### Task C3: Docs and the learning checkup

**Files:**
- Modify: `docs/specs/14-autonomy-engine.md`, `CHANGELOG.md`
- Outside the repo: `/Users/josephfung/Projects/office-of-the-ceo/docs/learning-checkup-runbook.md`

- [ ] **Spec 14:** add a "Sampling and feedback" section covering:
  - the pool and who writes it;
  - `sample-pool` and `principal` scoring;
  - the triple weight;
  - the block format and resolution rules;
  - `expired` rows carrying no signal.

  Link ADR-049.
- [ ] **Runbook:** add a section ("§7 Spot-check verdicts") with:
  - a parameterized-style read-only query listing the last 7 days' verdicts:

    ```sql
    SELECT created_at, skill_name, description, payload->'sample'->'verdict' AS verdict
    FROM autonomy_action_log
    WHERE scored_by = 'principal' AND created_at > now() - interval '7 days'
    ORDER BY created_at DESC;
    ```
  - counts by `good` and `bad`;
  - a reading note: "bad" reasons are the evidence for whether the judge needs more structure (spec).
- [ ] **CHANGELOG, under Added:**
  - `- **\`record-spot-check\`** — the principal answers spot checks by number; verdicts feed the autonomy score. (#2159)`
- [ ] **Then:** the full suite, the two reviewers, the PR (stacked on B), and a commit `docs: spec 14 sampling and feedback (#2159)`.

---

## PR D: Numbers for learning items and approvals

Branch `feat/band-sampling-d`, stacked on C. **Do not start Task D2 until the principal has approved the migration.**

### Task D1: Numbered task-completion items

**Files:**
- Modify: `skills/_shared/learning-state.ts`, `skills/_shared/learning-digest.ts`, `skills/learning/tools/task-completion-from-sent/handler.ts`, `skills/learning/tools/resolve-learning-digest/{tool.json,handler.ts}`, `skills/learning/tools/list-learning-digest/{tool.json,handler.ts}`
- Test: `skills/_shared/learning-state.test.ts`, `skills/_shared/learning-digest.test.ts`, the two tools' `handler.test.ts`

**Interfaces:**
- Produces:
  - `CompletionDigestItem.n?: number`;
  - `export function assignDigestNumbers(map: CompletionDigestMap): CompletionDigestMap`, which is pure and keeps existing numbers;
  - `resolve-learning-digest` input `number?: number`.

- [ ] **Step 1: Failing tests.**
  1. **New entries get the lowest free number.** `assignDigestNumbers` on `{a: {n: 1}, b: {}, c: {n: 3}}` gives `b` the number 2. Unnumbered entries are numbered in `createdAt` order, then by key.
  2. **Numbers are stable.** After `a` is resolved and removed, a new entry `d` gets 1, while `c` keeps 3.
  3. **`renderCompletionSection` uses `n`:** `2. <note> Reply \`confirm 2\` or \`dismiss 2\`.` and `\`undo 2\``.
  4. **`resolve-learning-digest` by number:** `{ action: 'confirm_completion', number: 2 }` resolves the entry with `n === 2`. An unknown number fails with the valid numbers listed. `task_id` still works.
  5. **`list-learning-digest`** returns `n` for each item.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `task-completion-from-sent` calls `assignDigestNumbers` before `writeCompletionDigest`. Readers call it too, so legacy entries without `n` render with deterministic numbers until the next write persists them.
  - The tool.json for `resolve-learning-digest`:
    - adds `"number": "number? (the item's number from the notification, e.g. 2)"`;
    - shortens `task_id` to `"string? (alternative to number: full UUID or unique prefix)"`;
    - bumps to `0.4.0`.

    Do the same for `list-learning-digest`, with a minor bump.
- [ ] **Step 4: Run** the tests and `tests/unit/agents/prompt-budget.test.ts`.
  - If the coordinator's tool definitions now exceed the budget, raise `localToolDefinitionBytes` by the measured delta, with a comment naming #2159 Phase 3 numbering.
- [ ] **Step 5: Commit.** `feat(learning): task-completion items are answered by number (#2159)`

### Task D2: Migration `098_approval_number.sql` (needs approval)

**Files:**
- Create: `src/db/migrations/098_approval_number.sql`, `tests/integration/migrate-approval-number.test.ts`

- [ ] **Step 1: The migration**

```sql
-- Up Migration
-- 098_approval_number.sql (#2159 Phase 3)
-- A small number the principal types to answer an approval ("approve 3"), in place of the
-- 8-character short_ref. Allocated at insert as the lowest number no approval used in the last
-- 7 days, under an advisory lock (ActionLogRepo.insert). Approvals expire within 48h, so a late
-- reply cannot reach a newer approval that reused the number. NULL on non-approval rows and on
-- approvals raised before this migration (those keep their short_ref).
ALTER TABLE autonomy_action_log ADD COLUMN approval_number SMALLINT;
CREATE INDEX idx_aal_approval_number ON autonomy_action_log (approval_number, created_at)
  WHERE approval_number IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_aal_approval_number;
ALTER TABLE autonomy_action_log DROP COLUMN IF EXISTS approval_number;
```

- [ ] **Step 2: Integration test.** Follow `tests/integration/migrate-shadow-eval-idempotency.test.ts`: up, down, then up again on `curia_test`, guarded by `requireCuriaTestDatabase`.
- [ ] **Step 3: Check the prefix.** `ls src/db/migrations | sort | tail -3` must show `098` as unique. Renumber to the next free prefix if `main` has moved.
- [ ] **Step 4: Commit.** `feat(db): approval_number on autonomy_action_log (#2159)`

### Task D3: Allocation and resolution by number

**Files:**
- Modify: `src/autonomy/action-log-repo.ts`, `src/autonomy/action-log-types.ts`
- Test: `tests/unit/autonomy/action-log-repo.test.ts`, `tests/integration/action-log-approval-number.test.ts`

**Interfaces:**
- Produces:
  - `ActionLogRow.approvalNumber: number | null`;
  - `insert()` allocates one for `outcome === 'pending_approval'`, and its return is unchanged (the id);
  - `findApprovalNumber(id: number): Promise<number | null>`;
  - `resolvePending(ref)` accepts `/^\d{1,3}$/` as an approval number.

- [ ] **Step 1: Failing unit tests**, using a `pool.connect()` fake that records the client's queries.
  1. A pending insert runs these in order:
     - `BEGIN`;
     - `SELECT pg_advisory_xact_lock(...)`;
     - the free-number query;
     - the INSERT with `approval_number`;
     - `COMMIT`.

     The client is released.
  2. On an INSERT error, it runs `ROLLBACK`, releases the client and rethrows.
  3. A non-pending insert does not allocate, and uses `pool.query` as before.
  4. `resolvePending('3')` queries `approval_number = $1` among pending, non-expired rows.
  5. `resolvePending('a3f7c12b')` behaves exactly as today.

- [ ] **Step 2: Failing integration test.**
  - Insert three pending approvals, which get 1, 2 and 3. Resolve number 2 (set `outcome = 'approved'`), then insert a fourth: it gets 4, not 2. This is Review Focus 2.
  - Backdate number 1's `created_at` by 8 days, then insert a fifth: it gets 1.
  - Ten concurrent inserts get ten distinct numbers.

- [ ] **Step 3: Run them.** Expected: FAIL.

- [ ] **Step 4: Implement.**
  - **The free-number query:**

    ```sql
    SELECT n FROM generate_series(1, 999) AS n
    WHERE n NOT IN (SELECT approval_number FROM autonomy_action_log
                    WHERE approval_number IS NOT NULL AND created_at > now() - interval '7 days')
    ORDER BY n LIMIT 1
    ```

    Run it inside `BEGIN; SELECT pg_advisory_xact_lock(hashtext('autonomy_approval_number'));`, then do the INSERT, with `approval_number` added to the column list, on the same client.
  - **When all 999 are taken:** insert NULL and log a warning. The approval then falls back to its `short_ref`.
  - **`mapRow`** reads `approval_number`.
  - **`resolvePending`:** when `/^\d{1,3}$/` matches, look up the pending, non-expired row with that `approval_number`. The not_found, already_resolved and expired distinctions mirror the short_ref path, restricted to rows created in the last 7 days.

- [ ] **Step 5: Run them.** Expected: PASS.
- [ ] **Step 6: Commit.** `feat(autonomy): approvals get a small reusable number (#2159)`

### Task D4: Approvals show and accept the number

**Files:**
- Modify:
  - `src/autonomy/approval-notification.ts:378-383`
  - `src/autonomy/approval-delivery.ts`
  - `src/autonomy/reaction-approval-mapper.ts:33,143-160`
  - `src/autonomy/approval-trigger.ts`
  - the gateway's two approval insert sites (`raiseSendApproval` and the export gate)
  - `skills/autonomy/tools/{approve-action,deny-action,dismiss-action,list-pending-actions}/{tool.json,handler.ts}`
- Test: the matching test files under `tests/unit/autonomy/` and the tools' `handler.test.ts`

- [ ] **Step 1: Failing tests.**
  1. **The notification body.** `buildApprovalNotificationBody` with `approvalNumber: 3` shows `Approval 3` and no `Reference:` line. Without a number it shows `Reference: <shortRef>` as today.
  2. **The email call to action** reads `Reply "approve 3" or "deny 3".` when numbered, and the current text otherwise.
  3. **Reaction binding.** `ReactionApprovalMapper.handleDelivered` binds from `Approval 3` content to the pending row with `approval_number = 3`, and still binds from `Reference: a3f7c12b`.
  4. **`list-pending-actions`** returns `number` for each pending item.
  5. **`approve-action`** with `short_ref: '3'` approves the row numbered 3, and the same goes for `deny-action` and `dismiss-action`.
  6. **Plumbing.** `ApprovalTriggerService.request` returns `approvalNumber`, read back with `findApprovalNumber(id)` after insert, and raise sites pass it to `registerDisplay`.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Display:**
    - `approvalNumber?: number | null` goes through `BuildApprovalNotificationBodyOpts` and `ApprovalDisplay`;
    - the `REFERENCE_RE` alternative becomes `/\b(?:Reference:\s*([0-9a-f]{8})|Approval\s+(\d{1,3}))\b/i`;
    - the number branch uses a new `findPendingByApprovalNumber(n)`.
  - **Tool descriptions:** in the approve, deny and dismiss `tool.json` files, `short_ref` becomes `"string? (the approval number from the notification, e.g. '3', or an older 8-character reference)"`. Use patch bumps; the input name is unchanged.
  - **Agent-facing advisories:** where the gateway's `approvalAdvisory(actionRef)` text quotes the ref, quote the number when there is one.
- [ ] **Step 4: Run** the tests and typecheck, then `prompt-budget.test.ts` (raise the budget by the measured delta if needed, with a comment).
- [ ] **Step 5: Commit.** `feat(autonomy): approvals are shown and answered by number (#2159)`

### Task D5: CHANGELOG and PR

- [ ] Add:
  - **Changed:** `- **Approvals and learning items** — answered by short numbers ("approve 3", "confirm 2") instead of IDs. (#2159)`
  - **Added:** `- **\`approval_number\`** — new nullable column on \`autonomy_action_log\` (migration 098). (#2159)`
- [ ] Run the full suite and the two reviewers, plus a security review: approval resolution is a security surface. Then open the PR, stacked on C, with `Closes #2159` only if every Phase 3 box is met. Otherwise use `Refs #2159`; the behavior-scenario box is still open.

---

## Rulings made while planning

1. **The pool needs a writer the spec assumed existed.** No autonomous action wrote a `success` row before this plan. The gateway records sends, because it alone sees every send, including relays and the band review's signals. The execution layer records everything else. Cost if wrong: a send recorded twice, which tests 5 and 9 in Task A2 pin.
2. **Live principal turns are not in the pool.** "Autonomous" excludes what the principal asked for in the moment. That also keeps admin tools (`set-autonomy`, `contact-set-tier`) out without a list. Cost if wrong: principal-directed actions are never sampled.
3. **`file-parse` is excluded** despite its `medium` rating: it reads a file and has no outside effect. Cost if wrong: a missing sample class.
4. **Triage is weighted high as a class.** The spec's "mail from a known contact" needs a sender lookup the triage tools cannot do. Cost if wrong: routine archive actions are sampled about three times as often as intended.
5. **"Financial or personal details shared" is not a weight.** No send-time signal records it. Cost if wrong: fewer samples of the sends the spec most wants checked; revisit with sampling data.
6. **Expired rows are skipped in the computation,** not rescored. Rows already scored keep their stored flags but stop counting, which covers history without a backfill. Cost if wrong: none to data; it is reversible.
7. **Principal verdicts weigh 3×, as a constant.** The spec says "above"; a setting would be a knob nobody tunes. Cost if wrong: a code change to retune.
8. **Pool rows are excluded from `get-autonomy`'s scored-action count.**
9. **New tools live in the `reports` bundle,** reached with `skill-activate`. The coordinator's tool budget has 74 bytes left, and digest jobs and verdict turns are rare. Cost if wrong: one extra tool call on those turns.
10. **The verdict trigger matches only a message that starts with a number and good/bad.** That covers both spec examples and avoids "I have 2 good ideas". Cost if wrong: a verdict buried mid-message gets no trigger. The coordinator can still find the tool through discovery.
11. **`record-spot-check` is `action_risk: none`** so the principal can answer at any band, including below 60. Its live-principal-turn check is the guard.
12. **A digest whose block was dropped is never bound,** so its numbers cannot be answered. The binder requires the header in the delivered content.
13. **Approval numbers need a column (D2),** pending approval. The no-schema alternatives were each worse:
    - reusing `short_ref` conflicts with its global uniqueness;
    - a config-store map has no transactional allocation.
