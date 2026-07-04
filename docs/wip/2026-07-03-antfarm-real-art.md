# Ant Farm AF-7 — Real LimeZu Art Loader + Safe Serving — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render real licensed LimeZu tiles/furniture and character sprites in the Ant Farm Phaser office when the art is present, serve it only behind session auth, and fall back cleanly to procedural placeholders when it's absent.

**Architecture:** A new authenticated Fastify route (`/api/antfarm/assets/*`) streams licensed PNGs from a dir *outside* the world-downloadable Vite `public/` root. The Phaser `OfficeScene` gains a `preload()` that loads those assets by URL; in `create()` it registers procedural placeholders first (unconditional baseline), then **overwrites** office texture keys with sub-regions cropped from the Modern Office tileset and swaps agents to animated `Sprite`s from premade character sheets — but only for assets that actually loaded. Any load error leaves the placeholder in place, so the open-core build (no licensed art) renders the full procedural experience with no hard failure.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Fastify + `@fastify/static`, Phaser 3.90, Vitest, Docker (curia-deploy `Dockerfile.curia`).

## Global Constraints

- **ESM only:** `.js` extension on every relative import; `import.meta.dirname` not `__dirname`.
- **No `any`:** use proper types / `unknown`-narrowing per repo conventions.
- **No `console.log`** in server code (pino only). Browser app code (`apps/antfarm/`) may use `console.warn`/`console.error` for load diagnostics — the acceptance criterion is *no* console **errors** in the fallback path, so use `console.info`/`console.warn` for expected-absent-asset messages, never `console.error`.
- **Licensed bytes never touch the unauthenticated static surface.** Real art is read only by the auth-gated `/api/antfarm/assets/*` route, from `apps/antfarm/assets-licensed/` (gitignored) — never `apps/antfarm/public/`.
- **Curated staging = runtime PNGs only.** Exclude `.ase`/`.aseprite`, `.gif`, `.txt` guides, and duplicate 16/48px masters.
- **Character source:** deterministic 1-of-20 premade sheets (NOT generator-part compositing — that library is not staged).
- **Naming:** no "Nathan"; no deployment-specific account names in shipped code.
- **Every PR updates `CHANGELOG.md`** under `## [Unreleased]`.
- **Typecheck before every commit touching `.ts`:** `pnpm -C <worktree> run typecheck`.
- **Worktree:** all work in `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art` (branch `feat/antfarm-real-art-1335`). Use `pnpm -C <path>` / `git -C <path>`, never `cd &&`.
- **curia-deploy changes** land in the separate `curia-deploy` repo (its own branch + PR), not the curia repo.

---

## File Structure

**curia repo (`worktrees/curia-antfarm-real-art/`):**
- Create `src/channels/http/routes/antfarm-assets.ts` — auth-gated licensed-asset streamer.
- Modify `src/channels/http/http-adapter.ts` — register the new route.
- Create `tests/integration/antfarm-assets.test.ts` — auth + 404 + traversal tests.
- Modify `apps/antfarm/src/game/agent-appearance.ts` — export `hashAgentId`.
- Create `apps/antfarm/src/game/character-sheets.ts` (+ `.test.ts`) — deterministic sheet selection.
- Create `apps/antfarm/src/game/asset-manifest.ts` — office tileset region map + character sheet/frame contract.
- Modify `apps/antfarm/src/game/OfficeScene.ts` — `preload()`, office texture-key swap, animated character sprites, clean fallback.
- Modify root `.gitignore` — ignore `apps/antfarm/assets-licensed/`.
- Modify `apps/antfarm/public/assets/README.md` — document the new serving path.
- Modify `CHANGELOG.md`.

**curia-deploy repo:**
- Add `custom/assets/antfarm/limezu/{office,characters}/` — curated runtime PNGs.
- Modify `deploy/compose/Dockerfile.curia` — COPY licensed art into `apps/antfarm/assets-licensed/`.
- Modify `runbooks/antfarm-deploy.md` — supersede the deferred-asset note.

**Dev tooling (not committed):** `/tmp/af-slicer.html` — canvas viewer for pinning tileset regions and character frame indices (procedure in Task 4 & Task 6).

---

## Task 1: Authenticated licensed-asset endpoint

Serves licensed PNGs only to authenticated sessions, from a dir outside the public web root. This is the security-critical task and is fully TDD-able via Fastify `inject`.

**Files:**
- Create: `src/channels/http/routes/antfarm-assets.ts`
- Modify: `src/channels/http/http-adapter.ts` (import near line 36; register near line 508)
- Test: `tests/integration/antfarm-assets.test.ts`
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Consumes: `assertSecret`, `SessionStore` from `../session-auth.js` (existing).
- Produces: `antfarmAssetsRoutes: FastifyPluginAsync<AntfarmAssetsOptions>` where
  `AntfarmAssetsOptions = { webAppBootstrapSecret: string | undefined; sessions: SessionStore }`.
  Route: `GET /api/antfarm/assets/*` → 200 (PNG stream) | 401 (unauth) | 404 (missing/traversal).

- [ ] **Step 1: Write the failing test** — `tests/integration/antfarm-assets.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { antfarmAssetsRoutes } from '../../src/channels/http/routes/antfarm-assets.js';

const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'antfarm-assets');
const ASSETS_DIR = join(FIXTURE_ROOT, 'apps', 'antfarm', 'assets-licensed', 'limezu');

describe('Ant Farm licensed-asset routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await mkdir(ASSETS_DIR, { recursive: true });
    // 1x1 PNG bytes are fine — we only assert content-type + status, not decode.
    await writeFile(join(ASSETS_DIR, 'office.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    process.chdir(FIXTURE_ROOT);
    app = Fastify();
    await app.register(antfarmAssetsRoutes, { webAppBootstrapSecret: 'secret', sessions: new Map() });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.chdir(REPO_ROOT);
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/antfarm/assets/limezu/office.png' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the PNG with the bootstrap-secret header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/antfarm/assets/limezu/office.png',
      headers: { 'x-web-bootstrap-secret': 'secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  it('returns 404 for a missing asset (open-core has no art)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/antfarm/assets/limezu/missing.png',
      headers: { 'x-web-bootstrap-secret': 'secret' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('blocks path traversal with 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/antfarm/assets/..%2f..%2f..%2f..%2fpackage.json',
      headers: { 'x-web-bootstrap-secret': 'secret' },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art exec vitest run tests/integration/antfarm-assets.test.ts`
Expected: FAIL — cannot resolve `antfarm-assets.js` (module does not exist yet).

- [ ] **Step 3: Implement the route** — `src/channels/http/routes/antfarm-assets.ts`

```typescript
// antfarm-assets.ts — Fastify plugin that serves LICENSED LimeZu art behind session auth.
//
// Licensed sheets must NOT be world-downloadable (LimeZu forbids redistribution), so
// unlike antfarm-static.ts (the unauthenticated /antfarm/* SPA mount) this route:
//   1. reads from apps/antfarm/assets-licensed/ — OUTSIDE the Vite public/ web root, so
//      the bytes never appear on the unauthenticated static surface;
//   2. requires a valid session (assertSecret — same check as /api/antfarm/timeline);
//   3. 404s when the file or the whole dir is absent, so the open-core image (which ships
//      no licensed art) makes the Phaser loader fall back to procedural placeholders.

import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, relative, extname } from 'node:path';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface AntfarmAssetsOptions {
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

// Only image/JSON are ever served; anything else falls through to octet-stream.
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json',
};

export const antfarmAssetsRoutes: FastifyPluginAsync<AntfarmAssetsOptions> = async (app, opts) => {
  const { webAppBootstrapSecret, sessions } = opts;
  // Resolved once at registration; process.cwd() is /app in the container, repo root in dev.
  const assetsRoot = join(process.cwd(), 'apps', 'antfarm', 'assets-licensed');

  app.get<{ Params: { '*': string } }>('/api/antfarm/assets/*', async (req, reply) => {
    if (!assertSecret(req, reply, webAppBootstrapSecret, sessions)) return;

    const urlPath = req.params['*'] ?? '';
    if (!urlPath) return reply.status(404).send({ error: 'Not found' });

    const absPath = resolve(assetsRoot, urlPath);
    // Reject any path that escapes assetsRoot (path traversal).
    if (relative(assetsRoot, absPath).startsWith('..')) {
      return reply.status(404).send({ error: 'Not found' });
    }

    try {
      const s = await stat(absPath);
      if (!s.isFile()) return reply.status(404).send({ error: 'Not found' });
    } catch (err) {
      // Missing file OR missing assets-licensed dir (open-core) → 404 → placeholders.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.status(404).send({ error: 'Not found' });
      }
      throw err;
    }

    const type = CONTENT_TYPES[extname(absPath).toLowerCase()] ?? 'application/octet-stream';
    reply.type(type);
    // Licensed art is immutable per build; let authenticated browsers cache it.
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(createReadStream(absPath));
  });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art exec vitest run tests/integration/antfarm-assets.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the route in `http-adapter.ts`**

Add the import next to the existing antfarm imports (after line 36):

```typescript
import { antfarmAssetsRoutes } from './routes/antfarm-assets.js';
```

Register it immediately after the `if (this.config.auditLogRepo) { … antfarmRoutes … }` block (after line 346). It is registered unconditionally — when `webAppBootstrapSecret` is undefined, `assertSecret` returns 503, matching the other session-auth routes:

```typescript
    // Licensed Ant Farm art — auth-gated so LimeZu sheets are never world-downloadable.
    // Independent of auditLogRepo: art serving does not need the timeline data source.
    await this.app.register(antfarmAssetsRoutes, {
      webAppBootstrapSecret,
      sessions,
    });
```

- [ ] **Step 6: Add the gitignore entry** — append to `.gitignore` (repo root):

```
# Licensed Ant Farm art — layered in by curia-deploy at image build, never committed.
/apps/antfarm/assets-licensed/
```

- [ ] **Step 7: Typecheck + full route test + auth-hook regression**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art run typecheck`
Expected: no errors.
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art exec vitest run tests/integration/antfarm-assets.test.ts tests/integration/antfarm-static.test.ts`
Expected: PASS. (Confirms the new route does not disturb the existing static/timeline auth behavior.)

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art add src/channels/http/routes/antfarm-assets.ts src/channels/http/http-adapter.ts tests/integration/antfarm-assets.test.ts .gitignore
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art commit -m "feat(antfarm): auth-gated /api/antfarm/assets route for licensed art"
```

---

## Task 2: Deterministic premade-sheet selection

Maps each agent id to one of the 20 premade character sheets, using the same hash the placeholder appearance map uses. Pure function, TDD.

**Files:**
- Modify: `apps/antfarm/src/game/agent-appearance.ts` (export `hashAgentId`)
- Create: `apps/antfarm/src/game/character-sheets.ts`
- Test: `apps/antfarm/src/game/character-sheets.test.ts`

**Interfaces:**
- Consumes: `hashAgentId(agentId: string): number` (now exported from `agent-appearance.js`).
- Produces:
  - `PREMADE_COUNT = 20`
  - `characterSheetIndexForAgent(agentId: string): number` → integer in `[1, 20]`.
  - `characterSheetKey(index: number): string` → Phaser texture key, e.g. `'char-07'`.
  - `characterSheetFile(index: number): string` → filename, e.g. `'Premade_Character_32x32_07.png'`.

- [ ] **Step 1: Export the hash** — in `apps/antfarm/src/game/agent-appearance.ts`, change:

```typescript
function hashAgentId(agentId: string): number {
```
to:
```typescript
export function hashAgentId(agentId: string): number {
```

- [ ] **Step 2: Write the failing test** — `apps/antfarm/src/game/character-sheets.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  PREMADE_COUNT,
  characterSheetIndexForAgent,
  characterSheetKey,
  characterSheetFile,
} from './character-sheets.js';

describe('characterSheetIndexForAgent', () => {
  it('is stable for the same agent id', () => {
    expect(characterSheetIndexForAgent('coordinator')).toBe(characterSheetIndexForAgent('coordinator'));
  });

  it('always returns an index in [1, PREMADE_COUNT]', () => {
    for (const id of ['a', 'coordinator', 'ceo-inbox', 'calendar', 'x'.repeat(40), '']) {
      const idx = characterSheetIndexForAgent(id);
      expect(idx).toBeGreaterThanOrEqual(1);
      expect(idx).toBeLessThanOrEqual(PREMADE_COUNT);
    }
  });

  it('distributes across many sheets (not all identical)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(characterSheetIndexForAgent(`agent-${i}`));
    expect(seen.size).toBeGreaterThan(10);
  });

  it('formats zero-padded keys and filenames', () => {
    expect(characterSheetKey(7)).toBe('char-07');
    expect(characterSheetFile(7)).toBe('Premade_Character_32x32_07.png');
    expect(characterSheetFile(20)).toBe('Premade_Character_32x32_20.png');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art --filter @curia/antfarm exec vitest run src/game/character-sheets.test.ts`
Expected: FAIL — module `character-sheets.js` not found.

- [ ] **Step 4: Implement** — `apps/antfarm/src/game/character-sheets.ts`

```typescript
/** Deterministic 1-of-20 premade LimeZu character sheet per agent id.
 *
 * The staged asset master (curia-deploy custom/assets/antfarm) ships 20 ready-made
 * Modern Interiors character spritesheets. v1 picks one per agent deterministically
 * (generator-part compositing is deferred post-v1 — that layer library isn't staged).
 * Uses the SAME hash as the placeholder appearance map so a given agent's identity is
 * consistent whether real art or placeholders are rendered. */

import { hashAgentId } from './agent-appearance.js';

export const PREMADE_COUNT = 20;

/** 1-based index (matches the 1-based Premade_Character_32x32_NN.png filenames). */
export function characterSheetIndexForAgent(agentId: string): number {
  return (hashAgentId(agentId) % PREMADE_COUNT) + 1;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Phaser texture key for a sheet index. */
export function characterSheetKey(index: number): string {
  return `char-${pad2(index)}`;
}

/** Runtime PNG filename (under limezu/characters/) for a sheet index. */
export function characterSheetFile(index: number): string {
  return `Premade_Character_32x32_${pad2(index)}.png`;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art --filter @curia/antfarm exec vitest run src/game/character-sheets.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art --filter @curia/antfarm run typecheck`
Expected: no errors.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art add apps/antfarm/src/game/agent-appearance.ts apps/antfarm/src/game/character-sheets.ts apps/antfarm/src/game/character-sheets.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art commit -m "feat(antfarm): deterministic premade character sheet selection"
```

---

## Task 3: Asset manifest module + pin office tileset regions

Declares the runtime asset contract: which URLs to load, and — for the single Modern Office tileset image — the pixel sub-region for each office prop. Region coordinates are **pinned by visual measurement** using the slicer tool (concrete procedure below); this is a measurement step, not a placeholder.

**Files:**
- Create: `apps/antfarm/src/game/asset-manifest.ts`

**Interfaces:**
- Produces:
  - `ASSET_BASE = '/api/antfarm/assets/limezu'` — auth-gated URL prefix.
  - `OFFICE_TILESET = { key: 'office-tileset', url: `${ASSET_BASE}/office/Modern_Office_Black_Shadow_32x32.png` }`.
  - `type TileRegion = { placeholderKey: string; sx: number; sy: number; sw: number; sh: number }`.
  - `OFFICE_REGIONS: TileRegion[]` — one entry per office prop that has real-art coverage. `placeholderKey` is the exact key the placeholder registered (`'office-floor' | 'desk' | 'desk-boss' | 'tasks-board' | 'wastebasket'`).
  - `ROOM_BUILDER = { key: 'office-roombuilder', url: `${ASSET_BASE}/office/Room_Builder_Office_32x32.png` }` (floor may come from the room-builder sheet rather than the object tileset — decide during measurement; if the tileset floor is used instead, drop this and add a floor entry to `OFFICE_REGIONS`).

- [ ] **Step 1: Prepare the slicer tool** — write `/tmp/af-slicer.html` (dev-only, not committed):

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  body{background:#888;margin:0;font-family:monospace}
  canvas{image-rendering:pixelated;display:block}
</style></head><body><div id="out"></div><script>
// Draws a source PNG at 2x with a labeled 16px coordinate grid so you can read the
// (sx,sy,sw,sh) of any object. Change SRC / CELL / SCALE as needed.
const SRC = '/Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/assets/antfarm/modern-office/tileset/Modern_Office_Black_Shadow_32x32.png';
const CELL = 32, SCALE = 2;
const img = new Image();
img.onload = () => {
  const cv = document.createElement('canvas');
  cv.width = img.width*SCALE; cv.height = img.height*SCALE;
  const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img,0,0,img.width*SCALE,img.height*SCALE);
  ctx.strokeStyle='rgba(255,0,0,0.5)'; ctx.fillStyle='#f00'; ctx.font='9px monospace';
  for(let x=0;x<img.width;x+=CELL){ ctx.beginPath();ctx.moveTo(x*SCALE,0);ctx.lineTo(x*SCALE,cv.height);ctx.stroke(); ctx.fillText(String(x), x*SCALE+1, 9); }
  for(let y=0;y<img.height;y+=CELL){ ctx.beginPath();ctx.moveTo(0,y*SCALE);ctx.lineTo(cv.width,y*SCALE);ctx.stroke(); ctx.fillText(String(y), 1, y*SCALE+9); }
  document.getElementById('out').appendChild(cv); document.title='READY';
};
img.onerror=()=>{document.title='ERROR'};
img.src = SRC;
</script></body></html>
```

Start a static server rooted at `/` and open the slicer:
```bash
cd / && python3 -m http.server 8899 --bind 127.0.0.1 >/tmp/af-httpd.log 2>&1 &
```
Navigate a browser (Playwright MCP `browser_navigate` → `http://127.0.0.1:8899/tmp/af-slicer.html`), `browser_take_screenshot` (fullPage, scale device), and `Read` the screenshot. Read off pixel coordinates for: a floor tile, a desk, a large/L-shaped desk (boss desk), the blue chart/whiteboard, and a bin. Cross-check the target look against `modern-office/designs-reference/Office_Design_1.gif` (open it the same way). Record `sx,sy,sw,sh` for each. Repeat with `SRC` pointed at `Room_Builder_Office_32x32.png` if the floor comes from there.

- [ ] **Step 2: Write the manifest with the measured coordinates** — `apps/antfarm/src/game/asset-manifest.ts`. Fill `sx/sy/sw/sh` from Step 1 (example values shown; replace with measured):

```typescript
/** Runtime asset contract for real LimeZu art. All URLs are served by the auth-gated
 *  /api/antfarm/assets route; absent art 404s and the scene keeps its placeholders. */

export const ASSET_BASE = '/api/antfarm/assets/limezu';

/** The Modern Office object tileset — one image; office props are sub-regions of it. */
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

// COORDINATES PINNED BY MEASUREMENT (Task 3 Step 1). Replace with measured values.
export const OFFICE_REGIONS: TileRegion[] = [
  { placeholderKey: 'office-floor', from: ROOM_BUILDER.key, sx: 0, sy: 0, sw: 32, sh: 32 },
  { placeholderKey: 'desk', from: OFFICE_TILESET.key, sx: 0, sy: 0, sw: 64, sh: 32 },
  { placeholderKey: 'desk-boss', from: OFFICE_TILESET.key, sx: 0, sy: 32, sw: 96, sh: 64 },
  { placeholderKey: 'tasks-board', from: OFFICE_TILESET.key, sx: 0, sy: 0, sw: 48, sh: 48 },
  { placeholderKey: 'wastebasket', from: OFFICE_TILESET.key, sx: 0, sy: 0, sw: 16, sh: 32 },
];
```

Note in a comment which props were deliberately left procedural (no pack coverage): `claw`, `tube`, `scheduler` (unless a wall clock was found in Step 1, in which case add it).

- [ ] **Step 3: Typecheck + commit** (no unit test — this is measured data consumed by Task 4/5)

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art --filter @curia/antfarm run typecheck`
Expected: no errors.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art add apps/antfarm/src/game/asset-manifest.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art commit -m "feat(antfarm): asset manifest + measured office tileset regions"
```

---

## Task 4: Load + swap office textures (with clean fallback)

Adds `preload()` and an office texture-key swap to `OfficeScene`. Because office props are swapped by **overwriting the placeholder texture key** with a cropped canvas, no office call-sites change. Verified in the browser (Phaser needs a real canvas/WebGL context, so this is manual-verify, not unit-tested).

**Files:**
- Modify: `apps/antfarm/src/game/OfficeScene.ts`

**Interfaces:**
- Consumes: `OFFICE_TILESET`, `ROOM_BUILDER`, `OFFICE_REGIONS` from `asset-manifest.js`; `registerPlaceholderTextures` (existing).
- Produces: private methods `preload()`, `private swapOfficeTextures(): void`, `private cropToTexture(srcKey, newKey, sx, sy, sw, sh): void`, and a `private failedLoads = new Set<string>()`.

- [ ] **Step 1: Add imports** at the top of `OfficeScene.ts` (after the existing placeholder import block):

```typescript
import { OFFICE_TILESET, ROOM_BUILDER, OFFICE_REGIONS } from './asset-manifest.js';
```

- [ ] **Step 2: Add `preload()` and the failed-load tracker.** Add the field near the other private fields (after line 41) and the method just before `create()` (before line 51):

```typescript
  // Keys of asset loads that errored (e.g. open-core build with no licensed art).
  // Anything in here keeps its procedural placeholder — never a hard failure.
  private failedLoads = new Set<string>();

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
    // Character sheets are loaded here too (added in Task 5).
  }
```

- [ ] **Step 3: Call the office swap from `create()`.** Insert `this.swapOfficeTextures();` immediately after `registerPlaceholderTextures(this);` (line 52) and before `this.drawRoom();`:

```typescript
  create(): void {
    registerPlaceholderTextures(this);
    this.swapOfficeTextures(); // overwrite office placeholder keys with real art when present

    const desks = this.registry.get('desks') as DeskSlot[] ?? [];
    // …unchanged…
```

- [ ] **Step 4: Implement the swap helpers.** Add these private methods (e.g. after `drawRoom`):

```typescript
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
```

- [ ] **Step 5: Manual verify — placeholders path (art ABSENT).** With no `assets-licensed/` dir:

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art --filter @curia/antfarm run dev
```
Open the printed dev URL. Expected: office renders exactly as before (procedural floor/desks/board/bin), and the browser console shows `[antfarm] licensed asset not loaded …` **info** lines — **no red errors**, no missing-texture gaps. (In pure `vite dev` the `/api/...` URLs 404, which is the same signal as open-core; that's the intended fallback.)

- [ ] **Step 6: Manual verify — real path (art PRESENT).** Stage a couple of real PNGs locally to exercise the loaded branch:

```bash
mkdir -p /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art/apps/antfarm/assets-licensed/limezu/office
cp /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/assets/antfarm/modern-office/tileset/Modern_Office_Black_Shadow_32x32.png /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art/apps/antfarm/assets-licensed/limezu/office/
cp /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/assets/antfarm/modern-office/room-builder/Room_Builder_Office_32x32.png /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art/apps/antfarm/assets-licensed/limezu/office/
```
The Vite dev server does not serve `/api/...`; verify this branch against the running Curia server instead (Task 8 area) OR temporarily point the manifest URLs at a `python3 -m http.server`-served copy. Expected: floor/desk/boss-desk/board/bin render as real LimeZu art; positions look sane (tune `setScale` at call-sites in `OfficeScene` only if the real art is visibly the wrong size). Remove the local `assets-licensed/` copy afterward (it's gitignored, but keep the tree clean).

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art --filter @curia/antfarm run typecheck`
Expected: no errors.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art add apps/antfarm/src/game/OfficeScene.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art commit -m "feat(antfarm): load + swap real office textures with placeholder fallback"
```

---

## Task 5: Animated character sprites from premade sheets

Loads each in-use premade sheet as a spritesheet, registers idle + 4-direction walk animations, and renders agents as animated `Sprite`s when the sheet loaded — falling back to the tinted placeholder image otherwise. Frame indices are **pinned via the slicer** (procedure below). Manual-verify (Phaser runtime).

**Files:**
- Modify: `apps/antfarm/src/game/OfficeScene.ts`
- Modify: `apps/antfarm/src/game/asset-manifest.ts` (add character frame constants)

**Interfaces:**
- Consumes: `characterSheetIndexForAgent`, `characterSheetKey`, `characterSheetFile` (Task 2); `ASSET_BASE`, and new `CHARACTER_FRAME` + `CHARACTER_ANIM` from `asset-manifest.js`.
- Changes `AgentSprite.body` from `Phaser.GameObjects.Image` to `Phaser.GameObjects.Image | Phaser.GameObjects.Sprite` (Sprite is a subclass of Image, so `.setTint/.setScale/.setInteractive/.setTexture` all still typecheck).
- Produces: `private ensureCharacterAnims(sheetKey: string): void`, `private facing(dx: number, dy: number): 'down'|'up'|'left'|'right'`.

- [x] **Step 1: Pin character frame layout (DONE — measured by the controller).** The frame layout was measured against `Premade_Character_32x32_10.png` with a browser canvas slicer: frames are **32w × 64h**; walk is 6 frames/direction on 64px-row 1 (up 56–61, left 62–67, right 68–73, down 74–79); idle reuses each direction's walk-start frame. These values are baked into Step 2 below — the implementer uses them verbatim and does NOT need to re-measure. (Left/right assignment is verified in the browser in Task 8.)

- [ ] **Step 2: Add character constants to `asset-manifest.ts`** using the pinned values (example shape; replace indices with measured):

```typescript
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
```

Note: a single-frame idle animation is valid in Phaser (`generateFrameNumbers` with `start === end`); `repeat: -1` on a 1-frame anim just holds the frame.

- [ ] **Step 3: Load in-use sheets in `preload()`.** In `OfficeScene.preload()`, after the office loads, add the character-sheet loads. Compute the distinct sheets the current desks need:

```typescript
    const desks = this.registry.get('desks') as DeskSlot[] ?? [];
    const sheetIndices = new Set(desks.map((d) => characterSheetIndexForAgent(d.agentId)));
    for (const idx of sheetIndices) {
      this.load.spritesheet(characterSheetKey(idx), characterSheetUrl(characterSheetFile(idx)), {
        frameWidth: CHARACTER_FRAME.width,
        frameHeight: CHARACTER_FRAME.height,
      });
    }
```
Add the imports:
```typescript
import { characterSheetIndexForAgent, characterSheetKey, characterSheetFile } from './character-sheets.js';
import { CHARACTER_FRAME, CHARACTER_ANIM, characterSheetUrl, type Direction } from './asset-manifest.js';
```

- [ ] **Step 4: Register per-sheet animations.** Add:

```typescript
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
```

- [ ] **Step 5: Use the real sprite in `ensureAgent`.** Replace the body-creation block (lines 170–180) with a branch: real Sprite when the sheet loaded, else the existing tinted placeholder image. Store the sheet key on the sprite for later animation.

```typescript
    const pos = deskPositionForAgent(this.layout, agentId);
    const sheetIdx = characterSheetIndexForAgent(agentId);
    const sheetKey = characterSheetKey(sheetIdx);
    const hasReal = this.textures.exists(sheetKey) && !this.failedLoads.has(sheetKey);

    const container = this.add.container(pos.x, pos.y - 10);
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
```

Add `sheetKey: string | null` and `hasReal: boolean` to the `AgentSprite` interface and set them in the returned object; change `body`'s type in the interface to `Phaser.GameObjects.Image | Phaser.GameObjects.Sprite`.

- [ ] **Step 6: Drive walk animation + facing in `animateWalk`.** Replace `animateWalk` body so real sprites play the directional walk during the tween and return to idle on completion:

```typescript
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
```

- [ ] **Step 7: Guard the placeholder-only tint reset in `setAgentState`.** The `else` branch (lines 241–244) calls `ensureTintedTexture` + `setTexture`, which only makes sense for placeholder images. Guard it so real sprites just clear the tint:

```typescript
    if (state === 'error') {
      agent.body.setTint(0xff6666);
    } else {
      agent.body.clearTint();
      if (!agent.hasReal) {
        const appearance = appearanceForAgent(agentId);
        agent.body.setTexture(ensureTintedTexture(this, 'character', appearance.outfitColor));
      }
    }
```

- [ ] **Step 8: Manual verify.** Repeat Task 4 Step 5 (absent → placeholders, no console errors) and Step 6 (present → real sprites). With real character sheets present: each agent shows a distinct real character; on `agent.walk` the agent plays a walk cycle facing the correct direction and settles into idle. If a direction faces the wrong way, correct the `CHARACTER_ANIM` indices (the only thing that can be wrong is the Step-1 measurement).

- [ ] **Step 9: Typecheck + full antfarm test + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art --filter @curia/antfarm run typecheck`
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art --filter @curia/antfarm exec vitest run`
Expected: no type errors; existing antfarm unit tests (appearance, world-layout, character-sheets) pass.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art add apps/antfarm/src/game/OfficeScene.ts apps/antfarm/src/game/asset-manifest.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art commit -m "feat(antfarm): animated premade character sprites with placeholder fallback"
```

---

## Task 6: Docs, changelog, attribution confirm (curia repo)

**Files:**
- Modify: `apps/antfarm/public/assets/README.md`
- Modify: `CHANGELOG.md`
- Verify: `apps/antfarm/src/components/CreditsFooter.tsx` renders (mounted in `App.tsx:274`).

- [ ] **Step 1: Update the assets README** — replace the "Production builds copy assets … into `public/assets/limezu/`" paragraph with the real mechanism:

```markdown
Licensed LimeZu art (`Modern Office`, `Modern Interiors`) is **not** committed here and is
**never** placed in `public/` (that path is world-downloadable). The hosted build layers
licensed runtime PNGs into `apps/antfarm/assets-licensed/` (gitignored), which is served
only behind session auth via `GET /api/antfarm/assets/*`. The open-core image ships no
licensed art, so those requests 404 and the scene renders procedural placeholders.
```

- [ ] **Step 2: Confirm attribution renders.** Run the antfarm dev server, load the app, and confirm the LimeZu credit footer (`CreditsFooter`) is visible. No code change expected. If it is not mounted, add `<CreditsFooter />` to the app shell — but `App.tsx:274` already renders it, so this should be a visual confirmation only.

- [ ] **Step 3: Add CHANGELOG entry** under `## [Unreleased]` → **Added**:

```markdown
- **Ant Farm real art** — the office renders licensed LimeZu tiles/furniture and animated premade character sprites when present, served only behind session auth (`/api/antfarm/assets/*`); falls back to procedural placeholders when absent. (#1335)
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art add apps/antfarm/public/assets/README.md CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art commit -m "docs(antfarm): document auth-gated asset serving + changelog"
```

---

## Task 7: Curated asset subtree + deploy COPY + runbook (curia-deploy)

Stage runtime PNGs only, layer them into the image at build, and update the runbook. This lands in the **curia-deploy** repo on its own branch.

**Files (curia-deploy):**
- Add: `custom/assets/antfarm/limezu/office/*.png`, `custom/assets/antfarm/limezu/characters/*.png`
- Modify: `deploy/compose/Dockerfile.curia`
- Modify: `runbooks/antfarm-deploy.md`

- [ ] **Step 1: Create the curia-deploy worktree**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy pull --ff-only origin main
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy worktree add /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-antfarm-art -b feat/antfarm-real-art-1335
```

- [ ] **Step 2: Stage the curated runtime PNGs (only the files the loader names).** Copy the exact sheets referenced by the manifest — the ≤20 premade character sheets at the 32x32 size, the Modern Office tileset (32x32), and the room-builder floor (32x32). Exclude `.ase`/`.gif`/`.txt`/16px/48px masters.

```bash
WT=/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-antfarm-art
SRC=/Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/assets/antfarm
mkdir -p "$WT/custom/assets/antfarm/limezu/office" "$WT/custom/assets/antfarm/limezu/characters"
cp "$SRC/modern-office/tileset/Modern_Office_Black_Shadow_32x32.png" "$WT/custom/assets/antfarm/limezu/office/"
cp "$SRC/modern-office/room-builder/Room_Builder_Office_32x32.png" "$WT/custom/assets/antfarm/limezu/office/"
cp "$SRC"/modern-interiors/premade-characters/32x32/Premade_Character_32x32_*.png "$WT/custom/assets/antfarm/limezu/characters/"
```
Verify the tree contains only `.png` (no `.ase`/`.gif`/`.txt`):
```bash
find /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-antfarm-art/custom/assets/antfarm/limezu -type f -not -name '*.png'
```
Expected: no output.

- [ ] **Step 3: Add the build-stage COPY to `deploy/compose/Dockerfile.curia`.** Replace the deferred-asset comment block (the lines explaining why art is NOT layered, above `COPY curia/apps/antfarm/ ./apps/antfarm/`) with a COPY that layers the curated subtree into the **auth-served** dir, and keep it before the antfarm build:

```dockerfile
# Layer licensed LimeZu art into the AUTH-GATED dir (served by /api/antfarm/assets/*),
# NOT public/ — so the sheets are never world-downloadable (LimeZu forbids redistribution).
# Runtime PNGs only (curated in custom/assets/antfarm/limezu/). Absent in the open-core
# image → the app 404s these requests and renders procedural placeholders.
COPY curia/apps/antfarm/ ./apps/antfarm/
COPY custom/assets/antfarm/limezu/ ./apps/antfarm/assets-licensed/limezu/
RUN pnpm --filter @curia/antfarm run build
RUN test -f apps/antfarm/dist/index.html
```

Then ensure the runtime stage carries the licensed dir into the final image (near the existing `COPY --from=build /app/apps/antfarm/dist …` at ~line 208):

```dockerfile
# Copy Ant Farm static bundle — served by Fastify under /antfarm/ (antfarm-static route)
COPY --from=build /app/apps/antfarm/dist ./apps/antfarm/dist
# Copy licensed art — served ONLY behind auth by /api/antfarm/assets/* (never under /antfarm/).
COPY --from=build /app/apps/antfarm/assets-licensed ./apps/antfarm/assets-licensed
```

- [ ] **Step 4: Update `runbooks/antfarm-deploy.md`.** Replace the "Later: layering in licensed LimeZu art" / deferred section with the implemented mechanism: art is layered into `apps/antfarm/assets-licensed/limezu/` at build and served only via the auth-gated `/api/antfarm/assets/*` route; the open-core image ships no art and falls back to placeholders; the curated subtree is runtime PNGs only.

- [ ] **Step 5: Verify the image build.** From the curia-deploy worktree, confirm the Dockerfile builds from a checkout that has the antfarm app (the build context includes both `curia/` and `custom/`):

```bash
docker build -f /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-antfarm-art/deploy/compose/Dockerfile.curia -t curia-antfarm-art-test /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-antfarm-art 2>&1 | tail -30
```
Expected: build succeeds; `apps/antfarm/dist/index.html` assertion passes. (If the build context differs in this repo's CI, match the existing `docker build`/compose invocation in the runbook.)

- [ ] **Step 6: Commit (curia-deploy)**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-antfarm-art add custom/assets/antfarm/limezu deploy/compose/Dockerfile.curia runbooks/antfarm-deploy.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-antfarm-art commit -m "feat(antfarm): layer curated LimeZu art into auth-served dir + runbook"
```

---

## Task 8: End-to-end verification (real server, auth boundary)

Proves the two hardest acceptance criteria against a running server: (a) unauthenticated `curl` cannot download a licensed sheet, (b) the real art renders when authenticated.

- [ ] **Step 1: Run the full Curia server with art staged.** Build the antfarm dist and stage the licensed dir where the server reads it (repo root during dev):

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art --filter @curia/antfarm run build
mkdir -p /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art/apps/antfarm/assets-licensed/limezu/office
cp /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy/custom/assets/antfarm/limezu/office/*.png /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art/apps/antfarm/assets-licensed/limezu/office/ 2>/dev/null || true
```
Start the server per the project's usual dev command (the `/run` skill or the documented `pnpm dev`), ensuring `WEB_APP_BOOTSTRAP_SECRET` is set (it is, via the symlinked `.env`).

- [ ] **Step 2: Confirm the auth boundary (acceptance criterion).**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:<port>/api/antfarm/assets/limezu/office/Modern_Office_Black_Shadow_32x32.png
```
Expected: `401` (no session/secret) — **not** the PNG. Then with the secret header:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "x-web-bootstrap-secret: <secret>" http://localhost:<port>/api/antfarm/assets/limezu/office/Modern_Office_Black_Shadow_32x32.png
```
Expected: `200`, `content-type: image/png`. Also confirm the sheet is NOT reachable on the unauthenticated static surface:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:<port>/antfarm/assets/limezu/office/Modern_Office_Black_Shadow_32x32.png
```
Expected: not `200` (the licensed dir is outside `public/`, so `/antfarm/*` never serves it).

- [ ] **Step 3: Visual confirm in the browser.** Authenticate to the console, open `/antfarm/`, and confirm real tiles/furniture + real animated characters render, agents walk with correct-facing animations, and the LimeZu credit footer is visible. Remove the local `assets-licensed/` copy when done.

- [ ] **Step 4: Full repo test + typecheck gate.**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art run typecheck`
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-antfarm-real-art exec vitest run tests/integration/antfarm-assets.test.ts tests/integration/antfarm-static.test.ts tests/integration/antfarm-routes.test.ts`
Expected: all green.

---

## Task 9: PR review + open PRs

- [ ] **Step 1: Auto-review (parallel).** Run `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter` on the branch diff; since this touches an auth boundary (asset serving), also run a security review. Address high-priority findings.
- [ ] **Step 2: Open the curia PR** from `feat/antfarm-real-art-1335` with `Closes #1335`, summarizing the loader, auth-gated serving, character/office coverage, and the deferred items (claw/tubes/scheduler procedural; generator-part compositing post-v1). Confirm CI starts.
- [ ] **Step 3: Open the curia-deploy PR** from its `feat/antfarm-real-art-1335` branch, referencing curia#1335 and the staged-master issue. Note that it must merge together with (or after) the curia PR since the Dockerfile now expects the app's `/api/antfarm/assets/*` route.
- [ ] **Step 4: Report both PR URLs + CI status.**

---

## Self-Review (spec coverage)

- **Blocker 1 (loader):** Tasks 4–5 (preload + office swap + character sprites). ✓
- **Blocker 2 (safe serving):** Task 1 (auth-gated route, dir outside `public/`). ✓
- **Design decision (option 1):** Task 1 implements the authenticated asset endpoint. ✓
- **Scope 1 (loader + fallback):** Tasks 4–5, `loaderror`/texture-existence guards, manual absent/present verification. ✓
- **Scope 2 (character variants):** Task 2 (deterministic 1-of-20) + Task 5 (animated sprites). ✓
- **Scope 3 (safe serving):** Task 1. ✓
- **Scope 4 (curated subtree + Dockerfile COPY):** Task 7 (PNG-only staging, build-stage COPY into `assets-licensed/`, runtime carry-over, runbook). ✓
- **Scope 5 (attribution):** Task 6 Step 2. ✓
- **Acceptance — present renders real art:** Tasks 4/5/8. ✓
- **Acceptance — absent → full procedural, no errors:** Task 4 Step 5, Task 5 Step 8. ✓
- **Acceptance — stable distinct per agent:** Task 2 tests. ✓
- **Acceptance — not downloadable unauth:** Task 1 tests + Task 8 Step 2 curl. ✓
- **Acceptance — Dockerfile PNG-only, build succeeds:** Task 7 Steps 2/5. ✓
- **Acceptance — attribution visible:** Task 6 Step 2. ✓
- **Acceptance — runbook updated:** Task 7 Step 4. ✓
- **Office coverage (Joseph's ask — maximize real furniture):** Task 3 (floor/desk/boss-desk/board/bin); claw/tubes/scheduler documented procedural. ✓

**Measurement steps (Task 3 Step 1, Task 5 Step 1)** are concrete tooled procedures with a defined output and behavioral acceptance check — not placeholders. All example coordinate/frame values are explicitly marked "replace with measured".
