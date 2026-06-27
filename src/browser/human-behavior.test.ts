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
      isVisible: vi.fn().mockResolvedValue(true),
      click,
    } as unknown as Locator;
    await humanClick(page, locator, { sleep: noopSleep, rng: () => 0.5 });
    expect((page.mouse.move as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(click).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledWith({ timeout: 10_000 });
  });
  it('still clicks when the bounding box is unavailable (best-effort)', async () => {
    const page = mockPage();
    const click = vi.fn().mockResolvedValue(undefined);
    const locator = {
      boundingBox: vi.fn().mockRejectedValue(new Error('detached')),
      isVisible: vi.fn().mockResolvedValue(true),
      click,
    } as unknown as Locator;
    await humanClick(page, locator, { sleep: noopSleep, rng: () => 0.5 });
    expect(click).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledWith({ timeout: 10_000 });
  });

  it('force-clicks hidden custom form controls', async () => {
    const page = mockPage();
    const click = vi.fn().mockResolvedValue(undefined);
    const locator = {
      boundingBox: vi.fn().mockResolvedValue(null),
      isVisible: vi.fn().mockResolvedValue(false),
      click,
    } as unknown as Locator;
    await humanClick(page, locator, { sleep: noopSleep, rng: () => 0.5 });
    expect(click).toHaveBeenCalledWith({ force: true, timeout: 10_000 });
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
