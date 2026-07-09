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
import { DECOR_PROPS, DECOR_SINGLES, decorTextureKey } from './decor.js';

// Explicit render-order bands. Desks draw IN FRONT of seated characters (so the desk front
// occludes their legs), with chairs behind and on-desk devices in front; overlays sit on top.
const DEPTH = {
  shadow: 1,    // wall-cast floor shadow — above the floor, below the walls
  wall: 2,      // room walls + wall-mounted fixed props (board, scheduler, wastebasket, tubes)
  decorWall: 3, // decorative art hung on the back wall (above the wall, behind furniture/agents)
  decorFloor: 4,// decorative props standing on the floor strip (above shadow, behind chairs/agents)
  chair: 5,
  agent: 10,
  desk: 15,     // real-art composed desks (in front of the seated agent)
  device: 18,   // computers / monitors sitting on the desk
  walker: 20,   // an agent that has stood up to walk/visit — above desks so it's never occluded
  overlay: 40,  // speech / think bubbles, task cards, badges, desk labels
  clawCard: 49, // a job card gripped by the descending grabber (above the office, below the mechanism)
  clawTrack: 50,// the overhead claw-track rail — mounted in front of the whole office (top layer)
  clawMech: 51, // the chain + grabber that hang/descend below the runner
  claw: 52,     // the claw runner/arm riding the rail — top layer, above track/chain/grabber
} as const;

// Claw grabber vertical travel — the placeholder grabber descends off the runner to "grab" a job
// at the scheduler and again to deposit it on a desk, then retracts. A chain tile fills the gap
// between the runner and the grabber while it's lowered. Pixel values tuned against live render.
const CLAW_REST_OFFSET = 28;      // grabber's retracted y below the runner's track y (tucked under it)
const CLAW_CHAIN_TOP_OFFSET = 12; // chain top y below the track y (just under the runner)
const CLAW_LEG_MS = 420;          // one descend or ascend leg
const CLAW_SLIDE_MS = 700;        // horizontal slide between stations

// Agent "walk over to delegate" visit: how the visitor stands relative to the target's desk, and
// how long it lingers before walking home. It stands in FRONT of the desk (positive dy) at a
// raised depth so it's never hidden behind the desk (the old code parked it behind → "under" it).
const WALK_DEST_DX = -40;         // x offset from the target desk (slightly left of centre)
const WALK_DEST_DY = 46;          // y offset — in front of the desk, not behind it
const WALK_LEG_MS = 700;          // one leg of the trip (there / back)
const WALK_VISIT_MS = 3200;       // linger at the desk before walking home (≈ a delegation's speech)

// Pixel-art speech / thought bubbles. Drawn from crisp axis-aligned fillRects (blocky bevelled
// corners + a chunky border) so they read as pixel art, with a readable monospace label on top.
// All tunable — bump BUBBLE_FONT_PX / paddings for bigger, the dwell knobs for slower.
const BUBBLE_BORDER_COLOR = 0x1a1f16; // near-black pixel border (matches UI ink)
const SPEECH_FILL_COLOR = 0xfdfdfb;   // speech = crisp near-white (clearly lighter than thought)
const THINK_FILL_COLOR = 0xf1e6c9;    // thought = warm cream (distinctly more yellow than speech)
const BUBBLE_TEXT_COLOR = '#1a1f16';
const BUBBLE_FONT_PX = 14;            // label size (was 10/8 — far too small to read)
const BUBBLE_BORDER_PX = 3;           // border thickness
const BUBBLE_PAD_X = 10;              // horizontal text padding inside the bubble
const BUBBLE_PAD_Y = 7;               // vertical text padding
const BUBBLE_MAX_TEXT_W = 190;        // wrap long speech instead of one tiny line
const BUBBLE_BEVEL_SPEECH = 4;        // single-step corner bevel for speech (reads fine as-is)
// Thought bubbles round their corners with a multi-step pixel staircase instead of one big bevel
// notch: each inset is applied to a THINK_CORNER_STEP-tall row from the corner inward, so the
// corner staggers down smoothly (outermost row most inset → widening to the straight middle).
const THINK_CORNER_STEP = 3;
const THINK_CORNER_INSETS = [8, 5, 3, 1];
const BUBBLE_GAP_SPEECH = 42;         // tail tip height above the agent's anchor
const BUBBLE_GAP_THINK = 46;          // thought sits a touch higher (and offset right, see caller)
const SPEECH_TAIL_H = 12;             // downward pointer tail
const THINK_TAIL_H = 26;             // vertical room for the trailing thought puffs
// Speech dwell scales with reading length so short quips don't linger and long lines are readable.
const SPEECH_DWELL_MIN = 2800;
const SPEECH_DWELL_PER_CHAR = 70;
const SPEECH_DWELL_MAX = 9000;

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
  thinkBubble: Phaser.GameObjects.Container | null;
  speechBubble: Phaser.GameObjects.Container | null;
  stateTint: 'normal' | 'active' | 'error';
  /** Phaser texture key for the loaded character sheet, or null if using placeholder. */
  sheetKey: string | null;
  /** True when a real premade sprite sheet loaded successfully and is in use. */
  hasReal: boolean;
}

// Custom in-repo art bundled in public/assets — present in EVERY build. A load failure here is a
// real bug (bad BASE_URL, CSP block, corrupt/404 asset), NOT the normal open-core "licensed art
// absent" path, so it's logged loudly (see the loaderror handler) instead of as info.
const BUNDLED_ASSET_KEYS = new Set(['claw-track', 'claw-runner', 'claw-chain', 'scheduler-art']);

export class OfficeScene extends Phaser.Scene {
  private layout!: WorldLayout;
  private agents = new Map<string, AgentSprite>();
  private claw!: Phaser.GameObjects.Image;
  private clawGrabber!: Phaser.GameObjects.Image;
  private clawChain!: Phaser.GameObjects.TileSprite;
  // A job card currently gripped by the grabber; positioned to follow the grabber each frame.
  private carriedCard: Phaser.GameObjects.Image | null = null;
  // True while a claw.deliver is animating. The claw/grabber/carriedCard are single shared objects,
  // so an overlapping delivery (back-to-back directives in fast replay) would fight over them and
  // mis-destroy the wrong card. When busy, a new delivery skips the animation but still applies its
  // effect (target agent activates). Reset in spawnFixedProps so a scene.restart clears it.
  private clawBusy = false;
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
    // The LoaderPlugin instance is reused across scene.restart() (updateLayout/resyncPlayback),
    // so re-registering the listener each preload would stack duplicate handlers. Clear any prior
    // loaderror listener first, then attach exactly one.
    // Record load failures instead of throwing; absent licensed art is the normal
    // open-core path and must fall back cleanly to procedural placeholders.
    this.load.off('loaderror');
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      this.failedLoads.add(file.key);
      if (BUNDLED_ASSET_KEYS.has(file.key)) {
        // Shipped in-repo art failed to load — this should never happen in a correct build.
        console.error(`[antfarm] BUNDLED asset failed to load: ${file.key} (${file.url}) — check BASE_URL / CSP / asset integrity`);
      } else {
        // Expected when licensed art is absent (open-core) — info, never error.
        console.info(`[antfarm] licensed asset not loaded (using placeholder): ${file.key}`);
      }
    });

    // Textures persist across restarts, so skip any key already loaded — re-queuing it is
    // redundant loader work and would re-fire loaderror for assets that are legitimately absent.
    if (!this.textures.exists(OFFICE_TILESET.key)) this.load.image(OFFICE_TILESET.key, OFFICE_TILESET.url);
    if (!this.textures.exists(ROOM_BUILDER.key)) this.load.image(ROOM_BUILDER.key, ROOM_BUILDER.url);
    // Office desk singles (desks, chairs, monitors, computer) — composed in buildOfficeArt().
    // Decorative singles (plants, wall art, furniture) are loaded here too; they're placed
    // best-effort in spawnDecor() and are NOT part of the licensedAssetsPresent gate, so a
    // missing decor tile degrades to "that prop absent" rather than voiding the whole scene.
    for (const n of [...OFFICE_SINGLES, ...DECOR_SINGLES]) {
      const key = officeSingleKey(n);
      if (!this.textures.exists(key)) this.load.image(key, officeSingleUrl(n));
    }
    // Custom (non-licensed) claw art — the track rail and the runner/arm. Bundled app art shipped
    // in public/assets, world-served at BASE_URL and present in EVERY build (unlike the auth-gated
    // licensed art). The runner replaces the procedural 'claw' texture (see spawnFixedProps).
    if (!this.textures.exists('claw-track')) {
      this.load.image('claw-track', `${import.meta.env.BASE_URL}assets/claw-track.png`);
    }
    if (!this.textures.exists('claw-runner')) {
      this.load.image('claw-runner', `${import.meta.env.BASE_URL}assets/claw-runner.png`);
    }
    if (!this.textures.exists('claw-chain')) {
      this.load.image('claw-chain', `${import.meta.env.BASE_URL}assets/claw-chain.png`);
    }
    // Custom scheduler machine art — replaces the procedural 'scheduler' placeholder.
    if (!this.textures.exists('scheduler-art')) {
      this.load.image('scheduler-art', `${import.meta.env.BASE_URL}assets/scheduler.png`);
    }

    // Character sheets are loaded here too (added in Task 5).
    const desks = this.registry.get('desks') as DeskSlot[] ?? [];
    const sheetIndices = new Set(desks.map((d) => characterSheetIndexForAgent(d.agentId)));
    for (const idx of sheetIndices) {
      const key = characterSheetKey(idx);
      if (this.textures.exists(key)) continue;
      this.load.spritesheet(key, characterSheetUrl(characterSheetFile(idx)), {
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
    this.spawnDecor();
    this.spawnDesks();
    this.spawnAgents(desks);
    this.badgeGroup = this.add.container(0, 0).setDepth(DEPTH.overlay);
    this.spawnClawTrack();

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
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[antfarm] cropToTexture: no 2d canvas context'); // swapOfficeTextures keeps the placeholder
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
    // The old wall "tasks board" was removed — the scheduler now serves as the job source/anchor,
    // and task cards spawn there (see showTaskCard).
    const schedulerKey = this.loadedOk('scheduler-art') ? 'scheduler-art' : 'scheduler';
    this.add.image(this.layout.scheduler.x, this.layout.scheduler.y, schedulerKey).setScale(2).setDepth(DEPTH.wall);
    this.add.image(this.layout.wastebasket.x, this.layout.wastebasket.y, 'wastebasket').setScale(2).setDepth(DEPTH.wall);
    this.add.image(this.layout.tubeIn.x, this.layout.tubeIn.y, 'tube').setScale(2).setTint(0x6a9a6a).setDepth(DEPTH.wall);
    this.add.image(this.layout.tubeOut.x, this.layout.tubeOut.y, 'tube').setScale(2).setTint(0x9a6a6a).setDepth(DEPTH.wall);

    // Custom claw-runner art if it loaded, else the procedural 'claw' placeholder.
    const clawKey = this.loadedOk('claw-runner') ? 'claw-runner' : 'claw';
    this.claw = this.add.image(this.layout.clawTrack.idleX, this.layout.clawTrack.y, clawKey).setScale(2).setDepth(DEPTH.claw);

    // The grabber (placeholder 'claw' art for now) hangs just below the runner and descends to
    // grab/deposit jobs; the chain fills the gap between them while it's lowered. Both track the
    // runner's x every frame (see update()); the grabber's y is driven by animateClawDeliver.
    const restY = this.layout.clawTrack.y + CLAW_REST_OFFSET;
    const chainTop = this.layout.clawTrack.y + CLAW_CHAIN_TOP_OFFSET;
    this.clawChain = this.add
      .tileSprite(this.layout.clawTrack.idleX, chainTop, 64, 0, 'claw-chain')
      .setOrigin(0.5, 0)   // grow downward from the runner
      .setTileScale(2)     // match the office's 32px→64px ×2 look
      .setDepth(DEPTH.clawMech)
      .setVisible(false);
    this.clawGrabber = this.add
      .image(this.layout.clawTrack.idleX, restY, 'claw')
      .setScale(2)
      .setDepth(DEPTH.clawMech);
    this.carriedCard = null;
    this.clawBusy = false;
  }

  /** Per-frame: keep the grabber + chain (and any gripped job card) locked under the runner's x.
   *  The runner slides horizontally via tweens; the grabber's y is animated separately, so the
   *  chain is stretched to fill whatever vertical gap currently exists between the two. */
  update(): void {
    if (!this.clawGrabber) return; // pre-create frame — nothing to sync yet
    const rx = this.claw.x;
    this.clawGrabber.x = rx;
    const chainTop = this.layout.clawTrack.y + CLAW_CHAIN_TOP_OFFSET;
    const chainH = Math.max(0, this.clawGrabber.y - chainTop);
    this.clawChain.x = rx;
    this.clawChain.y = chainTop;
    this.clawChain.height = chainH;
    this.clawChain.setVisible(chainH > 20); // hide the stub when the grabber is retracted
    if (this.carriedCard) {
      this.carriedCard.x = rx;
      this.carriedCard.y = this.clawGrabber.y;
    }

    // Keep each agent's bubbles pinned above it, so speech/thought travels WITH the agent when it
    // walks (e.g. the coordinator delegating): otherwise a bubble stays frozen at the desk where it
    // first appeared while the agent walks away — which is why delegations looked like they were
    // spoken from the coordinator's own desk.
    for (const agent of this.agents.values()) {
      if (agent.speechBubble) {
        agent.speechBubble.x = agent.container.x;
        agent.speechBubble.y = agent.container.y - BUBBLE_GAP_SPEECH;
      }
      if (agent.thinkBubble) {
        agent.thinkBubble.x = agent.container.x + 12;
        agent.thinkBubble.y = agent.container.y - BUBBLE_GAP_THINK;
      }
    }
  }

  /** Place the decorative back-wall props (plants, hung art, furniture, bookcase) from the decor
   *  manifest. Real-art only: these have no procedural fallback, so in placeholder/open-core mode
   *  we render nothing (matching the all-or-nothing art gate). Each prop is placed best-effort —
   *  a single that failed to load (or a crop whose source sheet is absent) is skipped, never a
   *  missing-texture void. See decor.ts to move/add/remove props. */
  private spawnDecor(): void {
    if (!this.realArtReady) return;
    for (const prop of DECOR_PROPS) {
      if (prop.enabled === false) continue; // kept in the manifest, toggled off the canvas
      let key: string;
      if (prop.source.kind === 'single') {
        key = officeSingleKey(prop.source.single);
        if (!this.loadedOk(key)) continue; // decor tile absent — skip just this prop
      } else {
        // Crop the prop out of its source sheet into a standalone texture (once).
        key = decorTextureKey(prop.id);
        if (!this.textures.exists(key)) {
          const { from, sx, sy, sw, sh } = prop.source;
          if (!this.loadedOk(from)) continue; // source sheet absent — skip
          try {
            this.cropToTexture(from, key, sx, sy, sw, sh);
          } catch (err) {
            console.warn(`[antfarm] failed to crop decor ${prop.id}; skipping`, err);
            continue;
          }
        }
      }
      // 'floor' props stand on their base point (bottom-anchored); 'wall' props hang centered.
      const originY = prop.layer === 'floor' ? 1 : 0.5;
      const depth = prop.layer === 'floor' ? DEPTH.decorFloor : DEPTH.decorWall;
      this.add
        .image(prop.x, prop.y, key)
        .setOrigin(0.5, originY)
        .setScale(prop.scale ?? 2)
        .setDepth(depth);
    }
  }

  /** Tile the custom claw-track rail across the top row (row 1), on the top layer so the overhead
   *  claw mechanism reads as mounted in front of the whole office. 32×32 art drawn ×2 = 64px, on
   *  the same 64px grid as the floor/walls. Custom in-repo art, so it renders in every build. */
  private spawnClawTrack(): void {
    if (!this.loadedOk('claw-track')) {
      // Bundled art — absence means a broken build (also logged loudly by the loaderror handler).
      console.warn('[antfarm] claw-track art missing — overhead rail will not render');
      return;
    }
    for (let x = 0; x < STAGE_WIDTH; x += 64) {
      this.add.image(x + 32, 32, 'claw-track').setScale(2).setDepth(DEPTH.clawTrack);
    }
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
    // Single shared claw: if a delivery is already in flight, don't start a competing tween chain
    // (it would fight over the runner/grabber and mis-destroy the carried card). Still apply the
    // effect so the target agent activates, just without the animation.
    if (this.clawBusy) {
      this.ensureAgent(directive.agentId);
      this.setAgentState(directive.agentId, 'active');
      return;
    }
    this.clawBusy = true;

    const target = deskPositionForAgent(this.layout, directive.agentId);
    const pickupX = this.layout.scheduler.x;   // grab the job over the scheduler (the job source)
    const grabY = this.layout.scheduler.y;      // how far the grabber reaches down to the scheduler
    const depositY = target.y - 30;             // how far it reaches down onto the target desk
    const restY = this.layout.clawTrack.y + CLAW_REST_OFFSET;

    // 1. Slide the runner over the scheduler. The grabber + chain follow its x via update().
    this.tweens.add({
      targets: this.claw,
      x: pickupX,
      duration: CLAW_SLIDE_MS,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        // 2. Descend the grabber to the scheduler (the chain stretches to fill the gap).
        this.tweens.add({
          targets: this.clawGrabber,
          y: grabY,
          duration: CLAW_LEG_MS,
          ease: 'Sine.easeIn',
          onComplete: () => {
            // Grab the job: spawn a card that now rides with the grabber (see update()).
            this.carriedCard?.destroy();
            this.carriedCard = this.add
              .image(pickupX, grabY, 'task-card')
              .setScale(2)
              .setDepth(DEPTH.clawCard);
            // 3. Retract the grabber (with the job) back up under the runner.
            this.tweens.add({
              targets: this.clawGrabber,
              y: restY,
              duration: CLAW_LEG_MS,
              ease: 'Sine.easeOut',
              onComplete: () => {
                // 4. Slide the runner over the target desk.
                this.tweens.add({
                  targets: this.claw,
                  x: target.x,
                  duration: CLAW_SLIDE_MS,
                  ease: 'Sine.easeInOut',
                  onComplete: () => {
                    // 5. Descend to deposit the job on the desk.
                    this.tweens.add({
                      targets: this.clawGrabber,
                      y: depositY,
                      duration: CLAW_LEG_MS,
                      ease: 'Sine.easeIn',
                      onComplete: () => {
                        // Release the job: detach the card and let it settle on the desk.
                        const card = this.carriedCard;
                        this.carriedCard = null;
                        if (card) {
                          this.tweens.add({
                            targets: card,
                            y: target.y - 10,
                            duration: 200,
                            onComplete: () => card.destroy(),
                          });
                        }
                        this.ensureAgent(directive.agentId);
                        this.setAgentState(directive.agentId, 'active');
                        // 6. Retract the grabber, then send the runner back to idle.
                        this.tweens.add({
                          targets: this.clawGrabber,
                          y: restY,
                          duration: CLAW_LEG_MS,
                          ease: 'Sine.easeOut',
                          onComplete: () => {
                            this.tweens.add({
                              targets: this.claw,
                              x: this.layout.clawTrack.idleX,
                              duration: 500,
                              ease: 'Sine.easeInOut',
                              onComplete: () => { this.clawBusy = false; }, // delivery done — allow the next
                            });
                          },
                        });
                      },
                    });
                  },
                });
              },
            });
          },
        });
      },
    });
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
    const sprite = agent.body;

    // Home = where the agent is right now (its own seat); it returns here after the visit.
    const homeX = agent.container.x;
    const homeY = agent.container.y;
    // Stand in FRONT of the target's desk (not behind it) so the visitor is visible; raise the
    // depth above desks/devices for the whole trip so it can't be occluded en route or on arrival.
    const destX = target.x + WALK_DEST_DX;
    const destY = target.y + WALK_DEST_DY;
    agent.container.setDepth(DEPTH.walker);

    const play = (kind: 'walk' | 'idle', dir: Direction): void => {
      if (agent.hasReal && agent.sheetKey && sprite instanceof Phaser.GameObjects.Sprite) {
        sprite.play(`${agent.sheetKey}-${kind}-${dir}`, true);
      }
    };

    // Leg 1: walk over to the target.
    const outDir = this.facing(destX - homeX, destY - homeY);
    play('walk', outDir);
    this.tweens.add({
      targets: agent.container,
      x: destX,
      y: destY,
      duration: WALK_LEG_MS,
      ease: 'Linear',
      onComplete: () => {
        play('idle', outDir);
        // Linger (the delegation speech shows here), then walk home and re-seat.
        this.time.delayedCall(WALK_VISIT_MS, () => {
          const backDir = this.facing(homeX - destX, homeY - destY);
          play('walk', backDir);
          this.tweens.add({
            targets: agent.container,
            x: homeX,
            y: homeY,
            duration: WALK_LEG_MS,
            ease: 'Linear',
            onComplete: () => {
              // Re-seated: always face the desk/computer (down), not the way it walked back —
              // otherwise it sits facing up/sideways, i.e. "backwards in its chair".
              play('idle', 'down');
              agent.container.setDepth(DEPTH.agent);
            },
          });
        });
      },
    });
  }

  /** Draw a blocky bevelled panel (chunky pixel border + cream fill) with crisp axis-aligned
   *  fillRects. `bevel` cuts the corners in square steps so it reads as pixel art rather than a
   *  smooth rounded rect. Coordinates are local to the graphics object. */
  private drawBevelPanel(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, bevel: number, fill: number): void {
    // Dark border shape (a rectangle with square-cut corners = two overlapping rects).
    g.fillStyle(BUBBLE_BORDER_COLOR, 1);
    g.fillRect(x + bevel, y, w - 2 * bevel, h);
    g.fillRect(x, y + bevel, w, h - 2 * bevel);
    // Interior, inset by the border thickness.
    const b = BUBBLE_BORDER_PX;
    g.fillStyle(fill, 1);
    g.fillRect(x + bevel + b, y + b, w - 2 * bevel - 2 * b, h - 2 * b);
    g.fillRect(x + b, y + bevel + b, w - 2 * b, h - 2 * bevel - 2 * b);
  }

  /** Draw a panel whose corners are rounded with a multi-step pixel staircase (THINK_CORNER_INSETS
   *  applied per THINK_CORNER_STEP-tall row) rather than one big bevel notch — smoother-looking
   *  corners for thought bubbles. Dark border shape first, then the cream fill inset by the border. */
  private drawRoundedPanel(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number): void {
    const step = THINK_CORNER_STEP;
    const insets = THINK_CORNER_INSETS;
    const cornerH = insets.length * step;
    const strip = (ix: number, iy: number, iw: number, ih: number, color: number): void => {
      g.fillStyle(color, 1);
      for (let i = 0; i < insets.length; i++) {
        const inset = insets[i]!;
        g.fillRect(ix + inset, iy + i * step, iw - 2 * inset, step);                 // top corner row
        g.fillRect(ix + inset, iy + ih - (i + 1) * step, iw - 2 * inset, step);       // mirrored bottom row
      }
      g.fillRect(ix, iy + cornerH, iw, ih - 2 * cornerH);                             // straight middle band
    };
    strip(x, y, w, h, BUBBLE_BORDER_COLOR);
    const b = BUBBLE_BORDER_PX;
    strip(x + b, y + b, w - 2 * b, h - 2 * b, THINK_FILL_COLOR);
  }

  /** A stepped triangular speech tail pointing straight down from (cx, topY) to (cx, topY+tailH),
   *  with the cream fill inset inside the dark border so it matches the bubble body. */
  private drawSpeechTail(g: Phaser.GameObjects.Graphics, cx: number, topY: number, tailH: number, fill: number): void {
    const step = 3;
    const startW = 16;
    g.fillStyle(BUBBLE_BORDER_COLOR, 1);
    for (let i = 0; i * step < tailH; i++) {
      const w = Math.max(step, startW - i * 4);
      g.fillRect(cx - w / 2, topY + i * step, w, step);
    }
    g.fillStyle(fill, 1);
    for (let i = 0; i * step < tailH - step; i++) {
      const w = Math.max(step, startW - 6 - i * 4);
      g.fillRect(cx - w / 2, topY + i * step, w, step);
    }
  }

  /** Two small bevelled puffs descending from the thought bubble toward the agent — the classic
   *  "…" trail of a thought balloon. */
  private drawThoughtPuffs(g: Phaser.GameObjects.Graphics, cx: number, topY: number): void {
    this.drawBevelPanel(g, cx - 7, topY + 2, 14, 14, 3, THINK_FILL_COLOR);
    this.drawBevelPanel(g, cx - 4, topY + 16, 9, 9, 2, THINK_FILL_COLOR);
  }

  /** Build a pixel-art bubble (speech = tail, think = puffs) sized to its text, anchored so the
   *  tail/puffs point down at (ax, ay). Returns the container; the label is stashed on it under
   *  the 'label' data key for callers that want to wire up interactivity. */
  private makeBubble(ax: number, ay: number, text: string, kind: 'speech' | 'think'): Phaser.GameObjects.Container {
    const container = this.add.container(ax, ay).setDepth(DEPTH.overlay);
    const label = this.add
      .text(0, 0, text, {
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: `${BUBBLE_FONT_PX}px`,
        color: BUBBLE_TEXT_COLOR,
        align: 'center',
        wordWrap: { width: BUBBLE_MAX_TEXT_W },
      })
      .setOrigin(0.5, 0.5);

    const w = Math.ceil(label.width) + BUBBLE_PAD_X * 2;
    const h = Math.ceil(label.height) + BUBBLE_PAD_Y * 2;
    const tailH = kind === 'speech' ? SPEECH_TAIL_H : THINK_TAIL_H;
    const bodyTop = -(tailH + h);   // bubble body sits above the anchor; tail/puffs reach down to 0
    const bodyBottom = -tailH;

    const g = this.add.graphics();
    if (kind === 'speech') {
      this.drawBevelPanel(g, -w / 2, bodyTop, w, h, BUBBLE_BEVEL_SPEECH, SPEECH_FILL_COLOR);
      this.drawSpeechTail(g, 0, bodyBottom, tailH, SPEECH_FILL_COLOR);
    } else {
      // Thought bubbles get the multi-step staircase corner (rounder than a single bevel notch).
      this.drawRoundedPanel(g, -w / 2, bodyTop, w, h);
      this.drawThoughtPuffs(g, 0, bodyBottom);
    }

    label.setPosition(0, bodyTop + h / 2);
    container.add([g, label]);
    container.setData('label', label);

    // Little pop-in so bubbles appear with a bit of life rather than snapping in.
    container.setScale(0.85);
    this.tweens.add({ targets: container, scale: 1, duration: 150, ease: 'Back.easeOut' });
    return container;
  }

  private showSpeech(directive: SceneDirective & { kind: 'agent.speak' }): void {
    const agent = this.ensureAgent(directive.agentId);
    agent.speechBubble?.destroy();
    const text = (directive.content ?? '…').slice(0, 140);
    const bubble = this.makeBubble(agent.container.x, agent.container.y - BUBBLE_GAP_SPEECH, text, 'speech');
    agent.speechBubble = bubble;

    const label = bubble.getData('label') as Phaser.GameObjects.Text;
    label.setInteractive({ useHandCursor: true });
    label.on('pointerdown', () => this.callbacks.onDirectiveClick(directive));

    // Dwell scales with reading length, then fade out (rather than the old hard 3s pop-off).
    const dwell = Phaser.Math.Clamp(
      SPEECH_DWELL_MIN + text.length * SPEECH_DWELL_PER_CHAR,
      SPEECH_DWELL_MIN,
      SPEECH_DWELL_MAX,
    );
    this.time.delayedCall(dwell, () => {
      // Only fade THIS bubble — if a newer speech replaced it, that one already destroyed this and
      // owns its own timer; touching agent.speechBubble here would kill the replacement early.
      if (agent.speechBubble !== bubble) return;
      this.tweens.add({
        targets: bubble,
        alpha: 0,
        duration: 350,
        onComplete: () => {
          bubble.destroy();
          if (agent.speechBubble === bubble) agent.speechBubble = null;
        },
      });
    });
  }

  private setThinkBubble(directive: SceneDirective & { kind: 'agent.think' }): void {
    const agent = this.ensureAgent(directive.agentId);
    if (directive.phase === 'stop') {
      agent.thinkBubble?.destroy(); // destroys the whole container (bubble + label) — no leak
      agent.thinkBubble = null;
      return;
    }
    agent.thinkBubble?.destroy();
    // Offset slightly right so a think bubble and a speech bubble don't fully overlap.
    const text = (directive.skillName ?? '…').slice(0, 24);
    agent.thinkBubble = this.makeBubble(agent.container.x + 12, agent.container.y - BUBBLE_GAP_THINK, text, 'think');
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
      .image(this.layout.scheduler.x, this.layout.scheduler.y - 30, 'task-card')
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
