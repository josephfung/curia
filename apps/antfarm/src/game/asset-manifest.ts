/** Runtime asset contract for real LimeZu art. All URLs are served by the auth-gated
 *  /api/antfarm/assets route; absent art 404s and the scene keeps its placeholders.
 *
 *  Office props are sub-regions of two Modern Office sheets (one image load each).
 *  Region coordinates were pinned by visual measurement against a 32px-grid overlay of
 *  the source sheets; they may need small tuning against the live render. */

export const ASSET_BASE = '/api/antfarm/assets/limezu';

/** The Modern Office object tileset — one image; furniture props are sub-regions of it. */
export const OFFICE_TILESET = {
  key: 'office-tileset',
  url: `${ASSET_BASE}/office/Modern_Office_Black_Shadow_32x32.png`,
} as const;

/** The room-builder sheet — source of the tiled floor. */
export const ROOM_BUILDER = {
  key: 'office-roombuilder',
  url: `${ASSET_BASE}/office/Room_Builder_Office_32x32.png`,
} as const;

export interface TileRegion {
  /** Placeholder texture key this real art overwrites (see placeholder-textures.ts). */
  placeholderKey: string;
  /** Source image key: OFFICE_TILESET.key or ROOM_BUILDER.key. */
  from: string;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

// Office props with real-art coverage. Coordinates pinned by measurement (see file header).
//
// Deliberately left PROCEDURAL (no clean pack match — matches the AF-7 scope decision):
//   - wastebasket : no dedicated trash-can sprite in the Modern Office pack.
//   - scheduler   : the clock-machine is a custom kitbash (SOURCE.md: "no pack covers these").
//   - claw, tube  : overhead claw + vacuum tubes are custom; no pack equivalent.
export const OFFICE_REGIONS: TileRegion[] = [
  // Gray office floor tile (room-builder interior fill, no border).
  { placeholderKey: 'office-floor', from: ROOM_BUILDER.key, sx: 32, sy: 256, sw: 32, sh: 32 },
  // Wood floor desk (lower furniture section).
  { placeholderKey: 'desk', from: OFFICE_TILESET.key, sx: 150, sy: 636, sw: 76, sh: 48 },
  // Large executive desk for the boss row.
  { placeholderKey: 'desk-boss', from: OFFICE_TILESET.key, sx: 192, sy: 8, sw: 64, sh: 88 },
  // Wall board displaying a chart — stands in for the tasks board.
  { placeholderKey: 'tasks-board', from: OFFICE_TILESET.key, sx: 286, sy: 390, sw: 66, sh: 44 },
];

/** Premade character sheet frame geometry (Modern Interiors 32x32 pack).
 *  MEASURED: each frame is 32 wide × 64 tall (1 tile wide, 2 tiles tall — humans span two
 *  32px rows). The sheet is 1792×1312 → 56 columns × 20 full 64px rows (last 32px is spare).
 *  Phaser generateFrameNumbers with frameHeight:64 indexes frame = row*56 + col. */
export const CHARACTER_FRAME = { width: 32, height: 64 } as const;

export type Direction = 'down' | 'up' | 'left' | 'right';

/** First-frame index + length for each animation/direction, PINNED by measurement
 *  (Task 5 Step 1) against Premade_Character_32x32_10.png. Global frame index = row*56 + col.
 *  Walk = 6 frames/direction on 64px-row 1 (frames 56–79). Idle reuses each walk
 *  direction's first frame as a single static pose (the dedicated idle row is too sparse to
 *  map cleanly, and reusing the walk anchor guarantees the idle facing matches the walk).
 *  NOTE: up=56 (pure back) and down=74 (faces visible) are certain; left/right (62/68) are the
 *  two side blocks and their L/R assignment is verified/swapped in the browser (Task 8). */
export interface AnimSpec { start: number; length: number; frameRate: number }
export const CHARACTER_ANIM: Record<'idle' | 'walk', Record<Direction, AnimSpec>> = {
  idle: {
    down:  { start: 74, length: 1, frameRate: 1 },
    up:    { start: 56, length: 1, frameRate: 1 },
    left:  { start: 62, length: 1, frameRate: 1 },
    right: { start: 68, length: 1, frameRate: 1 },
  },
  walk: {
    down:  { start: 74, length: 6, frameRate: 8 },
    up:    { start: 56, length: 6, frameRate: 8 },
    left:  { start: 62, length: 6, frameRate: 8 },
    right: { start: 68, length: 6, frameRate: 8 },
  },
};

export const characterSheetUrl = (file: string): string => `${ASSET_BASE}/characters/${file}`;
