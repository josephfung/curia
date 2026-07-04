import Phaser from 'phaser';
import type { SceneDirective } from '@curia/shared-types';
import type { DeskSlot } from '../layout/desk-layout.js';
import { appearanceForAgent, hashAgentId } from './agent-appearance.js';
import {
  buildWorldLayout,
  deskPositionForAgent,
  STAGE_WIDTH,
  STAGE_HEIGHT,
  type WorldLayout,
} from './world-layout.js';
import {
  ensureTintedTexture,
  registerPlaceholderTextures,
} from './placeholder-textures.js';
import {
  OFFICE_TILESET, ROOM_BUILDER, OFFICE_REGIONS, CHARACTER_FRAME, CHARACTER_ANIM,
  characterSheetUrl, type Direction,
  OFFICE_SINGLES, officeSingleUrl, officeSingleKey,
  DESK_COLOR_GROUPS, AGENT_DESK_COLORS, COORD_DESK_GROUP,
  AGENT_COMPUTER, COORD_CHAIR, AGENT_CHAIRS,
  FLOOR_BASE_KEY, FLOOR_VARIANT_KEYS, FLOOR_VARIANT_CHANCE,
} from './asset-manifest.js';
import { characterSheetIndexForAgent, characterSheetKey, characterSheetFile } from './character-sheets.js';

// Explicit render-order bands. Desks draw IN FRONT of seated characters (so the desk front
// occludes their legs), with chairs behind and on-desk devices in front; overlays sit on top.
const DEPTH = {
  shadow: 1,    // wall-cast floor shadow — above the floor, below the walls
  wall: 2,      // room walls + wall-mounted fixed props (board, scheduler, wastebasket, tubes)
  chair: 5,
  agent: 10,
  desk: 15,     // real-art composed desks (in front of the seated agent)
  device: 18,   // computers / monitors sitting on the desk
  claw: 22,
  overlay: 40,  // speech / think bubbles, task cards, badges, desk labels
} as const;

// Compose/crop geometry for the singles-based desks (pinned visually with the art director).
const DESK_TILE_W = 32;   // width of each desk tile's cropped content
const DESK_TILE_H = 48;   // desk graphic occupies the lower-left 32×48 of its 64×96 single
const CHAIR_H = 50;       // chair art sits ~10px up from the frame bottom
const CHAIR_BOTTOM_OFFSET = 10;

// Swap-only room textures (walls + wall shadow) that have NO placeholder fallback: they exist
// only after swapOfficeTextures crops them from the Room Builder sheet. Every key here (plus the
// floor variants) must exist for real-art mode, or the scene stays in placeholder mode rather
// than render Phaser's missing-texture voids (see create()). Keep in sync with drawWalls/drawShadows.
const WALL_TEXTURE_KEYS = [
  'wall-top-a', 'wall-top-b', 'wall-left', 'wall-right', 'wall-bottom',
  'wall-left-corner', 'wall-right-corner', 'wall-shadow',
] as const;

export interface OfficeSceneCallbacks {
  onAgentClick: (agentId: string, directive: SceneDirective | null) => void;
  onDirectiveClick: (directive: SceneDirective) => void;
}

export interface OfficeSceneData {
  desks: DeskSlot[];
  callbacks: OfficeSceneCallbacks;
}

interface AgentSprite {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite;
  agentId: string;
  thinkBubble: Phaser.GameObjects.Image | null;
  speechBubble: Phaser.GameObjects.Text | null;
  stateTint: 'normal' | 'active' | 'error';
  /** Phaser texture key for the loaded character sheet, or null if using placeholder. */
  sheetKey: string | null;
  /** True when a real premade sprite sheet loaded successfully and is in use. */
  hasReal: boolean;
}

export class OfficeScene extends Phaser.Scene {
  private layout!: WorldLayout;
  private agents = new Map<string, AgentSprite>();
  private claw!: Phaser.GameObjects.Image;
  private taskCards = new Map<string, Phaser.GameObjects.Image>();
  private badgeGroup!: Phaser.GameObjects.Container;
  private callbacks!: OfficeSceneCallbacks;
  private lastDirectiveByAgent = new Map<string, SceneDirective>();
  // Keys of asset loads that errored (e.g. open-core build with no licensed art).
  // Anything in here keeps its procedural placeholder — never a hard failure.
  private failedLoads = new Set<string>();
  // Single all-or-nothing gate: true only when EVERY licensed asset the scene needs (office
  // singles, floor/board source sheets, and all required character sheets) loaded. Drives the
  // office art, the desk stations, AND the character-sprite choice + seating together, so a
  // partial/mispackaged licensed drop degrades to the FULL procedural experience rather than a
  // broken hybrid (real characters on placeholder desks, mixed real/placeholder agents, etc.).
  // When false (open-core / clean dev / incomplete drop), everything falls back to placeholders.
  private realArtReady = false;

  constructor() {
    super({ key: 'OfficeScene' });
  }

  init(data: OfficeSceneData): void {
    // Prefer the registry (set once by PhaserOffice; survives restarts and the config auto-start),
    // then the start data, then any previously-set value. Never clobber a good value with
    // undefined — otherwise the pointer handlers throw on this.callbacks and no overlay opens.
    this.callbacks =
      (this.registry.get('callbacks') as OfficeSceneCallbacks | undefined) ??
      data?.callbacks ??
      this.callbacks;
  }

  preload(): void {
    // Record load failures instead of throwing; absent licensed art is the normal
    // open-core path and must fall back cleanly to procedural placeholders.
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      this.failedLoads.add(file.key);
      // Expected when licensed art is absent — info, never error (no console errors).
      console.info(`[antfarm] licensed asset not loaded (using placeholder): ${file.key}`);
    });

    this.load.image(OFFICE_TILESET.key, OFFICE_TILESET.url);
    this.load.image(ROOM_BUILDER.key, ROOM_BUILDER.url);
    // Office desk singles (desks, chairs, monitors, computer) — composed in buildOfficeArt().
    for (const n of OFFICE_SINGLES) {
      this.load.image(officeSingleKey(n), officeSingleUrl(n));
    }
    // Character sheets are loaded here too (added in Task 5).
    const desks = this.registry.get('desks') as DeskSlot[] ?? [];
    const sheetIndices = new Set(desks.map((d) => characterSheetIndexForAgent(d.agentId)));
    for (const idx of sheetIndices) {
      this.load.spritesheet(characterSheetKey(idx), characterSheetUrl(characterSheetFile(idx)), {
        frameWidth: CHARACTER_FRAME.width,
        frameHeight: CHARACTER_FRAME.height,
      });
    }
  }

  create(): void {
    registerPlaceholderTextures(this);

    const desks = this.registry.get('desks') as DeskSlot[] ?? [];
    // All-or-nothing: only render real art when EVERY licensed asset loaded. Compose the desk
    // textures first; only if that succeeds do we swap the floor/board too, so the room is never
    // half-reskinned. Any missing asset (or a canvas failure) leaves the full placeholder scene.
    if (this.licensedAssetsPresent(desks) && this.buildOfficeArt()) {
      this.swapOfficeTextures();
      // drawWalls/drawShadows/floorTileKey reference swap-only textures that have NO placeholder.
      // If any failed to crop (bad region coord, canvas failure), stay in placeholder mode rather
      // than render Phaser's missing-texture voids — preserving the all-or-nothing invariant above.
      const missingRoom = [...WALL_TEXTURE_KEYS, ...FLOOR_VARIANT_KEYS].filter(
        (k) => !this.textures.exists(k),
      );
      if (missingRoom.length === 0) {
        this.realArtReady = true;
      } else {
        console.warn(
          `[antfarm] real-art room textures missing (${missingRoom.join(', ')}); using placeholder room`,
        );
      }
    }

    this.layout = buildWorldLayout(desks);

    this.drawRoom();
    this.spawnFixedProps();
    this.spawnDesks();
    this.spawnAgents(desks);
    this.badgeGroup = this.add.container(0, 0).setDepth(DEPTH.overlay);

    const pending = this.registry.get('pendingReplay') as SceneDirective[] | undefined;
    if (pending?.length) {
      this.registry.remove('pendingReplay');
      for (const directive of pending) {
        this.playDirective(directive);
      }
    }
  }

  updateLayout(desks: DeskSlot[]): void {
    this.registry.set('desks', desks);
    this.agents.clear();
    this.taskCards.clear();
    this.lastDirectiveByAgent.clear();
    this.scene.restart({ desks, callbacks: this.callbacks });
  }

  /** Reset scene state and replay directives up to the current scrub position. */
  resyncPlayback(directives: SceneDirective[], desks: DeskSlot[]): void {
    this.registry.set('desks', desks);
    this.registry.set('pendingReplay', directives);
    this.agents.clear();
    this.taskCards.clear();
    this.lastDirectiveByAgent.clear();
    this.scene.restart({ desks, callbacks: this.callbacks });
  }

  playDirective(directive: SceneDirective): void {
    this.recordDirectiveAgents(directive);
    switch (directive.kind) {
      case 'claw.deliver':
        this.animateClawDeliver(directive);
        break;
      case 'agent.state':
        this.setAgentState(directive.agentId, directive.state);
        break;
      case 'agent.walk':
        this.animateWalk(directive);
        break;
      case 'agent.speak':
        this.showSpeech(directive);
        break;
      case 'agent.think':
        this.setThinkBubble(directive);
        break;
      case 'tube.in':
        this.animateTube('in');
        break;
      case 'tube.out':
        this.animateTube('out');
        break;
      case 'task.appear':
        this.showTaskCard(directive);
        break;
      case 'task.trash':
        this.trashTask(directive);
        break;
      case 'badge':
        this.showBadge(directive);
        break;
    }
  }

  private drawRoom(): void {
    // Tile the floor on a 64px grid (tile is 32px scaled ×2 = 64px on screen). In real-art mode
    // the floor starts below the two-row top wall (y≥128) and stops above the bottom wall row
    // (STAGE_HEIGHT-64) so no floor shows under those walls; in placeholder mode it fills the
    // whole stage (only a thin trim line stands in for walls). Bounds track STAGE_WIDTH/HEIGHT.
    const floorTop = this.realArtReady ? 128 : 60;
    const floorBottom = this.realArtReady ? STAGE_HEIGHT - 64 : STAGE_HEIGHT;
    for (let x = 0; x < STAGE_WIDTH; x += 64) {
      for (let y = floorTop; y < floorBottom; y += 64) {
        this.add.image(x + 32, y + 32, this.floorTileKey()).setScale(2).setDepth(0);
      }
    }
    if (this.realArtReady) {
      this.drawWalls();
      this.drawShadows();
    } else {
      // Placeholder mode: a simple trim line stands in for the walls.
      this.add.rectangle(STAGE_WIDTH / 2, 30, STAGE_WIDTH - 120, 4, 0x6a6a72)
        .setOrigin(0.5).setDepth(DEPTH.wall);
    }
  }

  /** Overlay wall-cast shadow tiles on the floor row directly below the top wall (the 3rd grid
   *  row). Depth sits above the floor but below chairs/agents/desks, so furniture and characters
   *  render on top of the shadow. Real-art only (the tile is swapped in by swapOfficeTextures). */
  private drawShadows(): void {
    const shadowY = 128 + 32; // center of the first floor row (row below the two-row top wall)
    for (let x = 0; x < STAGE_WIDTH; x += 64) {
      this.add.image(x + 32, shadowY, 'wall-shadow').setScale(2).setDepth(DEPTH.shadow);
    }
  }

  /** Overlay the room walls from the Room Builder sheet (real-art only; the tiles are swapped in
   *  by swapOfficeTextures). Tiles are 32px drawn ×2 = 64px on screen, on the same 64px grid as
   *  the floor. Top wall = two stacked rows; bottom wall = one row (the floor skips it); side
   *  walls run down each edge between them, with a corner cap at each top. Edge coordinates are
   *  simple/parametric so they're easy to tune against the live render. */
  private drawWalls(): void {
    const T = 64; // on-screen tile size (32px × the ×2 scale)
    // Top wall — two stacked rows across the full width.
    for (let x = 0; x < STAGE_WIDTH; x += T) {
      this.add.image(x + 32, 32, 'wall-top-a').setScale(2).setDepth(DEPTH.wall);
      this.add.image(x + 32, 96, 'wall-top-b').setScale(2).setDepth(DEPTH.wall);
    }
    // Bottom wall — one row across the full width (drawRoom leaves this row floor-free).
    for (let x = 0; x < STAGE_WIDTH; x += T) {
      this.add.image(x + 32, STAGE_HEIGHT - 32, 'wall-bottom').setScale(2).setDepth(DEPTH.wall);
    }
    // Side walls — down each edge, between the top wall and the bottom wall row.
    for (let y = 96; y < STAGE_HEIGHT - T; y += T) {
      this.add.image(32, y, 'wall-left').setScale(2).setDepth(DEPTH.wall);
      this.add.image(STAGE_WIDTH - 32, y, 'wall-right').setScale(2).setDepth(DEPTH.wall);
    }
    // Corner caps where the top and side walls meet (drawn last so they sit on top).
    this.add.image(32, 32, 'wall-left-corner').setScale(2).setDepth(DEPTH.wall);
    this.add.image(STAGE_WIDTH - 32, 32, 'wall-right-corner').setScale(2).setDepth(DEPTH.wall);
  }

  /** Pick a floor tile for one cell: the base tile most of the time, a random variant
   *  ~FLOOR_VARIANT_CHANCE of the time. Variants only exist once real art is swapped in, so in
   *  placeholder mode always fall back to the base key. */
  private floorTileKey(): string {
    if (this.realArtReady && Math.random() < FLOOR_VARIANT_CHANCE) {
      return FLOOR_VARIANT_KEYS[Math.floor(Math.random() * FLOOR_VARIANT_KEYS.length)]!;
    }
    return FLOOR_BASE_KEY;
  }

  /** Texture key for a composed desk (per color, or the coordinator desk). */
  private deskTextureKey(name: string): string {
    return `deskart-desk-${name}`;
  }

  /** Compose N desk tiles (lower-left 32×48 of each single) side by side into one texture. */
  private composeDeskTexture(key: string, group: number[]): void {
    if (this.textures.exists(key)) return;
    const canvas = document.createElement('canvas');
    canvas.width = group.length * DESK_TILE_W;
    canvas.height = DESK_TILE_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[antfarm] composeDeskTexture: no 2d canvas context');
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < group.length; i++) {
      const src = this.textures.get(officeSingleKey(group[i]!)).getSourceImage() as HTMLImageElement;
      ctx.drawImage(src, 0, src.height - DESK_TILE_H, DESK_TILE_W, DESK_TILE_H, i * DESK_TILE_W, 0, DESK_TILE_W, DESK_TILE_H);
    }
    this.textures.addCanvas(key, canvas);
  }

  /** Crop a cw×ch region from a single's lower-left (measured up from the bottom by bottomOff). */
  private cropSingle(key: string, single: number, cw: number, ch: number, bottomOff: number): void {
    if (this.textures.exists(key)) return;
    const src = this.textures.get(officeSingleKey(single)).getSourceImage() as HTMLImageElement;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[antfarm] cropSingle: no 2d canvas context');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, src.height - ch - bottomOff, cw, ch, 0, 0, cw, ch);
    this.textures.addCanvas(key, canvas);
  }

  private loadedOk(key: string): boolean {
    return this.textures.exists(key) && !this.failedLoads.has(key);
  }

  /** True only when every licensed asset the scene needs is present: the office singles, the
   *  floor/board source sheets, AND every character sheet the current desks require. This is
   *  the single gate for all-or-nothing real-art rendering. */
  private licensedAssetsPresent(desks: DeskSlot[]): boolean {
    const singlesOk = OFFICE_SINGLES.every((n) => this.loadedOk(officeSingleKey(n)));
    const regionsOk = this.loadedOk(OFFICE_TILESET.key) && this.loadedOk(ROOM_BUILDER.key);
    const sheetIndices = new Set(desks.map((d) => characterSheetIndexForAgent(d.agentId)));
    const charactersOk = [...sheetIndices].every((idx) => this.loadedOk(characterSheetKey(idx)));
    return singlesOk && regionsOk && charactersOk;
  }

  /** Compose the singles-based office art (desks, chairs, computer, monitors). Assumes the
   *  singles are present (callers gate on licensedAssetsPresent). Returns false on an
   *  unexpected canvas failure so the caller falls back to the full placeholder scene. */
  private buildOfficeArt(): boolean {
    try {
      for (const [color, group] of Object.entries(DESK_COLOR_GROUPS)) {
        this.composeDeskTexture(this.deskTextureKey(color), group);
      }
      this.composeDeskTexture(this.deskTextureKey('coord'), COORD_DESK_GROUP);
      this.cropSingle('deskart-computer', AGENT_COMPUTER, DESK_TILE_W, DESK_TILE_H, 0);
      this.cropSingle('deskart-chair-coord', COORD_CHAIR, DESK_TILE_W, CHAIR_H, CHAIR_BOTTOM_OFFSET);
      for (const n of AGENT_CHAIRS) {
        this.cropSingle(`deskart-chair-${n}`, n, DESK_TILE_W, CHAIR_H, CHAIR_BOTTOM_OFFSET);
      }
      // Monitors were top-cropped at a flat 32px; give 126 +10px and 127 +20px of top height.
      this.cropSingle('deskart-mon-125', 125, DESK_TILE_W, 32, 0);
      this.cropSingle('deskart-mon-126', 126, DESK_TILE_W, 42, 0);
      this.cropSingle('deskart-mon-127', 127, DESK_TILE_W, 52, 0);
      return true;
    } catch (err) {
      // Never hard-fail — fall back to placeholder desks (and placeholder characters).
      console.warn('[antfarm] failed to compose office art; using placeholders', err);
      return false;
    }
  }

  /** Deterministic desk color for a specialist agent (grey excluded — coordinator only). */
  private agentDeskColor(agentId: string): string {
    return AGENT_DESK_COLORS[(hashAgentId(agentId) >> 6) % AGENT_DESK_COLORS.length]!;
  }

  /** Deterministic chair single for a specialist agent. */
  private agentChair(agentId: string): number {
    return AGENT_CHAIRS[hashAgentId(agentId) % AGENT_CHAIRS.length]!;
  }

  /** Overwrite an existing texture key with a cropped region of a loaded source image.
   *  Call-sites that reference `newKey` (e.g. this.add.image(x,y,'desk')) then get real art
   *  with zero changes. Uses a canvas texture so the crop is a standalone key. */
  private cropToTexture(srcKey: string, newKey: string, sx: number, sy: number, sw: number, sh: number): void {
    const src = this.textures.get(srcKey).getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    if (this.textures.exists(newKey)) this.textures.remove(newKey); // drop the placeholder
    this.textures.addCanvas(newKey, canvas);
  }

  /** Swap office placeholder textures for real LimeZu tileset regions, where loaded. */
  private swapOfficeTextures(): void {
    for (const region of OFFICE_REGIONS) {
      // Skip if the source sheet failed to load or isn't registered (open-core → placeholders).
      if (this.failedLoads.has(region.from) || !this.textures.exists(region.from)) continue;
      try {
        this.cropToTexture(region.from, region.placeholderKey, region.sx, region.sy, region.sw, region.sh);
      } catch (err) {
        // Never hard-fail on a bad region — keep the placeholder and note it.
        console.warn(`[antfarm] failed to swap ${region.placeholderKey}; keeping placeholder`, err);
      }
    }
  }

  private spawnFixedProps(): void {
    this.add.image(this.layout.tasksBoard.x, this.layout.tasksBoard.y, 'tasks-board').setScale(2).setDepth(DEPTH.wall);
    this.add.image(this.layout.scheduler.x, this.layout.scheduler.y, 'scheduler').setScale(2).setDepth(DEPTH.wall);
    this.add.image(this.layout.wastebasket.x, this.layout.wastebasket.y, 'wastebasket').setScale(2).setDepth(DEPTH.wall);
    this.add.image(this.layout.tubeIn.x, this.layout.tubeIn.y, 'tube').setScale(2).setTint(0x6a9a6a).setDepth(DEPTH.wall);
    this.add.image(this.layout.tubeOut.x, this.layout.tubeOut.y, 'tube').setScale(2).setTint(0x9a6a6a).setDepth(DEPTH.wall);

    this.claw = this.add.image(this.layout.clawTrack.idleX, this.layout.clawTrack.y, 'claw').setScale(2).setDepth(DEPTH.claw);
  }

  private spawnDesks(): void {
    if (this.realArtReady) {
      this.spawnStations();
      return;
    }
    this.spawnPlaceholderDesks();
  }

  /** Procedural fallback: a single placeholder desk per agent, drawn BEHIND the agent (the
   *  original AF-5 look). Used when the singles-based office art is absent. */
  private spawnPlaceholderDesks(): void {
    for (const desk of this.layout.desks) {
      const key = desk.row === 'boss' ? 'desk-boss' : 'desk';
      const img = this.add.image(desk.x, desk.y + 20, key).setScale(2).setDepth(DEPTH.chair);
      img.setInteractive({ useHandCursor: true });
      img.on('pointerdown', () => {
        this.callbacks.onAgentClick(desk.agentId, this.directiveForAgent(desk.agentId));
      });
      this.add
        .text(desk.x, desk.y + 36, desk.agentId, { fontSize: '10px', color: '#e8f0dc' })
        .setOrigin(0.5)
        .setDepth(DEPTH.overlay);
    }
  }

  /** Real-art station: layered chair → (agent, added in spawnAgents) → desk → on-desk devices.
   *  The desk draws in front of the seated agent so the desk front occludes their legs.
   *  Coordinator gets the wide grey desk + three monitors; specialists a colored desk + a
   *  computer. Pixel offsets were tuned in a standalone Phaser harness with the art director
   *  and may want a light refinement pass against the live scene. */
  private spawnStations(): void {
    for (const desk of this.layout.desks) {
      const isCoord = desk.row === 'boss' || desk.agentId === this.layout.coordinatorId;
      const cy = desk.y + 20; // desk vertical centre

      const chairKey = isCoord ? 'deskart-chair-coord' : `deskart-chair-${this.agentChair(desk.agentId)}`;
      this.add.image(desk.x, cy - 54, chairKey).setScale(2).setDepth(DEPTH.chair);

      const deskKey = isCoord
        ? this.deskTextureKey('coord')
        : this.deskTextureKey(this.agentDeskColor(desk.agentId));
      const deskImg = this.add.image(desk.x, cy, deskKey).setScale(2).setDepth(DEPTH.desk);
      deskImg.setInteractive({ useHandCursor: true });
      deskImg.on('pointerdown', () => {
        this.callbacks.onAgentClick(desk.agentId, this.directiveForAgent(desk.agentId));
      });

      if (isCoord) {
        // Three monitors across the wide desk; bottom-anchored so the taller crops show fully.
        const monitors: Array<[string, number, number]> = [
          ['deskart-mon-125', -68, 32],
          ['deskart-mon-126', 0, 72],
          ['deskart-mon-127', 74, 73],
        ];
        for (const [key, dx, dy] of monitors) {
          this.add.image(desk.x + dx, cy - 24 + dy, key).setOrigin(0.5, 1).setScale(2).setDepth(DEPTH.device);
        }
      } else {
        this.add.image(desk.x, cy - 4, 'deskart-computer').setScale(2).setDepth(DEPTH.device);
      }

      this.add
        .text(desk.x, cy + 40, desk.agentId, { fontSize: '10px', color: '#e8f0dc' })
        .setOrigin(0.5)
        .setDepth(DEPTH.overlay);
    }
  }

  private spawnAgents(desks: DeskSlot[]): void {
    for (const desk of desks) {
      this.ensureAgent(desk.agentId);
    }
  }

  private ensureAgent(agentId: string): AgentSprite {
    const existing = this.agents.get(agentId);
    if (existing) return existing;

    const pos = deskPositionForAgent(this.layout, agentId);
    const sheetIdx = characterSheetIndexForAgent(agentId);
    const sheetKey = characterSheetKey(sheetIdx);
    // Tied to the single all-or-nothing gate: realArtReady already guarantees every character
    // sheet loaded, so agents are never a mix of real sprites and placeholder blobs.
    const hasReal = this.realArtReady;

    // With real office art the agent is seated behind its desk (desk draws in front to occlude
    // the legs); the higher seat + agent depth produce the "at the desk" look.
    const seatedY = this.realArtReady ? pos.y - 40 : pos.y - 10;
    const container = this.add.container(pos.x, seatedY);
    container.setDepth(DEPTH.agent);
    let body: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite;
    if (hasReal) {
      this.ensureCharacterAnims(sheetKey);
      // Frame is 32×64 (tall). Scale 1.3 → ~42×83 on screen, proportionate to the 64px
      // office tiles; origin biased downward so the character's feet sit near the desk pos
      // (the sprite's body occupies the lower ~2/3 of the 64px frame). Both are tunable.
      const sprite = this.add.sprite(0, 0, sheetKey, CHARACTER_ANIM.idle.down.start)
        .setOrigin(0.5, 0.66)
        .setScale(1.3);
      sprite.play(`${sheetKey}-idle-down`);
      body = sprite;
    } else {
      const appearance = appearanceForAgent(agentId);
      const texKey = ensureTintedTexture(this, 'character', appearance.outfitColor);
      body = this.add.image(0, 0, texKey).setScale(2);
    }
    body.setInteractive({ useHandCursor: true });
    body.on('pointerdown', () => {
      this.callbacks.onAgentClick(agentId, this.directiveForAgent(agentId));
    });
    container.add(body);

    const agentSprite: AgentSprite = {
      container,
      body,
      agentId,
      thinkBubble: null,
      speechBubble: null,
      stateTint: 'normal',
      sheetKey: hasReal ? sheetKey : null,
      hasReal,
    };
    this.agents.set(agentId, agentSprite);
    return agentSprite;
  }

  private animateClawDeliver(directive: SceneDirective & { kind: 'claw.deliver' }): void {
    const target = deskPositionForAgent(this.layout, directive.agentId);
    const tasksX = this.layout.tasksBoard.x;
    const trackY = this.layout.clawTrack.y;

    this.tweens.add({
      targets: this.claw,
      x: tasksX,
      duration: 600,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        const card = this.add.image(tasksX, this.layout.tasksBoard.y - 20, 'task-card').setScale(2).setDepth(DEPTH.overlay);
        this.tweens.add({
          targets: this.claw,
          x: target.x,
          duration: 800,
          ease: 'Sine.easeInOut',
          onComplete: () => {
            this.tweens.add({
              targets: card,
              x: target.x,
              y: target.y - 30,
              duration: 400,
              onComplete: () => {
                card.destroy();
                this.ensureAgent(directive.agentId);
                this.setAgentState(directive.agentId, 'active');
              },
            });
            this.tweens.add({
              targets: this.claw,
              x: this.layout.clawTrack.idleX,
              duration: 500,
            });
          },
        });
      },
    });
    this.claw.y = trackY;
  }

  private setAgentState(agentId: string, state: 'active' | 'error'): void {
    const agent = this.ensureAgent(agentId);
    agent.stateTint = state;
    if (state === 'error') {
      agent.body.setTint(0xff6666);
    } else {
      agent.body.clearTint();
      if (!agent.hasReal) {
        const appearance = appearanceForAgent(agentId);
        agent.body.setTexture(ensureTintedTexture(this, 'character', appearance.outfitColor));
      }
    }
    this.tweens.add({
      targets: agent.container,
      scaleX: 1.1,
      scaleY: 1.1,
      yoyo: true,
      duration: 200,
    });
  }

  /** Register idle/walk × 4-direction anims for a loaded character sheet (idempotent). */
  private ensureCharacterAnims(sheetKey: string): void {
    for (const kind of ['idle', 'walk'] as const) {
      for (const dir of ['down', 'up', 'left', 'right'] as const) {
        const animKey = `${sheetKey}-${kind}-${dir}`;
        if (this.anims.exists(animKey)) continue;
        const spec = CHARACTER_ANIM[kind][dir];
        this.anims.create({
          key: animKey,
          frames: this.anims.generateFrameNumbers(sheetKey, {
            start: spec.start,
            end: spec.start + spec.length - 1,
          }),
          frameRate: spec.frameRate,
          repeat: -1,
        });
      }
    }
  }

  private facing(dx: number, dy: number): Direction {
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
    return dy < 0 ? 'up' : 'down';
  }

  private animateWalk(directive: SceneDirective & { kind: 'agent.walk' }): void {
    const agent = this.ensureAgent(directive.agentId);
    const target = deskPositionForAgent(this.layout, directive.targetAgentId);
    const destX = target.x - 20;
    const destY = target.y - 10;
    const dir = this.facing(destX - agent.container.x, destY - agent.container.y);
    const sprite = agent.body;
    if (agent.hasReal && agent.sheetKey && sprite instanceof Phaser.GameObjects.Sprite) {
      sprite.play(`${agent.sheetKey}-walk-${dir}`, true);
    }
    this.tweens.add({
      targets: agent.container,
      x: destX,
      y: destY,
      duration: 700,
      ease: 'Linear',
      onComplete: () => {
        if (agent.hasReal && agent.sheetKey && sprite instanceof Phaser.GameObjects.Sprite) {
          sprite.play(`${agent.sheetKey}-idle-${dir}`, true);
        }
      },
    });
  }

  private showSpeech(directive: SceneDirective & { kind: 'agent.speak' }): void {
    const agent = this.ensureAgent(directive.agentId);
    if (agent.speechBubble) {
      agent.speechBubble.destroy();
    }
    const text = (directive.content ?? '…').slice(0, 40);
    agent.speechBubble = this.add
      .text(agent.container.x, agent.container.y - 40, text, {
        fontSize: '10px',
        color: '#1a1f16',
        backgroundColor: '#ffffff',
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.overlay);
    agent.speechBubble.setInteractive({ useHandCursor: true });
    agent.speechBubble.on('pointerdown', () => {
      this.callbacks.onDirectiveClick(directive);
    });
    this.time.delayedCall(3000, () => {
      agent.speechBubble?.destroy();
      agent.speechBubble = null;
    });
  }

  private setThinkBubble(directive: SceneDirective & { kind: 'agent.think' }): void {
    const agent = this.ensureAgent(directive.agentId);
    if (directive.phase === 'stop') {
      agent.thinkBubble?.destroy();
      agent.thinkBubble = null;
      return;
    }
    agent.thinkBubble?.destroy();
    agent.thinkBubble = this.add
      .image(agent.container.x + 20, agent.container.y - 30, 'think-bubble')
      .setScale(1.5)
      .setDepth(DEPTH.overlay);
    if (directive.skillName) {
      this.add
        .text(agent.container.x + 20, agent.container.y - 30, directive.skillName.slice(0, 8), {
          fontSize: '8px',
          color: '#333',
        })
        .setOrigin(0.5)
        .setDepth(DEPTH.overlay);
    }
  }

  private animateTube(direction: 'in' | 'out'): void {
    const pos = direction === 'in' ? this.layout.tubeIn : this.layout.tubeOut;
    const particle = this.add.circle(pos.x, pos.y, 6, direction === 'in' ? 0x6a9a6a : 0x9a6a6a).setDepth(DEPTH.overlay);
    const targetX = direction === 'in'
      ? (this.layout.coordinatorId
        ? deskPositionForAgent(this.layout, this.layout.coordinatorId).x
        : 400)
      : pos.x + 40;
    this.tweens.add({
      targets: particle,
      x: targetX,
      y: pos.y + 20,
      alpha: 0,
      duration: 600,
      onComplete: () => particle.destroy(),
    });
  }

  private showTaskCard(directive: SceneDirective & { kind: 'task.appear' }): void {
    const existing = this.taskCards.get(directive.taskId);
    if (existing) return;
    const card = this.add
      .image(this.layout.tasksBoard.x, this.layout.tasksBoard.y - 30, 'task-card')
      .setScale(2)
      .setDepth(DEPTH.overlay)
      .setInteractive({ useHandCursor: true });
    card.on('pointerdown', () => {
      this.callbacks.onDirectiveClick(directive);
    });
    if (directive.title) {
      this.add
        .text(card.x, card.y, directive.title.slice(0, 12), { fontSize: '8px', color: '#1a1f16' })
        .setOrigin(0.5)
        .setDepth(DEPTH.overlay);
    }
    this.taskCards.set(directive.taskId, card);
    this.tweens.add({ targets: card, y: card.y - 10, yoyo: true, duration: 300 });
  }

  private trashTask(directive: SceneDirective & { kind: 'task.trash' }): void {
    const card = this.taskCards.get(directive.taskId);
    if (!card) return;
    this.tweens.add({
      targets: card,
      x: this.layout.wastebasket.x,
      y: this.layout.wastebasket.y,
      angle: 360,
      alpha: 0,
      duration: 500,
      onComplete: () => {
        card.destroy();
        this.taskCards.delete(directive.taskId);
      },
    });
  }

  private showBadge(directive: SceneDirective & { kind: 'badge' }): void {
    const badge = this.add.container(400, 50);
    const bg = this.add.image(0, 0, 'badge').setScale(1.5);
    const label = this.add.text(0, 0, directive.label.slice(0, 20), {
      fontSize: '9px',
      color: '#1a1f16',
    }).setOrigin(0.5);
    badge.add([bg, label]);
    badge.setInteractive(new Phaser.Geom.Rectangle(-40, -8, 80, 16), Phaser.Geom.Rectangle.Contains);
    badge.on('pointerdown', () => {
      this.callbacks.onDirectiveClick(directive);
    });
    this.badgeGroup.add(badge);
    this.tweens.add({
      targets: badge,
      alpha: 0,
      delay: 4000,
      duration: 500,
      onComplete: () => badge.destroy(),
    });
  }

  private directiveForAgent(agentId: string): SceneDirective | null {
    return this.lastDirectiveByAgent.get(agentId) ?? null;
  }

  private recordDirectiveAgents(directive: SceneDirective): void {
    if ('agentId' in directive && typeof directive.agentId === 'string') {
      this.lastDirectiveByAgent.set(directive.agentId, directive);
    }
    if (directive.kind === 'agent.walk') {
      this.lastDirectiveByAgent.set(directive.targetAgentId, directive);
    }
  }
}
