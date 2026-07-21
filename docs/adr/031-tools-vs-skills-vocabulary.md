# ADR-031: Tools vs skills vocabulary (atom rename)

Date: 2026-07-21
Status: Accepted

## Context

Curia’s extension atoms (`calendar-create-event`, etc.) have always been called
**skills**. Anthropic’s Agent Skills format uses **skill** for a *collection*
(instructions + optional tools/scripts). Curia also already fakes a collection
level three times (`enable_task_management`, MCP servers, and — without a rename —
imported Claude skills). Design:
[`docs/wip/2026-07-16-tools-skills-architecture-design.md`](../wip/2026-07-16-tools-skills-architecture-design.md);
epic #1436; Phase 1 tracking #1485.

Two questions must be settled before later phases:

1. **Public vocabulary** — what is an atom vs a collection?
2. **Migration mechanics** — how to rename ~117 on-disk manifests, the runtime
   catalog, the DB lifecycle table, and operator-facing surfaces without a long
   dual-read window?

Sandbox go/no-go for imported scripts is **out of scope** here (Phase 4 / a
later ADR).

Alternatives considered for the atom name:

- Keep calling atoms “skills” and invent another word for collections —
  rejected; conflicts with Anthropic Agent Skills and keeps `pinned_skills`
  lying about what it pins after Phase 2.
- Call atoms “capabilities” / “actions” — rejected; Messages API + MCP already
  use **tool** for the invocation unit.

## Decision

### Vocabulary

| Level | Name | Unit of |
|---|---|---|
| atom | **tool** | invocation + authorization (`action_risk`, `sensitivity`, `allowed_callers`) |
| collection | **skill** | install / pin / discover / activate (Phase 2+) |

Phase 1 renames only the atom. The collection store arrives in Phase 2 and will
reuse the freed `SkillRegistry` name for lifecycle of *skills (bundles)*.

### Concrete renames (Phase 1)

- On-disk manifest: `skill.json` → **`tool.json`** (one-shot; no dual-read).
- Runtime catalog: `SkillRegistry` → **`ToolRegistry`**.
- Public TS contracts: `SkillManifest` / `SkillHandler` / `SkillContext` /
  `SkillResult` / `RegisteredSkill` → **`Tool*`** / `RegisteredTool`.
- Lifecycle DB table: `skill_registry` → **`tool_registry`**;
  `RegistryKind` `'skill'` → `'tool'`.
- Discovery capability + admin atom: `skillSearch` → **`toolSearch`**;
  atom `skill-registry` → **`tool-registry`**.
- HTTP/console: `/api/registry/skills` → `/api/registry/tools`; UI label
  “Skills” → “Tools” for the atom registry page.
- Bus events: `skill.invoke` / `skill.result` / `autonomy.skill_blocked` →
  **`tool.*` / `autonomy.tool_blocked`** (pre-1.0 public API break; changelog).

### Explicit non-renames (Phase 1)

- **`pinned_skills`** in agent YAML — field name stays; Phase 1 still pins
  atom (tool) names. Phase 2 changes the pin *target* to bundles.
- **`enable_task_management`** — retired in Phase 2 into a normal skill.
- **Flat on-disk layout** — keep `skills/<atom>/` (with `tool.json` inside).
  Phase 2 introduces `skills/<skill>/SKILL.md` + `tools/<tool>/`. Renaming the
  top-level dir to `tools/` now would fight that layout.
- **`src/skills/` module path** — deferred; type/API renames deliver the
  contract without import-path churn.
- **`autonomy_action_log.skill_name` column** — leave the column name; app
  code may speak of “tool name” in comments. Avoids widening the DB migration
  to historical audit rows.
- MCP config file `config/skills.yaml` / `SkillsConfig` — optional clarify-later;
  it configures MCP *servers*, not atoms.

### Migration mechanics

**One-shot cutover** for manifests and the registry table:

1. Ship code that only reads `tool.json` and `tool_registry`.
2. Migration `ALTER TABLE skill_registry RENAME TO tool_registry` (plus
   trigger/function renames); copy row data in place via rename.
3. Operators with **custom** atoms must rename `skill.json` → `tool.json` in
   their deploy overlay and restart (same channel as today:
   `curia-deploy/custom/skills/`). Documented in CHANGELOG + adding-a-tool guide.

Dual-read was rejected: it prolongs the wrong vocabulary and risks silent
divergence between filenames.

ADR-022’s lifecycle model (install/enable/ghost, restart-based enforcement,
`registry-defaults.yaml` enrollment) is **unchanged** — only the atom naming
and table name are superseded. ADR-016’s decision to register MCP tools into
the shared runtime catalog remains; that catalog’s type is now `ToolRegistry`.

## Consequences

**Easier:**

- Phase 2 can introduce a real **skill** (bundle) store named `SkillRegistry`
  without colliding with the atom catalog.
- Operator/docs language matches Messages API + MCP (tool = atom) and Anthropic
  Agent Skills (skill = collection).
- Pre-1.0 open-core timing: cheapest moment for this public-API sweep.

**Harder / accepted:**

- Large mechanical PR (~117 manifests, registry/API/console, bus event types,
  docs). Custom overlays must rename manifests on upgrade. The loader logs an
  **error** (not a silent skip) when a directory still has `skill.json` and no
  `tool.json`, so an unmigrated custom atom fails loudly at startup.
- Historical `audit_log` rows retain old `skill.*` event-type strings and
  `payload.skillName`. **Readers dual-match:** `findToolResults` /
  `findByEventTypes`, activity-log, and antfarm interpret both vocabularies
  (`src/audit/legacy-tool-events.ts`). New writes use only `tool.*` /
  `toolName`. Bus permissions / live subscribers stay on the new names only
  (they never re-read historical rows).
- `autonomy_action_log.skill_name` column name is unchanged; app code maps
  `toolName` ↔ that column on write/read (coherent through the rename).
- `pinned_skills` still lists tools until Phase 2 — temporarily awkward naming
  that the follow-up phase corrects by changing pin targets, not the field.
