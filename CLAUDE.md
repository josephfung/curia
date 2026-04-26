# Curia — Claude Code Instructions

## Project Overview

Curia is a multi-agent AI platform for executives. Architecture specs are in `docs/specs/`. Read `docs/specs/00-overview.md` first for the full picture.

## Architecture

Five layers connected by a message bus. Four domain layers have hard security boundaries; the fifth (System) is for trusted cross-cutting infrastructure.

- **Channel Layer** — translates platform messages (Signal, Email, etc.) into normalized bus events
- **Dispatch Layer** — routes messages to agents, enforces policy, translates responses back
- **Agent Layer** — LLM-powered agents with isolated memory scopes
- **Execution Layer** — runs skills (local or MCP), validates permissions, sanitizes outputs
- **System Layer** — trusted infrastructure with full pub/sub access (audit logger, scheduler)

Cross-cutting: Audit Logger, Memory Engine, Scheduler.

## Code Conventions

### TypeScript
- ESM only (`"type": "module"`, `.js` extensions on all relative imports)
- Node 22+, use `import.meta.dirname` instead of `__dirname`
- No `any` — use proper types, generics, or discriminated unions
- All event types defined as discriminated unions in `src/bus/events.ts`
- All errors normalized to `AgentError` type (see `docs/specs/05-error-recovery.md`)

### Database
- PostgreSQL 16+ with pgvector
- Parameterized queries only — never interpolate variables into SQL strings
- Migrations in `src/db/migrations/` using node-pg-migrate (plain SQL)

**Migration numbering — rebase hazard:** Two branches landing at the same time will often pick the same next number (e.g. both create `019_*`). `node-pg-migrate` sorts alphabetically within a prefix, so a duplicate prefix causes a `checkOrder` error on startup and takes down prod. **After every rebase and before every merge, `ls src/db/migrations/ | sort` and verify every prefix is unique.** If there's a collision, renumber the newer migration to the next available slot — do not rename the one that prod has already applied.

### Error Handling
- No empty `catch {}` blocks — every catch must log, audit, and propagate
- Use structured `AgentError` types, not string matching
- Skills return `{ success: true, data }` or `{ success: false, error }` — never throw

### Logging
- pino for all logging (structured JSON)
- No `console.log` anywhere — enforced by lint rule
- Log levels: error, warn, info, debug

### Testing
- Vitest for unit and integration tests
- Integration tests use real Postgres (via Docker), not mocks
- Tests live next to the code they test, or in `tests/unit/` and `tests/integration/`

## Key Files

- `src/index.ts` — bootstrap orchestrator, wires everything in dependency order
- `src/bus/events.ts` — event type registry (discriminated union), source of truth
- `src/bus/permissions.ts` — layer-to-event authorization map (security boundary)
- `agents/*.yaml` — agent configuration files
- `skills/*/skill.json` — skill manifests
- `config/default.yaml` — base configuration

## Adding Things

### New Channel Adapter
1. Create `src/channels/<name>/` implementing `ChannelAdapter` interface
2. Register as `layer: "channel"` with the bus
3. Add config section to `config/default.yaml`
4. Write tests

### New Skill
1. Create `skills/<name>/skill.json` (manifest) + `handler.ts`
2. Declare permissions and secrets in the manifest
3. Write `handler.test.ts`

### Autonomy Awareness

When adding a new skill, declare its action risk in `skill.json`. This field is **required** — Phase 2 will reject manifests that omit it at startup:

```json
"action_risk": "medium"
```

Values by capability class:
- `"none"` — reads, retrieval, summarization (no external effect; min score 0)
- `"low"` — internal state writes, memory, contacts (min score 60)
- `"medium"` — outbound communications (min score 70)
- `"high"` — calendar writes, commitments on behalf of CEO (min score 80)
- `"critical"` — financial / destructive / irreversible actions (min score 90)

A raw number (0–100) may be used for precision. Numbers outside [0, 100] produce a validation error at skill load time.

When adding a new agent, ensure it receives the autonomy block via the runtime injection mechanism (same pattern as date/timezone injection — pass `autonomyService` in `AgentRuntime` config if the agent needs autonomy awareness). See `docs/specs/14-autonomy-engine.md`.

### New Agent
1. Create `agents/<name>.yaml` with required fields (name, description, model, system_prompt)
2. Optionally add `handler: ./<name>.handler.ts` for custom logic

## Architecture Decision Records (ADRs)

ADRs live in `docs/adr/`. Each ADR documents a significant architectural decision — the context, the choice made, and the consequences.

**When to write an ADR:** If the spec or plan you're working on contains a major architectural decision — a choice between fundamentally different approaches, a new external dependency that shapes the system, or a deliberate trade-off with long-term consequences — write an ADR before or alongside the implementation. Use `docs/adr/template.md`.

Examples that warrant an ADR:
- Choosing one technology over another (database engine, external API, messaging pattern)
- A new design pattern or abstraction that other components will follow
- Explicitly rejecting an approach that seems obvious (document why)
- A breaking change to a public API surface with a stated rationale

Examples that do NOT need an ADR:
- Adding a new skill or agent using existing patterns
- Bug fixes
- Routine dependency updates

Add a row to `docs/adr/README.md` for every new ADR.

## WIP Artifacts (Plans & Designs)

All timestamped work artifacts — implementation plans and design specs — live in `docs/wip/`. This overrides the default superpowers skill behavior:

- **Spec docs** (design documents): `docs/wip/YYYY-MM-DD-<feature>-design.md`
- **Plan docs** (implementation plans): `docs/wip/YYYY-MM-DD-<feature>.md`

Do **not** create `docs/superpowers/`, `docs/plans/`, or `docs/specs/designs/` — those directories no longer exist. All new WIP artifacts go directly in `docs/wip/`.

## Changelog & Versioning

### Every PR must update CHANGELOG.md

Add entries under `## [Unreleased]` before creating the PR. Exception: the release PR
itself (see *Preparing a release* below) doesn't need a separate CHANGELOG entry — the
new release heading is the record.

Use these sections as needed:
- **Added** — new skills, agents, channels, specs, or features
- **Changed** — behavior changes to existing functionality
- **Fixed** — bug fixes
- **Removed** — deleted features or files
- **Security** — security fixes or hardening

One bullet per logical change. Lead with the **feature name in bold**, then a brief description.
Reference spec numbers where relevant (e.g. "spec 14").

### When to bump the version number

**Do not bump the version during regular commits or PRs.** All in-progress work accumulates in CHANGELOG under `## [Unreleased]`. The version is bumped only when deliberately cutting a release — see *Preparing a release* below.

When cutting a release, use this table to determine the bump size:

| Change type | Bump | Examples |
|---|---|---|
| New skill, agent, or channel | **minor** (`0.X.0`) | Adding `web-search`, adding Signal channel |
| New spec shipped for the first time (brand-new capability) | **minor** (`0.X.0`) | Autonomy engine shipped, entity context enrichment |
| Completing a partially-shipped spec or feature | **patch** (`0.x.Y`) | Context summarization completing §01-memory-system.md |
| Bug fix, small improvement, doc-only | **patch** (`0.x.Y`) | Fixing a skill error path, updating a guide |
| Breaking change to public API surface | **minor** + note in changelog | Renaming a `SkillContext` field, changing `skill.json` schema |

**Public API surfaces** (changes here must be called out explicitly in the changelog even pre-1.0):
- `skill.json` manifest schema (fields, types, required/optional)
- `SkillHandler` / `SkillContext` / `SkillResult` TypeScript interfaces
- Agent YAML schema (`agents/*.yaml` fields)
- Bus event type definitions (`src/bus/events.ts`)
- Channel adapter interface

**1.0.0** is reserved for when these surfaces are stable enough to commit to — do not bump to
1.0.0 without explicit discussion. The milestone is API stability + production deployment,
not just "it works."

### Preparing a release

A release is a deliberate, standalone step — separate from day-to-day PR work. Follow these steps in order.

**1. Read the unreleased changes**

Open `CHANGELOG.md` and review all entries under `## [Unreleased]`. Read for themes: what capabilities shipped, what was fixed, what changed under the hood.

**2. Name the release and determine the version bump**

Pick a short, evocative release name that captures the dominant theme (e.g. "Memory Stabilization", "Autonomy Foundations", "Signal Clarity"). Keep it dignified — not whimsical, not corporate.

Use the bump table above to determine the version bump. If the unreleased batch mixes types, the highest applicable bump wins (any minor → minor; all patches → patch).

**3. Update CHANGELOG.md**

- Create a new heading immediately after `## [Unreleased]`:
  ```
  ## [X.Y.Z] — Release Name — YYYY-MM-DD
  ```
- Move all `[Unreleased]` bullets under it. Leave `## [Unreleased]` in place above it, empty, ready for the next batch.
- Condense and group the bullets — aim for clarity over completeness. Merge related entries, cut implementation detail, and make it readable to someone who uses Curia but didn't write the code. The CHANGELOG is a reader document, not a commit log.

**4. Update version numbers**

- `package.json` → `"version": "X.Y.Z"`
- `README.md` → update any version badge or version reference

**5. Generate a release haiku**

Write a haiku thematically aligned with the release — drawn from the changes, the fixes, the dominant mood. It should feel like a small hidden gift at the end of the release notes, not a gimmick. Tone: quiet, precise, a little wry.

**6. Open a release PR**

- Branch: `chore/release-X.Y.Z`
- PR title: `chore: release vX.Y.Z — Release Name`
- PR body: the new CHANGELOG section, followed by the haiku
- No other code changes — this PR is the release commit only
- Watch CI; wait for merge before proceeding

**7. After merge: tag and publish**

Once the release PR is merged, fetch and tag the merge commit:

```bash
git -C /path/to/repo fetch origin main
git -C /path/to/repo pull origin main
git -C /path/to/repo tag -a vX.Y.Z -m "vX.Y.Z — Release Name"
git -C /path/to/repo push origin vX.Y.Z
```

Then create a GitHub release (`gh release create`):
- **Title:** `vX.Y.Z — Release Name`
- **Tag:** `vX.Y.Z`
- **Body:** rewrite the CHANGELOG bullets into natural, friendly prose — past tense, as if narrating what changed. Prioritize what a user of Curia would care about. Close with a horizontal rule and the haiku.

## Scope Discipline

- Fix what was asked. Don't refactor surrounding code.
- If you spot issues nearby, mention them — don't touch them.
- No drive-by type annotations on code you didn't change.
