# Ant Farm — Art credits

Ant Farm uses pixel-art assets in the style of **LimeZu**:

- [Modern Office - Revamped (16×16)](https://limezu.itch.io/modernoffice) — office tiles, furniture, props
- [Modern Interiors character generator](https://limezu.itch.io/moderninteriors) — top-down character sprites

Per the LimeZu license, attribution is required (LimeZu grants redistribution;
crediting is a license condition). The in-app credits footer links to both packs.

## Where the art lives

LimeZu confirmed redistribution, so the licensed sheets are committed directly in
this repo — no build-time layering from any private source.

| Location | Contents |
|---|---|
| `public/assets/` (this repo) | CC0 placeholders + README only |
| `assets-licensed/limezu/` (this repo) | Licensed LimeZu sheets (`office/` + `characters/`), served via `GET /api/antfarm/assets/*` only to an authenticated caller (a valid session cookie, or the `x-web-bootstrap-secret` header for programmatic access) |
| Runtime (`placeholder-textures.ts`) | Procedural CC0 stand-ins used when the licensed art is absent (e.g. a source checkout without it) |

The licensed sheets sit **outside** `public/` (which Vite exposes unauthenticated),
so the only way to fetch them at runtime over HTTP is the auth-gated route — they never
appear on the unauthenticated static surface. (The bytes are still in this public repo and
image; that is intended, since LimeZu granted redistribution. The route gating is about the
runtime surface, not secrecy.)

Character appearance is driven by a deterministic map from agent id to generator
parts (skin, hair, outfit, accessory), so each agent has a stable, distinct look.
