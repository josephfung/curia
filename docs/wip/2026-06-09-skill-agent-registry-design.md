# Design: Database-layer registry for skills and agents (install/enable lifecycle)

**Issue:** [#541](https://github.com/josephfung/curia/issues/541)
**Date:** 2026-06-09
**Status:** Draft — pending review

---

## Summary

Replace the purely filesystem-based, all-or-nothing loading of skills and agents with a
database-backed registry that gates loading on an explicit per-item lifecycle:
**uninstalled → installed (disabled) → enabled**. Only *enabled* items load into the
runtime registries. The change adds two tables, a startup reconciliation step, runtime
enforcement in the loaders, and a web-app management surface (Skills + Agents pages).

This is **Spec 1 of 3** in a larger arc. Secrets declaration/management (PR2) and config
declaration/management (PR3) hang off this lifecycle and are explicitly **out of scope
here** — but the manifest schema reserves the `install`/`uninstall` blocks they will use.

Existing manifests need **zero changes**. The running production deployment is migrated
with a one-shot backfill script that enables everything currently on disk, preserving
today's behavior exactly.

---

## Key design decisions

Settled during brainstorming; they shape everything below.

1. **State is derived, never stored.** The tables store only `enabled` + timestamps. The
   four operational states are computed by cross-referencing on-disk manifests against
   registry rows:

   | State | On disk | DB row | Loaded at runtime |
   |---|---|---|---|
   | Uninstalled | yes | no | no |
   | Installed (disabled) | yes | yes, `enabled=false` | no |
   | Enabled | yes | yes, `enabled=true` | **yes** |
   | Ghost | no | yes | no (warn at startup) |

2. **The migration only creates empty tables.** A SQL migration runs identically in every
   environment and cannot read the filesystem, so it cannot decide what to enroll.
   Enrollment is an **application-layer reconciliation step** at startup.

3. **Core-set defaults live in a trusted, in-repo config file, never in manifests.**
   A `config/registry-defaults.yaml` lists the minimal skills/agents enabled by default on
   a fresh install. Putting a `default_enabled` flag in `skill.json` / `agent.yaml` would
   let an uploaded skill self-enable on upload, defeating the whole point of an
   install/enable gate (this issue is security-labeled for exactly this reason). The
   defaults file ships with the codebase and is not attacker-controlled.

4. **The existing prod deployment is migrated by a throwaway script, not startup magic.**
   `scripts/backfill-registry-enable-all.ts` inserts enabled rows for every on-disk item.
   Joseph runs it once against prod after deploy; we delete it after this development
   cycle. No permanent "enable everything" branch lingers in startup code, and no fragile
   "detect an upgrade vs. a fresh install" heuristic.

5. **Reconciliation is idempotent and never overrides an admin.** It only acts on a core
   item that has **no row**. An admin who deliberately disables a core skill stays
   disabled across restarts, because a row already exists.

6. **Enforcement is restart-based.** Hot-reload is out of scope (per the issue). Toggling
   `enabled` writes the DB; the in-memory registries are not mutated until the next
   restart. The web UI states this plainly.

7. **Discovery and load are split.** Today the loader does one pass that parses, imports
   the handler, validates, and registers — crashing on any bad manifest. We split into a
   lightweight **discovery** pass (parse metadata for *all* items, for the UI) and a strict
   **load+register** pass (only *enabled* items get their handler imported and validated).
   A malformed *disabled/uninstalled* manifest surfaces as an error row in the UI instead
   of crashing startup; an enabled item keeps today's fail-closed behavior.

8. **MCP tools are out of scope.** The registry governs filesystem skills (`skills/<name>/`)
   and filesystem agents (`agents/<name>.yaml`). MCP servers are config-driven
   (`config/skills.yaml`) with a different lifecycle and continue to load unchanged.

9. **`install`/`uninstall` blocks are reserved but inert in PR1.** The manifest schemas
   gain optional `install`/`uninstall` objects so future declarations validate, but in
   PR1 Install only creates the row. `requires_secrets` (PR2) and `requires_config` (PR3)
   will populate these blocks later.

---

## Architecture

A new `src/registry/` module, plus surgical changes to the existing skill/agent loaders,
the bootstrap, the HTTP adapter, and the console app.

```
src/registry/
  types.ts             # DerivedState, RegistryRow, RegistryEntry, discovery types
  registry-repo.ts     # DB CRUD over skill_registry / agent_registry (parameterized)
  registry-service.ts  # merges discovery + rows → state; install/uninstall/enable/disable
  reconcile.ts         # startup core-set enrollment (idempotent)
config/
  registry-defaults.yaml   # trusted core-set list (skills + agents)
scripts/
  backfill-registry-enable-all.ts   # one-shot prod migration; deleted after this cycle
```

### Component 1: discovery (changes to existing loaders)

Refactor `src/skills/loader.ts` and `src/agents/loader.ts` to separate *discovery* from
*load+register*.

- **`discoverSkillManifests(skillsDir): SkillDiscovery[]`** — scan each `skills/<name>/`,
  read and JSON-parse `skill.json`, capture metadata (`name`, `description`, `version`,
  `action_risk`, `sensitivity`, `capabilities`, etc.) **without** importing the handler.
  On a parse/shape error, return an entry with `{ name, error }` rather than throwing.
- **`discoverAgentManifests(agentsDir): AgentDiscovery[]`** — same for `agents/*.yaml`
  (YAML-parse, capture `name`, `description`, `version`, `role`, `model`, etc.).

`SkillDiscovery` / `AgentDiscovery` carry the parsed metadata plus an optional `error`.
These feed both reconciliation and the management UI.

- **`loadSkillsFromDirectory(...)`** gains an `enabledNames: Set<string>` parameter (or a
  predicate). It iterates discovery results, and for each item in `enabledNames` performs
  the existing strict path (handler import, capability validation, `register()`). Items
  not enabled are skipped (info-logged once). Enabled-but-malformed manifests keep the
  current hard-fail behavior — a thing going live must be valid.
- Agent loading is gated the same way.

### Component 2: registry repo (`src/registry/registry-repo.ts`)

Constructor-injected `(pool: DbPool, logger: Logger)`, matching the `AutonomyService` /
`SecretsService` pattern. One repo instance per table, parameterized via a `table`
discriminator, or two thin classes — implementation detail. Methods (per table):

| Method | Behavior |
|---|---|
| `listRows(): Promise<RegistryRow[]>` | All rows for the table. |
| `getRow(name): Promise<RegistryRow \| null>` | Single row. |
| `install(name, actor): Promise<RegistryRow>` | Insert `enabled=false`, `installed_at=now`, `installed_by=actor`. Idempotent: if a row exists, no-op return. |
| `enable(name, actor): Promise<RegistryRow>` | Set `enabled=true`, `enabled_at=now`, `enabled_by=actor`, `updated_at=now`. Requires an existing row. |
| `disable(name, actor): Promise<RegistryRow>` | Set `enabled=false`, `enabled_at=null`, `enabled_by=null`, `updated_at=now`. |
| `uninstall(name): Promise<void>` | Delete the row. |

`RegistryRow` maps snake_case DB columns to camelCase, following the `mapTaskRow` pattern.

### Component 3: registry service (`src/registry/registry-service.ts`)

The merge + policy layer. Constructed with the two repos and the discovery results
(captured once at startup). It computes derived state and exposes the operations the API
needs.

```text
RegistryEntry = {
  name, kind: 'skill' | 'agent',
  metadata: { description, version, action_risk, ... } | null,  // null when ghost
  state: 'uninstalled' | 'installed' | 'enabled' | 'ghost',
  installedAt, installedBy, enabledAt, enabledBy,
  manifestError?: string,   // set when the manifest parsed badly
}
```

| Method | Behavior |
|---|---|
| `listSkills(): RegistryEntry[]` | Outer-join discovery × rows → derived state for every known skill. |
| `listAgents(): RegistryEntry[]` | Same for agents. |
| `install(kind, name, actor)` | Validates the item exists on disk (reject ghost installs). PR1: just `repo.install`. PR2/3: run the install block here. |
| `enable(kind, name, actor)` | Requires an installed row. Rejects enabling a ghost. |
| `disable(kind, name, actor)` | `repo.disable`. |
| `uninstall(kind, name, actor)` | Allowed even for ghosts (the only way to clear a ghost row). PR2/3: run the uninstall block first. |

Note `enable`/`disable`/`install`/`uninstall` change DB state only — they do **not** touch
the live in-memory registries (restart-based enforcement, decision 6).

### Component 4: reconciliation (`src/registry/reconcile.ts`)

`reconcileRegistries(deps)` runs at startup, after migrations, before the load+register
pass. Pseudocode:

```text
defaults = parse config/registry-defaults.yaml   # { skills: [...], agents: [...] }
for kind in [skills, agents]:
  rows = repo.listRows()  (as a name set)
  for name in defaults[kind]:
    if name in rows: continue              # respect existing admin state
    if name not in discovery names:        # core item declared but not on disk
        logger.warn(... 'core default missing on disk'); continue
    repo.install(name, 'reconciliation'); repo.enable(name, 'reconciliation')
```

Pure DB + the defaults file + discovery names. No handler imports.

### Component 5: backfill script (`scripts/backfill-registry-enable-all.ts`)

Standalone, run via `pnpm tsx`. Connects to the DB, runs discovery against `skills/` and
`agents/`, and for every discovered item with no row, inserts an enabled row
(`installed_by='backfill'`, `enabled_by='backfill'`). Idempotent. Prints a summary
(`N skills enrolled, M agents enrolled, K already present`). **Deleted after this cycle**
— a `TODO(remove-after-541)` header marks it.

### Component 6: HTTP routes (`src/channels/http/routes/registry.ts`)

A new route module following the `assertSecret`-gated pattern of `routes/kg.ts`. Registered
in `http-adapter.ts` when `webAppBootstrapSecret` and the registry service are present.

```text
GET    /api/registry/skills                 → { skills: RegistryEntry[] }
GET    /api/registry/agents                 → { agents: RegistryEntry[] }
POST   /api/registry/skills/:name/install   → { entry }
POST   /api/registry/skills/:name/enable    → { entry }
POST   /api/registry/skills/:name/disable   → { entry }
DELETE /api/registry/skills/:name           → { ok: true }   (uninstall)
   ...identical quartet for /api/registry/agents/:name...
```

Actor recorded as `'web-app'` (no per-user identity in the console today — same as existing
routes). Rate-limited like the other admin routes.

### Component 7: bootstrap wiring (`src/index.ts`)

New sequence (replacing the current single-pass load):

```text
1. run migrations (creates 051 tables)
2. registryRepo(s) = new RegistryRepo(pool, logger)
3. skillDiscovery = discoverSkillManifests(skillsDir)
   agentDiscovery = discoverAgentManifests(agentsDir)
4. await reconcileRegistries({ repos, discovery, defaultsPath })
5. enabledSkills = new Set(skillRepo.listRows().filter(enabled).map(name))
   loadSkillsFromDirectory(skillsDir, skillRegistry, logger, enabledSkills)
6. loadMcpServers(...)                       # unchanged
7. enabledAgents = new Set(agentRepo.listRows().filter(enabled).map(name))
   agentConfigs = loadAllAgentConfigs(agentsDir).filter(c => enabledAgents.has(c.name))
   register only those in AgentRegistry
8. registryService = new RegistryService(repos, skillDiscovery, agentDiscovery)
   → injected into the HTTP adapter config
9. validateAllowedCallers(...) and runtime creation — see knock-on below
```

### Knock-on: pinned skills and delegates referencing disabled items

A disabled skill may still appear in some enabled agent's `pinned_skills`, and a disabled
agent may be referenced as a delegate or `allowed_caller`. Today a missing pinned skill or
caller fails hard at startup. New behavior:

- `SkillRegistry.toToolDefinitions(names)` already only emits tools for registered skills;
  a disabled pinned skill is simply absent. We add a **warning log** listing dropped
  pinned skills per agent so the gap is visible, rather than silent.
- `validateAllowedCallers` is relaxed to **warn** (not throw) when an `allowed_callers`
  entry names an agent that exists on disk but is disabled/uninstalled — it still throws
  for a genuinely unknown name (typo protection preserved).

---

## Data schema

Migration `051_create_skill_agent_registry.sql` (verify `051` is still the next free
prefix at merge time — see the migration-numbering rebase hazard in CLAUDE.md; branches
`feat/tasks-v1-migration` and `feat/compose-reply` are in flight).

```sql
-- Up Migration

CREATE TABLE skill_registry (
  name         TEXT PRIMARY KEY,                 -- matches skill.json "name"
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT        NOT NULL DEFAULT 'system',
  enabled_at   TIMESTAMPTZ,                      -- set when enabled flips true, cleared on disable
  enabled_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_registry (
  name         TEXT PRIMARY KEY,                 -- matches agents/<name>.yaml "name"
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT        NOT NULL DEFAULT 'system',
  enabled_at   TIMESTAMPTZ,
  enabled_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No secondary indexes: both tables are tiny (dozens of rows at most) and the only
-- hot query is a full "list all rows" at startup. The PRIMARY KEY on name suffices.

-- Down Migration
DROP TABLE skill_registry;
DROP TABLE agent_registry;
```

No `installed_at` default-row seeding — enrollment is reconciliation's job, in app code.

---

## Manifest schema changes (reserved, inert in PR1)

Add optional, additive blocks to `schemas/skill-manifest.schema.json` and
`schemas/agent-config.schema.json`:

```jsonc
"install":   { "type": "object", "additionalProperties": true },   // shape firmed up in PR2/PR3
"uninstall": { "type": "object", "additionalProperties": true }
```

PR1 parses but does not act on them. This is a **public API-surface change to the
manifest schema** — call it out in the changelog per CLAUDE.md. Existing manifests omit
both and validate unchanged.

---

## `config/registry-defaults.yaml`

```yaml
# Trusted, in-repo list of skills/agents enabled by default on a FRESH install.
# Not read from individual manifests (which are attacker-controlled on upload).
# Reconciliation enrolls these as enabled only when no registry row exists yet.
skills:
  - skill-registry        # exact core set finalized during implementation
  # - memory-query
  # - ...
agents:
  - coordinator
  # - ...
```

The concrete core set is finalized in the plan (it must be enough for a fresh install to
be usable, but minimal). The existing prod deployment ignores this file — the backfill
script enables everything regardless.

---

## Data flow

**Fresh install, first boot:** migrations create empty tables → reconciliation enrolls the
core set as enabled → only core skills/agents load → admin opens the Skills page, sees the
rest as *uninstalled*, installs + enables the ones they want → restart.

**Existing prod, upgrade boot:** migrations create empty tables → reconciliation enrolls
*core only* (everything else would be uninstalled → system degraded). **Therefore Joseph
runs `backfill-registry-enable-all.ts` immediately after the upgrade boot** (or before
first restart) to enable everything, restoring today's behavior. *(Operational note: the
runbook must sequence this; see Error handling.)*

**Admin disables a misbehaving skill:** toggle off in the web app → `disable` writes the
DB → next restart, the skill is absent from `SkillRegistry` and uninvokable. No deploy.

**Ghost (files removed but row remains):** discovery has no entry, row exists →
`listSkills` marks it `ghost` → startup logs a warning, the item does not load → admin
sees the ⚠ indicator and can Uninstall to clear the row.

---

## Web app

New "Skills & Agents" collapsible nav group in `Sidebar.tsx`, two routes
(`/registry/skills`, `/registry/agents`) in `router.tsx`, two pages modeled on
`ContactsPage` (records table + right-hand detail drawer).

**List view (each):**
- One row per known entry, with a **state pill**: `uninstalled` (grey) · `installed`
  (amber) · `enabled` (green) · `ghost` (red ⚠).
- `enabled`/`installed` rows: an enable/disable **toggle**.
- `uninstalled` rows: an **Install** button (no toggle).
- `ghost` rows: ⚠ "files missing" indicator, **Uninstall** only.
- Manifest-error rows: ⚠ with the parse error in a tooltip; no enable.

**Detail drawer (row click):**
- Full manifest metadata (name, description, version, action_risk, sensitivity,
  capabilities; agents also show role + model tier).
- State + timestamps (installed_at/by, enabled_at/by).
- Actions: **Install** and **Install & enable** (convenience, per decision); **Uninstall**
  (destructive, confirm dialog); enable/disable toggle.
- A persistent note: *"Enabling or disabling takes effect on the next restart."*

Reuses existing CSS (`.records-*`, `.drawer*`, `.status-pill*`) and the `apiFetch` wrapper.

---

## Error handling

- **Malformed manifest, item enabled:** hard fail at the load+register pass (unchanged
  fail-closed). The system must not boot with a broken enabled skill.
- **Malformed manifest, item disabled/uninstalled:** discovery records `{ name, error }`;
  the item shows as an error row in the UI; startup continues.
- **Ghost row at startup:** `logger.warn` with the name; not loaded; surfaced in the UI.
- **Install/enable on a ghost (no files):** service rejects with a clear error.
- **Reconciliation references a core default not on disk:** `logger.warn`, skip — a
  missing core file is operator misconfiguration, not a crash.
- **Backfill ordering on prod:** if the upgrade boots before the backfill script runs,
  non-core items are inert (uninstalled) but the system still boots on the core set. The
  runbook must instruct running the script promptly; this is a deliberate, recoverable
  degradation, not data loss. No empty catches anywhere; every catch logs + propagates.

---

## Testing (TDD — tests first)

**Unit — `src/registry/registry-service.test.ts`:**
- State derivation: on-disk+no-row → `uninstalled`; row+disabled → `installed`;
  row+enabled → `enabled`; row+no-disk → `ghost`; bad manifest → error entry.
- `install` rejects a ghost; `enable` requires an installed row; `uninstall` clears a ghost.

**Unit — `src/registry/reconcile.test.ts`:**
- Enrolls a core item with no row as enabled.
- Idempotent: a second run is a no-op.
- Respects an admin-disabled core item (row present, disabled) — does not re-enable.
- Core default missing on disk → warn, no throw.

**Unit — loader split:**
- `discoverSkillManifests` returns metadata without importing handlers; a bad manifest
  yields an error entry, not a throw.
- `loadSkillsFromDirectory` registers only names in `enabledNames`; an enabled bad
  manifest still throws.
- `toToolDefinitions` drops a disabled pinned skill and the drop is warn-logged.
- `validateAllowedCallers` warns (not throws) for a known-but-disabled agent; still throws
  for an unknown name.

**Integration — `tests/integration/registry-repo.test.ts`** (`describeIf(DATABASE_URL)`):
- Migration up creates both tables + indexes; down drops them.
- `install`/`enable`/`disable`/`uninstall` round-trips; timestamps + `*_by` set correctly.
- Backfill script enrolls all discovered items as enabled; idempotent on re-run.
- Enabled-only loading: seed rows, boot the loader, assert only enabled names register.
- Cleanup: `DELETE FROM skill_registry; DELETE FROM agent_registry;` in `afterAll`.

---

## Out of scope (PR2 / PR3 / explicitly deferred)

- **Secrets** declaration (`requires_secrets`) + vault `list()` + entry/edit UI → **PR2**.
- **Config** declaration (`requires_config`) + unified store + editor → **PR3**.
- **`dispatch_task` / `scheduled_jobs`** install primitives — deferred until a real need.
- **Hot-reload** of registries without restart — out of scope per the issue.
- **MCP tools** — config-driven, unchanged.
- **Per-user RBAC** in the console — no user identity exists today; actor is `'web-app'`.

---

## Changelog / versioning notes

- **Added** — skill/agent registry (`skill_registry` + `agent_registry` tables,
  `RegistryService`, startup reconciliation, `config/registry-defaults.yaml`),
  `/api/registry/*` routes, console Skills & Agents management pages, one-shot backfill
  script.
- **Changed** — skill/agent loading is now gated on the registry; only enabled items load.
  `skill.json` / agent YAML schema gains optional `install`/`uninstall` blocks (**public
  API surface — called out per CLAUDE.md**). `allowed_callers` validation relaxed to warn
  on disabled-but-known agents.
- An **ADR** is warranted: "DB-gated install/enable lifecycle for skills & agents over
  filesystem auto-load," documenting the derived-state model, the trusted-defaults-file
  decision (vs. a manifest flag), and restart-based (not hot-reload) enforcement.
