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
| `assets-licensed/limezu/` (this repo) | Licensed LimeZu sheets (`office/` + `characters/`), served only behind session auth via `GET /api/antfarm/assets/*` |
| Runtime (`placeholder-textures.ts`) | Procedural CC0 stand-ins used when the licensed art is absent (e.g. a source checkout without it) |

The licensed sheets sit **outside** `public/` (which Vite exposes unauthenticated),
so they are never world-downloadable — the auth-gated route is the only way to reach them.

Character appearance is driven by a deterministic map from agent id to generator
parts (skin, hair, outfit, accessory), so each agent has a stable, distinct look.
