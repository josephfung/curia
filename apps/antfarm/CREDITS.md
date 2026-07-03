# Ant Farm — Art credits

Ant Farm uses pixel-art assets in the style of **LimeZu**:

- [Modern Office - Revamped (16×16)](https://limezu.itch.io/modernoffice) — office tiles, furniture, props
- [Modern Interiors character generator](https://limezu.itch.io/moderninteriors) — top-down character sprites

Per the LimeZu license, attribution is required. The in-app credits footer links to both packs.

## In-repo vs deploy

| Location | Contents |
|---|---|
| `public/assets/` (this repo) | CC0 placeholders + README only |
| `public/assets/limezu/` (gitignored) | Licensed sprites layered at build from curia-deploy |
| Runtime (`placeholder-textures.ts`) | Procedural CC0 stand-ins until LimeZu assets are present |

Character appearance is driven by a deterministic map from agent id to generator
parts (skin, hair, outfit, accessory), so each agent has a stable, distinct look.
