# Ant Farm assets

CC0 placeholder art lives in-repo. Procedural textures are also generated at runtime
in `src/game/placeholder-textures.ts` when the Phaser scene boots.

Licensed LimeZu art (`Modern Office`, `Modern Interiors`) is **never** placed in `public/`
(that path is world-downloadable). LimeZu granted redistribution, so the licensed PNGs are
committed to this repo under `apps/antfarm/assets-licensed/limezu/` — outside `public/` — and
served only behind session auth via `GET /api/antfarm/assets/*`. If a build omits that art,
those requests 404 and the scene renders procedural placeholders.

See `CREDITS.md` for attribution requirements.
