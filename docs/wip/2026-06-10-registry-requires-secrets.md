# Registry PR2 — `requires_secrets` declaration + install-time vault wiring

Issue: #939. Builds on PR1 (#541/#933), which reserved inert `install`/`uninstall`
blocks in the manifest schema and shipped the install/enable lifecycle.

## Scope (confirmed with Joseph)

- Status indicators + install-time gate.
- **Inline secret entry** in the Skills drawer at install/enable time (e.g. enter the
  Tavily API key when enabling `web-search`), storing it in the vault.
- **No** standalone Vault CRUD settings page.
- **Skills only** — agent manifests keep their inert `install` block.

## Design

A skill declares the vault keys it needs in its manifest:

```jsonc
// skill.json
"install": { "requires_secrets": ["tavily_api_key"] }
```

`install.requires_secrets` is the **install/enable gate** (what must be configured
before the skill goes live). It is distinct from the existing top-level `secrets`
field, which is the **runtime allowlist** (what `ctx.secret()` may read). They often
overlap but answer different questions, so they stay separate.

### Backend

1. **Schema** (`schemas/skill-manifest.schema.json`) — replace the inert
   `"install": { "type": "object" }` with a typed block: `requires_secrets` is an
   array of non-empty strings, `additionalProperties: false`. `uninstall` stays inert
   (PR3). Startup validation already compiles this schema, so it accepts/rejects the
   shape for free.

2. **Types** — `SkillManifest.install` becomes `{ requires_secrets?: string[] }`.
   `ManifestMetadata` (registry) gains `requiresSecrets?: string[]`, populated by
   `discoverSkillManifests()` from `manifest.install?.requires_secrets`. This surfaces
   the list to both the install gate and the UI through the existing discovery path.

3. **`SecretsService.list()`** — `SELECT name FROM secrets ORDER BY name`; returns key
   names only, never values.

4. **`RegistryService` gate** — inject a narrow `SecretsLister` (`{ list() }`;
   `SecretsService` satisfies it). `install()`, `installAndEnable()`, and `enable()`
   call `assertSecretsConfigured()`: if the skill's `requiresSecrets` aren't all present
   in the vault, throw `RegistryGuardError` listing the missing keys (→ HTTP 400). Skills
   with no `requires_secrets` are unaffected. If a skill requires secrets but no vault is
   wired, fail closed.

5. **Vault HTTP routes** (`src/channels/http/routes/vault.ts`) — same session-auth +
   rate-limit pattern as the registry routes:
   - `GET /api/vault/status` → `{ configured_keys: string[] }` for cross-referencing.
   - `PUT /api/vault/secrets/:name` (body `{ value }`) → `secretsService.set(name, value)`.
     Guarded: the name must be declared in *some* skill's `requires_secrets` (derived from
     discovery). This keeps the write endpoint purpose-specific — it can only set
     skill-declared secrets, not arbitrary vault keys.

   Mounted only when `webAppBootstrapSecret`, `secretsService`, and `registryService`
   are all present.

### Console (Skills drawer, skills only)

- Fetch `GET /api/vault/status` on open; cross-reference against
  `entry.metadata.requiresSecrets`.
- "Required secrets" section: green pill when configured, red pill + masked input +
  Save when missing. Save → `PUT /api/vault/secrets/:name`, then re-fetch status.
- Disable Install / Install & enable / Enable (with a tooltip) while any required
  secret is unconfigured — mirroring the service-level gate.

## Tests

- `validator.test.ts` (+ fixtures): a manifest with `install.requires_secrets` passes;
  an unknown key inside `install` is rejected (`additionalProperties`).
- `registry-service.test.ts`: install blocked when a required secret is missing; install
  succeeds when all present; `requires_secrets: []` / absent block unaffected; enable
  gated the same way; missing-vault fails closed.
- `secrets-service.test.ts`: `list()` returns configured names only.
- `vault-routes.test.ts` (integration): status lists keys; PUT sets a declared secret;
  PUT rejects an undeclared name; auth required.

## Out of scope

- `uninstall` block execution (vault cleanup) → later.
- `requires_config` (PR3).
- Standalone Vault settings/CRUD page.
- Agent manifest `requires_secrets`.
