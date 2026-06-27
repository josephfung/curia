// src/browser/human-behavior.ts — human-like browsing behavior for the web-browser skill.
//
// Behavioral bot-detection (Cloudflare Bot Management, DataDome) scores mouse/keyboard
// telemetry: whether plausible movement exists at all, and whether it looks mechanical
// (teleporting cursors, constant velocity, instant fills). These helpers add the telemetry
// real users emit. The pure functions (computeJitter/computeKeyDelay/<strategy>.path) carry
// the testable logic; the page-driving functions wrap them. All randomness is injected via
// `rng` and all sleeps via `sleep` so the logic is deterministic under test. (#1053)

import type { Page, Locator } from 'playwright';

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

// ─── Page-driving helpers ────────────────────────────────────────────────────
// All randomness injected via `rng`, all sleeps via `sleep` — fully testable
// without real timers or a real browser.

export interface BehaviorOptions {
  rng?: Rng;
  sleep?: (ms: number) => Promise<void>;
  strategy?: MouseMoveStrategy;
  /** Optional logger for debug-level diagnostics. Accepts any pino logger instance. */
  log?: Pick<import('pino').Logger, 'debug'>;
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
  const { rng = Math.random, sleep = defaultSleep, log } = opts;
  try {
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
  } catch (err) {
    // A keyboard error means text was likely not typed — surface it as a real failure
    // rather than silently succeeding with an empty field. (#1053)
    log?.debug({ err }, 'humanType: keyboard error');
    throw err;
  }
}

/**
 * Move the cursor to a random point inside the locator's box along a curved path, pause,
 * then click. The cursor "arrives from" a random viewport point so the path is a real curve
 * rather than a teleport. Best-effort: any movement failure is swallowed and we still click.
 */
export async function humanClick(page: Page, locator: Locator, opts: BehaviorOptions = {}): Promise<void> {
  const { rng = Math.random, sleep = defaultSleep, strategy = bezierStrategy, log } = opts;
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
  } catch (err) {
    // Best-effort: movement failure must not prevent the click — behavioral telemetry
    // is decorative; the click itself is what matters. Log so it's observable. (#1053)
    log?.debug({ err }, 'humanClick: movement failed — falling back to direct click');
  }
  // Custom-styled radios/checkboxes hide the native input but keep aria-label on it.
  // Playwright resolves them, yet they fail actionability checks — force click still
  // toggles the control and emits the input events the site's JS listens for.
  let visible: boolean;
  try {
    visible = await locator.isVisible();
  } catch (err) {
    log?.debug({ err }, 'humanClick: visibility check failed');
    throw err;
  }
  if (visible) {
    await locator.click({ timeout: 10_000 });
  } else {
    log?.debug('humanClick: target not visible — using force click (typical for custom radios/checkboxes)');
    await locator.click({ force: true, timeout: 10_000 });
  }
}

/**
 * Simulate casual browsing before the first meaningful interaction: a few curved mouse moves
 * across the viewport plus a short scroll down and back up. Best-effort — must never fail the
 * caller's navigation.
 */
export async function simulateHumanPresence(page: Page, opts: BehaviorOptions = {}): Promise<void> {
  const { rng = Math.random, sleep = defaultSleep, strategy = bezierStrategy, log } = opts;
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
  } catch (err) {
    // Best-effort: presence simulation is purely decorative and must never fail the
    // navigation. Log so it's observable in case of repeated failures. (#1053)
    log?.debug({ err }, 'simulateHumanPresence: page error swallowed (best-effort)');
  }
}
