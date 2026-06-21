# Migrate Google Workspace OAuth secrets into the vault (#913)

Split out of #911. Move `google_oauth_client_id`, `google_oauth_client_secret`,
`curia_google_email` out of plaintext `.env` into the encrypted vault. Google is
separate from #911 because the secrets have **two** independent consumers, both of
which currently read `process.env` and must read the vault before the vars can leave
`.env`.

## The two read paths

1. **`drive-download-file` handler** → `getDriveClient()` (`src/google/drive-auth.ts`).
   Today the handler calls `getDriveClient()` with no args, so `drive-auth` reads
   `process.env` directly and **no `secret.accessed` audit event fires**. The skill
   manifest declares the secrets in UPPERCASE (`GOOGLE_OAUTH_CLIENT_ID`), which never
   matches a vault key (snake_case) and is effectively dead — `ctx.secret()` is never
   called.

2. **`google-workspace` MCP subprocess** (`config/skills.yaml`). The `env:` block
   declares `GOOGLE_OAUTH_CLIENT_ID: ""` / `GOOGLE_OAUTH_CLIENT_SECRET: ""`
   (empty-sentinel = "inherit from process.env" via `buildChildEnv`), and
   `fixed_inputs.user_google_email: "env:CURIA_GOOGLE_EMAIL"` resolves via
   `resolveEnvValue()` from `process.env`. Both must become vault-aware.

## Design decisions (confirmed with Joseph)

- **MCP spawn path = vault-only, no env fallback.** A missing Google secret skips the
  whole `google-workspace` server (same loud-fail contract as a missing `fixed_input`
  today). This is the new, documented meaning of the empty-string `env:` sentinel:
  "resolve from the vault by the lowercased key name." `google-workspace` is the only
  server in `skills.yaml` with an `env:` block, so there is no other consumer to break.
- **Spawn-time vault reads are NOT audited in this PR.** Boot-time system spawns have no
  `agentId`/`taskEventId`, so a per-task `secret.accessed` event doesn't fit. Read via
  raw `secretsService.get()`. File a follow-up for a system-scoped audit event.
- **`ctx.secret()` path (path 1) keeps its existing #911 vault-first/env-fallback
  behavior.** That is the established model; we are not changing it.

## Work items

### Path 1 — audited drive handler
- `skills/drive-download-file/skill.json`: rename `secrets` to snake_case
  (`google_oauth_client_id`, `google_oauth_client_secret`, `curia_google_email`);
  bump `version` 0.1.0 → 0.1.1.
- `skills/drive-download-file/handler.ts`: read the three via `ctx.secret(...)` and pass
  `{ clientId, clientSecret, email }` into `getDriveClient(options)`. Surface a clean
  skill error (not a throw) if a secret is missing.

### Path 2 — vault-aware MCP spawn (the reusable pattern)
- `src/skills/mcp-client.ts`: export `buildChildEnv`; drop its `process.env`
  empty-sentinel fallback so it only merges the minimal base + literal overrides
  (parent-env stripping preserved). Resolution now happens upstream in the loader.
- `src/skills/mcp-loader.ts`:
  - Add required `secretsService` param to `loadMcpServers`.
  - New helper to resolve a stdio `env:` block: empty value → vault key
    `key.toLowerCase()`, `secretsService.get()`, vault-only; missing → signal skip.
    Non-empty value → literal passthrough.
  - New vault-aware `fixed_inputs` resolver: `"env:VAR"` → `secretsService.get(VAR
    .toLowerCase())`, vault-only; missing → skip server. Literal → passthrough.
  - Pass the fully-resolved `env` into `connectStdio`.
- `src/index.ts`: pass `secretsService` into `loadMcpServers`.

### Seed + cleanup
- `scripts/seed-vault.ts`: add the three Google keys to `SEED_SECRET_NAMES`
  (skill-scoped section).
- `.env.example`: remove `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `CURIA_GOOGLE_EMAIL`; update the #913 note + the skills.yaml comments that say "set in
  .env".
- `config/skills.yaml`: update comments to reflect vault-sourced creds.
- `docs/dev/google-drive.md`: vault-sourced credentials.
- `CHANGELOG.md`: Security entry under `[Unreleased]`.

## Tests (TDD)
- `mcp-client.test.ts` (new): `buildChildEnv` includes the minimal base, excludes
  unrelated parent env (e.g. `DB_PASSWORD`), and applies literal overrides only.
- `mcp-loader.test.ts`: env-block resolves empty key from vault; missing vault secret
  skips server; `fixed_inputs` `env:` ref resolves from vault, vault-only; literal
  fixed_inputs passthrough unchanged.
- `handler.test.ts`: `ctx.secret()` called for all three; `getDriveClient` receives the
  resolved `{ clientId, clientSecret, email }`; missing secret → clean skill error.

## Acceptance criteria (from #913)
- [ ] `drive-download-file` reads secrets via `ctx.secret()` (audited), not `process.env`
- [ ] MCP subprocess receives OAuth creds from the vault at spawn time, not inherited env
- [ ] Parent-env stripping in `buildChildEnv()` still holds — only declared keys injected
- [ ] Three Google secrets seeded in the vault and removed from `.env` / `.env.example`
- [ ] `docs/dev/google-drive.md` updated
- [ ] Full test suite green
