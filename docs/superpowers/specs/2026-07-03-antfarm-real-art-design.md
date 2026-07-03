# Ant Farm AF-7 — Load real LimeZu art + serve licensed sheets safely

**Issue:** curia#1335 · **Epic:** #1313 · **Follows:** AF-5 #1318, AF-6 #1319
**Deploy plumbing:** curia-deploy#156 · **Staged master:** curia-deploy#155

## Problem

The Ant Farm Phaser office (`apps/antfarm`) renders everything from procedural CC0
placeholder textures. Two things block rendering the real licensed LimeZu art, and
both must be solved together:

1. **No loader.** `OfficeScene` has no `this.load.*` calls — it only registers
   procedural textures. Staging the licensed sheets has zero visual effect until a
   loader consumes them.
2. **Unauthenticated static surface.** `/antfarm/*` is a bare `@fastify/static`
   mount. Anything under the Vite `public/` root is world-downloadable at
   `/antfarm/assets/...`. Dumping raw LimeZu sheets there would **publish** them — a
   redistribution hazard under the LimeZu license (which forbids resale/redistribution).

## Licensing posture (why hosted-build-only, behind auth)

Per `curia-deploy/custom/assets/antfarm/SOURCE.md`: embedding LimeZu art in a
publicly-pullable open-core image is **pending creator confirmation** (LimeZu emailed
2026-07-02; unconfirmed as of 2026-07-03). Until confirmed, the **public open-core
image ships placeholders only**; licensed art is a **hosted-build / operator-supplied
(BYO-license) layer**, and must not be freely downloadable even in the hosted build.
This design honors that: licensed bytes never touch the unauthenticated static mount.

## Character source decision (diverges from issue text)

The issue says to composite agents from Modern Interiors **generator parts**
(skin/hair/outfit/accessory). Those layer PNGs are **deliberately not staged**
(~80M library, deferred post-v1 per `SOURCE.md`). What *is* staged: **20 premade
character spritesheets** (`modern-interiors/premade-characters/{16x16,32x32,48x48}/`,
standard Modern Interiors layout, idle + 4-direction walk animations).

**Decision (confirmed with Joseph):** v1 deterministically maps each agent id to one
of the 20 premade sheets (hash → `1 of 20`), matching the `SOURCE.md` v1 plan.
Generator-parts compositing stays deferred post-v1. The existing
`agent-appearance.ts` map is retained **only** as the procedural-placeholder
appearance driver (unchanged, still tested).

## Design

### Component 1 — Authenticated asset endpoint (safe serving)

New Fastify plugin `src/channels/http/routes/antfarm-assets.ts`, registered in
`http-adapter.ts` alongside `antfarmStaticRoutes`:

- Route: `GET /api/antfarm/assets/*`
- **Auth:** `assertSecret(request, reply, webAppBootstrapSecret, sessions)` — the
  identical session-cookie / `x-web-bootstrap-secret` check already guarding
  `/api/antfarm/timeline`. The global `onRequest` hook already exempts `/api/antfarm/*`
  from bearer auth, so no hook change is needed.
- **Source dir:** licensed art lives **outside** the Vite `public/` root, at
  `apps/antfarm/assets-licensed/` (gitignored). This dir is absent in the open-core
  image and in clean dev checkouts.
- **Behavior:** path-traversal guard via `resolve` + `relative(dir, abs).startsWith('..')`
  (mirrors `antfarm-static.ts`). File present → stream it with a correct content-type
  and long-lived cache header. File or dir missing → **404** (no SPA fallback).
- **Result:** unauthenticated request → 401; authenticated request for a missing
  asset (open-core) → 404. Either way the loader falls back to placeholders.

Content-type: derive from extension (PNG is the only type v1 serves). Use
`@fastify/static`'s `reply.sendFile` rooted at `assets-licensed/` **after** the auth
check and traversal guard, OR a manual `createReadStream` + `reply.type()`; the
`sendFile`-after-guard approach matches the existing static route and is preferred.

### Component 2 — Asset manifest + loader

New `apps/antfarm/src/game/asset-manifest.ts`:

- Declares the runtime asset contract: for each real texture, the request URL
  (under the `/antfarm/` base → `/api/antfarm/assets/limezu/...`), the load kind
  (`image` | `spritesheet` with `frameWidth/frameHeight`), and the placeholder key it
  replaces.
- Two groups: `office` (single Modern Office tileset image, sub-regions carved into
  named frames) and `characters` (the ≤20 premade spritesheets actually referenced).

`OfficeScene` changes:

- Add `preload()`: iterate the manifest, issue `this.load.image` / `this.load.spritesheet`
  against the asset URLs. Register a `this.load.on('loaderror', file => failed.add(file.key))`
  handler. Loads that 404 (open-core) or fail land in `failed`; the loader **never
  throws**.
- `create()`: call `registerPlaceholderTextures(this)` first (unconditional baseline),
  then for each manifest entry whose key loaded successfully (`this.textures.exists`
  and not in `failed`), carve office sub-frames / register character animations and
  swap the real texture in. Missing entries stay procedural.

Because Phaser gates `preload → create` on load completion, the swap logic in
`create()` sees a settled load state. Worst case = the current full procedural
experience (the acceptance-criteria fallback).

### Component 3 — Characters (premade sheets + 4-dir animation)

New `apps/antfarm/src/game/character-sheets.ts`:

- `characterSheetForAgent(agentId): number` → reuse `hashAgentId` (exported from
  `agent-appearance.ts` or duplicated as a tiny stable hash) → `h % PREMADE_COUNT`
  (20). Deterministic, stable per id, visually distinct up to 20 agents (collisions
  past 20 are acceptable for v1, no worse than the current palette collisions).
- Manifest references only the sheets actually selected by live agents (lazy is
  possible, but v1 may simply stage/reference all 20 — ~small once curated to one
  size). **Use the 32×32 sheets** for crispness at the app's scale; frame size and
  the idle/walk frame indices are **pinned during implementation** by slicing a sheet
  and viewing frames against `Spritesheet_animations_GUIDE.png` (idle = row 1,
  walk = row 2 in the guide; 4 directions per animation).
- `OfficeScene.ensureAgent`: when the real sheet loaded, create a `Phaser.Sprite`
  (not a static image) using the agent's sheet, play the idle animation; drive the
  walk animation + facing direction from `animateWalk`. When absent, keep the current
  tinted-placeholder image path unchanged.
- `setAgentState('error')`: keep the red tint on the sprite; on recovery clear tint
  and resume idle (no `ensureTintedTexture` needed for real sprites).

### Component 4 — Office art (maximal real coverage)

Source: the **Modern Office "Black Shadow" tileset** (single sheet) + room-builder
floor/walls. Load the tileset once as an image; the manifest defines named
sub-regions via `scene.textures.get(key).add(frameName, 0, x, y, w, h)`.

Target real-art coverage (exact tileset pixel regions pinned during implementation by
visual inspection of the tileset + `designs-reference` gifs):

| Placeholder key | Real source | Notes |
|---|---|---|
| `office-floor` | room-builder floor tile | tiled |
| `desk` | Modern Office desk | floor-row desks |
| `desk-boss` | Modern Office large / L-desk | boss desk (pack has large desks) |
| `tasks-board` | Modern Office chart/whiteboard | the blue graph board |
| `wastebasket` | Modern Office bin | colored office bins exist |

Stays **procedural** (no pack coverage — confirmed against `SOURCE.md` "no pack covers
these" + tileset inspection):

- `claw` (overhead claw — custom)
- `tube` (vacuum tubes — custom)
- `scheduler` (clock-machine — custom; keep procedural unless a suitable wall-clock
  single is found during implementation, in which case swap it in too)

The manifest is generic, so any prop that turns out to have a good pack match gets
added as a manifest row without code changes.

### Component 5 — Curated subtree, deploy COPY, attribution

- Stage `curia-deploy/custom/assets/antfarm/limezu/{characters,office}/` — **runtime
  PNGs only**: the premade character sheet(s) at one chosen size + the Modern Office
  tileset + room-builder floor. **Exclude** `.ase`/`.aseprite`, `.gif` reference,
  `CHARACTER_GENERATOR.txt`/guides, and the duplicate 16/48px masters we don't ship.
- `Dockerfile.curia` (curia-deploy): add a build-stage `COPY` layering the curated
  subtree into `apps/antfarm/assets-licensed/` (the auth-served dir — **not**
  `public/`), superseding the deferred-asset note. Guarded so a checkout without the
  subtree still builds (open-core).
- Update `curia-deploy/runbooks/antfarm-deploy.md` to document the implemented
  `/api/antfarm/assets/*` serving mechanism (supersedes "deferred").
- Confirm `CreditsFooter` (LimeZu attribution) renders in the built app — expected
  no change; verify only.

## Testing

- **Unit** (`character-sheets.test.ts`): `characterSheetForAgent` is stable per id,
  distributes across the 20 sheets, always in range — mirrors the existing
  `agent-appearance.test.ts`.
- **Route test** (`antfarm-assets` integration): unauthenticated
  `GET /api/antfarm/assets/limezu/...` → 401; authenticated request for a missing file
  → 404; path traversal (`../`) → 404/blocked. Covers the curl acceptance criterion.
- **Manual/verify:** with `assets-licensed/` present → real tiles/furniture + real
  character sprites, 4-direction walk/idle; with the dir absent → full procedural
  experience, no console errors, no missing-texture gaps.

## Acceptance criteria (from issue)

- [ ] Present → real LimeZu tiles/furniture + real character sprites; agents walk/idle
      with 4-direction animations.
- [ ] Absent (open-core / clean dev) → full procedural experience, no console errors,
      no hard failure.
- [ ] Each agent id → stable, visually distinct character.
- [ ] Raw licensed sheets **not** downloadable unauthenticated (401/404, not the PNG).
- [ ] `Dockerfile.curia` layers only curated runtime PNGs; build succeeds from a
      checkout containing the Ant Farm app.
- [ ] LimeZu attribution visible in the running app.
- [ ] `runbooks/antfarm-deploy.md` updated to the implemented mechanism.

## Out of scope

- Generator-parts compositing (deferred post-v1; layer library not staged).
- Custom top-down robot sprites (deferred post-v1; no turnkey pack).
- Real art for claw / vacuum tubes / scheduler-machine (no pack coverage).

## Touch points

- **curia repo:** `apps/antfarm/src/game/OfficeScene.ts` (preload + swap logic),
  new `asset-manifest.ts`, `character-sheets.ts` (+ test); new
  `src/channels/http/routes/antfarm-assets.ts`; `http-adapter.ts` (registration);
  `.gitignore` (`apps/antfarm/assets-licensed/`).
- **curia-deploy repo:** `deploy/compose/Dockerfile.curia`, `runbooks/antfarm-deploy.md`,
  curated `custom/assets/antfarm/limezu/` subtree.
