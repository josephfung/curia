import { describe, it, expect } from 'vitest';
import { buildWorldLayout } from './world-layout.js';
import type { DeskSlot } from '../layout/desk-layout.js';

describe('buildWorldLayout', () => {
  const desks: DeskSlot[] = [
    { agentId: 'coordinator', row: 'boss', column: 0 },
    { agentId: 'calendar', row: 'floor', column: 0 },
    { agentId: 'contacts', row: 'floor', column: 1 },
  ];

  it('places coordinator as boss desk', () => {
    const layout = buildWorldLayout(desks);
    expect(layout.coordinatorId).toBe('coordinator');
    const boss = layout.desks.find((d) => d.row === 'boss');
    expect(boss?.agentId).toBe('coordinator');
  });

  it('positions floor agents at distinct spots, separate from boss', () => {
    const layout = buildWorldLayout(desks);
    const floor = layout.desks.filter((d) => d.row === 'floor');
    expect(floor).toHaveLength(2);
    // Distinct positions — they may share a column (x) but differ by row (y), or vice versa.
    const samePoint = floor[0]!.x === floor[1]!.x && floor[0]!.y === floor[1]!.y;
    expect(samePoint).toBe(false);
    // Floor desks sit below the boss desk.
    const boss = layout.desks.find((d) => d.row === 'boss')!;
    expect(floor[0]!.y).toBeGreaterThan(boss.y);
  });

  it('splits specialists across two rows (first row gets the extra when odd)', () => {
    const five: DeskSlot[] = [
      { agentId: 'boss', row: 'boss', column: 0 },
      { agentId: 'a', row: 'floor', column: 0 },
      { agentId: 'b', row: 'floor', column: 1 },
      { agentId: 'c', row: 'floor', column: 2 },
      { agentId: 'd', row: 'floor', column: 3 },
      { agentId: 'e', row: 'floor', column: 4 },
    ];
    const floor = buildWorldLayout(five).desks.filter((d) => d.row === 'floor');
    const rowYs = [...new Set(floor.map((d) => d.y))].sort((p, q) => p - q);
    expect(rowYs).toHaveLength(2); // exactly two rows
    // 5 specialists → 3 on the top row, 2 on the bottom row.
    expect(floor.filter((d) => d.y === rowYs[0]!)).toHaveLength(3);
    expect(floor.filter((d) => d.y === rowYs[1]!)).toHaveLength(2);
    // Within a row, spacing clears the ~192px desk width (no horizontal overlap).
    const topXs = floor.filter((d) => d.y === rowYs[0]!).map((d) => d.x).sort((p, q) => p - q);
    expect(topXs[1]! - topXs[0]!).toBeGreaterThanOrEqual(192);
  });

  it('includes fixed props', () => {
    const layout = buildWorldLayout(desks);
    expect(layout.tasksBoard.x).toBeGreaterThan(0);
    expect(layout.clawTrack.maxX).toBeGreaterThan(layout.clawTrack.minX);
  });
});
