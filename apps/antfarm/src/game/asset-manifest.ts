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
