# Web-browser bot-detection hardening (Patchright + human behavior) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fingerprintable `playwright-extra` + stealth-plugin stack with Patchright, add a human-behavior interaction layer, and give the web-browser skill human-like telemetry + one-shot soft-block recovery, so it stops getting blocked by Cloudflare/DataDome-style edge detection.

**Architecture:** Patchright drops in for the launch path in `src/browser/browser-service.ts` (closing the CDP `Runtime.enable` protocol leak). A new pure-and-page-driving module `src/browser/human-behavior.ts` supplies curved-mouse, human-typing, dwell, and presence helpers. The skill handler (`skills/web-browser/handler.ts`) wires these into navigate (dwell + presence + one reload-retry), click (human click), and type (human click + clear + human type, including the `secret_ref` path). Fingerprint identity is left to real Chrome's native, coherent surfaces (no override).

**Tech Stack:** TypeScript (ESM, Node 24+), Patchright `1.61.0` (peer of `playwright 1.61.0`), Vitest, pnpm.

**Design spec:** `docs/wip/2026-06-23-web-browser-patchright-hardening-design.md`

## Global Constraints

- ESM only: `.js` extensions on all relative imports; `import.meta.dirname` not `__dirname`.
- No `any`. Skills return `{ success: true, data }` / `{ success: false, error }` — never throw out of `execute`.
- No `console.log`; use the injected pino logger (`ctx.log` in the handler).
- The behavior layer is **best-effort**: a failure inside any human-behavior helper must be swallowed and must never fail the underlying browser action.
- Preserve unchanged: persistent-profile + incognito session model, `channelFallbackActive` channel fallback, Singleton/X11 lock cleanup, crash recovery, ad-block opt-in, SSRF host gating, and all #973 secret-redaction + same-action screenshot-suppression guarantees.
- All randomness in `human-behavior.ts` is injected via an `rng: () => number` parameter (default `Math.random`); all sleeps via an injectable `sleep` (default real `setTimeout`). This is what makes the module unit-testable.
- Real Google Chrome (`channel: 'chrome'`) is the prod browser; **never set a partial `userAgent`/client-hint override** — rely on Chrome's native, mutually-consistent identity set.
- Commit messages: conventional (`feat:`/`fix:`/`chore:`/`docs:`). **No `Co-Authored-By` trailers, no Claude/AI attribution anywhere.**
- Run `pnpm -C <worktree> run typecheck` before each commit that touches `.ts`.
- Worktree: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053` (branch `feat/patchright-stealth-1053`). Use `pnpm -C <worktree>` and `git -C <worktree>` — never `cd &&`.

---

## File Structure

- **Modify** `package.json` — add `patchright@1.61.0`; remove `playwright-extra`, `puppeteer-extra-plugin-stealth`. (`pnpm-lock.yaml` synced.)
- **Modify** `src/browser/browser-service.ts` — swap imports to Patchright; drop `--disable-blink-features=AutomationControlled`; update fingerprint comment in `buildContextOptions`.
- **Create** `src/browser/human-behavior.ts` — pure helpers (`computeJitter`, `computeKeyDelay`), mouse strategies (`bezierStrategy`, `linearStrategy`), page-driving fns (`jitteredDelay`, `humanClick`, `humanType`, `simulateHumanPresence`).
- **Create** `src/browser/human-behavior.test.ts` — unit tests for the above.
- **Modify** `skills/web-browser/handler.ts` — navigate dwell/presence + soft-block reload; click → `humanClick`; type → `humanClick` + clear + `humanType`; guidance comments.
- **Modify** `skills/web-browser/handler.test.ts` — mock `human-behavior`; update #973 assertions (`fill` → `humanType`); add dwell/presence + soft-block + click tests.
- **Modify** `skills/web-browser/skill.json` — patch version bump + one-line "drive real UI" note.
- **Modify** `CHANGELOG.md` — `Changed` + `Security` entries under `[Unreleased]`.
- **Follow-up (separate repo)** `curia-deploy/deploy/compose/Dockerfile.curia` — add `patchright install chromium` so the bundled-Chromium fallback works (Task 6).

---

## Task 1: Swap the stealth stack for Patchright

**Files:**
- Modify: `package.json` (deps), `pnpm-lock.yaml`
- Modify: `src/browser/browser-service.ts:34-47` (imports + plugin registration), `:440-444` (launch args), `:386-398` (fingerprint comment)

**Interfaces:**
- Produces: nothing new exported. The module still launches via `chromium.launchPersistentContext(...)`; only the source of `chromium` changes (`patchright` instead of `playwright-extra`).

- [ ] **Step 1: Confirm the stealth packages are imported only by browser-service**

Run: `grep -rn "playwright-extra\|puppeteer-extra-plugin-stealth" src skills --include="*.ts"`
Expected: matches only in `src/browser/browser-service.ts` (lines ~34–35, ~47). If anything else matches, stop and reassess.

- [ ] **Step 2: Edit `package.json` dependencies**

In the `dependencies` block: remove the `"playwright-extra"` and `"puppeteer-extra-plugin-stealth"` lines; add `"patchright": "1.61.0"` (keep `"playwright": "^1.61.0"`). Keep alphabetical order if the block is sorted.

- [ ] **Step 3: Sync the lockfile**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 install`
Expected: completes; `pnpm-lock.yaml` now lists `patchright@1.61.0` and no longer lists `playwright-extra`/`puppeteer-extra-plugin-stealth`. If pnpm prompts about a new build script for `patchright`/`patchright-core`, set its `allowBuilds` value in `pnpm-workspace.yaml` to a boolean (`true`) — never placeholder text (CLAUDE.md). Do not hand-edit other `allowBuilds` values.

- [ ] **Step 4: Swap the imports in `browser-service.ts`**

Replace the two stealth imports (lines ~34–35):

```ts
import { chromium as stealthChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
```

with:

```ts
// Patchright is a drop-in Playwright fork that patches the protocol-level leaks the old
// stealth plugin couldn't reach — most importantly the CDP `Runtime.enable` /
// console / exec-context leaks detection vendors key on, plus Playwright's own header
// signatures. We keep the real-Chrome channel + persistent-context model unchanged; only
// the launcher changes. The rest of the file types against the 'playwright' BrowserContext
// (structurally identical), hence the existing `as unknown as BrowserContext` casts. (#1053)
import { chromium } from 'patchright';
```

- [ ] **Step 5: Remove the plugin registration**

Delete the comment block + line at ~42–47 that reads `stealthChromium.use(StealthPlugin());`. (Patchright needs no plugin registration.)

- [ ] **Step 6: Update the two launch call sites**

In `launchPersistentContext()` change both `stealthChromium.launchPersistentContext(...)` calls to `chromium.launchPersistentContext(...)` (keep the `as unknown as BrowserContext` casts and the channel/fallback logic exactly as-is).

- [ ] **Step 7: Drop the now-redundant automation flag**

In `baseOptions.args` (~440–444) remove the `'--disable-blink-features=AutomationControlled'` entry, leaving `--no-sandbox` and `--disable-dev-shm-usage`. Add a comment on the line above:

```ts
args: [
  // Patchright owns the navigator.webdriver / AutomationControlled surface, so we no
  // longer pass --disable-blink-features=AutomationControlled (stacking a flag it
  // manages is a documented anti-pattern). These two are container requirements. (#1053)
  '--no-sandbox',
  '--disable-dev-shm-usage',
],
```

- [ ] **Step 8: Update the fingerprint comment in `buildContextOptions`**

Replace the doc-comment above `buildContextOptions()` (~386–391) so it no longer references the removed stealth plugin and records the real-Chrome decision:

```ts
/**
 * Fingerprint/context options shared by the persistent context and any incognito context.
 * We deliberately DO NOT set userAgent (or any sec-ch-ua / userAgentData override): with
 * the real Chrome channel, Chrome natively emits a COMPLETE, mutually-consistent identity
 * set (UA + client hints + userAgentData) for the true binary version and OS. Overriding
 * any single surface without perfectly mirroring the others manufactures exactly the
 * inconsistency detection keys on — and a hardcoded UA goes stale into a bot tell (#987).
 * timezoneId is set only when a timezone is configured, aligning the context with the
 * principal. (#1053)
 */
```

- [ ] **Step 9: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 run typecheck`
Expected: PASS (no references to the removed packages remain).

- [ ] **Step 10: Run the existing browser-service tests**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run src/browser/browser-service.test.ts | tail -30`
Expected: PASS. (Tests inject `contextFactory`, so the launcher swap is transparent to them; this confirms the import swap didn't break module load.)

- [ ] **Step 11: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 add package.json pnpm-lock.yaml pnpm-workspace.yaml src/browser/browser-service.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 commit -m "feat: swap web-browser stealth stack for Patchright (#1053)"
```

(If `pnpm-workspace.yaml` was not modified in Step 3, omit it from the `add`.)

---

## Task 2: human-behavior pure core (helpers + mouse strategies)

**Files:**
- Create: `src/browser/human-behavior.ts`
- Test: `src/browser/human-behavior.test.ts`

**Interfaces:**
- Produces:
  - `type Rng = () => number`
  - `interface Point { x: number; y: number }`
  - `interface MouseMoveStrategy { path(from: Point, to: Point, rng?: Rng): Point[] }`
  - `const bezierStrategy: MouseMoveStrategy` (default), `const linearStrategy: MouseMoveStrategy`
  - `function computeJitter(minMs: number, maxMs: number, rng?: Rng): number`
  - `function computeKeyDelay(char: string, rng?: Rng): number`

- [ ] **Step 1: Write the failing test**

Create `src/browser/human-behavior.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  computeJitter,
  computeKeyDelay,
  bezierStrategy,
  linearStrategy,
  type Point,
} from './human-behavior.js';

// Deterministic PRNG so path/jitter assertions are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('computeJitter', () => {
  it('returns min + fraction*(max-min) for a fixed rng', () => {
    expect(computeJitter(100, 200, () => 0.5)).toBe(150);
  });
  it('stays within [min, max]', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = computeJitter(50, 80, rng);
      expect(v).toBeGreaterThanOrEqual(50);
      expect(v).toBeLessThanOrEqual(80);
    }
  });
  it('tolerates swapped bounds', () => {
    expect(computeJitter(200, 100, () => 0)).toBe(100);
  });
});

describe('computeKeyDelay', () => {
  it('base delay for a normal char is 30-80ms', () => {
    expect(computeKeyDelay('a', () => 0)).toBe(30);
    expect(computeKeyDelay('a', () => 1)).toBe(80);
  });
  it('adds a longer pause after sentence punctuation', () => {
    // base(0) + sentence(0) lower bound = 30 + 100 = 130
    expect(computeKeyDelay('.', () => 0)).toBe(130);
  });
  it('adds a medium pause after clause punctuation', () => {
    expect(computeKeyDelay(',', () => 0)).toBe(80); // 30 + 50
  });
});

describe('bezierStrategy.path', () => {
  const from: Point = { x: 0, y: 0 };
  const to: Point = { x: 100, y: 100 };

  it('excludes the start and ends exactly on the target', () => {
    const pts = bezierStrategy.path(from, to, () => 0.5);
    expect(pts[0]).not.toEqual(from);
    expect(pts[pts.length - 1]).toEqual(to);
  });
  it('produces a bounded number of points that scales with distance', () => {
    const pts = bezierStrategy.path(from, to, () => 0.5);
    expect(pts.length).toBeGreaterThanOrEqual(8);
    expect(pts.length).toBeLessThanOrEqual(60);
  });
  it('is deterministic for a seeded rng', () => {
    const a = bezierStrategy.path(from, to, mulberry32(42));
    const b = bezierStrategy.path(from, to, mulberry32(42));
    expect(a).toEqual(b);
  });
  it('keeps every point within a sane envelope (overshoot/arc bounded)', () => {
    const pts = bezierStrategy.path(from, to, mulberry32(7));
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(160);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(160);
    }
  });
  it('returns a single target point for a zero-length move', () => {
    expect(bezierStrategy.path({ x: 5, y: 5 }, { x: 5, y: 5 }, () => 0.5)).toEqual([{ x: 5, y: 5 }]);
  });
});

describe('linearStrategy.path', () => {
  it('ends on the target with uniform spacing', () => {
    const pts = linearStrategy.path({ x: 0, y: 0 }, { x: 40, y: 0 }, () => 0.5);
    expect(pts[pts.length - 1]).toEqual({ x: 40, y: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run src/browser/human-behavior.test.ts | tail -20`
Expected: FAIL — cannot resolve `./human-behavior.js`.

- [ ] **Step 3: Write the pure core**

Create `src/browser/human-behavior.ts`:

```ts
// src/browser/human-behavior.ts — human-like browsing behavior for the web-browser skill.
//
// Behavioral bot-detection (Cloudflare Bot Management, DataDome) scores mouse/keyboard
// telemetry: whether plausible movement exists at all, and whether it looks mechanical
// (teleporting cursors, constant velocity, instant fills). These helpers add the telemetry
// real users emit. The pure functions (computeJitter/computeKeyDelay/<strategy>.path) carry
// the testable logic; the page-driving functions wrap them. All randomness is injected via
// `rng` and all sleeps via `sleep` so the logic is deterministic under test. (#1053)

export type Rng = () => number;

export interface Point {
  x: number;
  y: number;
}

export interface MouseMoveStrategy {
  /** Intermediate points from `from` to `to`, EXCLUDING `from`, ending exactly on `to`. Pure. */
  path(from: Point, to: Point, rng?: Rng): Point[];
}

/** Cubic ease-in-out — concentrates points at the ends, thinning the middle (variable velocity). */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Straight line, uniform spacing. Baseline / fallback strategy. */
export const linearStrategy: MouseMoveStrategy = {
  path(from, to) {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 1) return [{ x: to.x, y: to.y }];
    const steps = Math.max(2, Math.min(40, Math.round(dist / 10)));
    const pts: Point[] = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
    pts[pts.length - 1] = { x: to.x, y: to.y };
    return pts;
  },
};

/**
 * Curved cursor path: a quadratic Bezier with a randomized perpendicular arc, variable
 * velocity (ease-in-out point spacing), a small overshoot-and-correct near the end, and
 * sub-pixel tremor on intermediate points. The final point is forced exactly onto `to`.
 */
export const bezierStrategy: MouseMoveStrategy = {
  path(from, to, rng = Math.random) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return [{ x: to.x, y: to.y }];

    const steps = Math.max(8, Math.min(60, Math.round(dist / 8) + Math.floor(rng() * 6)));

    // Control point: midpoint pushed perpendicular to the straight line for a natural arc.
    const px = -dy / dist;
    const py = dx / dist;
    const arc = (rng() - 0.5) * dist * 0.3;
    const cx = from.x + dx * 0.5 + px * arc;
    const cy = from.y + dy * 0.5 + py * arc;

    // Aim slightly past the target so the tail "overshoots", then snaps back to `to`.
    const overshoot = Math.min(dist * 0.05, 8) * rng();
    const ox = to.x + (dx / dist) * overshoot;
    const oy = to.y + (dy / dist) * overshoot;

    const pts: Point[] = [];
    for (let i = 1; i <= steps; i++) {
      const t = easeInOut(i / steps);
      const mt = 1 - t;
      let x = mt * mt * from.x + 2 * mt * t * cx + t * t * ox;
      let y = mt * mt * from.y + 2 * mt * t * cy + t * t * oy;
      if (i < steps) {
        x += (rng() - 0.5) * 1.5;
        y += (rng() - 0.5) * 1.5;
      }
      pts.push({ x, y });
    }
    pts[pts.length - 1] = { x: to.x, y: to.y };
    return pts;
  },
};

/** Randomized delay in ms within [min, max] (bounds tolerated in either order). */
export function computeJitter(minMs: number, maxMs: number, rng: Rng = Math.random): number {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return lo + rng() * (hi - lo);
}

/** Per-character keystroke delay: 30-80ms base, longer after sentence/clause punctuation. */
export function computeKeyDelay(char: string, rng: Rng = Math.random): number {
  let delay = 30 + rng() * 50;
  if ('.!?'.includes(char)) delay += 100 + rng() * 200;
  else if (',;:'.includes(char)) delay += 50 + rng() * 100;
  return delay;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run src/browser/human-behavior.test.ts | tail -20`
Expected: PASS (all describe blocks for the pure core).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 run typecheck`
Expected: PASS.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 add src/browser/human-behavior.ts src/browser/human-behavior.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 commit -m "feat: add human-behavior pure core (jitter, key cadence, mouse paths) (#1053)"
```

---

## Task 3: human-behavior page-driving functions

**Files:**
- Modify: `src/browser/human-behavior.ts` (append page-driving fns)
- Modify: `src/browser/human-behavior.test.ts` (append page-driving tests)

**Interfaces:**
- Consumes: `Rng`, `Point`, `MouseMoveStrategy`, `bezierStrategy`, `computeJitter`, `computeKeyDelay` (Task 2).
- Produces:
  - `interface BehaviorOptions { rng?: Rng; sleep?: (ms: number) => Promise<void>; strategy?: MouseMoveStrategy }`
  - `function jitteredDelay(minMs: number, maxMs: number, opts?: BehaviorOptions): Promise<void>`
  - `function humanClick(page: Page, locator: Locator, opts?: BehaviorOptions): Promise<void>`
  - `function humanType(page: Page, text: string, opts?: BehaviorOptions): Promise<void>`
  - `function simulateHumanPresence(page: Page, opts?: BehaviorOptions): Promise<void>`

- [ ] **Step 1: Write the failing tests (append to `human-behavior.test.ts`)**

```ts
import { vi } from 'vitest';
import type { Page, Locator } from 'playwright';
import {
  jitteredDelay,
  humanClick,
  humanType,
  simulateHumanPresence,
} from './human-behavior.js';

const noopSleep = () => Promise.resolve();

describe('jitteredDelay', () => {
  it('sleeps for the computed jitter and resolves', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await jitteredDelay(100, 100, { sleep, rng: () => 0.5 });
    expect(sleep).toHaveBeenCalledWith(100);
  });
});

describe('humanType', () => {
  it('types each character via the keyboard', async () => {
    const type = vi.fn().mockResolvedValue(undefined);
    const page = { keyboard: { type } } as unknown as Page;
    await humanType(page, 'ab.', { sleep: noopSleep, rng: () => 0 });
    expect(type).toHaveBeenCalledTimes(3);
    expect(type).toHaveBeenNthCalledWith(1, 'a', { delay: 0 });
    expect(type).toHaveBeenNthCalledWith(3, '.', { delay: 0 });
  });
});

describe('humanClick', () => {
  function mockPage() {
    return {
      mouse: { move: vi.fn().mockResolvedValue(undefined) },
      viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    } as unknown as Page;
  }
  it('moves the cursor along a path, then clicks', async () => {
    const page = mockPage();
    const click = vi.fn().mockResolvedValue(undefined);
    const locator = {
      boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 100, height: 40 }),
      click,
    } as unknown as Locator;
    await humanClick(page, locator, { sleep: noopSleep, rng: () => 0.5 });
    expect((page.mouse.move as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('still clicks when the bounding box is unavailable (best-effort)', async () => {
    const page = mockPage();
    const click = vi.fn().mockResolvedValue(undefined);
    const locator = {
      boundingBox: vi.fn().mockRejectedValue(new Error('detached')),
      click,
    } as unknown as Locator;
    await humanClick(page, locator, { sleep: noopSleep, rng: () => 0.5 });
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('simulateHumanPresence', () => {
  it('moves the mouse and scrolls without throwing', async () => {
    const page = {
      mouse: { move: vi.fn().mockResolvedValue(undefined), wheel: vi.fn().mockResolvedValue(undefined) },
      viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    } as unknown as Page;
    await simulateHumanPresence(page, { sleep: noopSleep, rng: () => 0.5 });
    expect((page.mouse.wheel as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
  it('swallows errors from the page (best-effort)', async () => {
    const page = {
      mouse: { move: vi.fn().mockRejectedValue(new Error('boom')), wheel: vi.fn() },
      viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    } as unknown as Page;
    await expect(simulateHumanPresence(page, { sleep: noopSleep, rng: () => 0.5 })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run src/browser/human-behavior.test.ts | tail -20`
Expected: FAIL — `jitteredDelay`/`humanClick`/`humanType`/`simulateHumanPresence` are not exported.

- [ ] **Step 3: Append the page-driving functions to `human-behavior.ts`**

Add at the top of the imports section:

```ts
import type { Page, Locator } from 'playwright';
```

Append after the pure core:

```ts
export interface BehaviorOptions {
  rng?: Rng;
  sleep?: (ms: number) => Promise<void>;
  strategy?: MouseMoveStrategy;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Randomized wait within [minMs, maxMs]. */
export async function jitteredDelay(
  minMs: number,
  maxMs: number,
  opts: BehaviorOptions = {},
): Promise<void> {
  const { rng = Math.random, sleep = defaultSleep } = opts;
  await sleep(computeJitter(minMs, maxMs, rng));
}

/**
 * Type `text` character-by-character with human cadence: per-key delay, longer pauses after
 * punctuation, and an occasional "thinking" pause every 10-30 chars. Drives page.keyboard,
 * so the caller must focus the target first.
 */
export async function humanType(page: Page, text: string, opts: BehaviorOptions = {}): Promise<void> {
  const { rng = Math.random, sleep = defaultSleep } = opts;
  let sinceLastPause = 0;
  let pauseThreshold = 10 + Math.floor(rng() * 20);
  for (const char of text) {
    await page.keyboard.type(char, { delay: 0 });
    let delay = computeKeyDelay(char, rng);
    if (++sinceLastPause >= pauseThreshold) {
      delay += 150 + rng() * 250;
      sinceLastPause = 0;
      pauseThreshold = 10 + Math.floor(rng() * 20);
    }
    await sleep(delay);
  }
}

/**
 * Move the cursor to a random point inside the locator's box along a curved path, pause,
 * then click. The cursor "arrives from" a random viewport point so the path is a real curve
 * rather than a teleport. Best-effort: any movement failure is swallowed and we still click.
 */
export async function humanClick(page: Page, locator: Locator, opts: BehaviorOptions = {}): Promise<void> {
  const { rng = Math.random, sleep = defaultSleep, strategy = bezierStrategy } = opts;
  try {
    const box = await locator.boundingBox();
    if (box) {
      const vp = page.viewportSize() ?? { width: 1280, height: 720 };
      const from: Point = { x: rng() * vp.width, y: rng() * vp.height };
      const target: Point = {
        x: box.x + box.width * (0.3 + rng() * 0.4),
        y: box.y + box.height * (0.3 + rng() * 0.4),
      };
      for (const p of strategy.path(from, target, rng)) {
        await page.mouse.move(p.x, p.y);
      }
      await sleep(computeJitter(80, 200, rng));
    }
  } catch {
    // Best-effort: never let the movement layer fail the click.
  }
  await locator.click({ timeout: 10_000 });
}

/**
 * Simulate casual browsing before the first meaningful interaction: a few curved mouse moves
 * across the viewport plus a short scroll down and back up. Best-effort — must never fail the
 * caller's navigation.
 */
export async function simulateHumanPresence(page: Page, opts: BehaviorOptions = {}): Promise<void> {
  const { rng = Math.random, sleep = defaultSleep, strategy = bezierStrategy } = opts;
  try {
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    let current: Point = { x: rng() * vp.width, y: rng() * vp.height };
    const moves = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < moves; i++) {
      const target: Point = { x: 50 + rng() * (vp.width - 100), y: 50 + rng() * (vp.height - 100) };
      for (const p of strategy.path(current, target, rng)) {
        await page.mouse.move(p.x, p.y);
      }
      current = target;
      await jitteredDelay(150, 400, { rng, sleep });
    }
    await page.mouse.wheel(0, 100 + rng() * 200);
    await jitteredDelay(300, 800, { rng, sleep });
    await page.mouse.wheel(0, -(100 + rng() * 200));
    await jitteredDelay(200, 500, { rng, sleep });
  } catch {
    // Best-effort: presence simulation must never fail the navigation.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run src/browser/human-behavior.test.ts | tail -20`
Expected: PASS (pure core + page-driving).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 run typecheck`
Expected: PASS.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 add src/browser/human-behavior.ts src/browser/human-behavior.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 commit -m "feat: add human-behavior page-driving helpers (click/type/presence/dwell) (#1053)"
```

---

## Task 4: Navigate hardening — dwell + presence + one soft-block reload

**Files:**
- Modify: `skills/web-browser/handler.ts` (imports + navigate case ~124-172; add `isLikelyEmpty` helper)
- Modify: `skills/web-browser/handler.test.ts` (add module mock + `reload` to mock page + new tests)

**Interfaces:**
- Consumes: `jitteredDelay`, `simulateHumanPresence` from `../../src/browser/human-behavior.js`; existing `isHardBlock(title)`.
- Produces: a new module-private `async function isLikelyEmpty(page: Page): Promise<boolean>`.

- [ ] **Step 1: Add the human-behavior module mock + extend the mock page (test file)**

At the **top** of `handler.test.ts`, immediately after the existing imports, add:

```ts
// Mock the human-behavior module so dwell/presence/click/type are observable spies with no
// real delays. Hoisted by vitest; the handler imports these and gets the spies. (#1053)
vi.mock('../../src/browser/human-behavior.js', () => ({
  jitteredDelay: vi.fn().mockResolvedValue(undefined),
  simulateHumanPresence: vi.fn().mockResolvedValue(undefined),
  humanClick: vi.fn().mockResolvedValue(undefined),
  humanType: vi.fn().mockResolvedValue(undefined),
}));

import {
  jitteredDelay,
  simulateHumanPresence,
  humanClick,
  humanType,
} from '../../src/browser/human-behavior.js';
```

In `makeMockPage`, add a `reload` spy and a `keyboard.type` spy (so later tasks and the soft-block path have them). Change the `keyboard` line and add `reload`:

```ts
    keyboard: { press: vi.fn().mockResolvedValue(undefined), type: vi.fn().mockResolvedValue(undefined) },
    mouse: { wheel: vi.fn().mockResolvedValue(undefined), move: vi.fn().mockResolvedValue(undefined) },
    reload: vi.fn().mockResolvedValue({ status: () => 200 }),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
```

Add a `beforeEach` near the top-level (after the mock import) to reset the spies between tests:

```ts
import { beforeEach } from 'vitest';
beforeEach(() => {
  vi.mocked(jitteredDelay).mockClear();
  vi.mocked(simulateHumanPresence).mockClear();
  vi.mocked(humanClick).mockClear();
  vi.mocked(humanType).mockClear();
});
```

- [ ] **Step 2: Write the failing tests (append a new describe block to `handler.test.ts`)**

```ts
describe('web-browser navigate hardening — dwell + soft-block reload (#1053)', () => {
  function makeNavCtx(page: ReturnType<typeof makeMockPage>) {
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const browserService = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-nav', session }),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserService;
    return {
      input: { action: 'navigate', url: 'https://example.com' },
      log: logger,
      browserService,
    } as unknown as SkillContext;
  }

  it('dwells and simulates presence after a clean navigation', async () => {
    const fill = vi.fn();
    const page = makeMockPage('Example Domain content here for a normal page', fill, 'https://example.com/');
    const ctx = makeNavCtx(page);

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(vi.mocked(simulateHumanPresence)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(jitteredDelay)).toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('reloads once on a soft block, then succeeds when the reload clears it', async () => {
    const fill = vi.fn();
    const page = makeMockPage('content', fill, 'https://shop.example.com/');
    // First title read = CF challenge; after reload = clean page.
    page.title = vi.fn()
      .mockResolvedValueOnce('Just a moment...')
      .mockResolvedValue('Shop — Home');
    const ctx = makeNavCtx(page);

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(simulateHumanPresence)).toHaveBeenCalledTimes(1);
  });

  it('returns a hard-block error when the soft block persists after the reload', async () => {
    const fill = vi.fn();
    const page = makeMockPage('content', fill, 'https://walled.example.com/', { title: 'Access Denied' });
    const ctx = makeNavCtx(page);

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(page.reload).toHaveBeenCalledTimes(1);
    if (!result.success) expect(result.error).toMatch(/blocked automated access/i);
    // No presence simulation once we've declared the page undrivable.
    expect(vi.mocked(simulateHumanPresence)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run skills/web-browser/handler.test.ts -t "navigate hardening" | tail -30`
Expected: FAIL — no dwell/reload behavior yet (`simulateHumanPresence` not called; `reload` not called).

- [ ] **Step 4: Add the import + `isLikelyEmpty` helper to `handler.ts`**

After the `extractFrameContent` import (line ~16) add:

```ts
import { jitteredDelay, simulateHumanPresence, humanClick, humanType } from '../../src/browser/human-behavior.js';
```

Near `isHardBlock` (~363) add:

```ts
// A near-empty body after load is a soft-block tell (CF/JS challenge serving a stub page),
// distinct from isHardBlock's title match. Best-effort: an evaluate failure is treated as
// "not empty" so we never reload on a transient read error. (#1053)
async function isLikelyEmpty(page: Page): Promise<boolean> {
  try {
    const len = await page.evaluate(() => (document.body?.innerText ?? '').trim().length);
    return typeof len === 'number' && len < 50;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Rework the navigate case to add soft-block recovery + dwell**

Replace the block in the `navigate` case from the `const response = await page.goto(...)` line through the `if (isHardBlock(pageTitle)) { ... }` block (~145-170) with:

```ts
          const response = await page.goto(parsedUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch((err) => {
            ctx.log.debug({ err, sessionId }, 'networkidle not reached after navigate — proceeding with current DOM');
          });

          const readTitle = async (): Promise<string> => {
            try {
              return await page.title();
            } catch (err) {
              ctx.log.debug({ err, sessionId }, 'Could not read page title for block check');
              return '';
            }
          };

          // Soft-block recovery: a CF/DataDome soft block often clears on a second,
          // human-paced load. Before declaring the site undrivable, dwell like a human and
          // reload ONCE if the page looks blocked or served a near-empty stub. One retry,
          // not a loop. (#1053)
          let pageTitle = await readTitle();
          if (isHardBlock(pageTitle) || (await isLikelyEmpty(page))) {
            ctx.log.info({ sessionId, url: parsedUrl.toString(), pageTitle }, 'Soft block suspected — dwelling and reloading once');
            await jitteredDelay(1500, 3000);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch((err) => {
              ctx.log.debug({ err, sessionId }, 'Reload during soft-block recovery failed — proceeding with current DOM');
            });
            await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
            pageTitle = await readTitle();
          }

          // Fail fast on a hard edge block that survived the reload (IP/edge-level — retrying
          // won't help). Surface a distinct, actionable error rather than an empty page.
          const status = response?.status();
          if (isHardBlock(pageTitle)) {
            ctx.log.warn({ sessionId, url: parsedUrl.toString(), status, pageTitle }, 'Navigation hit a hard edge block');
            return {
              success: false,
              error: `Site blocked automated access (HTTP ${status ?? '?'}${pageTitle ? `, "${pageTitle}"` : ''}). This site can't be driven from the server — hand off to the principal or draft the request instead.`,
            };
          }

          // Clean (or recovered) navigation: dwell + simulate human presence so behavioral
          // challenge JS can score human-like telemetry before the first interaction. (#1053)
          await jitteredDelay(2000, 4000);
          await simulateHumanPresence(page);
          break;
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run skills/web-browser/handler.test.ts -t "navigate hardening" | tail -30`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full handler test file (catch regressions in existing navigate/hard-block tests)**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run skills/web-browser/handler.test.ts | tail -40`
Expected: PASS. The existing hard-block tests now also call `reload` once (constant block title ⇒ still blocked ⇒ same error); the `block_ads/incognito` test still asserts the forwarded flags. If a pre-existing hard-block test asserts `goto` call count, relax it to allow the added reload (note it in the commit). 

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 run typecheck`
Expected: PASS.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 add skills/web-browser/handler.ts skills/web-browser/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 commit -m "feat: navigate dwell + presence + one soft-block reload-retry (#1053)"
```

---

## Task 5: Wire human behavior into click + type

**Files:**
- Modify: `skills/web-browser/handler.ts` (click case ~174-184; type case ~232-270)
- Modify: `skills/web-browser/handler.test.ts` (update #973 assertions `fill` → `humanType`; add a click test)

**Interfaces:**
- Consumes: `humanClick`, `humanType` (imported in Task 4).

- [ ] **Step 1: Update the existing #973 + literal-text assertions and add a click test**

In `handler.test.ts`:

- Line ~112 — replace `expect(fill).toHaveBeenCalledWith(SECRET_VALUE);` with:
  ```ts
  expect(vi.mocked(humanType)).toHaveBeenCalledWith(expect.anything(), SECRET_VALUE, expect.anything());
  ```
- Line ~186 (`both text and secret_ref`) — replace `expect(fill).not.toHaveBeenCalled();` with:
  ```ts
  expect(vi.mocked(humanType)).not.toHaveBeenCalled();
  ```
- Line ~207 (`resolver capability absent`) — replace `expect(fill).not.toHaveBeenCalled();` with:
  ```ts
  expect(vi.mocked(humanType)).not.toHaveBeenCalled();
  ```
- Line ~218 (`literal text fill`) — replace `expect(fill).toHaveBeenCalledWith('hello world');` with:
  ```ts
  expect(vi.mocked(humanType)).toHaveBeenCalledWith(expect.anything(), 'hello world', expect.anything());
  ```

Append a click test to the existing interaction describe block (or a new one):

```ts
describe('web-browser click uses human behavior (#1053)', () => {
  it('routes click through humanClick', async () => {
    const fill = vi.fn();
    const page = makeMockPage('page body content for the click target test', fill, 'https://example.com/');
    const session = new BrowserSession({} as unknown as BrowserContext, page as unknown as Page);
    const ctx = {
      input: { action: 'click', selector: 'Submit button' },
      log: logger,
      browserService: {
        getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: 'sess-click', session }),
        closeSession: vi.fn(),
      } as unknown as BrowserService,
    } as unknown as SkillContext;

    const result = await new WebBrowserHandler().execute(ctx);

    expect(result.success).toBe(true);
    expect(vi.mocked(humanClick)).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run skills/web-browser/handler.test.ts | tail -40`
Expected: FAIL — `humanClick`/`humanType` not yet called by the handler (and the updated `fill` assertions now fail against the unchanged handler).

- [ ] **Step 3: Wire `humanClick` into the click case**

In `handler.ts` click case (~178-179) replace:

```ts
          const clickTarget = await resolveLocator(page, selector, ctx.log);
          await clickTarget.click();
```

with:

```ts
          const clickTarget = await resolveLocator(page, selector, ctx.log);
          // Human-style cursor approach + pre-click pause, then click — gives behavioral
          // detection plausible mouse telemetry instead of a teleport-and-click. (#1053)
          await humanClick(page, clickTarget);
```

- [ ] **Step 4: Wire `humanClick` + clear + `humanType` into the type case**

In `handler.ts` type case, replace the final two lines (~267-268):

```ts
          const typeTarget = await resolveLocator(page, selector, ctx.log);
          await typeTarget.fill(fillValue);
```

with:

```ts
          const typeTarget = await resolveLocator(page, selector, ctx.log);
          // Focus the field with a human cursor approach, clear any existing content (fill()
          // used to replace; humanType appends), then type with human cadence. Applies to BOTH
          // the visible-text and secret_ref paths — the value was already registered for
          // redaction above, and redaction scrubs reflected content/URL, not keystrokes, so
          // the #973 guarantees are unaffected by fill()→type. (#1053)
          await humanClick(page, typeTarget);
          // ControlOrMeta = Cmd on macOS (dev), Ctrl on Linux (prod).
          await page.keyboard.press('ControlOrMeta+a');
          await page.keyboard.press('Delete');
          await humanType(page, fillValue);
```

- [ ] **Step 5: Run the handler tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run skills/web-browser/handler.test.ts | tail -40`
Expected: PASS (all describe blocks, including the updated #973 tests and the new click test).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 run typecheck`
Expected: PASS.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 add skills/web-browser/handler.ts skills/web-browser/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 commit -m "feat: human click + clear + human type for web-browser click/type actions (#1053)"
```

---

## Task 6: Guidance comments, skill.json note, version bump, CHANGELOG, deploy follow-up

**Files:**
- Modify: `skills/web-browser/handler.ts` (guidance comment)
- Modify: `skills/web-browser/skill.json` (version + description note)
- Modify: `CHANGELOG.md`
- Follow-up (separate repo): `curia-deploy/deploy/compose/Dockerfile.curia`

- [ ] **Step 1: Add the "drive real UI, not fetch()" guidance comment**

In `handler.ts`, just inside `execute` before the `switch (action ...)` dispatch (~122), add:

```ts
      // GUIDANCE (#1053): on bot-protected sites, prefer real UI interaction (click/type/
      // select via these actions) over issuing fetch() inside page.evaluate(). A fetch() from
      // page context is blocked at the TLS/fingerprint layer even with valid cookies, because
      // it doesn't carry the browser's network fingerprint — whereas driving the real UI lets
      // the site's own JS make requests through Chromium's genuine network stack.
```

- [ ] **Step 2: Bump skill.json version + add a description note**

Read the current version:

Run: `grep -n '"version"\|"description"' skills/web-browser/skill.json`

Bump the patch component (e.g. `0.4.2` → `0.4.3`). Append to the end of the `description` string (before its closing quote): ` On bot-protected sites, prefer real UI interaction over injected fetch().`

- [ ] **Step 3: Add CHANGELOG entries under `[Unreleased]`**

In `CHANGELOG.md`, under `## [Unreleased]`, add (create the section headers if absent):

```markdown
### Changed
- **`web-browser` skill** — replaced the `playwright-extra` + stealth-plugin stack with Patchright and added a human-behavior layer (curved mouse, paced typing, post-load dwell + presence) plus one soft-block reload-retry, to reduce Cloudflare/DataDome-style blocking. (#1053)

### Security
- **`web-browser` skill** — closed the CDP `Runtime.enable` protocol leak that the old stealth plugin left exposed, by moving to Patchright. (#1053)
```

(If `### Changed` / `### Security` already exist under `[Unreleased]`, add the bullets to them instead of duplicating headers.)

- [ ] **Step 4: Typecheck, full suite, lint**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 run typecheck`
Expected: PASS.

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 exec vitest run src/browser skills/web-browser | tail -40`
Expected: PASS (browser-service, browser-session, human-behavior, handler).

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 run lint | tail -20`
Expected: clean (no `console.log`, no unused imports — confirm `fill` in the test file isn't now-unused; if it is, keep it on the locator mock but remove unused destructures the linter flags).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 add skills/web-browser/handler.ts skills/web-browser/skill.json CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-patchright-1053 commit -m "docs: web-browser real-UI guidance, skill version bump, changelog (#1053)"
```

- [ ] **Step 6: Deploy follow-up (record now, apply via curia-deploy PR)**

The bundled-Chromium fallback in `launchPersistentContext` now uses Patchright's patched Chromium, which is downloaded by `patchright install chromium` (separate from `playwright install`). Prod's primary path is real Chrome (`channel: 'chrome'`, unaffected), but to keep the fallback functional, `curia-deploy/deploy/compose/Dockerfile.curia` must add, alongside the existing `playwright install` lines (~122-130):

```dockerfile
# Patchright uses its own patched Chromium for the bundled-Chromium fallback path (#1053).
RUN pnpm exec patchright install chromium
```

This is a **separate curia-deploy PR** (own worktree/branch). Note it in this PR's description as a required companion change; do not edit the deploy repo from this worktree. Verify the curia repo's own Dockerfile (`Dockerfile`) does not install browsers (it doesn't) — no change needed there.

---

## Self-Review

**Spec coverage:**
- Item 1 (Patchright swap) → Task 1. ✓
- Item 2 (human-behavior module, Bezier mouse, deterministic tests) → Tasks 2-3. ✓
- Item 3 (always-on post-nav dwell + presence) → Task 4 Step 5. ✓
- Item 4 (human-type everything incl. secret_ref; click) → Task 5. ✓
- Item 5 (fingerprint = rely on real Chrome + audit, no override) → Task 1 Steps 7-8 (drop flag, no UA set, documented). Manual probe-page check → PR description (Task 6 / rollout). ✓
- Item 6 (one soft-block reload-retry) → Task 4 Step 5. ✓
- Item 7 (drive-real-UI guidance) → Task 6 Steps 1-2. ✓
- Testing (human-behavior unit tests; handler dwell/reload/click/type; service green) → Tasks 2-5. ✓
- Rollout (skill version, CHANGELOG, deploy follow-up, manual before/after) → Task 6 + PR. ✓

**Placeholder scan:** No TBD/TODO/"handle errors"/"similar to" — every code step shows complete code. ✓

**Type consistency:** `BehaviorOptions`/`Rng`/`Point`/`MouseMoveStrategy` defined in Tasks 2-3 and consumed consistently; handler imports `jitteredDelay`/`simulateHumanPresence`/`humanClick`/`humanType` (Task 4) and uses `humanClick`/`humanType` (Task 5) with the exact `(page, locator|text, opts?)` signatures declared. `isLikelyEmpty(page): Promise<boolean>` defined and used in Task 4. ✓

**Risks captured:** existing hard-block tests now trigger one extra reload (Task 4 Step 7 note); `fill` assertions must change to `humanType` (Task 5 Step 1); deploy fallback needs `patchright install chromium` (Task 6 Step 6).
