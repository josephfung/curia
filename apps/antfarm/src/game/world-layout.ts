import type { DeskSlot } from '../layout/desk-layout.js';

/** Pixel positions for fixed office props (1600×960 stage). */
export const STAGE_WIDTH = 1600;
export const STAGE_HEIGHT = 960;

// --- Specialist ("floor") desk layout ---------------------------------------
// Specialists are split across two rows so they neither crowd each other nor
// collide with the coordinator's desk above. A composed desk renders ~192px wide
// on the world canvas (3 tiles × 32px × the ×2 sprite scale), and a full station
// (monitors above, chair/label below) is ~180px tall — so spacing must clear the
// width and the rows must sit well below the coordinator (boss desk at y:200,
// see buildWorldLayout). Tune freely.
const FLOOR_ROW1_Y = 340;        // first specialist row — clears the coordinator's station (~y:200 + ~90 below)
const FLOOR_ROW2_Y = 560;        // second row — clears row 1's bottom (~390)
const FLOOR_MARGIN = 100;        // min gap from the stage's left/right edges
const FLOOR_MAX_SPACING = 240;   // center-to-center cap: 192px desk + ~48px breathing room

// Coordinator ("boss") desk — locked to the LEFT wall (was center-stage at STAGE_WIDTH/2). The
// whole station (desk, chair, agent sprite, monitors, label) is drawn relative to this single
// point in OfficeScene, so moving it here moves all of it together. The composed grey desk is
// ~256px wide (4 tiles × 32px × the ×2 scale), centered on this x, so its left edge sits at
// x−128 — keep x large enough to clear the ~64px-wide left wall.
const BOSS_DESK_X = 274;
const BOSS_DESK_Y = 200;

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
    deskPositions.push({ agentId: boss.agentId, row: 'boss', x: BOSS_DESK_X, y: BOSS_DESK_Y });
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
    // Top of the room, just right of the printer (decor printer-325 sits at x≈510). This point is
    // both the scheduler sprite's position AND the claw's grab target, so they stay in lockstep.
    scheduler: { x: 650, y: 140 },
    wastebasket: { x: STAGE_WIDTH - 80, y: 400 },
    clawTrack: { y: 36, minX: 60, maxX: STAGE_WIDTH - 60, idleX: STAGE_WIDTH - 120 },
    tubeIn: { x: STAGE_WIDTH / 2 - 100, y: STAGE_HEIGHT - 90 },
    tubeOut: { x: STAGE_WIDTH / 2 + 100, y: STAGE_HEIGHT - 90 },
  };
}

export function deskPositionForAgent(layout: WorldLayout, agentId: string): Vec2 {
  const desk = layout.desks.find((d) => d.agentId === agentId);
  if (desk) return { x: desk.x, y: desk.y };
  return { x: STAGE_WIDTH / 2, y: 260 };
}
