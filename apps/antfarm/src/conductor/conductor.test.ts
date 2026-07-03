import { describe, it, expect } from 'vitest';
import type { SceneDirective } from '@curia/shared-types';
import { Conductor } from './conductor.js';
import {
  buildAnimationSchedule,
  logicalToAnimationMs,
  animationToLogicalMs,
} from './schedule.js';
import { DEFAULT_MIN_ANIMATION_GAP_MS } from './types.js';

function badge(id: string, logicalTs: number): SceneDirective {
  return {
    id,
    logicalTs,
    causedBy: null,
    kind: 'badge',
    badgeKind: 'human.decision',
    label: id,
  };
}

describe('buildAnimationSchedule', () => {
  it('spaces dense logical clusters by minimum animation gap', () => {
    const schedule = buildAnimationSchedule([
      badge('a', 1000),
      badge('b', 1005),
      badge('c', 1010),
    ], 400);

    expect(schedule[0]!.animationStartMs).toBe(0);
    expect(schedule[1]!.animationStartMs).toBe(400);
    expect(schedule[2]!.animationStartMs).toBe(800);
  });
});

describe('logical ↔ animation mapping', () => {
  it('maps logical timestamps into the compressed animation timeline', () => {
    const schedule = buildAnimationSchedule([
      badge('a', 0),
      badge('b', 10_000),
    ]);
    expect(logicalToAnimationMs(5000, schedule)).toBeGreaterThan(0);
    expect(logicalToAnimationMs(5000, schedule)).toBeLessThan(DEFAULT_MIN_ANIMATION_GAP_MS);
    expect(animationToLogicalMs(0, schedule)).toBe(0);
  });
});

describe('Conductor', () => {
  it('plays at variable velocity', () => {
    const conductor = new Conductor();
    conductor.loadScript({
      directives: [
        badge('a', 0),
        badge('b', 1000),
      ],
    });
    conductor.setVelocity(2);
    conductor.setMode('playing');

    const first = conductor.tick(0);
    expect(first).toHaveLength(1);

    const second = conductor.tick(200);
    expect(second.length).toBeGreaterThanOrEqual(0);
    expect(conductor.getVelocity()).toBe(2);
  });

  it('scrubs to a logical timestamp', () => {
    const conductor = new Conductor();
    conductor.loadScript({
      directives: [badge('a', 0), badge('b', 5000), badge('c', 10_000)],
    });
    conductor.scrubToLogicalTs(5000);
    const snap = conductor.getSnapshot();
    expect(snap.currentLogicalTs).toBeGreaterThanOrEqual(4000);
    expect(snap.firedIndex).toBeGreaterThanOrEqual(0);
  });

  it('merges replay and live without duplicate ids', () => {
    const conductor = new Conductor();
    conductor.mergeLiveBuffer(
      [badge('hist', 1000), badge('dup', 5000)],
      [badge('dup', 5000), badge('live', 6000)],
      5000,
    );
    const ids = conductor.getSnapshot().directives.map((d) => d.id);
    expect(ids).toEqual(['hist', 'dup', 'live']);
  });
});
