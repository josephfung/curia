### Added

- **Card capture links** — new-card and renewal forms; the agent can edit a card's label and expiry. (#1358)
- **`secret-capture-request`** — **public API:** `template`, `card_label`, expiry, name and ZIP inputs; now 0.5.0. (#1358)
- **`GET/POST /api/secret-capture/:token`** — **public API:** `capture_template`, renewal `card`; POST accepts `{ card }`. (#1358)
- **`web-browser` `select`** — fills a dropdown from a saved card's expiry fields; tool now 1.12.0. (#1358)
- **`list-user-secrets` cards** — lists saved cards by label, brand and last four; tool now 0.3.0. (#1358)
- **`card-use-request`** — **new tools** `card-use-request` and internal `card-use-confirm`, both 0.1.0. (#1358)
