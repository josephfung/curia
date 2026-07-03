import type { SceneDirective } from '@curia/shared-types';

export type PlaybackMode = 'paused' | 'playing' | 'live';

export interface ScheduledDirective {
  directive: SceneDirective;
  /** Position on the animation timeline (ms from script start). */
  animationStartMs: number;
}

export interface ConductorSnapshot {
  directives: SceneDirective[];
  schedule: ScheduledDirective[];
  currentLogicalTs: number;
  animationMs: number;
  velocity: number;
  mode: PlaybackMode;
  /** Index of the last fired directive in schedule (-1 = none yet). */
  firedIndex: number;
}

export const MIN_VELOCITY = 0.25;
export const MAX_VELOCITY = 8;
export const DEFAULT_MIN_ANIMATION_GAP_MS = 400;
