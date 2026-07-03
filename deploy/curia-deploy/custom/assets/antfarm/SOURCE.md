# Ant Farm — licensed LimeZu assets (private)

**Do not commit raw LimeZu files to the public `curia` repo.** This directory is the
canonical home for production sprite sheets, layered into the Docker image at build time.

## Packs

| Pack | URL | Use in Ant Farm |
|------|-----|-----------------|
| Modern Office - Revamped (16×16) | https://limezu.itch.io/modernoffice | Office tiles, furniture, props |
| Modern Interiors | https://limezu.itch.io/moderninteriors | Top-down character generator sheets |

Record the **purchase date**, **itch.io version/build**, and **license confirmation**
when you add or refresh files.

## Layout

Copy extracted PNG/sheets into subfolders that mirror the in-app loader paths:

```
custom/assets/antfarm/
  SOURCE.md          ← this file
  limezu/
    office/          ← Modern Office sheets (tiles, furniture)
    characters/      ← Modern Interiors character parts / walk cycles
```

At image build, `Dockerfile.curia` copies this tree to
`apps/antfarm/public/assets/limezu/` **before** `pnpm --filter @curia/antfarm run build`.

If the directory is empty, the build still succeeds — the app uses in-repo CC0
placeholders and procedural textures until licensed art is present.

## License

LimeZu assets are **not redistributable** in the public open-core image. They are
for private/hosted production builds only, until owned/commissioned art replaces them
(see Ant Farm epic #1313).

Attribution is required and is surfaced in-app via `CREDITS.md` / the credits footer.
