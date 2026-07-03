import type { SceneDirective } from '@curia/shared-types';
import type { ScheduledDirective } from './types.js';
import { DEFAULT_MIN_ANIMATION_GAP_MS } from './types.js';

/** Sort directives by logical time then stable id. */
export function sortDirectives(directives: SceneDirective[]): SceneDirective[] {
  return [...directives].sort((a, b) => {
    if (a.logicalTs !== b.logicalTs) return a.logicalTs - b.logicalTs;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Map logical time to animation time. When events are denser than the minimum
 * animation gap, the animation timeline compresses logical clusters into evenly
 * spaced beats so the stage can keep up visually.
 */
export function buildAnimationSchedule(
  directives: SceneDirective[],
  minGapMs: number = DEFAULT_MIN_ANIMATION_GAP_MS,
): ScheduledDirective[] {
  const sorted = sortDirectives(directives);
  const schedule: ScheduledDirective[] = [];
  let animationCursor = 0;

  for (const directive of sorted) {
    schedule.push({ directive, animationStartMs: animationCursor });
    animationCursor += minGapMs;
  }

  return schedule;
}

/** Map a logical timestamp to its animation position using the schedule. */
export function logicalToAnimationMs(
  logicalTs: number,
  schedule: ScheduledDirective[],
): number {
  if (schedule.length === 0) return 0;

  const first = schedule[0]!.directive.logicalTs;
  if (logicalTs <= first) return 0;

  for (let i = 0; i < schedule.length; i++) {
    const current = schedule[i]!;
    const next = schedule[i + 1];
    if (!next || logicalTs < next.directive.logicalTs) {
      const span = (next?.directive.logicalTs ?? current.directive.logicalTs + 1) - current.directive.logicalTs;
      const offset = Math.min(1, (logicalTs - current.directive.logicalTs) / Math.max(span, 1));
      const gap = (next?.animationStartMs ?? current.animationStartMs + DEFAULT_MIN_ANIMATION_GAP_MS)
        - current.animationStartMs;
      return current.animationStartMs + offset * gap;
    }
  }

  const last = schedule[schedule.length - 1]!;
  return last.animationStartMs;
}

/** Inverse: animation ms → approximate logical timestamp. */
export function animationToLogicalMs(
  animationMs: number,
  schedule: ScheduledDirective[],
): number {
  if (schedule.length === 0) return 0;

  for (let i = 0; i < schedule.length; i++) {
    const current = schedule[i]!;
    const next = schedule[i + 1];
    if (!next || animationMs < next.animationStartMs) {
      if (!next) return current.directive.logicalTs;
      const gap = next.animationStartMs - current.animationStartMs;
      const offset = gap > 0 ? (animationMs - current.animationStartMs) / gap : 0;
      const span = next.directive.logicalTs - current.directive.logicalTs;
      return current.directive.logicalTs + offset * span;
    }
  }

  return schedule[schedule.length - 1]!.directive.logicalTs;
}

export function totalAnimationDurationMs(schedule: ScheduledDirective[]): number {
  if (schedule.length === 0) return 0;
  const last = schedule[schedule.length - 1]!;
  return last.animationStartMs + DEFAULT_MIN_ANIMATION_GAP_MS;
}
