# Design: Declared credentials for MCP skills

**Status:** Approved (brainstorm) — pending spec review
**Date:** 2026-06-21
**Related:** #913 (vault-only MCP secret resolution), #911/#542 (encrypted vault), #964 (channel registry resolvable gate), #971/#995 (secret-capture), #1099 (atproto-mcp skipped — folds into this)

## 1. Goal & non-goals

**Goal.** An MCP server declares its required secrets *by name* in `skills.yaml`. The web console lists declared servers, shows the right (masked/plain) fields, writes values to the encrypted vault, and gates enable/disable on whether the required secrets resolve — mirroring the existing Channels registry. This kills the failure mode that silently took down `atproto-mcp`: secrets scattered across two `.env` files plus a hand-maintained `seed-vault` list plus stale "inherit from process.env" comments, with no single declared source of truth.

**Non-goals (explicit, to bound scope).**

- **Authoring** new MCP servers from the browser (writing `skills.yaml`). Config remains the source of server definitions.
- **Unifying** channels + MCP + local skills into one registry abstraction. We build a *parallel* registry and reuse primitives; unification is a possible future project, and this design is shaped to make it easier later.
- A first-class **local-skill** secret UI (the tavily/openai/nylas set). Shared flat keys bring some of it along for free (§9); a dedicated surface is a fast-follow.

## 2. Background: the channel analog

The Channels system already implements this pattern for channels, and we mirror it:

- **Declaration** — `ChannelDescriptor` in `src/channels/catalog.ts` declares `credentialFields` (`key`, `label`, `secret` bool, `envFallback`) and `requiredSecretKeys`.
- **API + UI** — `GET /api/registry/channels` serves descriptors enriched with per-field status; `apps/console/src/pages/ChannelSettings.tsx` renders masked fields and submits to `PUT /api/vault/secrets/:name`, writing under `channel.<name>.<key>`.
- **Gate + lifecycle** — a `channel_registry` table tracks install/enable/disable; enable is blocked unless `requiredResolvable` (every required key present per `src/channels/credential-resolver.ts`, using `normalizeSecretValue` so whitespace-only reads as absent — the #964 symmetry). Uninstall cascades to delete the channel's vault keys.

Two deliberate differences for MCP:

1. **Definitions come from config** (`skills.yaml`, core + `curia-deploy/custom`), not a code catalog. `skills.yaml` *is* the descriptor source.
2. **Flat vault keys**, not `channel.<name>.<key>` namespacing (see §3).

## 3. Vault keys & write-allowlist

**Flat keys.** The declared `key` *is* the vault key (`atproto_identifier`, `google_oauth_client_id`). No `mcp.*` namespace.

Rationale (validated against the codebase): flat shared keys are the platform-native pattern — `nylas_api_key` and `ceo_nylas_grant_id` are each referenced by 12 skills, sharing the same vault row by name. Namespacing MCP secrets per-server would make MCP the only component type that cannot share a credential, force duplication of the live Google trio (shared by the `google-workspace` MCP and the `drive-download-file` skill), and require migrating off #913's already-shipped bare-key resolution. Flat keys avoid all three. The "no scatter" property comes from *requiring declaration*, not from namespacing.

**Write-allowlist.** `PUT /api/vault/secrets/:name` (`src/channels/http/routes/vault.ts`) already accepts "a channel credential key **or** a skill-declared secret." We extend the allowed set to also include the union of every declared MCP `secrets[].key`. The endpoint stays the single guarded write path; only declared names are writable.

## 4. Declaration schema (`skills.yaml`)

Add an optional `secrets:` block to an MCP server entry — the MCP analog of channel `credentialFields`, and the single source of truth for the loader, the vault allowlist, and the console.

```yaml
- name: atproto-mcp
  transport: stdio
  command: ./node_modules/.bin/atproto-mcp
  secrets:
    - key: atproto_identifier            # flat vault key = declared name (shareable)
      label: "Bluesky handle (e.g. you.bsky.social)"
      required: true
      secret: false                      # plain text -> not masked in UI
      inject: { env: ATPROTO_IDENTIFIER } # how the resolved value reaches the subprocess
    - key: atproto_password
      label: "Bluesky app password (revocable; never the account password)"
      required: true
      secret: true                       # masked input
      inject: { env: ATPROTO_PASSWORD }
  env:
    ALLOWED_FILE_DIRS: "/run/curia-tempfiles"   # non-secret literals stay here
  action_risk: medium
  timeout_ms: 30000
```

Field semantics:

- **`key`** — flat vault key (the declared name); shareable across skills and MCP servers. The `google-workspace` server declares `key: google_oauth_client_id`, the same row the drive skill reads.
- **`label`** — human label for the console field.
- **`required`** — feeds the enable gate.
- **`secret`** — masking flag (handle = plain, password = masked), mirrors `ChannelCredentialField.secret`.
- **`inject`** — the wiring that replaces today's `env: KEY: ""` sentinel and `fixed_inputs: "env:VAR"`. Two forms:
  - `{ env: VAR_NAME }` — inject the resolved vault value into the child process env as `VAR_NAME`.
  - `{ fixed_input: param_name }` — inject as a tool-call fixed input (the `google-workspace` `user_google_email` case).

The plain `env:` block is reduced to **non-secret literals only** (e.g. `ALLOWED_FILE_DIRS`).

**Decision:** the `secrets:` block owns both the metadata and the wiring (via `inject`), rather than keeping `env:""`/`fixed_inputs` as wiring and adding `secrets:` as side-metadata. One block avoids drift between the wiring and the declared list.

## 5. Resolution (the #913 path)

`mcp-loader`'s vault resolution from #913 stays vault-only (no `process.env` fallback), but sources the `(vault key -> inject target)` mapping from the `secrets:` block instead of inferring it from `env: ""` / `fixed_inputs: "env:"`. For each declared secret on an enabled server: read `key` from the vault; if `inject.env`, place the value in the child env under that var; if `inject.fixed_input`, merge it into the server's fixed inputs. A missing *required* secret skips the server (the existing loud-fail backstop). `buildChildEnv` continues to inject only declared keys onto the minimal safe base (least-privilege preserved).

## 6. Registry & lifecycle

New `mcp_server_registry` table mirroring `channel_registry`:

| column | meaning |
|---|---|
| `name` | server name from `skills.yaml` |
| `enabled` | row absent = uninstalled; present + `false` = installed; `true` = enabled |
| `installed_at` / `installed_by` / `enabled_at` / `enabled_by` / `updated_at` | audit |

- **State** (`uninstalled` / `installed` / `enabled`) derived exactly like channels.
- **Enable gate** — blocked unless every `required` secret resolves; reuse the credential-resolver presence check + `normalizeSecretValue`.
- **Loader change** — `loadMcpServers` consults the registry: **only `enabled` servers spawn.** A server defined in `skills.yaml` but not enabled is not spawned; it still appears in the console as installable/configurable. The #913 "skip if a required secret is unresolvable" check stays as a backstop.
- **Apply timing** — spawning happens at boot, so enable/disable/secret changes take effect on next restart. The UI states "takes effect on restart." Live hot-reload of the MCP subprocess set is out of scope.

## 7. Backend API (parallel to channels)

- `GET /api/registry/mcp` — list declared servers x registry rows x per-secret status (`configured`, `source`, `secret`, `label`) plus `requiredResolvable`. Never returns values.
- `POST /api/registry/mcp/:name/install`
- `POST /api/registry/mcp/:name/enable` — gated on `requiredResolvable`.
- `POST /api/registry/mcp/:name/disable`
- `DELETE /api/registry/mcp/:name` — uninstall; cascade-delete the server's *exclusively-owned* vault keys (see §9 shared-key caveat).
- Secret writes reuse the existing `PUT /api/vault/secrets/:name`.

## 8. Frontend (console)

A new **"MCP Skills"** section beside Channels, reusing the channel React components:

- A card per declared server: state pill, description, per-secret rows (masked when `secret: true`) with configured/source status, an **Enable** button disabled until `requiredResolvable` (same "configure the required credentials first" tooltip).
- Same submit path (`PUT /api/vault/secrets/:name`), same masked-field convention, same gate mirroring (the frontend never offers an action the backend would reject).

## 9. curia-deploy/custom layering & shared keys

- The registry reads the **effective** loaded server set (core `skills.yaml` fully overridden by `curia-deploy/custom` per existing behavior). Servers from either layer appear identically; no merge logic is added.
- **Shared-key caveat on uninstall** — because keys are flat/shared, uninstall must not delete a vault key that another enabled component still declares. Uninstall deletes only keys exclusively owned by this server (computed from the union of declarations).
- **Free win** — populating `google_oauth_client_id` via the `google-workspace` card also satisfies the `drive-download-file` skill (same flat key). Sharing working as intended.

## 10. Migration & rollout

1. **Preserve running servers.** On first boot after deploy, auto-`install` every server declared in the effective `skills.yaml`, and auto-`enable` those whose required secrets already resolve (`google-workspace`; `atproto-mcp` once seeded). Nothing that works today goes dark.
2. **#1099 folds in.** `atproto-mcp` installs but stays not-enabled until its two secrets are populated — now a first-class console flow (fill the Bluesky creds, enable). The "add atproto to the `seed-vault` list" step largely disappears.
3. **`seed-vault` list.** Stops being the canonical home for skill/MCP secrets; keep it only for the bootstrap-required set. Declared MCP/skill secrets are populated via the UI (or a transient-env seed). No more hand-editing `SEED_SECRET_NAMES` per integration.
4. **Second `.env`.** `ATPROTO_*` / `GOOGLE_*` in `curia-deploy/deploy/compose/.env` become removable once vault-populated — the "no second source" win.
5. **Comment cleanup.** Drop the stale "inherit from process.env" comments in core and `curia-deploy` `skills.yaml`.

## 11. Testing

- **Schema validation** — `secrets[]` shape, `inject` variants (`env` / `fixed_input`), duplicate-`key` detection, `required`/`secret` defaults.
- **Loader** — enabled + resolvable spawns; installed-not-enabled does not spawn; enabled-but-missing-required-secret is skipped (backstop) without crashing; non-secret `env:` literals still pass through; least-privilege parent-env stripping holds.
- **Registry service** — enable gate blocks until resolvable; uninstall cascade respects shared keys.
- **Resolver** — vault-only (no env fallback) for injected MCP secrets, sourced from `secrets:`.
- **API** — allowlist rejects undeclared names; status responses never leak values.
- **Migration** — auto-install/enable reproduces the currently-active server set.

## 12. Out of scope / follow-ups (flagged, not built)

- Authoring MCP servers from the browser (§1).
- Unifying channels + MCP + local skills into one registry (§1).
- First-class local-skill secret UI (tavily/openai/nylas) — partly covered via shared keys; dedicated surface is a fast-follow.
- Live hot-reload of MCP subprocesses on enable/disable (§6) — currently restart-to-apply.
- The `channel.email.nylas_api_key` (namespaced) vs flat `nylas_api_key` (skills) divergence — pre-existing inconsistency, noted not fixed.
