### Removed

- **Legacy Nylas vault keys** — `nylas_api_key`, `nylas_grant_id`, `nylas_self_email` are no longer read or seeded. (#2522)

### Changed

- **Nylas API key migration** — a vault holding only `nylas_api_key` has it renamed to `channel.email.nylas_api_key`. (#2522)
- **Upgrade note** — if email reports the Nylas key missing, re-save it in Settings → Channels → Email. (#2522)
- **Seeding the Nylas key** — scope with `SEED_VAULT_ONLY=channel.email.nylas_api_key`; leftover legacy rows are deletable orphans. (#2522)
