### Fixed

- **Card-use tools** — `card-use-request` and `card-use-confirm` rejoin the web bundle, so saved cards are reachable again. (#1358)
- **`approve-action` / `deny-action` / `dismiss-action`** — receive `cardUse` again, so failed, denied or dismissed card requests settle. (#1358)
- **Bundle membership test** — fails CI when a bundle's tool directory is missing from its `SKILL.md`.
- **Smoke judge dates** — behavior descriptions resolve date placeholders, so date cases state the expected dates.
- **Batch-send cases** — drafts sit at fixed times, so the cases pass at any hour. (#2474)
