import type { SceneDirective } from '@curia/shared-types';
import { sortDirectives } from './schedule.js';

/** Remove duplicate directives by audit row id, keeping the first occurrence. */
export function dedupeById(directives: SceneDirective[]): SceneDirective[] {
  const seen = new Set<string>();
  const result: SceneDirective[] = [];
  for (const directive of sortDirectives(directives)) {
    if (seen.has(directive.id)) continue;
    seen.add(directive.id);
    result.push(directive);
  }
  return result;
}

/**
 * Merge a historical replay window with a live SSE buffer opened at `streamOpenTs`.
 * Replay rows strictly before the boundary are kept; live rows at or after are appended.
 * Overlapping ids at the boundary are deduped (live wins when same id — last write kept).
 */
export function mergeReplayAndLive(
  replay: SceneDirective[],
  liveBuffer: SceneDirective[],
  streamOpenTs: number,
): SceneDirective[] {
  const replayBefore = replay.filter((d) => d.logicalTs < streamOpenTs);
  const liveAtOrAfter = liveBuffer.filter((d) => d.logicalTs >= streamOpenTs);
  const combined = [...replayBefore, ...liveAtOrAfter];
  return dedupeById(combined);
}
