# 21 — Ant Farm Office Visualization

## Goal

Replay Curia's `audit_log` as an animated pixel-art office so an observer can *watch* the system work — agents at desks, a scheduler claw dropping jobs, delegation walks, speech and thought bubbles, tasks appearing and being trashed — without reading raw event rows. Ant Farm is a read-only lens over data that already exists; it adds no new storage and takes no action on the system it depicts.

## Design principles

- **Demonstration-first.** Ant Farm exists to make the platform legible to a human. It is an observability surface, not a control surface: there is no way to command an agent or mutate state from it.
- **Real-data-only.** Every animation is derived from a real `audit_log` row (replay) or a real live bus event (stream). There is no synthetic or demo mode — an empty office means the audit log is empty for the selected window.
- **"DVR" replay + live.** A single Conductor drives playback: scrub to any point in a historical window, adjust velocity, pause, or snap to the live edge where newly-arriving events fire as they happen. Replay and live are the same timeline, merged at a boundary rather than two separate views.
- **Clean degradation.** Licensed art is optional. When it is absent (e.g. a source checkout that omits it), the office renders entirely from procedural CC0 placeholder textures — no hard failure, no missing-texture gaps.

---

## Architecture

Ant Farm is a **separate single-page app** (`apps/antfarm/`, the `@curia/antfarm` workspace package) that coexists with the React console. The console is served at `/`; Ant Farm mounts under `/antfarm/`. Both are built into the same Docker image and served by the same Fastify HTTP channel.

The app is a **Phaser scene wrapped in React**:

- **`OfficeScene` (Phaser 3.90)** — the WebGL canvas. It draws the room, desks, stations, claw track, and vacuum tubes, spawns one character per agent, and applies scene directives as animations (`animateClawDeliver`, `animateWalk`, `showSpeech`, `showBadge`, `showTaskCard`, …). All visual state lives here.
- **React-DOM overlays** — the transport bar (`TransportBar`), detail overlays (`DetailOverlay`), and the licensing credits footer (`CreditsFooter`) are plain React components layered over the canvas. Clicking an agent or a directive opens an overlay and pauses playback; closing it restores the prior mode.

The producer and consumer are decoupled by a **shared contract package, `@curia/shared-types`** (dependency-free). It defines the `SceneDirective` discriminated union — the only vocabulary the visualization understands — plus the `ActivityScript` (an ordered list of directives) and the minimal `AuditEventRow` shape the interpreter consumes. The server produces directives; the SPA renders them; neither imports the other's internals.

### Event → directive interpretation

The server-side **interpreter** (`src/antfarm/interpreter.ts`) is the heart of the contract. `interpretEvent(row)` maps a single `audit_log` row to **zero, one, or two** scene directives; unmapped event types return `null`. The mapping is deliberately small and metaphor-driven:

| Audit event | Directive(s) | Office metaphor |
|---|---|---|
| `schedule.fired` | `claw.deliver` | overhead claw drops a job onto an agent's desk |
| `agent.task` | `agent.state` (`active`) | agent lights up / starts working |
| `tool.invoke` (`delegate`) | `agent.walk` + `agent.speak` | agent walks to the delegate's desk and speaks the task |
| `tool.invoke` (other) | `agent.think` (`start`) | thought bubble appears (skill running) |
| `tool.result` | `agent.think` (`stop`) | thought bubble clears |
| `agent.discuss` | `agent.speak` | speech bubble (Bullpen conversation) |
| `inbound.message` | `tube.in` | message arrives through a vacuum tube |
| `outbound.message` / `outbound.delivered` | `tube.out` | message leaves through a vacuum tube |
| `task.created` | `task.appear` | a task card appears |
| `task.completed` | `task.trash` | the task card is thrown in the wastebasket |
| `agent.error` | `agent.state` (`error`) | agent tints red |
| `human.decision` | `badge` (`human.decision`) | a decision badge pops |
| `autonomy.*_blocked` | `badge` (`autonomy.blocked`) | an autonomy-blocked badge pops |

`buildScript(rows)` flattens a page of rows into an ordered `ActivityScript`. The interpreter never imports backend types — it operates on the `AuditEventRow` shape from `@curia/shared-types`, so the exact same code path serves both historical replay (over `AuditLogRepo`) and live events (over the bus, via `busEventToAuditRow`).

### The Conductor (playback engine)

The client-side **Conductor** (`apps/antfarm/src/conductor/`) owns the DVR model. It holds the loaded directives, an **animation schedule** (each directive assigned an `animationStartMs`, with a minimum inter-beat gap so bursts don't collapse into one frame), and a playhead:

- **Modes** — `paused`, `playing`, `live`. `tick(nowMs)` advances the playhead by elapsed wall-time × velocity while `playing`; in `live` it pins the playhead to the schedule's end so appended directives fire immediately.
- **Velocity** — clamped to `[0.25, 8]×`.
- **Scrub** — `scrubToAnimationMs` / `scrubToLogicalTs` move the playhead anywhere in the window and re-sync which beats have "fired".
- **Replay ↔ live merge** — `mergeReplayAndLive(replay, liveBuffer, streamOpenTs)` splices a historical window to the live buffer at the moment the stream opened: replay rows strictly before `streamOpenTs` are kept, live rows at-or-after are appended, and overlapping audit-row ids are deduped (`dedupeById`). `appendDirectives` then incrementally folds in each new live beat without rebuilding the whole schedule.

`getSnapshot()` returns **stable array references** for `directives`/`schedule` (they change only on load/append/merge, never on `tick`), so React memos and the Phaser scene do not churn every animation frame — this is the fix for the early playback-flicker bug where the scene restarted each frame.

---

## Data & API

Three HTTP routes serve Ant Farm, all under the `/api/antfarm/*` (data) and `/antfarm/*` (static) prefixes.

### `GET /api/antfarm/timeline` — paginated replay

Reads a historical window from the audit log and returns an `ActivityScript`. Backed by `AuditLogRepo.findTimeline` (and, for type-filtered variants, `findByEventTypes`), which return a **keyset-paginated `TimelinePage`**:

- **Query params:** `from`, `to`, `conversationId`, `taskId`, `limit` (default 500, max 2000), `after` (an opaque `{ timestamp, id }` cursor).
- **Ordering & keyset:** rows are ordered `timestamp ASC, id ASC`; the cursor advances with a strict `(timestamp, id) > ($ts, $id)` comparison (parameterized SQL — no interpolation). The repo fetches `limit + 1` rows to compute `hasMore` without a second count query, and sets `nextCursor` to the last returned row when there is more.
- **Response:** the built `ActivityScript` plus `hasMore` and `nextCursor`, so the client can page forward through a large window.

On arrival the SPA preloads the **last-24h window** so the office lands ready to play. Invalid `from`/`to`/`after` values return `400`.

### `GET /api/antfarm/stream` — live SSE fan-out

A Server-Sent-Events endpoint that pushes interpreted directives as bus events happen. The HTTP route hijacks the reply, writes the SSE headers (`text/event-stream`, `no-cache`, `X-Accel-Buffering: no`), emits a `:connected` preamble, and registers the connection with the `EventRouter`. A 30-second `:ping` heartbeat keeps the connection alive; client disconnect tears down the heartbeat and deregisters.

The `EventRouter` maintains a **separate `antfarmClients` set** — entirely distinct from the message-response SSE clients, so there is no cross-talk. It subscribes to the Ant Farm event types at the `system` layer; each matching bus event is run through `busEventToAuditRow` → `interpretEvent`, and the resulting directive(s) are fanned out to every live client in the envelope `{"type":"directive","directive":{…}}` (written as `data: …\n\n`). Fan-out is **backpressure-aware**: a client whose pending-write buffer exceeds the cap is dropped, and per-client delivery is rate-limited to protect a slow consumer from an event burst.

### `GET /api/antfarm/assets/*` — auth-gated licensed art

Streams licensed art (the LimeZu sheets) from `apps/antfarm/assets-licensed/` — a directory **outside** the Vite `public/` web root, so the bytes never appear on the unauthenticated static surface. See **Security** and **Assets & Licensing** below.

---

## Security model

Ant Farm surfaces raw audit activity, so every data route is **fail-closed** and session-gated.

### Route authentication

All `/api/antfarm/*` routes call `assertSecret(request, reply, webAppBootstrapSecret, sessions)` — the same check that guards the KG and jobs APIs: a valid `curia_session` cookie **or** the `x-web-bootstrap-secret` header. The global `onRequest` bearer-auth hook explicitly exempts `/api/antfarm/*`, so these routes rely solely on the session check inside each handler. When `WEB_APP_BOOTSTRAP_SECRET` is unset, `assertSecret` returns `503` (consistent with the other session-auth routes). The timeline/stream routes register only when an `auditLogRepo` is present; the assets route registers unconditionally (art serving needs no data source) but is inert without the secret. Unauthenticated requests to any of them never see audit data or licensed bytes — the SPA itself renders a "sign in via the console first" gate when the session check fails.

### Scoped `/antfarm/` Content-Security-Policy

The console ships a strict CSP with `img-src 'self'`. Phaser cannot run under it, so `/antfarm/` HTML responses get a **scoped, relaxed** policy — identical to the console's except for the image sources:

```
console:  img-src 'self'
antfarm:  img-src 'self' data: blob:
```

Both additions are load-bearing and image-only (neither can execute script, so `script-src 'self'` — the XSS mitigation — is unchanged):

- **`data:`** — Phaser loads its internal boot textures (`__DEFAULT`, `__MISSING`, `__WHITE`) from embedded base64 `data:` PNG URIs at startup. `__WHITE` backs all tinting/graphics; without `data:` the WebGL canvas renders blank (this was the "blank canvas in production" bug).
- **`blob:`** — Phaser's file loader fetches the licensed art via XHR and hands it to an `Image` element as a `URL.createObjectURL(blob)` `blob:` URL. `'self'` does not cover the `blob:` scheme, so without it every real-art load was CSP-blocked and the office silently fell back to placeholders (the "placeholder-only art in production" bug).

**Trailing-slash scoping is deliberate.** The relaxed CSP is applied only when the request path starts with `/antfarm/` (with the slash) — exactly what the antfarm-static plugin serves. Bare `/antfarm` (no slash) is *not* matched: no Ant Farm route handles it, so it falls through to the console's `/*` wildcard and is served the **console** index. Matching bare `/antfarm` here would hand a console page the relaxed `data:` CSP — the exact leak this scoping prevents.

### Asset route hardening

`/api/antfarm/assets/*` streams user-derived file paths, so it is hardened against the MIME-sniffing / XSS class:

- **Strict content-type allowlist** — only `.png` (`image/png`) and `.json` (`application/json`) are ever emitted. Any other extension returns `404` rather than falling back to `octet-stream`, so the response body is never a stream of unknown provenance and can never be labelled `text/html`.
- **`X-Content-Type-Options: nosniff`** — forbids the browser from re-interpreting the body (e.g. sniffing a PNG's bytes as HTML and executing embedded script).
- **Path-traversal guard** — `resolve` + `relative(dir, abs).startsWith('..')`; any escape from the assets root returns `404`.
- **Absent-art fallback** — a missing file *or* a missing `assets-licensed/` directory returns `404` (via `ENOENT`), which the Phaser loader treats as "use the placeholder". Any other fs error (`EACCES`, …) is logged with context and propagated as a diagnosable `500`, not silently swallowed.

---

## Assets & Licensing

Ant Farm renders in the visual style of **LimeZu** pixel-art packs (Modern Office for tiles/furniture/props, Modern Interiors for character sprites). LimeZu granted written redistribution approval (2026-07-02, curia#1504), so the licensed art now ships in-repo and in every image — the placeholder path remains as a graceful fallback:

- **Placeholders are the fallback baseline.** `placeholder-textures.ts` registers procedural CC0 stand-ins for every prop and character. They render whenever the licensed art is absent (e.g. a source checkout without it) — the acceptance-criteria floor, no hard failure.
- **Licensed art ships in-repo.** Runtime PNGs (the Modern Office tileset + room-builder floor; up to 20 premade Modern Interiors character spritesheets at the 32×32 size) are committed to `apps/antfarm/assets-licensed/limezu/` and baked into the image (open-core included). That directory sits **outside** the Vite `public/` web root and is served **only** behind the session-gated assets route — the licensed bytes never touch the unauthenticated static mount.
- **Characters: deterministic 1-of-20.** Each agent id is hashed to one of the 20 premade sheets (`characterSheetForAgent`), giving every agent a stable, visually distinct look. When the real sheet loaded, the agent renders as an animated `Sprite` (idle + 4-direction walk); when absent, it falls back to the tinted procedural placeholder driven by the `agent-appearance` map. *(Generator-part compositing — building characters from skin/hair/outfit layers — is deferred post-v1; that ~80M layer library is not staged.)*
- **Office props: real where covered.** Floor, desks, the boss desk, the tasks board, and the wastebasket are swapped to cropped regions of the Modern Office tileset when present. The claw, vacuum tubes, and scheduler-machine have **no pack coverage** and stay procedural by design.
- **Attribution.** The in-app `CreditsFooter` links both LimeZu packs, satisfying the attribution clause whether or not the licensed art is present.

The loader never throws: `OfficeScene.preload()` records load errors in a `failedLoads` set, and `create()` swaps in real textures only for entries that actually loaded — so an absent asset always leaves its placeholder in place.

---

## Deployment

- The Docker image **builds both SPAs** (`@curia/console` and `@curia/antfarm`) and copies each `dist/` into the runtime image.
- The Fastify HTTP channel registers `antfarmStaticRoutes` (the `/antfarm/*` mount) **before** `consoleRoutes`, so the console's `/*` wildcard does not swallow Ant Farm requests. When the antfarm `dist/` is absent, the static route serves a `503` "not built" page instead of falling through.
- The curated licensed-art subtree lives in-repo at `apps/antfarm/assets-licensed/limezu/` (runtime PNGs only — no `.ase`/`.gif`/`.txt` masters) and the runtime stage `COPY`s `apps/antfarm/assets-licensed` into the image, so every build (open-core included) ships the real art. A checkout that omits the subtree still builds and renders placeholders.

---

## Known Deficiencies

- **Generator-part character compositing** — deferred post-v1, layer library not staged.
