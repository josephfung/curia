### Added

- **Saved cards** — gated `#field` addressing fills card number, CVV and expiry without exposing them. (#1358)
- **Card-use confirmation** — the principal approves each checkout; grants last 30 minutes, two fills. (#1358)
- **`secret.accessed.secretField`** — **public API:** names the card field filled, never its value. (#1358)
- **`card_use.requested` / `card_use.decided`** — **public API:** checkout confirmation events; brand and last four only. (#1358)
- **`resolveSecretRef`** — **public API:** `siteUrl` option; `ToolContext` gains `approvalVia` and `cardUse`. (#1358)
- **ADR-060** — card use needs a per-checkout confirmation; ADR-027 amended. (#1358)

### Security

- **Bare card refs** — refused; a card's JSON can no longer be typed into a field. (#1358)
