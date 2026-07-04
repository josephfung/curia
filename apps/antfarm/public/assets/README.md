# Ant Farm assets

CC0 placeholder art lives in-repo. Procedural textures are also generated at runtime
in `src/game/placeholder-textures.ts` when the Phaser scene boots.

Licensed LimeZu art (`Modern Office`, `Modern Interiors`) is **not** committed here and is
**never** placed in `public/` (that path is world-downloadable). The hosted build layers
licensed runtime PNGs into `apps/antfarm/assets-licensed/` (gitignored), which is served
only behind session auth via `GET /api/antfarm/assets/*`. The open-core image ships no
licensed art, so those requests 404 and the scene renders procedural placeholders.

See `CREDITS.md` for attribution requirements.
