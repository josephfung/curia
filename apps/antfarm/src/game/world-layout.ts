import type { DeskSlot } from '../layout/desk-layout.js';

/** Pixel positions for fixed office props (800×480 stage). */
export const STAGE_WIDTH = 800;
export const STAGE_HEIGHT = 480;

export interface Vec2 {
  x: number;
  y: number;
}

export interface DeskPosition extends Vec2 {
  agentId: string;
  row: 'boss' | 'floor';
}

export interface WorldLayout {
  desks: DeskPosition[];
  coordinatorId: string;
  tasksBoard: Vec2;
  scheduler: Vec2;
  wastebasket: Vec2;
  clawTrack: { y: number; minX: number; maxX: number; idleX: number };
  tubeIn: Vec2;
  tubeOut: Vec2;
}

export function buildWorldLayout(desks: DeskSlot[]): WorldLayout {
  const boss = desks.find((d) => d.row === 'boss');
  const coordinatorId = boss?.agentId ?? 'coordinator';
  const floor = desks.filter((d) => d.row === 'floor');

  const deskPositions: DeskPosition[] = [];
  if (boss) {
    deskPositions.push({ agentId: boss.agentId, row: 'boss', x: STAGE_WIDTH / 2, y: 110 });
  }

  const floorStartX = 80;
  const floorSpacing = Math.min(140, (STAGE_WIDTH - 160) / Math.max(floor.length, 1));
  floor.forEach((desk, index) => {
    deskPositions.push({
      agentId: desk.agentId,
      row: 'floor',
      x: floorStartX + index * floorSpacing + floorSpacing / 2,
      y: 220,
    });
  });

  return {
    desks: deskPositions,
    coordinatorId,
    tasksBoard: { x: 120, y: 380 },
    scheduler: { x: STAGE_WIDTH / 2 - 40, y: 390 },
    wastebasket: { x: STAGE_WIDTH - 80, y: 400 },
    clawTrack: { y: 36, minX: 60, maxX: STAGE_WIDTH - 60, idleX: STAGE_WIDTH - 120 },
    tubeIn: { x: STAGE_WIDTH / 2 - 100, y: 90 },
    tubeOut: { x: STAGE_WIDTH / 2 + 100, y: 90 },
  };
}

export function deskPositionForAgent(layout: WorldLayout, agentId: string): Vec2 {
  const desk = layout.desks.find((d) => d.agentId === agentId);
  if (desk) return { x: desk.x, y: desk.y };
  return { x: STAGE_WIDTH / 2, y: 260 };
}
