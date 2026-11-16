### Fixed

- **Card-use tools** — `card-use-request` and `card-use-confirm` rejoin the web bundle, so saved cards are reachable again. (#1358)
- **`approve-action` / `deny-action`** — receive `cardUse` again, so failed or denied card requests are settled. (#1358)
- **Bundle membership test** — fails CI when a bundle's tool directory is missing from its `SKILL.md`.
