import type { DeskSlot } from '../layout/desk-layout.js';

/** Pixel positions for fixed office props (1600×960 stage). */
export const STAGE_WIDTH = 1600;
export const STAGE_HEIGHT = 960;

// --- Specialist ("floor") desk layout ---------------------------------------
// Specialists are split across two rows so they neither crowd each other nor
// collide with the coordinator's desk above. A composed desk renders ~192px wide
// on the world canvas (3 tiles × 32px × the ×2 sprite scale), and a full station
// (monitors above, chair/label below) is ~180px tall — so spacing must clear the
// width and the rows must sit well below the coordinator (y:110). Tune freely.
const FLOOR_ROW1_Y = 340;        // first specialist row — clears the coordinator below y~160
const FLOOR_ROW2_Y = 560;        // second row — clears row 1's bottom (~390)
const FLOOR_MARGIN = 100;        // min gap from the stage's left/right edges
const FLOOR_MAX_SPACING = 240;   // center-to-center cap: 192px desk + ~48px breathing room

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
    deskPositions.push({ agentId: boss.agentId, row: 'boss', x: STAGE_WIDTH / 2, y: 200 });
  }

  // Split specialists across two rows (first row gets the extra when odd), each row
  // centered on the stage with spacing wide enough to clear the ~192px desk width.
  const half = Math.ceil(floor.length / 2);
  const rows: Array<{ agents: DeskSlot[]; y: number }> = [
    { agents: floor.slice(0, half), y: FLOOR_ROW1_Y },
    { agents: floor.slice(half), y: FLOOR_ROW2_Y },
  ];
  for (const { agents, y } of rows) {
    const spacing = Math.min(
      FLOOR_MAX_SPACING,
      (STAGE_WIDTH - FLOOR_MARGIN * 2) / Math.max(agents.length, 1),
    );
    const rowWidth = spacing * agents.length;
    const startX = (STAGE_WIDTH - rowWidth) / 2; // center the row on the stage
    agents.forEach((desk, index) => {
      deskPositions.push({
        agentId: desk.agentId,
        row: 'floor',
        x: startX + spacing * (index + 0.5),
        y,
      });
    });
  }

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
