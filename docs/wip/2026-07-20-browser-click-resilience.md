# Web-browser click resilience — implementation plan

> **For agentic workers:** implement task-by-task, TDD, one commit per task.

**Goal:** Let the `web-browser` skill drive long, hostile forms (e.g. the
16personalities survey) to completion instead of stalling on covered clicks,
40-second dead-ref hangs, mid-flow session eviction, and futile retry loops.

**Architecture:** Five focused, interdependent changes across the browser skill
and its support layer. No new dependencies, no schema changes. All logic runs
in Node driving Playwright (NOT serialized into the page), so named helpers are
fine — the `keepNames`/`frame.evaluate` constraint that governs `dom-extract.ts`
does not apply here.

**Tech stack:** TypeScript (ESM), Playwright/patchright, Vitest, happy-dom.

## Root cause (from prod logs, conversation 00db93a8)

1. **Covered clicks.** 16P has a `position: sticky` navbar. Playwright scrolls a
   radio into view, it lands *under* the navbar, the navbar "intercepts pointer
   events", the real (non-force) click retries 10s and fails. The element is real
   and visible — just occluded. `force:true` does NOT fix this (a forced click at
   the covered coordinates hits the navbar); only repositioning does.
2. **40-second dead-ref hangs.** `resolveLocator` returns an unmatchable locator
   on 0/>1 ref matches; `humanClick`'s `boundingBox()` (no timeout → 30s) plus the
   10s click = ~40s per stale ref. The SPA re-renders as you answer (ref seq climbs
   past e519), orphaning refs constantly.
3. **Mid-flow session eviction.** 10-min idle TTL evicted the survey session,
   after which every call got a fresh blank session and every ref was unresolved.
4. **Futility loop.** Dozens of 10–40s failures drained the token budget →
   "I wasn't able to formulate a response."

## Global constraints

- Skills return `{ success }` shapes; the handler's outer try/catch already maps a
  throw to `{ success:false, error }`. `resolveLocator` throwing is therefore safe.
- No `console.log`; pino only. No `any`. `.js` import extensions.
- `humanClick` runs in Node — named inner functions are fine here.

---

## Task 1 — Reposition-and-retry on pointer interception (`human-behavior.ts`)

**Files:** `src/browser/human-behavior.ts`, `src/browser/human-behavior.test.ts`

When the real click throws because another element intercepts the pointer,
re-scroll the target to viewport center (`el.scrollIntoView({block:'center'})`)
and retry the click once. Center-positioning clears both top and bottom sticky
bars. If it still fails, surface the error (Task 5's guidance tells the agent to
scroll/dismiss).

- Detect interception via the Playwright error message ("intercepts pointer
  events") on the `click({timeout})` call.
- Reposition through `locator.evaluate(el => el.scrollIntoView({block:'center'}))`,
  small settle, retry the same visible/force branch once.
- Test: a locator whose first `click()` rejects with an "intercepts pointer
  events" TimeoutError, second resolves → assert `evaluate` (recenter) ran and the
  click ultimately succeeded. A locator that keeps intercepting → the error
  propagates (no infinite loop).

## Task 2 — Stale/ambiguous refs fail fast (`handler.ts`, `human-behavior.ts`)

**Files:** `skills/web-browser/handler.ts`, `skills/web-browser/handler.test.ts`,
`src/browser/human-behavior.ts`, `src/browser/human-behavior.test.ts`

- `resolveLocator`: on the ref fast-path, when total matches is 0 or >1, **throw**
  a clear error instead of returning the `[...][data-curia-ref-unresolved]` locator:
  - 0 → `Element ref "<ref>" is stale (the element is gone or the page re-rendered). Re-read the page with get_content to get fresh refs.`
  - \>1 → `Element ref "<ref>" is ambiguous (matched N elements). Re-read the page with get_content.`
  The handler's existing catch turns this into `{ success:false, error }` in ~1s.
- `humanClick`: cap `boundingBox()` at `1500ms` (`locator.boundingBox({ timeout: 1500 })`)
  as a backstop for an element that vanishes between resolve and click, so it can
  never eat the 30s default again.
- Tests: `resolveLocator` 0-match throws stale message; >1 throws ambiguous
  message; a valid single match still returns the locator. Existing bracket/ref
  tests updated for the throw contract.

## Task 3 — Longer idle TTL for long flows (`config/default.yaml`, `browser-service.ts`)

**Files:** `config/default.yaml`, `src/browser/browser-service.ts` (default only if
config-independent), `src/browser/browser-service.test.ts`

- Raise `browser.sessionTtlMs` default from `600000` (10 min) to `1800000` (30 min).
- Keep the code default in `BrowserServiceOptions` in sync (the `?? 600_000`).
- Test: a session is still live after 20 min of simulated idle (backdate
  `lastUsedAt` by 20 min, assert `getOrCreateSession` returns the same instance).

## Task 4 — Circuit-breaker on consecutive failures (`browser-session.ts`, `handler.ts`)

**Files:** `src/browser/browser-session.ts`, `skills/web-browser/handler.ts`,
`skills/web-browser/handler.test.ts`

- Add `consecutiveFailures = 0` to `BrowserSession`, with
  `recordFailure()` (++), `recordSuccess()` (= 0), and `isTripped(threshold)`.
- In `handler.execute`, after acquiring the session:
  - If the action is an **interaction** (`click`, `type`, `select`, `hover`,
    `wait_for`) and `session.isTripped(BREAKER_THRESHOLD)` (4), short-circuit with:
    `Stopping browser interaction: N actions failed in a row. Re-read the page with get_content, or hand off to the principal.` (No action attempted → cheap.)
  - `get_content` / `navigate` / `screenshot` / `scroll` / `press_key` /
    `close_session` always run (recovery paths).
  - On a successful action → `recordSuccess()`; in the catch → `recordFailure()`.
- The breaker turns a post-trip 40s hang into an instant error, and a successful
  re-read resets it so recovery is always possible.
- **Known limitation (follow-up):** the counter is per-session, so it only catches
  within-session futility. Task 3 keeps the session alive so the counter actually
  accumulates; true cross-session futility needs agent-task state the skill lacks.
- Tests: 4 failing clicks then a 5th click short-circuits without calling the page;
  a get_content between resets the counter so the next click is attempted again.

## Task 5 — Agent guidance for the residual (`skills/web-browser/skill.json`)

**Files:** `skills/web-browser/skill.json`

Extend the description so the agent knows how to recover from what the mechanism
can't auto-fix:
- If a click reports the target is covered/intercepted and auto-retry still fails,
  scroll the page or dismiss the overlay (cookie banner, modal, sticky bar) before
  retrying.
- If an action reports a ref is **stale**, call `get_content` to get fresh refs
  rather than retrying the same ref.
- Bump `version` (patch → this is behavioral hardening of an existing skill).

## Verification

- `pnpm -C <worktree> run typecheck` clean.
- New + existing browser tests green (`src/browser/*.test.ts`,
  `skills/web-browser/*.test.ts`).
- CHANGELOG `[Unreleased] → Fixed` / `Changed` entries (≤15 words each).
- Auto-review (code-reviewer + silent-failure-hunter) before PR.
