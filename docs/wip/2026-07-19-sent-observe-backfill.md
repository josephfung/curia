# sent-observe Oldest-First Backlog Drain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain `>SENT_MAX_SCAN` Sent-folder backlogs oldest-first across successive runs so no message is permanently skipped, while keeping the first-ever run forward-only.

**Architecture:** Add a `receivedBefore` filter to the CEO Nylas client, then replace the sent-observe watermark-advance block with a small state machine over two new `ceo_inbox` config keys (`backfill_before` = descending `received_before` ceiling, `backfill_target` = the newest date to jump the watermark to on completion). The main watermark stays pinned to its floor during a drain.

**Tech Stack:** TypeScript (ESM, Node 24+), Vitest, Nylas v3 REST, KG-backed `ConfigStore`.

## Global Constraints

- ESM only; `.js` extensions on all relative imports; no `any`.
- Skills never throw — return `{ success: true, data }` / `{ success: false, error }`.
- pino logging only; no `console.log`.
- Typecheck with `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill run typecheck` before every `.ts` commit.
- Run tests with `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill test <path>`.
- Nylas `received_before` and `received_after` are **inclusive** Unix-second bounds.
- Commit style: conventional (`fix:` / `test:`), sign off with `-s`, no Co-Authored-By / no AI attribution.
- Config sentinel: `'0'` (`EPOCH`) means "backfill key unset"; a real ceiling/target is always a Unix-second value `> 0`.

---

### Task 1: Add `receivedBefore` to the CEO Nylas client

**Files:**
- Modify: `skills/_shared/ceo-nylas-client.ts` (`ListMessagesOptions`, `listMessages`, `listAllMessages`)
- Test: `skills/_shared/ceo-nylas-client.test.ts` (create if absent, else append)

**Interfaces:**
- Produces: `ListMessagesOptions.receivedBefore?: number`; `listAllMessages({ folder, receivedAfter?, receivedBefore?, maxScan? })` sends `received_before` on the **first** request only (cursor carries it thereafter).

- [ ] **Step 1: Write the failing test.** Confirm `received_before` is sent on the first page and NOT re-sent once a `page_token` is present.

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CeoNylasClient } from './ceo-nylas-client.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('CeoNylasClient.listAllMessages received_before', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends received_before on page 1 and not on cursor pages', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      // Page 1 → one message + a cursor; page 2 → empty, no cursor.
      if (String(url).includes('page_token')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'm1', date: 100, folders: ['SENT'] }], next_cursor: 'CUR' }),
        { status: 200 },
      );
    });

    const client = new CeoNylasClient('key', 'grant', log);
    const { messages } = await client.listAllMessages({
      folder: 'SENT',
      receivedAfter: 50,
      receivedBefore: 200,
      maxScan: 500,
    });

    expect(messages).toHaveLength(1);
    expect(urls[0]).toContain('received_before=200');
    expect(urls[0]).toContain('received_after=50');
    expect(urls[1]).toContain('page_token=CUR');
    expect(urls[1]).not.toContain('received_before');
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL** (`received_before` not in URL).

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill test skills/_shared/ceo-nylas-client.test.ts`
Expected: FAIL on `urls[0]` assertion.

- [ ] **Step 3: Implement.** In `ceo-nylas-client.ts`:

Add to `ListMessagesOptions` (after `receivedAfter?: number;`):
```ts
  /** Inclusive upper bound (Unix seconds). Nylas returns messages with date <= this. */
  receivedBefore?: number;
```

In `listMessages`, in the non-`query` branch after the `receivedAfter` line:
```ts
      if (options.receivedBefore !== undefined) params.set('received_before', String(options.receivedBefore));
```

In `listMessages`, extend the `query`-suppression warning object to include `receivedBefore` alongside `receivedAfter` so a caller combining search + `received_before` is still warned:
```ts
      if (options.folder || options.unread !== undefined || options.receivedAfter !== undefined || options.receivedBefore !== undefined) {
        this.log.warn(
          { suppressedOptions: { folder: options.folder, unread: options.unread, receivedAfter: options.receivedAfter, receivedBefore: options.receivedBefore } },
          'nylas: listMessages — folder/unread/receivedAfter/receivedBefore ignored because search_query_native is set (Nylas v3 limitation)',
        );
      }
```

In `listAllMessages`, inside the first-page `else` block (where `receivedAfter` is set), after the `receivedAfter` block:
```ts
        if (options.receivedBefore !== undefined) {
          params.set('received_before', String(options.receivedBefore));
        }
```
Also update the method's doc comment: filters now read `(in/received_after/received_before)`.

- [ ] **Step 4: Run the test — expect PASS.**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill test skills/_shared/ceo-nylas-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit.**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill add skills/_shared/ceo-nylas-client.ts skills/_shared/ceo-nylas-client.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill commit -s -m "feat(ceo-nylas-client): add received_before filter for oldest-first paging (#1431)"
```

---

### Task 2: Backfill state machine in the sent-observe handler

**Files:**
- Modify: `skills/ceo-inbox-sent-observe/handler.ts`
- Test: `skills/ceo-inbox-sent-observe/handler.test.ts`

**Interfaces:**
- Produces (exported constants, for tests): `BACKFILL_BEFORE_KEY = 'sent_observe.backfill_before'`, `BACKFILL_TARGET_KEY = 'sent_observe.backfill_target'`.
- Consumes: `ConfigStore.get/set` (Task-0 existing), `CeoNylasClient.listAllMessages({ receivedBefore })` (Task 1).

**Behavior contract (implement exactly):**
- Read `watermark` (existing), `backfillBefore = Number(get(BACKFILL_BEFORE_KEY)) || 0`, `backfillTarget = Number(get(BACKFILL_TARGET_KEY)) || 0`. `backfillMode = backfillBefore > 0`.
- Scan: `listAllMessages({ folder:'SENT', ...(watermark>0?{receivedAfter:watermark}:{}), ...(backfillMode?{receivedBefore:backfillBefore}:{}), maxScan:SENT_MAX_SCAN })`.
- After processing + `advanceOk` computed, replace the watermark-advance block:
  - If `advanceOk`:
    - **Backfill mode:** if `messages.length > 0 && truncated` → `set(BACKFILL_BEFORE_KEY, String(minDate))` (descend; watermark pinned). Else (drained / empty window) → `set(WATERMARK_KEY, String(backfillTarget + 1))`, `set(BACKFILL_BEFORE_KEY, EPOCH)`, `set(BACKFILL_TARGET_KEY, EPOCH)`; `watermarkAdvancedTo = backfillTarget + 1`.
    - **Normal mode** and `messages.length > 0`: if `truncated && watermark > 0` → enter backfill: `set(BACKFILL_TARGET_KEY, String(maxDate))`, `set(BACKFILL_BEFORE_KEY, String(minDate))` (watermark pinned). Else → `set(WATERMARK_KEY, String(maxDate + 1))`; `watermarkAdvancedTo = maxDate + 1`.
  - Else (`!advanceOk` and `messages.length > 0`): existing hold-warn (unchanged).
- Truncation warning: keep firing when `truncated`, reworded (see Step 3).
- Idle backoff: set `IDLE_BACKOFF_KEY = nowMs` only when `messages.length === 0 && !backfillMode` (a mid-drain empty window completes the drain, it is not idle). Otherwise `set(IDLE_BACKOFF_KEY, EPOCH)`.
- Result `data` gains `backfill_active: boolean` (true when `backfillBefore > 0` after this run's writes, i.e. a drain is still in progress).

- [ ] **Step 1: Write the failing tests.** Append to `handler.test.ts`. Uses a `fetch` mock that returns pages by `received_before` window. Helper to build N summary messages:

```ts
// --- #1431 backfill drain ---
function sentMsg(id: string, date: number) {
  return { id, thread_id: '', subject: `s-${id}`, from: [{ email: 'ceo@x.com' }],
    to: [{ email: 'a@x.com' }], cc: [], snippet: '', date, unread: false, folders: ['SENT'], attachments: [] };
}

// Serve a fixed corpus newest-first, honoring received_after / received_before / limit / page_token.
// Cursor is the numeric index of the next message to return, encoded in the token.
function serveCorpus(mockFetch: ReturnType<typeof vi.spyOn>, corpus: Array<{ id: string; date: number }>) {
  const sorted = [...corpus].sort((a, b) => b.date - a.date); // newest-first
  mockFetch.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
    const u = new URL(String(url));
    if (u.pathname.includes('/messages/')) {
      // getMessage — not needed for these no-match tests, but answer safely.
      return new Response(JSON.stringify({ data: { id: 'x', date: 0, body: '', folders: ['SENT'] } }), { status: 200 });
    }
    const after = u.searchParams.get('received_after');
    const before = u.searchParams.get('received_before');
    const limit = Number(u.searchParams.get('limit') ?? '20');
    const token = u.searchParams.get('page_token');
    // Filter once; the cursor walks the filtered list.
    const filtered = sorted.filter((m) =>
      (after === null || m.date >= Number(after)) && (before === null || m.date <= Number(before)));
    const start = token ? Number(token) : 0;
    const slice = filtered.slice(start, start + limit);
    const nextStart = start + limit;
    const body: Record<string, unknown> = { data: slice.map((m) => sentMsg(m.id, m.date)) };
    if (nextStart < filtered.length) body.next_cursor = String(nextStart);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe('#1431 oldest-first backlog drain', () => {
  const BACKFILL_BEFORE_KEY = 'sent_observe.backfill_before';
  const BACKFILL_TARGET_KEY = 'sent_observe.backfill_target';

  it('drains a >SENT_MAX_SCAN backlog across runs with no message skipped', async () => {
    // 1100 messages, dates 1000..2099 (unique seconds), floor watermark = 999.
    const corpus = Array.from({ length: 1100 }, (_, i) => ({ id: `m${i}`, date: 1000 + i }));
    const handler = new CeoInboxSentObserveHandler();
    const mockFetch = vi.spyOn(globalThis, 'fetch');
    serveCorpus(mockFetch, corpus);

    const seed: Record<string, string> = { [WATERMARK_KEY]: '999' };
    const observedDates = new Set<number>();
    // Wrap serveCorpus to record which dates were returned in list responses.
    const origFetch = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url) => {
      const res = await origFetch(url);
      const clone = res.clone();
      const j = await clone.json().catch(() => null);
      if (j && Array.isArray(j.data)) for (const m of j.data) observedDates.add(m.date);
      return res;
    });

    // Run until backfill clears (guard against runaway).
    for (let run = 0; run < 10; run++) {
      const ctx = buildCtx({ seed, force: true, nowMs: 9_000_000_000_000, tasks: [] });
      // Carry config forward between runs.
      for (const [k, v] of Object.entries(seed)) ctx.__mem.__values.set(k, v);
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      for (const [k, v] of ctx.__mem.__values.entries()) seed[k] = v; // persist state
      if (!(Number(seed[BACKFILL_BEFORE_KEY] ?? '0') > 0)) break;
    }

    // Every message date must have been observed at least once.
    for (let d = 1000; d <= 2099; d++) expect(observedDates.has(d)).toBe(true);
    // Watermark ends past the newest; backfill keys cleared.
    expect(seed[WATERMARK_KEY]).toBe(String(2099 + 1));
    expect(Number(seed[BACKFILL_BEFORE_KEY] ?? '0')).toBe(0);
    expect(Number(seed[BACKFILL_TARGET_KEY] ?? '0')).toBe(0);
  });

  it('first-ever run (watermark 0) is forward-only — no backfill initiated', async () => {
    const corpus = Array.from({ length: 1100 }, (_, i) => ({ id: `m${i}`, date: 1000 + i }));
    const handler = new CeoInboxSentObserveHandler();
    const mockFetch = vi.spyOn(globalThis, 'fetch');
    serveCorpus(mockFetch, corpus);

    const ctx = buildCtx({ force: true, nowMs: 9_000_000_000_000, tasks: [] }); // no watermark seed → 0
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    // Advanced to the newest seen, NO backfill state written.
    expect(ctx.__mem.__values.get(WATERMARK_KEY)).toBe(String(2099 + 1));
    expect(ctx.__mem.__values.get(BACKFILL_BEFORE_KEY)).toBeUndefined();
    expect(ctx.__mem.__values.get(BACKFILL_TARGET_KEY)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests — expect FAIL** (backfill never initiated; drain test sees skipped dates / wrong watermark).

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill test skills/ceo-inbox-sent-observe/handler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `handler.ts`.**

Add exported constants near `WATERMARK_KEY`:
```ts
/** Descending `received_before` ceiling for an in-progress oldest-first backlog drain (#1431).
 *  Presence (a value > EPOCH) means a drain is underway; it walks toward WATERMARK across runs. */
export const BACKFILL_BEFORE_KEY = 'sent_observe.backfill_before';
/** Newest message date captured when a >SENT_MAX_SCAN backlog was detected (#1431). The watermark
 *  jumps to backfill_target + 1 only once the drain reaches the oldest sub-window. */
export const BACKFILL_TARGET_KEY = 'sent_observe.backfill_target';
```

Read backfill state right after `watermark` is computed:
```ts
    const backfillBeforeRaw = await store.get(CONFIG_NAMESPACE, BACKFILL_BEFORE_KEY);
    const backfillBefore = backfillBeforeRaw && Number.isFinite(Number(backfillBeforeRaw)) ? Number(backfillBeforeRaw) : 0;
    const backfillTargetRaw = await store.get(CONFIG_NAMESPACE, BACKFILL_TARGET_KEY);
    const backfillTarget = backfillTargetRaw && Number.isFinite(Number(backfillTargetRaw)) ? Number(backfillTargetRaw) : 0;
    // A drain is in progress iff a finite ceiling is stored. During a drain the watermark stays
    // pinned to its floor (the received_after bound) and only jumps to backfillTarget+1 on completion.
    const backfillActive = backfillBefore > 0;
```

Change the `listAllMessages` call to add the ceiling:
```ts
    const { messages, truncated } = await client.listAllMessages({
      folder: 'SENT',
      ...(watermark > 0 ? { receivedAfter: watermark } : {}),
      ...(backfillActive ? { receivedBefore: backfillBefore } : {}),
      maxScan: SENT_MAX_SCAN,
    });
```

Replace the watermark-advance block (the `if (messages.length > 0 && maxDate >= watermark && advanceOk) { ... } else if (...) { warn }` block) with:
```ts
    // Watermark / backfill state transition (#1431). advanceOk still gates everything: any
    // evidence-persist / guard / shadow failure holds ALL state (no watermark move, no backfill
    // move) so the same window is re-observed next run.
    let watermarkAdvancedTo: number | null = null;
    if (advanceOk) {
      if (backfillActive) {
        if (messages.length > 0 && truncated) {
          // Still an older tail below minDate — descend the ceiling; watermark stays pinned.
          // minDate (inclusive) re-scans the boundary second next run so a same-second group
          // split by the SENT_MAX_SCAN ceiling is never lost (re-processing is idempotent via
          // the matched/asked/reconciled guards).
          await store.set(CONFIG_NAMESPACE, BACKFILL_BEFORE_KEY, String(minDate));
        } else {
          // Drain complete (window fully scanned, or emptied). Jump the watermark past the newest
          // date captured when the backlog was detected, then clear the backfill keys.
          watermarkAdvancedTo = backfillTarget + 1;
          await store.set(CONFIG_NAMESPACE, WATERMARK_KEY, String(watermarkAdvancedTo));
          await store.set(CONFIG_NAMESPACE, BACKFILL_BEFORE_KEY, EPOCH);
          await store.set(CONFIG_NAMESPACE, BACKFILL_TARGET_KEY, EPOCH);
        }
      } else if (messages.length > 0) {
        if (truncated && watermark > 0) {
          // A real gap above a known floor exceeded the scan ceiling: begin an oldest-first drain.
          // Record the newest date (watermark jumps here on completion) and set the first ceiling
          // to this batch's oldest. The watermark is NOT advanced — it stays the drain's floor, so
          // it never sits above an un-drained message.
          await store.set(CONFIG_NAMESPACE, BACKFILL_TARGET_KEY, String(maxDate));
          await store.set(CONFIG_NAMESPACE, BACKFILL_BEFORE_KEY, String(minDate));
        } else {
          // Normal forward advance. Covers the non-truncated case AND the first-ever run
          // (watermark 0): forward-only observation, historical tail intentionally not backfilled.
          watermarkAdvancedTo = maxDate + 1;
          await store.set(CONFIG_NAMESPACE, WATERMARK_KEY, String(watermarkAdvancedTo));
        }
      }
    } else if (messages.length > 0) {
      const holdReason = !evidencePersisted
        ? 'ceo-inbox-sent-observe: evidence persistence failed — holding watermark for retry'
        : !draftEvidenceComplete
          ? 'ceo-inbox-sent-observe: draft body fetch failed — holding watermark for retry'
          : !shadowReconcileOk
            ? 'ceo-inbox-sent-observe: shadow reconcile failed — holding watermark for retry'
            : 'ceo-inbox-sent-observe: guard write failed — holding watermark for retry';
      ctx.log.warn(
        { path: PENDING_DIFFS_PATH, evidencePersisted, shadowReconcileOk, draftEvidenceComplete, matchedGuardPersisted, askedGuardPersisted },
        holdReason,
      );
    }
    // True when a drain is still underway after this run's writes (fed back to the caller/logs).
    const backfillStillActive = backfillActive
      ? watermarkAdvancedTo === null // descended (not completed)
      : (truncated && watermark > 0 && messages.length > 0); // just initiated
```

Reword the truncation warning block:
```ts
    if (truncated) {
      if (watermark > 0) {
        ctx.log.warn(
          { scanned: messages.length, maxScan: SENT_MAX_SCAN, floor: watermark,
            ceiling: backfillActive ? backfillBefore : null, nextCeiling: Number.isFinite(minDate) ? minDate : null,
            backfillTarget: backfillActive ? backfillTarget : maxDate },
          `ceo-inbox-sent-observe: Sent window exceeded the ${SENT_MAX_SCAN}-message scan ceiling — ` +
            'draining the older tail oldest-first across successive runs (backfill in progress).',
        );
      } else {
        ctx.log.warn(
          { scanned: messages.length, maxScan: SENT_MAX_SCAN, advancedTo: watermarkAdvancedTo },
          `ceo-inbox-sent-observe: first run against a large mailbox exceeded the ${SENT_MAX_SCAN}-message ` +
            'scan ceiling — observing forward-only; historical mail is intentionally not backfilled.',
        );
      }
    }
```

Change the idle-backoff block so a mid-drain empty window does not register as idle:
```ts
    if (messages.length === 0 && !backfillActive) {
      await store.set(CONFIG_NAMESPACE, IDLE_BACKOFF_KEY, String(nowMs));
    } else {
      await store.set(CONFIG_NAMESPACE, IDLE_BACKOFF_KEY, EPOCH);
    }
```

Add `backfill_active: backfillStillActive` to BOTH the early idle-backoff-skip `data` object and the final `data` object (the early skip is never mid-drain, so pass `false` there).

Update the `run complete` info log to include `backfillStillActive`.

- [ ] **Step 4: Run the tests — expect PASS** (both new tests).

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill test skills/ceo-inbox-sent-observe/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the pre-existing truncation test.** The test `on truncation advances forward and warns` runs at watermark 0 and asserts a forward advance + a warn. Under the new wording it still advances forward and still warns (the watermark-0 branch), so confirm it passes; if its warn-message assertion is substring-specific, update the substring to match the new watermark-0 message. Do NOT weaken its watermark-advance assertion. Add one assertion: `expect(ctx.__mem.__values.get('sent_observe.backfill_before')).toBeUndefined();`

- [ ] **Step 6: Run the whole sent-observe suite + typecheck.**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill test skills/ceo-inbox-sent-observe/`
Then: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit.**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill add skills/ceo-inbox-sent-observe/handler.ts skills/ceo-inbox-sent-observe/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill commit -s -m "fix(sent-observe): drain >SENT_MAX_SCAN Sent backlogs oldest-first (#1431)"
```

---

### Task 3: Version bump, changelog, doc note, PR

**Files:**
- Modify: `skills/ceo-inbox-sent-observe/skill.json` (patch `version` bump)
- Modify: `CHANGELOG.md` (under `## [Unreleased]` → `### Fixed`)
- Modify: `docs/adr/029-passive-email-observation-and-counterfactual-competence.md` (one line noting the oldest-first drain + forward-only first run), if it describes the truncation policy.

- [ ] **Step 1: Bump `skill.json` version** by one patch (e.g. `0.x.Y` → `0.x.(Y+1)`). Read the current value first.

- [ ] **Step 2: Add CHANGELOG entry** under `### Fixed` (≤15 words after the em-dash equivalent — use a period, no em dash):

```md
- **`ceo-inbox-sent-observe`** — drains Sent backlogs over `SENT_MAX_SCAN` oldest-first; first run stays forward-only. (#1431)
```

- [ ] **Step 3: ADR note.** If ADR-029 documents the "advance past the tail and warn" truncation policy, add a short note that a `>SENT_MAX_SCAN` post-downtime backlog is now drained oldest-first (`received_before` descending ceiling) while the first-ever run remains forward-only. Skip if ADR-029 does not mention the policy.

- [ ] **Step 4: Full targeted test + typecheck.**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill test skills/ceo-inbox-sent-observe/ skills/_shared/ceo-nylas-client.test.ts`
Then: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill run typecheck`

- [ ] **Step 5: Commit + run auto-review subagents (code-reviewer + silent-failure-hunter) before opening the PR.**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill add -A
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sent-observe-backfill commit -s -m "chore(sent-observe): version bump + changelog for oldest-first drain (#1431)"
```

- [ ] **Step 6: Push + open PR** with `Closes #1431` in the Summary, describing the pinned-floor/descending-ceiling drain and the forward-only first-run decision. Confirm CI started.

---

## Self-Review

- **Spec coverage:** Task 1 = `receivedBefore` client filter. Task 2 = the drain state machine (criteria 1, 2, 3, first-run). Task 2 tests cover the ≥2-run drain and the watermark-0 first run. Task 3 = version/changelog/docs. All spec sections mapped.
- **Placeholders:** none — every code step shows exact code.
- **Type consistency:** `BACKFILL_BEFORE_KEY` / `BACKFILL_TARGET_KEY` used identically in handler and tests; `receivedBefore` matches the client option name; `EPOCH` (`'0'`) is the existing handler constant.
- **Idempotency:** re-processing across the inclusive boundary and held-window retries is covered by the existing matched-draft / asked-task / shadow `reconciled_at` guards — no new idempotency surface introduced.
