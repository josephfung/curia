# Band-driven autonomy, Phase 1 (noise): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut principal-bound noise. Approvals go out on one channel chosen from standing preferences. "Act, then tell" items and automatic notices go to a digest queue instead of standalone emails. The action log records who actually resolved each approval.

**Architecture:** Three PRs, in this order, each shippable alone.
- **PR A (1d):** a string change at five write sites, plus one scoring rule.
- **PR B (1b + 1c):** a `principal.report` bus event (audit-logged; it needs no new table) with a `ReportQueue` reader over `audit_log`, and an acknowledged cursor in the config store. Three tools (report, list, ack). Three notice paths are re-pointed from email to the queue. A daily `ReportFallbackDigest` system interval sends the weekly fallback.
- **PR C (1a):** approval raise sites stop notifying. An `ApprovalDelivery` service sends one approval on one channel. The `deliver-approval` tool lets the turn's agent choose that channel. The dispatcher relay wakes the coordinator to do it. The expiry sweep emails anything left undelivered after 15 minutes.

**Tech Stack:** TypeScript (ESM, Node 24), Vitest, pino, Postgres via existing repos.

**Spec:** `docs/wip/2026-10-15-band-driven-autonomy-design.md` (Phase 1 section). Issue #2159.

## Global Constraints

- Say "principal", never "CEO", in prose, comments, tool descriptions and user-facing text. Existing `ceo*` identifiers are left alone.
- No `any`. Use `.js` extensions on relative imports. No empty `catch {}`: every catch logs.
- Skills return `{ success: true, data }` or `{ success: false, error }` and never throw.
- New tools start at `"version": "0.1.0"`. Touched tools get a patch bump (behavior fix) or a minor bump (new input/output).
- New tools declare `action_risk`. Reads and principal-only delivery are `"none"`.
- `src/bus/events.ts` is a public API surface. The new event is called out in CHANGELOG under **Added**.
- Each CHANGELOG bullet has at most 15 words after the em-dash.
- Run `pnpm -C <worktree> run typecheck` and `pnpm -C <worktree> test` before every commit. Commits use `git commit -s`, with no Co-Authored-By line.
- Fixtures use made-up names (Dana, Sam) and `example.com` addresses. The repo is public.
- The coordinator is under a prompt budget (`tests/unit/agents/prompt-budget.test.ts`). Behavior guidance goes in tool descriptions (ADR-046), not `system_prompt`.

## Review Focus

1. **A digest turn that fails after listing reports.** The items must reappear in the next digest. Only `ack-principal-reports` advances the marker, and the ack is refused when the config-store write soft-rejects. Covered by Task B3.
2. **An approval nobody delivers.** The agent ignores the advisory, or the relay wake is lost. The expiry sweep emails it once after 15 minutes and stamps `notification_sent_at`. Covered by Task C5.
3. **A second `deliver-approval` call for the same approval** (a retry loop, or two turns). It must be refused once delivered: one ping, not two. Covered by Task C2.
4. **Every chosen channel fails** (Signal is down, no Slack identity). The tool returns an error that names the channels still available, so the agent can fall through. Nothing is sent in parallel. Covered by Task C2.
5. **A `principal.report` publish failure on a notice path.** It is logged at error level with the notice's subject. The notice is not silently lost from the logs. Covered by Tasks B4–B6.

---

## PR A: Honest attribution (1d)

Branch: `feat/band-autonomy-1d` from `main`, after the spec PR (#2160) merges. Until then, base it on `feat/band-driven-autonomy`.

### Task A1: Tools record `coordinator`; reactions record `principal`

**Files:**
- Modify: `skills/autonomy/tools/approve-action/handler.ts:64`, `skills/autonomy/tools/deny-action/handler.ts:35`, `skills/autonomy/tools/dismiss-action/handler.ts:34`, `skills/email/tools/send-draft/handler.ts:159`
- Modify: `src/autonomy/reaction-approval-mapper.ts:248,301`
- Modify: each tool's `tool.json` (patch bump)
- Test: the sibling `handler.test.ts` files, and `tests/unit/autonomy/reaction-approval-mapper.test.ts`

**Interfaces:**
- Produces: `RESOLVED_BY` constants in `src/autonomy/action-log-types.ts`:
  ```ts
  /** Who resolved a pending approval. 'ceo' survives on rows written before #2159. */
  export const RESOLVED_BY = {
    principal: 'principal',     // the principal acted directly (reaction)
    coordinator: 'coordinator', // an agent called a resolve tool, on its own reading of the conversation
    system: 'system',           // expiry sweep, gate rejection
  } as const;
  ```

- [ ] **Step 1: Update the tests to expect the new values (they fail).** In `deny-action/handler.test.ts:90`, `approve-action/handler.test.ts:102`, `dismiss-action/handler.test.ts:90` and `send-draft/handler.test.ts:558`, replace `'ceo'` with `'coordinator'`. In `reaction-approval-mapper.test.ts`, replace every `resolveRow).toHaveBeenCalledWith(42, …, 'ceo')` with `'principal'` (lines 127, 154, 207, 226, 240, 267, 295, 353).
- [ ] **Step 2: Run them and confirm they fail.**
  `pnpm -C <wt> exec vitest run skills/autonomy skills/email/tools/send-draft tests/unit/autonomy/reaction-approval-mapper.test.ts`
  Expected: FAIL, with `'ceo'` received where `'coordinator'` or `'principal'` was expected.
- [ ] **Step 3: Implement.** Add `RESOLVED_BY` to `action-log-types.ts`. Replace each literal `'ceo'` at the five sites:
  - the four tools use `RESOLVED_BY.coordinator`
  - the reaction mapper uses `RESOLVED_BY.principal`

  Above each tool call, add the comment:
  `// An agent called this tool on its own reading of the conversation, so it is not recorded as the principal's decision (#2159).`
  Bump the patch version of `approve-action`, `deny-action`, `dismiss-action` and `send-draft`.
- [ ] **Step 4: Rerun Step 2's command.** Expected: PASS.
- [ ] **Step 5: Commit.** `fix(autonomy): record who actually resolved an approval (#2159)`

### Task A2: Coordinator-resolved rows carry no scoring signal

**Files:**
- Modify: `src/autonomy/scoring-pass.ts` (`scoreRow`)
- Test: `tests/unit/autonomy/scoring-pass.test.ts`

- [ ] **Step 1: Write the failing tests** in the `scoreRows` describe block:

```ts
it('scores a coordinator-resolved approval as no signal', async () => {
  const row = makeRow({ id: 20, outcome: 'approved', resolvedBy: 'coordinator' });
  const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
  const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

  await pass.run();

  expect(repo.updateScoringFlags).toHaveBeenCalledWith(20, {
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: 'deterministic-coordinator',
  });
});

it('scores a coordinator-denied approval as no signal', async () => {
  const row = makeRow({ id: 21, outcome: 'denied', resolvedBy: 'coordinator' });
  const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
  const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

  await pass.run();

  expect(repo.updateScoringFlags).toHaveBeenCalledWith(21, expect.objectContaining({
    competenceFlag: null, scoredBy: 'deterministic-coordinator',
  }));
});

it('keeps the principal signal for a reaction-resolved approval', async () => {
  const row = makeRow({ id: 22, outcome: 'approved', resolvedBy: 'principal' });
  const repo = makeRepo({ findUnscoredTerminal: vi.fn().mockResolvedValue([row]) });
  const pass = new AutonomyScoringPass(repo, makeAutonomyService(), makeLlmProvider(), createSilentLogger(), defaultConfig);

  await pass.run();

  expect(repo.updateScoringFlags).toHaveBeenCalledWith(22, expect.objectContaining({
    competenceFlag: 1, scoredBy: 'deterministic',
  }));
});
```

- [ ] **Step 2: Run** `pnpm -C <wt> exec vitest run tests/unit/autonomy/scoring-pass.test.ts`. Expected: the first two FAIL, because they get the `approved` and `denied` deterministic flags.
- [ ] **Step 3: Implement.** At the top of `scoreRow`, before the `DETERMINISTIC_SCORES` lookup:

```ts
    // Only the principal's own decisions are feedback (#2159). A resolve tool called by
    // an agent records the agent's reading of the conversation — the Oct 2026 incident
    // had the coordinator deny a held reply after misreading coaching as withdrawal.
    // Score the row so it leaves the unscored queue, but give it no signal.
    if (row.resolvedBy === RESOLVED_BY.coordinator) {
      await this.repo.updateScoringFlags(row.id, COORDINATOR_RESOLVED_FLAGS);
      return true;
    }
```

  Add `COORDINATOR_RESOLVED_FLAGS` next to `UNPARSEABLE_FLAGS`, with all flags null and `scoredBy: 'deterministic-coordinator'`. Import `RESOLVED_BY`.
- [ ] **Step 4: Rerun Step 2.** Expected: PASS. Check that `computeCapabilityScore` skips null dimensions; the existing "null means no signal" contract in `action-log-types.ts` says it does.
- [ ] **Step 5: CHANGELOG** under **Fixed**:
  `- **Approval attribution** — resolve tools record \`coordinator\`; only reaction decisions count as principal feedback. (#2159)`
- [ ] **Step 6: Commit.** `fix(autonomy): only principal decisions feed the score (#2159)`

---

## PR B: Report queue (1b + 1c)

Branch: `feat/band-autonomy-reports`.

### Task B1: `principal.report` event

**Files:**
- Modify: `src/bus/events.ts`: the payload, the event interface, the `BusEvent` union member and the `createPrincipalReport` factory
- Modify: `src/bus/permissions.ts`: publish for `dispatch` and `system`; subscribe for `system` only
- Modify: `src/audit/field-extraction.ts`: the extractor
- Test: `tests/unit/bus/principal-report-event.test.ts` (new), and the existing permission tests

**Interfaces:**
- Produces:
  ```ts
  export type PrincipalReportUrgency = 'digest' | 'now';
  /** What produced the item. Agents use 'agent'; system paths name themselves. */
  export type PrincipalReportSource =
    | 'agent' | 'principal_note' | 'blocked_content' | 'approval_pending' | 'approval_expired';
  export interface PrincipalReportPayload {
    summary: string;              // one or two sentences, principal-facing
    urgency: PrincipalReportUrgency;
    source: PrincipalReportSource;
    conversationId?: string;      // the thread or task this concerns
    link?: string;                // e.g. a console task URL
    actionShortRef?: string;      // for approval_* items
  }
  export function createPrincipalReport(
    payload: PrincipalReportPayload & { parentEventId: string; sourceLayer: 'dispatch' | 'system' },
  ): PrincipalReportEvent;
  ```

- [ ] **Step 1: Failing test.**

```ts
import { describe, it, expect } from 'vitest';
import { createPrincipalReport } from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';
import { extractStructuredFields } from '../../../src/audit/field-extraction.js';

describe('principal.report', () => {
  const event = createPrincipalReport({
    summary: 'Replied to Dana confirming Tuesday.',
    urgency: 'digest',
    source: 'agent',
    conversationId: 'email:abc',
    parentEventId: 'task-1',
    sourceLayer: 'dispatch',
  });

  it('builds the event with the given layer', () => {
    expect(event.type).toBe('principal.report');
    expect(event.sourceLayer).toBe('dispatch');
    expect(event.payload).not.toHaveProperty('sourceLayer');
  });

  it('is published by dispatch and system, and read only by system', () => {
    expect(canPublish('dispatch', 'principal.report')).toBe(true);
    expect(canPublish('system', 'principal.report')).toBe(true);
    expect(canPublish('agent', 'principal.report')).toBe(false);
    expect(canSubscribe('channel', 'principal.report')).toBe(false);
    expect(canSubscribe('system', 'principal.report')).toBe(true);
  });

  it('extracts structured audit columns', () => {
    const fields = extractStructuredFields('principal.report', event.payload as unknown as Record<string, unknown>);
    expect(fields).toMatchObject({ action: 'report', target_type: 'principal', initiator_type: 'system' });
  });
});
```

  (Check the real names of the permission helpers in `permissions.ts` before writing this, and use whatever the existing permission tests import.)
- [ ] **Step 2: Run it.** It fails because `createPrincipalReport` is not exported.
- [ ] **Step 3: Implement**, following `createDelegationPrincipalNote`. Add a header comment block in `permissions.ts`:
  `// #2159 (report queue): dispatch and system publish principal.report — items for the principal's digest. Only system subscribes; channels never see it, so a report can't leak to a sender.`
  - Extractor: `action: 'report'`, `outcome: 'success'`, `target_type: 'principal'`, `target_id: payload.source`, `initiator_type: INITIATOR_TYPE_SYSTEM`, `initiator_id: payload.source`.
- [ ] **Step 4: Run** the new test plus `tests/unit/bus` and `tests/unit/audit`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(bus): principal.report event for the digest queue (#2159)`

### Task B2: `ReportQueue`

**Files:**
- Create: `src/reports/report-queue.ts`
- Test: `tests/unit/reports/report-queue.test.ts`

**Interfaces:**
- Consumes: `AuditLogRepo.findByEventTypes(types, { after, to, limit })` and `ConfigStore.get/set`.
- Produces:
  ```ts
  export interface ReportItem { id: string; at: Date; summary: string; urgency: PrincipalReportUrgency; source: PrincipalReportSource; conversationId?: string; link?: string; actionShortRef?: string }
  export interface ReportBatch { items: ReportItem[]; cursor: string | null; hasMore: boolean }
  export class ReportQueue {
    constructor(deps: { auditLogRepo: Pick<AuditLogRepo, 'findByEventTypes'>; configStore: Pick<ConfigStore, 'get' | 'set'>; logger: Logger; now?: () => Date });
    /** Items after the acknowledged marker, oldest first, skipping the last 30s. Never moves the marker. */
    list(limit?: number): Promise<ReportBatch>;
    /** Advance the marker to `cursor`. Returns false (marker unchanged) when the write soft-rejects. */
    ack(cursor: string): Promise<boolean>;
    /** Timestamp of the oldest unacknowledged item, or null when none. */
    oldestUnreported(): Promise<Date | null>;
  }
  export const REPORT_SETTLE_MS = 30_000;
  ```
- The marker is stored at config-store namespace `reports`, key `last_reported`, as JSON `{"t":"<iso>","id":"<uuid>"}`. The `cursor` string is that same JSON, so `ack()` validates and stores it verbatim.

- [ ] **Step 1: Failing tests.** Use in-memory fakes for both dependencies:
  - `list()` with no marker reads everything up to `now - 30s`, and returns items mapped from payload plus a cursor equal to the last row's `(timestamp, id)`.
  - `list()` passes `after` from a stored marker.
  - `list()` never calls `configStore.set`. This test is what guarantees an item is not lost before delivery.
  - `ack(cursor)` stores the cursor. When `set` returns `{ stored: false }`, `ack` returns `false`.
  - `ack('garbage')` throws `Error('invalid report cursor')`.
  - A row whose payload has no string `summary` is skipped with a warn log, not thrown.
  - `oldestUnreported()` returns the first row's timestamp, or null.
- [ ] **Step 2: Run.** It fails because the module is missing.
- [ ] **Step 3: Implement.** In the header comment, say why the settle lag exists: the audit writer is async (`src/audit/logger.ts`), and a cursor past a row that lands late would skip it. `list` calls `findByEventTypes(['principal.report'], { after, to: new Date(now - REPORT_SETTLE_MS), limit })`. Map `row.payload` defensively; it is `Record<string, unknown>`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(reports): report queue over principal.report audit rows (#2159)`

### Task B3: Report tools

**Files:**
- Create: `skills/reports/SKILL.md` (bundle with three tools)
- Create: `skills/reports/tools/report-to-principal/{tool.json,handler.ts,handler.test.ts}`
- Create: `skills/reports/tools/list-principal-reports/{tool.json,handler.ts,handler.test.ts}`
- Create: `skills/reports/tools/ack-principal-reports/{tool.json,handler.ts,handler.test.ts}`
- Modify: `agents/coordinator.yaml`: pin `reports` and bump the patch version

**Interfaces:**
- `report-to-principal`:
  - Inputs: `summary` (string, at most 500 chars), `urgency` (`digest|now`, default `digest`), `link` (string, optional).
  - Capabilities: `bus`. `action_risk: "none"`. Allowed callers: coordinator.
  - Publishes `createPrincipalReport({ …, source: 'agent', conversationId: ctx.conversationId, parentEventId: ctx.taskEventId, sourceLayer: 'dispatch' })`.
  - Description: *"Record something the principal should hear about in their next digest: an action you took on their behalf, a decision you made, or a reading of an ambiguous instruction. Use urgency 'now' only when you have also pinged them directly. Does not message the principal."*
- `list-principal-reports`:
  - Capabilities: `auditLogRepo`, `entityMemory`. It builds `new ReportQueue({ auditLogRepo, configStore: new ConfigStore(ctx.entityMemory, ctx.log), logger: ctx.log })`.
  - Returns `{ items: [{ n, at (toLocalIso), summary, urgency, link? }], cursor, hasMore, displayTimezone }`. Items are numbered 1..N; IDs are never returned.
  - Description: *"Items for the principal's digest since the last acknowledged digest. After the digest has been sent, call ack-principal-reports with the returned cursor. If the digest fails to send, do not ack: the items will come back next time."*
- `ack-principal-reports`:
  - Input: `cursor` (string). Capabilities: `entityMemory`.
  - When `ack` is false it returns `{ success: false, error: 'Marker not stored; the items will repeat in the next digest.' }`.

- [ ] **Step 1: Failing handler tests**, one file per tool. Follow `skills/autonomy/tools/deny-action/handler.test.ts` for the ctx shape. Cover:
  - `report-to-principal`:
    - publishes once with `sourceLayer 'dispatch'`
    - rejects an empty or over-length summary
    - fails without the bus
  - `list-principal-reports`:
    - numbers the items
    - never calls `set`
  - `ack-principal-reports`:
    - the soft-reject case returns an error
    - an invalid cursor returns an error, not a throw
- [ ] **Step 2: Run** `pnpm -C <wt> exec vitest run skills/reports`. Expected: FAIL.
- [ ] **Step 3: Implement** the handlers and manifests, plus `SKILL.md` (frontmatter `name: reports`, `version: "0.1.0"`, and the three tools). Pin `reports` in `coordinator.yaml`.
- [ ] **Step 4: Run** the skill tests, `tests/unit/agents/prompt-budget.test.ts` and `tests/unit/skills`. If the coordinator's tool-definition budget fails, trim the three descriptions first. Raise the budget only with a comment that cites #2159.
- [ ] **Step 5: Commit.** `feat(reports): tools to file, list and acknowledge digest items (#2159)`

### Task B4: Principal notes go to the queue

**Files:**
- Modify: `src/dispatch/dispatcher.ts`, `deliverPrincipalNote` (around line 1162)
- Test: `tests/unit/dispatch/dispatcher-principal-note.test.ts`

- [ ] **Step 1: Update the tests.**
  - The note now publishes `principal.report` with `source: 'principal_note'`, `urgency: 'digest'`, `conversationId` set, and `summary = principalNoteBody(note, source)`. It no longer publishes `outbound.notification`.
  - The "a send already reached the principal" skip still applies.
  - The "no verified principal email" early return is removed: the queue does not need an address.
  - A publish rejection logs at error with the note length (never the text) and does not throw.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replace `createOutboundNotification` with `createPrincipalReport({ …, sourceLayer: 'dispatch', parentEventId: event.id })`. Update the method doc comment: the note is now *queued for the digest*, not emailed. Leave `principal-note-notification.ts` in place, because `principalNoteBody` still formats the summary.
- [ ] **Step 4: Run** the dispatcher tests and scenario case `tests/scenarios/cases/18-non-principal-note-for-principal.yaml`. If that case asserts the email, update its expectation to "queued", with a comment citing #2159.
- [ ] **Step 5: Commit.** `feat(dispatch): queue principal notes for the digest instead of emailing (#2159)`

### Task B5: Filter block notices go to the queue

**Files:**
- Modify: `src/skills/outbound-gateway.ts`: the two `blocked_content` `sendNotification` sites (around lines 1315 and 2712)
- Test: the existing gateway blocked-notification tests (`grep -rln "blocked_content" tests/unit`)

- [ ] **Step 1: Update the tests.** A block publishes `principal.report` (`source: 'blocked_content'`, `urgency: 'digest'`). The summary is `Outbound message blocked: <reasonSummary>`, or `Outbound draft blocked: …` for drafts, followed by ` (block <blockId>)`. No `outbound.notification` with `blocked_content` is sent. `skipNotificationOnBlock` still suppresses it, so the recursion guard is kept.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add a private helper `queueBlockReport(summary, conversationId, parentEventId)` that publishes via `this.bus.publish('dispatch', …)` and logs at error on rejection. Leave the `'blocked_content'` member in the `notificationType` union, because older audit rows carry it. Add the comment `// No longer emitted (#2159); kept for historical audit rows.`
- [ ] **Step 4: Run** `pnpm -C <wt> exec vitest run tests/unit/skills`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(gateway): queue block notices for the digest (#2159)`

### Task B6: Approval-expiry notices go to the queue

**Files:**
- Modify: `src/autonomy/approval-expiry-sweep.ts`
- Modify: `src/index.ts` (pass `bus`)
- Test: `tests/unit/autonomy/approval-expiry-sweep.test.ts`

- [ ] **Step 1: Update the tests.** Each expired row of any tier publishes one `principal.report` (`source: 'approval_expired'`, `actionShortRef`, summary `Approval expired without an answer: <description>`). No `approval_expired` email is sent. `ApprovalExpirySweepResult.notified` counts queued reports. A publish failure for one row logs at error and the loop continues.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Swap `outboundGateway` for `bus: Pick<EventBus, 'publish'>` in the options. Keep the `outboundGateway` option, because Task C5 uses it for the delivery safety net. Publish with `sourceLayer: 'system'`. Update the header comment: expiry is now digest material, not an alert, and the `NOTIFIABLE_TIERS` filter goes away, because every expiry is worth one digest line.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(autonomy): report expired approvals in the digest (#2159)`

### Task B7: Weekly fallback digest

**Files:**
- Create: `src/reports/report-fallback-digest.ts`
- Modify: `src/bus/events.ts` (add `'report_digest'` to the `notificationType` union and its comment list)
- Modify: `src/index.ts` (construct, `start()`, and `stop()` on shutdown, next to `approvalExpirySweep`)
- Modify: `config/default.yaml` (`reports.fallbackDigest.maxAgeDays: 7`, `checkIntervalHours: 24`) and `src/config.ts` (the typed loader with defaults)
- Test: `tests/unit/reports/report-fallback-digest.test.ts`

**Interfaces:**
- Consumes: `ReportQueue.oldestUnreported/list/ack` and `OutboundGateway.sendNotification`.
- Produces: `ReportFallbackDigest` with `start()`, `stop()` and `tick(): Promise<{ sent: boolean; items: number }>`. Shaped like `ApprovalExpirySweep`: an in-flight guard and a first tick delayed by 60s.

- [ ] **Step 1: Failing tests:**
  - No unreported items: no send.
  - Oldest item is 6 days old: no send.
  - Oldest item is 8 days old: one `sendNotification({ notificationType: 'report_digest', subject: 'Curia: weekly summary', body })` whose body is a numbered list, then `ack(cursor)`.
  - The send returns false: no ack, and an error is logged.
  - More than one page (`hasMore`): every page is listed before the send, and the last cursor is acked.
  - No principal email bound: no send, and a warning is logged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** In the header comment, say that it keys on the age of the oldest unreported item rather than on whether a digest job exists, so a broken digest job can't suppress it.
- [ ] **Step 4: Run** the tests, then `pnpm -C <wt> run typecheck`.
- [ ] **Step 5: CHANGELOG.**
  - **Added**:
    - `- **Report queue** — \`principal.report\` event and tools collect "act, then tell" items for the digest. (#2159)`
    - `- **Weekly fallback digest** — sent when queued items go a week unreported. (#2159)`
  - **Changed**:
    - `- **Principal notices** — notes, block notices and expired approvals go to the digest, not email. (#2159)`
- [ ] **Step 6: Commit.** `feat(reports): weekly fallback digest for installs without one (#2159)`

**After PR B deploys:** each existing digest job needs one line added to its instructions:
*"Call list-principal-reports and include its items. After sending, call ack-principal-reports with its cursor."*
The principal makes this edit; the scheduler jobs are user data.

---

## PR C: One-channel approvals (1a)

Branch: `feat/band-autonomy-approvals`. Depends on PR B (report items).

### Task C1: Default standing preference

**Files:**
- Modify: `src/identity/defaults.ts`
- Test: `tests/unit/identity/defaults.test.ts` (create it if absent)

- [ ] **Step 1: Failing test.** `DEFAULT_OFFICE_IDENTITY.behavioralPreferences` contains a string that matches `/one channel/i` and names Signal, SMS and email in that order.
- [ ] **Step 2: Implement.** Append:
  `'When something needs the principal right away, use one channel: Signal if connected, otherwise SMS, otherwise email. Everything else waits for the digest.'`
  Add a comment above it saying it is an editable example seeded on fresh installs only. Existing installs add it in the console (Settings → Posture).
- [ ] **Step 3: Run, then commit.** `feat(identity): default one-channel standing preference (#2159)`

### Task C2: `ApprovalDelivery` and `deliver-approval`

**Files:**
- Create: `src/autonomy/approval-delivery.ts`
- Modify: `src/autonomy/approval-channel-notify.ts`: split into `sendApprovalOnChannel(channel, …)`, a single-channel function, and delete the both-channels fan-out
- Create: `skills/autonomy/tools/deliver-approval/{tool.json,handler.ts,handler.test.ts}`
- Modify: `skills/autonomy/SKILL.md` (list the tool) and `src/skills/loader.ts` + `src/skills/execution.ts` + `src/skills/types.ts` (new capability `approvalDelivery`)
- Modify: `src/index.ts` (construct and wire)
- Test: `tests/unit/autonomy/approval-delivery.test.ts`, and update `tests/unit/autonomy/approval-channel-notify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ApprovalChannel = 'signal' | 'sms' | 'slack' | 'email';
  export type DeliverResult =
    | { delivered: true; channel: ApprovalChannel }
    | { delivered: false; reason: 'not_found' | 'not_pending' | 'already_delivered' | 'channel_unavailable' | 'send_failed'; available: ApprovalChannel[] };
  export class ApprovalDelivery {
    constructor(deps: { actionLogRepo: ActionLogRepo; outboundGateway: OutboundGateway; principalIdentities: readonly ChannelIdentity[]; principalEmail: string | PrincipalEmailRef; contactService?: ContactService; logger: Logger });
    /** Channels the principal has a verified, active identity on, in the order signal, sms, slack, email. */
    availableChannels(): ApprovalChannel[];
    /** Send one pending approval on one channel. Stamps notification_sent_at on success. */
    deliver(shortRef: string, channel: ApprovalChannel): Promise<DeliverResult>;
  }
  ```
- Bodies come from `buildApprovalNotificationBody`. Signal and Slack use the 👍/👎 call to action and bind the message ID (`bindDeliveryMessage`). SMS and email use "Reply approve or deny". The reference is kept in the body for now; Phase 3 replaces it with numbers.
- `deliver-approval` tool:
  - Inputs: `short_ref` (string) and `channel` (`signal|sms|slack|email`). Capability: `approvalDelivery`. `action_risk: "none"`. Allowed callers: coordinator.
  - Description: *"Send a pending approval to the principal on ONE channel. Choose the channel from the principal's standing preferences for urgent items. If delivery fails, the error lists the channels still available; try the next one. An approval is delivered once; it is mentioned again only in the next digest."*

- [ ] **Step 1: Failing tests** for `ApprovalDelivery`:
  - The row is pending and undelivered, and Signal succeeds: exactly one `outboundGateway.send` (channel `signal`), `bindDeliveryMessage(id, 'signal', msgId)`, `setNotificationSentAt(id)`, and `{ delivered: true }`.
  - The row already has `notificationSentAt`: `already_delivered` and no send.
  - The row is not pending: `not_pending`.
  - The channel has no verified principal identity: `channel_unavailable` with `available` listed.
  - The send fails or throws: `send_failed`, `notification_sent_at` is not stamped, and a warn is logged.
  - Email goes through `sendNotification({ notificationType: 'approval_requested' })` and stamps on `true`.
  - Never more than one send per call.
- [ ] **Step 2: Failing tests** for the tool: it maps each `DeliverResult` to success or error text. The error text names `available` channels, e.g. `Signal delivery failed. Channels still available: sms, email.`
- [ ] **Step 3: Run** both test files. Expected: FAIL.
- [ ] **Step 4: Implement.** Add `approvalDelivery` to `VALID_CAPABILITIES`, `capabilityServiceMap` and `ToolContext`. Mention the `ToolContext` field in the CHANGELOG as a public API addition.
- [ ] **Step 5: Run** the tests and typecheck. Expected: PASS.
- [ ] **Step 6: Commit.** `feat(autonomy): deliver an approval on one chosen channel (#2159)`

### Task C3: Raise sites stop fanning out

**Files:**
- Modify: `src/autonomy/approval-trigger.ts`
  - remove the email and chat sends
  - remove `notificationSent` from `ApprovalRequestResult`
  - publish a `principal.report` with `source: 'approval_pending'`
- Modify: `src/skills/execution.ts`: the advisory text in `buildGateError`, `buildTierGateError` and `buildExportGateError`
- Modify: `src/skills/outbound-gateway.ts`: the score-gate site (around line 785) and the export-gate site (around line 1092) stop notifying, publish the report item, and their `blockedReason` gets the delivery instruction
- Modify: `src/index.ts` (constructor args)
- Test: `tests/unit/autonomy/approval-trigger.test.ts`, the execution gate tests (`grep -rln "approval request has been sent" tests`), and the gateway gate tests

**Interfaces:**
- `ApprovalRequestResult` becomes `{ created: true; shortRef: string } | { created: false; reason: 'duplicate'; existingShortRef: string }`.
- The advisory text for a new approval, built by one shared helper `approvalAdvisory(shortRef)` in `approval-trigger.ts`:
  `An approval request was created (ref: <ref>). Deliver it to the principal now with deliver-approval, on the channel their standing preferences name for urgent items.`
- Duplicate: unchanged.

- [ ] **Step 1: Update the tests.**
  - `request()` makes no `sendNotification` or `send` calls.
  - It publishes one `principal.report` (`approval_pending`, `actionShortRef`, summary `Waiting for your approval: <description>`).
  - The gate errors contain `deliver-approval` and the ref.
  - The gateway score and export gates make no notification calls.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The constructor drops `outboundGateway`, `contactService` and `principalIdentities`, and gains `bus: Pick<EventBus, 'publish'>`. A report-publish failure logs at error and does not fail the request: the row exists, and the 15-minute safety net covers delivery. In the gateway, drop the now-unused imports (`deliverApprovalToChatChannels`, and `resolveNotificationRecipientTier` if it is unused).
- [ ] **Step 4: Run** `pnpm -C <wt> exec vitest run tests/unit/autonomy tests/unit/skills` and typecheck. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(autonomy): approvals no longer fan out across channels (#2159)`

### Task C4: Post-turn relay approvals wake the coordinator

**Files:**
- Modify: `src/dispatch/dispatcher.ts`, `requestRelayGateCApproval` (around line 1717)
- Test: the dispatcher relay Gate C tests (`grep -rln "requestRelayGateCApproval\|relay escalate" tests/unit/dispatch`)

- [ ] **Step 1: Failing test.** When `request()` returns `created: true`, the dispatcher publishes one `agent.task`:
  - `agentId: 'coordinator'`
  - `channelId: 'scheduler'`, `senderId: 'system'`
  - `conversationId: 'approval-delivery:<ref>'`
  - `parentEventId: taskEventId`
  - content containing `deliver-approval`, the ref and the description

  No wake is sent on `created: false` (duplicate). A publish failure logs at error; the safety net covers it.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Follow the `plan-adaptive-replan.ts:410` pattern. Content:
  `A reply was held for the principal's approval (ref: <ref>): <description>. Deliver it with deliver-approval on the channel the principal's standing preferences name for urgent items. Do not do anything else.`
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(dispatch): wake the coordinator to deliver held relay approvals (#2159)`

### Task C5: Safety net for undelivered approvals

**Files:**
- Modify: `src/autonomy/action-log-repo.ts`: `findUndelivered(olderThan: Date): Promise<ActionLogRow[]>`, i.e. pending rows with `notification_sent_at IS NULL AND created_at < $1` (parameterized)
- Modify: `src/autonomy/approval-expiry-sweep.ts`: the tick also delivers undelivered rows by email via `ApprovalDelivery.deliver(ref, 'email')`
- Modify: `src/index.ts`
- Test: `tests/unit/autonomy/approval-expiry-sweep.test.ts`, plus the `action-log-repo` SQL test

- [ ] **Step 1: Failing tests:**
  - An undelivered row older than 15 minutes is delivered by email once, with a warn log `approval delivered by safety net — the agent did not deliver it`.
  - A row delivered earlier is untouched.
  - When the email fails, an error is logged and the next tick retries.
  - The repo query uses `$1`, not interpolation.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use the same in-flight guard. Run the undelivered pass before the expiry pass, so a row near expiry still gets its one ping.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: CHANGELOG.**
  - **Changed**:
    - `- **Approval delivery** — one message on the principal's preferred channel, not email, Signal and Slack. (#2159)`
  - **Added**:
    - `- **\`deliver-approval\`** — sends a pending approval on one chosen channel; undelivered ones email after 15 minutes. (#2159)`
- [ ] **Step 6: Commit.** `feat(autonomy): email approvals no agent delivered within 15 minutes (#2159)`

### Task C6: Docs

- [ ] Update `docs/specs/14-autonomy-engine.md` (the approval notification section) to describe one-channel delivery, the safety net and the report queue.
- [ ] Commit: `docs: approval delivery and report queue in spec 14 (#2159)`

---

## Post-merge checklist (for the principal)

1. In the console posture settings, add the one-channel preference. Fresh installs get it by default; existing installs do not.
2. Add the list/ack line to the morning and end-of-day digest jobs.
3. After two weeks, count principal-bound messages per piece of work. The target is under 5.
