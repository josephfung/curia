// decor.ts — purely decorative office props (plants, wall art, furniture) placed along the
// back wall. This is the SINGLE source of truth for "what decor exists and where it sits", so
// nudging a prop is a one-line edit to its x/y here (see OfficeScene.spawnDecor).
//
// Two kinds of source art, both from the licensed LimeZu "Modern Office" pack:
//   - single : a whole "Modern Office Single" (64×96 px) placed as-is, keyed by its pack number.
//              Numbers index Modern_Office_Singles_32x32_<n>.png (served from the licensed dir).
//   - crop   : a sub-region cropped out of the Modern Office object tileset (OFFICE_TILESET),
//              for props that only exist on the big sheet and have no standalone single (e.g.
//              the bookcase). Coordinates are raw sheet pixels {sx,sy,sw,sh}.
//
// Decor is REAL-ART ONLY: every prop here comes from licensed art with no procedural fallback,
// so OfficeScene only spawns decor when realArtReady is true (open-core / clean-dev builds show
// none). A prop whose art fails to load is skipped individually — never a hard failure.
//
// LAYERS (drive both vertical anchoring and render depth):
//   - 'wall'  : hung on the back wall (2nd grid row). Centered origin; sits behind furniture.
//   - 'floor' : standing on the floor strip against the wall (3rd grid row). Bottom-anchored so
//               the art's base rests on the floor line.

import { OFFICE_TILESET } from './asset-manifest.js';

export type DecorSource =
  | { kind: 'single'; single: number }
  | { kind: 'crop'; from: string; sx: number; sy: number; sw: number; sh: number };

export interface DecorProp {
  /** Stable id — also the composed texture key suffix (`decor-<id>`). Must be unique. */
  id: string;
  source: DecorSource;
  /** 'wall' = hung (centered), 'floor' = standing (bottom-anchored). See LAYERS above. */
  layer: 'wall' | 'floor';
  /** World position on the 1600×960 stage. For 'floor' this is the base (feet) point; for
   *  'wall' it's the center of the piece. Tune freely — this is the knob to move a prop. */
  x: number;
  y: number;
  /** Sprite scale. Defaults to 2 (matches the rest of the office's 32px→64px ×2 grid). */
  scale?: number;
  /** Set false to keep the prop defined here (position + source preserved) but NOT render it — a
   *  quick on/off toggle so a prop can be pulled from the canvas and re-added later without losing
   *  its placement. Omitted or true = rendered. */
  enabled?: boolean;
}

// --- Back-wall vertical bands (64px grid, measured from the top wall down) -------------------
// Row 1 = top wall (y 0–64), Row 2 = second wall row (y 64–128), Row 3 = first floor strip
// (y 128–192, floor line ≈ 192). Art hangs on Row 2; plants/furniture stand on Row 3.
const WALL_Y = 90;    // centered hang height on the 2nd (wall) row
const FLOOR_Y = 196;  // base (feet) line for props standing on the 3rd (floor) row

/**
 * All decorative props. Grouped by intent for readability; order here is also spawn order
 * (later props draw on top within the same depth band). Positions are a deliberate first pass
 * — expect to nudge them against the live render.
 */
export const DECOR_PROPS: DecorProp[] = [
  // --- Plants: along the back wall, left side (3rd row / floor) ---------------------------
  { id: 'plant-98',  source: { kind: 'single', single: 98 },  layer: 'floor', x: 136, y: FLOOR_Y },
  { id: 'plant-99',  source: { kind: 'single', single: 99 },  layer: 'floor', x: 320, y: FLOOR_Y + 320, enabled: false },
  { id: 'plant-100', source: { kind: 'single', single: 100 }, layer: 'floor', x: 1470, y: FLOOR_Y },

  // --- Wall art: hung on the 2nd row, spread across the wall ------------------------------
  { id: 'cert-blue-113', source: { kind: 'single', single: 113 }, layer: 'wall', x: 364,  y: WALL_Y - 64 },
  { id: 'cert-red-115',  source: { kind: 'single', single: 115 }, layer: 'wall', x: 440,  y: WALL_Y - 64 },
  { id: 'photo-grey-96', source: { kind: 'single', single: 96 },  layer: 'wall', x: 640,  y: WALL_Y + 320, enabled: false },
  { id: 'photo-brown-97', source: { kind: 'single', single: 97 }, layer: 'wall', x: 810,  y: WALL_Y + 320, enabled: false },
  { id: 'pollock-sm-163', source: { kind: 'single', single: 163 }, layer: 'wall', x: 980, y: WALL_Y, enabled: false },
  { id: 'pollock-lg-164', source: { kind: 'single', single: 164 }, layer: 'wall', x: 860, y: WALL_Y - 64 },

  // --- Bookcase: cropped from the object tileset, far-left of the floor row ---------------
  { id: 'bookcase', source: { kind: 'crop', from: OFFICE_TILESET.key, sx: 224, sy: 398, sw: 64, sh: 64 }, layer: 'floor', x: 226, y: FLOOR_Y - 32 },

  // --- Couch: cropped from the object tileset, starting on the 2nd row, right of the printer.
  // Taller than the singles (96×96 crop → 192px on screen), so it's bottom-anchored at a lower
  // y to lift its top into the 2nd row.
  { id: 'couch', source: { kind: 'crop', from: OFFICE_TILESET.key, sx: 64, sy: 640, sw: 96, sh: 96 }, layer: 'floor', x: 860, y: 260 },

  // --- Furniture: 3rd row, further along the wall (right side) ----------------------------
  { id: 'whiteboard-blank-170',   source: { kind: 'single', single: 170 }, layer: 'floor', x: 700,  y: FLOOR_Y + 320, enabled: false },
  { id: 'whiteboard-simple-171',  source: { kind: 'single', single: 171 }, layer: 'wall', x: 1350, y: WALL_Y - 64 },
  { id: 'whiteboard-complex-172', source: { kind: 'single', single: 172 }, layer: 'floor', x: 960,  y: FLOOR_Y + 320, enabled: false },
  { id: 'water-cooler-173',       source: { kind: 'single', single: 173 }, layer: 'floor', x: 1026, y: FLOOR_Y + 10 },
  { id: 'vending-175',            source: { kind: 'single', single: 175 }, layer: 'floor', x: 1220, y: FLOOR_Y + 20 },
  { id: 'coffee-320',             source: { kind: 'single', single: 320 }, layer: 'floor', x: 1094, y: FLOOR_Y + 20 },
  { id: 'printer-325',            source: { kind: 'single', single: 325 }, layer: 'floor', x: 510, y: FLOOR_Y + 20 },
];

/** Distinct single numbers referenced by decor — the loader fetches exactly these (deduped). */
export const DECOR_SINGLES: number[] = Array.from(
  new Set(
    DECOR_PROPS.flatMap((p) => (p.source.kind === 'single' ? [p.source.single] : [])),
  ),
);

/** Phaser texture key for a placed decor prop's composed/loaded texture. */
export const decorTextureKey = (id: string): string => `decor-${id}`;
