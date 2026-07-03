import type { ActivityScript, SceneDirective } from '@curia/shared-types';
import { mergeReplayAndLive, dedupeById } from './merge.js';
import {
  animationToLogicalMs,
  buildAnimationSchedule,
  logicalToAnimationMs,
  totalAnimationDurationMs,
} from './schedule.js';
import type { ConductorSnapshot, PlaybackMode, ScheduledDirective } from './types.js';
import { DEFAULT_MIN_ANIMATION_GAP_MS, MAX_VELOCITY, MIN_VELOCITY } from './types.js';

export class Conductor {
  private directives: SceneDirective[] = [];
  private schedule: ScheduledDirective[] = [];
  private animationMs = 0;
  private velocity = 1;
  private mode: PlaybackMode = 'paused';
  private firedIndex = -1;
  private lastTickAt: number | null = null;

  loadScript(script: ActivityScript): void {
    this.directives = dedupeById(script.directives);
    this.rebuildSchedule();
    this.firedIndex = -1;
    if (this.directives.length > 0) {
      this.animationMs = 0;
    }
  }

  appendDirectives(incoming: SceneDirective[]): void {
    if (incoming.length === 0) return;
    this.directives = dedupeById([...this.directives, ...incoming]);
    this.rebuildSchedule();
  }

  mergeLiveBuffer(replay: SceneDirective[], liveBuffer: SceneDirective[], streamOpenTs: number): void {
    this.directives = mergeReplayAndLive(replay, liveBuffer, streamOpenTs);
    this.rebuildSchedule();
  }

  setVelocity(velocity: number): void {
    this.velocity = Math.min(MAX_VELOCITY, Math.max(MIN_VELOCITY, velocity));
  }

  getVelocity(): number {
    return this.velocity;
  }

  setMode(mode: PlaybackMode): void {
    this.mode = mode;
    if (mode === 'live') {
      const end = this.schedule[this.schedule.length - 1];
      if (end) {
        this.animationMs = end.animationStartMs;
      }
    }
    this.lastTickAt = null;
  }

  getMode(): PlaybackMode {
    return this.mode;
  }

  scrubToLogicalTs(logicalTs: number): void {
    this.animationMs = logicalToAnimationMs(logicalTs, this.schedule);
    this.syncFiredIndex();
    this.lastTickAt = null;
  }

  scrubToAnimationMs(animationMs: number): void {
    const max = totalAnimationDurationMs(this.schedule);
    this.animationMs = Math.max(0, Math.min(animationMs, max));
    this.syncFiredIndex();
    this.lastTickAt = null;
  }

  tick(nowMs: number): SceneDirective[] {
    if (this.mode !== 'playing' && this.mode !== 'live') {
      this.lastTickAt = nowMs;
      return [];
    }

    if (this.lastTickAt !== null && this.mode === 'playing') {
      const delta = (nowMs - this.lastTickAt) * this.velocity;
      this.animationMs += delta;
      const max = totalAnimationDurationMs(this.schedule);
      if (this.animationMs >= max) {
        this.animationMs = max;
        this.mode = 'paused';
      }
    }
    this.lastTickAt = nowMs;

    return this.collectNewlyFired();
  }

  getSnapshot(): ConductorSnapshot {
    return {
      directives: [...this.directives],
      schedule: [...this.schedule],
      currentLogicalTs: animationToLogicalMs(this.animationMs, this.schedule),
      animationMs: this.animationMs,
      velocity: this.velocity,
      mode: this.mode,
      firedIndex: this.firedIndex,
    };
  }

  getSchedule(): ScheduledDirective[] {
    return [...this.schedule];
  }

  private rebuildSchedule(): void {
    this.schedule = buildAnimationSchedule(this.directives, DEFAULT_MIN_ANIMATION_GAP_MS);
    this.syncFiredIndex();
  }

  private syncFiredIndex(): void {
    let idx = -1;
    for (let i = 0; i < this.schedule.length; i++) {
      if (this.schedule[i]!.animationStartMs <= this.animationMs) {
        idx = i;
      } else {
        break;
      }
    }
    this.firedIndex = idx;
  }

  private collectNewlyFired(): SceneDirective[] {
    const fired: SceneDirective[] = [];
    for (let i = this.firedIndex + 1; i < this.schedule.length; i++) {
      const entry = this.schedule[i]!;
      if (entry.animationStartMs > this.animationMs) break;
      fired.push(entry.directive);
      this.firedIndex = i;
    }
    return fired;
  }
}
