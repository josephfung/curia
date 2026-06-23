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
