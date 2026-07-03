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

  it('positions floor agents separately from boss', () => {
    const layout = buildWorldLayout(desks);
    const floor = layout.desks.filter((d) => d.row === 'floor');
    expect(floor).toHaveLength(2);
    expect(floor[0]!.x).not.toBe(floor[1]!.x);
  });

  it('includes fixed props', () => {
    const layout = buildWorldLayout(desks);
    expect(layout.tasksBoard.x).toBeGreaterThan(0);
    expect(layout.clawTrack.maxX).toBeGreaterThan(layout.clawTrack.minX);
  });
});
