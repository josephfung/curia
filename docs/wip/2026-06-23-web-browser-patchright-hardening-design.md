# Web-browser skill: bot-detection hardening (Patchright + human behavior)

**Issue:** [#1053](https://github.com/josephfung/curia/issues/1053)
**Date:** 2026-06-23
**Status:** Design — approved verbally, pending written spec review

## Problem

The web-browser skill is frequently blocked by edge bot-detection (Cloudflare Bot
Management, DataDome-style). The current stealth approach — `playwright-extra` +
`puppeteer-extra-plugin-stealth` — patches JS-surface signals but leaves
protocol-level signals exposed. Specifically, `puppeteer-extra-plugin-stealth` does
not close the CDP `Runtime.enable` leak that detection vendors use to flag
CDP-driven Chrome regardless of JS patches, and the plugin's own signature is widely
fingerprinted. The skill also drives pages with no behavioral telemetry (instant
clicks, instant fills, no dwell), which behavioral challenge JS scores as non-human.

This work builds on the real-Chrome fingerprint hardening from #987.

## Goals

1. Close the protocol-level gap by replacing the stealth stack with Patchright.
2. Add a human-behavior interaction layer (mouse, typing, dwell, presence).
3. Make the skill present human-like behavioral telemetry on every external navigation.
4. Recover from transient soft-blocks with one human-style reload before failing.
5. Keep persistent-profile, channel-fallback, incognito, ad-block, SSRF, and
   secret-redaction (#973) behavior unchanged.

## Non-goals (tracked separately per the issue)

Proxy/residential-IP support, WebRTC leak prevention, CAPTCHA solving, and the
browser-pool / managed-service migration. Out of scope here.

## Key context that shaped the design

- **Curia runs real Google Chrome in prod** via `channel: 'chrome'`
  (`curia-deploy/deploy/compose/Dockerfile.curia` runs `playwright install chrome`).
  Real Chrome natively emits a complete, mutually-consistent identity set — UA
  header, `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` client hints, and
  `navigator.userAgentData.brands` + `fullVersionList` — for the true binary version
  and OS. Playwright/Patchright do not strip these.
- The Pulse reference (`pulse/src/substack/SubstackAdapter.ts` + `cf-bypass.ts`),
  which reliably operates against Cloudflare, launches **bundled** Chromium (no
  `channel`), whose native brands say "Chromium" not "Google Chrome" — which is why
  Pulse must actively rewrite UA / client-hints / `userAgentData` to look like real
  Chrome. **Curia does not have that gap.** We therefore rely on real Chrome's native
  identity surfaces rather than porting Pulse's spoofing — see Item 5.
- `patchright@1.61.0` exactly matches Curia's `playwright@1.61.0`. Patchright is a
  drop-in Playwright fork; the rest of the codebase keeps typing against the
  `playwright` types via the existing `as unknown as BrowserContext` cast.
- `browser-service.test.ts` injects `contextFactory` directly, so it never exercises
  the real launch path. Swapping the stealth stack does not affect those tests.

## Design

### Item 1 — Replace the stealth stack with Patchright

In `src/browser/browser-service.ts`:

- Remove the imports of `chromium as stealthChromium` from `playwright-extra` and
  `StealthPlugin` from `puppeteer-extra-plugin-stealth`, and the module-load
  `stealthChromium.use(StealthPlugin())` registration.
- `import { chromium } from 'patchright'`. Both `launchPersistentContext` call sites
  (configured channel + bundled-Chromium fallback) use `chromium`.
- Launch flags: keep `--no-sandbox` and `--disable-dev-shm-usage` (container
  requirements). **Drop** `--disable-blink-features=AutomationControlled` — Patchright
  owns the `navigator.webdriver` / automation surface; stacking a flag it already
  manages is a documented anti-pattern. Add a code comment explaining the removal.
- Channel-fallback (`channelFallbackActive`), persistent-context model, Singleton
  lock and X11 lock cleanup, crash-recovery, and incognito logic are all unchanged.

`package.json`: add `patchright@1.61.0`, remove `playwright-extra` and
`puppeteer-extra-plugin-stealth`. Keep `playwright@1.61.0` (peer of Patchright; the
adblocker and type imports still use it). Sync the lockfile.

### Item 2 — Human-behavior module (`src/browser/human-behavior.ts`)

A standalone, page-driven module. Pure helpers carry the testable logic; the
page-driving functions wrap them. All randomness is injected via an `rng: () =>
number` parameter (default `Math.random`) so unit tests are deterministic.

**Mouse movement — curved/Bezier strategy.** A pure point-sequence generator models
a human cursor path:

```
type Point = { x: number; y: number };
interface MouseMoveStrategy {
  // Returns intermediate points from `from` to `to`, excluding `from`,
  // ending at (or very near) `to`. Pure — no I/O.
  path(from: Point, to: Point, rng: () => number): Point[];
}
```

- `bezierStrategy` (default): a quadratic/cubic Bezier with a randomized control
  point offset perpendicular to the straight line (the "arc"), **variable velocity**
  (ease-in/ease-out point spacing so the cursor accelerates then decelerates), a
  small **overshoot-and-correct** near the end, and per-point **tremor** (sub-pixel
  jitter). Step count scales with distance.
- `linearStrategy`: straight line with uniform spacing — kept as a fallback/baseline
  and to make the strategy seam real.

The generator is unit-tested as a pure function: start excluded, ends within a small
epsilon of the target, point count within expected bounds for a given distance,
deterministic for a seeded `rng`, and overshoot stays within a sane envelope.

**Page-driving functions:**

- `jitteredDelay(minMs, maxMs, { rng, sleep })` — randomized wait. Built on the pure
  `computeJitter(min, max, rng)`.
- `humanClick(page, locator, { rng, strategy })` — read the locator bounding box, aim
  at a random offset inside it (not dead center), drive the mouse along
  `strategy.path(...)` point-by-point with small inter-point delays, a short
  pre-click pause, then `locator.click()`. If the box is unavailable, fall back to a
  plain click (never throw from the behavior layer).
- `humanType(page, text, { rng })` — per-character `keyboard.type` with cadence from
  the pure `computeKeyDelay(char, rng)`: base inter-key delay, longer pauses after
  sentence/clause punctuation, occasional "thinking" pauses every 10–30 chars.
- `simulateHumanPresence(page, { rng, strategy })` — 3–5 curved mouse moves across the
  viewport with jittered pauses, a short scroll down, and a scroll back up.

These functions are best-effort: a failure inside the behavior layer (e.g. a missing
bounding box, a detached element mid-move) is caught and downgraded so it never fails
the underlying action.

### Item 3 — Post-navigation dwell + presence (always on)

In `skills/web-browser/handler.ts`, navigate path, **after** the existing
`networkidle` settle and the `isHardBlock` check (and only when not hard-blocked):

- `await jitteredDelay(2000, 4000)` then `await simulateHumanPresence(page)`.

No trusted-host bypass (decision: uniform on every external navigation). Internal /
private hosts are already rejected by the SSRF guard before navigation, so a bypass
would be dead code. The added latency (~3–6s) sits within the navigate path; the
existing 20s `goto` timeout + 5s networkidle are unchanged, and the dwell runs after
them, so it does not compete with the goto budget.

### Item 4 — Wire human behavior into click / type

- `click` → resolve locator, then `humanClick(page, locator)` instead of
  `locator.click()`.
- `type` → resolve locator, `humanClick` to focus the field, **clear** it
  (`Ctrl/Cmd+A` then `Delete`), then `humanType(page, fillValue)` — for **both** the
  visible-`text` path and the `secret_ref` path. The secret path still calls
  `session.registerInjectedSecret(fillValue)` before typing and sets
  `injectedSecretThisAction = true`. The #973 guarantees are unaffected: value-aware
  redaction scrubs reflected content + URL (not keystrokes), and the
  same-action screenshot suppression is keyed on `injectedSecretThisAction`, both
  independent of fill-vs-type. Clearing first preserves the old `fill()` semantics
  (replace, not append).
  - Platform-correct select-all: use Playwright's `ControlOrMeta+a` so it works on
    Linux (prod) and macOS (dev) — mirrors the Pulse reference.

### Item 5 — Fingerprint surfaces: rely on real Chrome's native set

No fingerprint module and no runtime verification layer. With `channel: 'chrome'`,
real Chrome already delivers a complete, internally-consistent identity set. The
work here is an **audit** that our launch path introduces no gaps and no
inconsistency:

- `buildContextOptions()` must **not** set a `userAgent` (a partial override would
  desync UA from `sec-ch-ua` + `userAgentData`). It already omits it — keep it that
  way and update the comment, which currently references the now-removed stealth
  plugin's "UA-override evasion."
- We set no `extraHTTPHeaders` that touch client hints, and add no `userAgentData`
  init script. We let Chrome emit all of UA, `sec-ch-ua`(+mobile+platform),
  `userAgentData.brands`, and `fullVersionList` natively.
- Document the decision in a code comment in `browser-service.ts`: we deliberately
  defer to real Chrome's native identity surfaces because they are coherent by
  construction; overriding any single surface without perfectly mirroring the others
  is the inconsistency detection keys on.

Acceptance-criteria coverage: the "verified mutually consistent" criterion is met by
a **documented manual check** against a fingerprint probe page (e.g. CreepJS /
browserleaks) noted in the PR, confirming UA major == `sec-ch-ua` major ==
`userAgentData` major, platform matches the host OS, and no `HeadlessChrome` / webdriver
tells. No code asserts this at runtime.

### Item 6 — Transient-block recovery (one reload-and-retry)

In the navigate path, replace the single hard-block decision with a one-shot
soft-block recovery:

- After load, compute a soft-block signal: `isHardBlock(title)` is true **or** the
  cleaned page content is empty/near-empty after the settle (a degraded/challenge
  page).
- On the **first** soft signal: `await jitteredDelay(...)` (human-style dwell),
  `await page.reload({ waitUntil: 'domcontentloaded' })`, re-run the settle, and
  re-evaluate. This is a single retry, not a loop.
- If the signal persists after the reload, return the existing hard-block error.
- If it was a genuine hard block both times, behavior is unchanged except for one
  extra reload + dwell.

This keeps the "fail fast, hand off" contract for truly undrivable sites while
giving transient CF soft-blocks the human-style second chance that works in Pulse.

### Item 7 — "Drive real UI, don't inject fetch()" guidance

- Code comment near the navigate/interaction dispatch in `handler.ts`: on protected
  sites, prefer real UI interaction (click/type/select) over `fetch()` inside
  `page.evaluate()` — the latter is blocked at the TLS/fingerprint layer even with
  valid cookies, because the request does not carry the browser's network fingerprint.
- One sentence in `skill.json`'s description reinforcing the same for the LLM.

## Testing

- **New `src/browser/human-behavior.test.ts`:**
  - `computeJitter` / `computeKeyDelay` ranges and determinism under a seeded `rng`.
  - `bezierStrategy.path`: excludes start, ends within epsilon of target, point count
    scales with distance, deterministic for seeded `rng`, overshoot bounded.
  - `humanClick` / `humanType` / `simulateHumanPresence` against a mock `Page`:
    assert the expected mouse/keyboard calls happen and that a thrown error in the
    behavior layer is swallowed (best-effort contract).
- **`skills/web-browser/handler.test.ts` additions:**
  - navigate triggers dwell + `simulateHumanPresence` (mockable seam).
  - `type` clears then human-types; `secret_ref` still registers the secret and
    suppresses the same-action screenshot.
  - soft-block → one reload → success path, and soft-block → reload → still-blocked →
    hard-block error path.
- **`browser-service.test.ts`:** unchanged contract; confirm green after the import
  swap (contextFactory-injected, stealth-stack-agnostic).
- Full suite green; `pnpm run typecheck` clean.

## Rollout / chores

- `skill.json`: **patch** version bump (hardening + infra; no new user-facing input).
- `CHANGELOG.md` under `[Unreleased]`: `Changed` (Patchright swap, human behavior) and
  `Security` (closes the CDP `Runtime.enable` protocol leak) entries, referencing #1053.
- Auto-review subagents before PR (code-reviewer, silent-failure-hunter); no auth /
  crypto surface touched, so no dedicated security review required beyond that.
- Manual before/after against a previously-blocking CF-protected site, captured in
  the PR description (acceptance criterion).

## Risks / open items

- **Pinned Chrome version:** resolved by Item 5 — we no longer pin a version, so
  there is nothing to keep in lockstep with the deploy image. Removed as a risk.
- **Latency:** always-on dwell adds ~3–6s per navigation. Accepted (per decision);
  revisit with a config bypass only if it bites real workflows.
- **Patchright maturity:** active project with a large stealth-community base; pinned
  to the exact `playwright` version we already run. Channel-fallback to bundled
  Chromium remains as a safety net.
- **Behavior layer reliability:** all behavior helpers are best-effort and must never
  fail the underlying action — enforced by tests.
