import { describe, it, expect } from 'vitest';
import type { SceneDirective } from '@curia/shared-types';
import { dedupeById, mergeReplayAndLive } from './merge.js';

function directive(id: string, logicalTs: number): SceneDirective {
  return {
    id,
    logicalTs,
    causedBy: null,
    kind: 'agent.state',
    agentId: 'coordinator',
    state: 'active',
  };
}

describe('dedupeById', () => {
  it('removes duplicate ids keeping first occurrence', () => {
    const result = dedupeById([
      directive('a', 100),
      directive('a', 200),
      directive('b', 300),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('a');
    expect(result[0]!.logicalTs).toBe(100);
    expect(result[1]!.id).toBe('b');
  });
});

describe('mergeReplayAndLive', () => {
  it('splices replay before streamOpenTs with live at or after, deduping boundary overlap', () => {
    const replay = [
      directive('r1', 1000),
      directive('overlap', 5000),
      directive('r2', 6000),
    ];
    const live = [
      directive('overlap', 5000),
      directive('l1', 7000),
    ];

    const merged = mergeReplayAndLive(replay, live, 5000);
    expect(merged.map((d) => d.id)).toEqual(['r1', 'overlap', 'l1']);
    expect(merged).toHaveLength(3);
  });

  it('produces no gaps across the boundary', () => {
    const replay = [directive('a', 100), directive('b', 200)];
    const live = [directive('c', 300), directive('d', 400)];
    const merged = mergeReplayAndLive(replay, live, 250);
    expect(merged.map((d) => d.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
