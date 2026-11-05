# Curia — Claude Code Instructions

## Project Overview

Curia is a multi-agent AI platform for executives. Architecture specs are in `docs/specs/`. Read `docs/specs/00-overview.md` first for the full picture.

## Architecture

Five layers connected by a message bus. Four domain layers have hard security boundaries; the fifth (System) is for trusted cross-cutting infrastructure.

- **Channel Layer** — translates platform messages (Signal, Email, etc.) into normalized bus events
- **Dispatch Layer** — routes messages to agents, enforces policy, translates responses back
- **Agent Layer** — LLM-powered agents that read and write a shared knowledge graph
- **Execution Layer** — runs skills (local or MCP), validates permissions, sanitizes outputs
- **System Layer** — trusted infrastructure with full pub/sub access (audit logger, scheduler)

Cross-cutting: Audit Logger, Memory Engine, Scheduler.

## Code Conventions

### TypeScript
- ESM only (`"type": "module"`, `.js` extensions on all relative imports)
- Node 26+, use `import.meta.dirname` instead of `__dirname`
- **CommonJS packages: use the default import** (`import webpush from 'web-push'`, then read names off it). Node exposes a CommonJS package's named exports only when its static detection finds them (it finds web-push's `WebPushError` but not `generateVAPIDKeys`), so a named import is a guess, and the default import always works. Vitest's interop accepts a named import that Node's own loader rejects, so it passes every test and crashes the built app at startup (#2410). CI's `check:dist-imports` step loads the built bundle's imports with plain Node to catch it; run `pnpm exec tsup src/index.ts --format esm --no-dts && pnpm run check:dist-imports` locally when you add a dependency.
- No `any` — use proper types, generics, or discriminated unions
- All event types defined as discriminated unions in `src/bus/events.ts`
- All errors normalized to `AgentError` type (see `docs/specs/05-error-recovery.md`)

### Type Checking

Always run `pnpm -C <worktree> run typecheck` (not raw `tsc --noEmit`) —
CI uses `pnpm run typecheck` which may resolve a different tsconfig chain than
a bare `tsc` invocation. Run this before every commit that touches `.ts` files.

What it covers: `src/`, `skills/`, `tests/` and `scripts/` (four tsconfig
projects) plus **every workspace package** under `apps/*` and `packages/*`, via
`pnpm -r run typecheck`. No workspace package needs checking separately, and new
ones are picked up automatically — they only need their own `typecheck` script,
which `tests/unit/workspace-typecheck-coverage.test.ts` requires of any package
shipping `.ts` sources (`pnpm -r` silently *skips* a package that lacks the
script, so that test is what keeps the skip loud).

The root projects have the mirror-image failure mode: a file in no project at
all is checked by nothing and reports green forever (that was `scripts/**` and
`vitest.config.ts`, with 13 live errors, until #1729).
`tests/unit/root-typecheck-coverage.test.ts` keeps that loud too — it fails if
any TypeScript file outside the workspace packages is absent from every root
project. A new top-level tree therefore needs a home in a tsconfig on day one.

Non-test files under `scripts/**` live in `tsconfig.scripts.json`, which keeps
the base project's strict settings — they are maintenance tools run against
production. `scripts/**/*.test.ts` and `vitest.config.ts` are in
`tsconfig.tests.json` with the relaxations mock-heavy test code needs.

What it does **not** cover, so don't read the green as total:

- `apps/*/vite.config.ts` — reachable only through a project reference, and
  plain `tsc --noEmit` does not build references (that needs `tsc -b`).

Use `-C`, not `--prefix`: for pnpm (unlike npm) `--prefix` sets only the install
location, so workspace resolution still comes from the process CWD and can
resolve the wrong workspace entirely.

### Strict TypeScript Patterns

Two patterns that pass local checks but fail CI regularly:

- **Array element access** — `array[0]` on `mock.calls`, `result.rows`, etc.
  is `T | undefined` under strict null checks. Use non-null assertion (`array[0]!`)
  when the element is guaranteed to exist, or destructure with a guard.

- **Narrowing from `Record<string, unknown>`** — after runtime validation, casting
  `Record<string, unknown>` directly to a typed interface fails if the interface
  has required properties. Cast through `unknown` first:
  `obj as unknown as MyInterface` (with a comment noting the runtime check above).

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
- No `console.log` in backend code (`src/`, `tests/`) — enforced by the `no-console` lint rule
- The browser apps under `apps/` are exempt: pino is a Node logger, so `no-console` is
  deliberately not set on their `eslint.config.js` block. Antfarm has `clientWarn`
  (`apps/antfarm/src/client-log.ts`); the console app uses `console.error` directly
- Log levels: error, warn, info, debug

### Testing
- Vitest for unit and integration tests
- Integration tests use real Postgres (via Docker), not mocks
- Unit tests for `src/` live in `tests/unit/` (mirror the source tree). Integration tests live in `tests/integration/`. Skill handler tests stay beside the skill; app tests stay in the app package.
- **The behavior suites (`pnpm smoke`, `pnpm scenarios`) cost money and are the release gate** (see "Behavior gate" below), not a development check. Every run bills real model calls, agents plus the judge, and day-to-day runs added up to hundreds of dollars a month. While developing, rely on unit and integration tests. Run a suite only when the change is to a prompt or a behavior, and then:
  - run only the cases the change touches (`--case`, `--tags`), with few runs;
  - compare against saved baseline transcripts rather than re-running a `main` arm;
  - get the maintainer's agreement first, stating the cases, the run count and the estimated cost, and report the summary's spend afterwards;
  - never run a full suite mid-branch to check that nothing else broke. That is the release gate's job.

### pnpm-workspace.yaml — do not edit during worktree setup

**Never edit `pnpm-workspace.yaml` to resolve `pnpm install` output about build script approvals.** The `allowBuilds` values are already correct in the repo. When `pnpm install` warns about packages needing build approval, those warnings are informational — the existing entries handle them. If pnpm adds a new entry for a genuinely new dependency, set its value explicitly to `true` or `false` (never placeholder text). A pre-commit hook enforces this: any `allowBuilds` value that is not a boolean will block the commit.

If you need to approve new build scripts interactively, use `pnpm approve-builds` — do not hand-edit this file.

### Dependency overrides live in pnpm-workspace.yaml — NOT package.json

**pnpm v10+ reads the `overrides` map only from `pnpm-workspace.yaml`. A `pnpm.overrides` block in `package.json` is silently ignored** — no warning, no error, it just does nothing. (We learned this the hard way: five security pins sat dead in `package.json` and only "worked" because natural resolution happened to satisfy their floors.) The same applies to other `package.json#pnpm.*` settings such as `onlyBuiltDependencies`, which is superseded by `allowBuilds` here.

When you need to pin a transitive dependency (e.g. to clear a CVE), add it to the `overrides:` block in `pnpm-workspace.yaml`, run `pnpm install`, and confirm the change actually took effect: the regenerated lockfile must contain a top-level `overrides:` section and `pnpm why <pkg>` must show the forced version. If `pnpm install` reports "Already up to date" after editing an override, pnpm did not see your change — you almost certainly edited the wrong file.

## Key Files

- `src/index.ts` — bootstrap orchestrator, wires everything in dependency order
- `src/bus/events.ts` — event type registry (discriminated union), source of truth
- `src/bus/permissions.ts` — layer-to-event authorization map (security boundary)
- `agents/*.yaml` — agent configuration files
- `skills/<bundle>/tools/<tool>/tool.json` — tool manifests in a bundle (most tools); `skills/<tool>/tool.json` for standalone tools
- `config/default.yaml` — base configuration

## Adding Things

### New Channel Adapter
1. Create `src/channels/<name>/` implementing the `Channel` interface from `src/channels/channel.ts` (`name`, `isToggleable`, `start()`, `stop()`)
2. Add a `ChannelDescriptor` to `src/channels/catalog.ts` (credential fields + required secret keys)
3. Add `src/channels/<name>/outbound-request.ts` (the channel's `OutboundSendRequest` variant) and export `principal-rules.ts` with `PrincipalChannelRules`: identity comparator, `extractRecipients` (principal-eligible vs never-principal ids — group/conversation ids must be never-principal), and optional Gate C `carveoutSkill`. Append the contribution to `src/contacts/principal-channel-registry.ts` — omit `carveoutSkill` to fail closed for Gate C (ADR-034, ADR-035). Recipient projection for principal tagging needs **no** edit to `src/skills/outbound-gateway.ts`.
4. Re-export the new request variant into the `OutboundSendRequest` union in `outbound-gateway.ts` and add delivery dispatch (`OutboundGatewayConfig` client + `dispatch<Channel>()` + `send()` branch) when the channel sends externally
5. Register as `layer: "channel"` with the bus
6. Add config section to `config/default.yaml`
7. Write tests (include never-principal fields in `extractRecipients` tests)

### New Tool
1. Create `tool.json` (manifest) + `handler.ts` — inside a bundle at `skills/<bundle>/tools/<name>/` and listed in that bundle's `SKILL.md`, or standalone at `skills/<name>/`. A tool listed in an enabled bundle's `SKILL.md` is enrolled in the registry on the next boot; a standalone tool starts disabled unless `config/registry-defaults.yaml` `tools:` lists it (#1974)
2. Declare permissions and secrets in the manifest
3. Write `handler.test.ts`
4. **Pin it to at least one agent.** Prefer pinning a **skill bundle** (`pinned_skills: [calendar]`) so the agent gets the whole toolset + any SKILL.md instructions. For singleton tools still living at `skills/<tool>/`, pin the tool name (auto-wrapped as a singleton skill). A tool that isn't reachable via any pinned skill is invisible unless discovery surfaces it. Exception: pure infrastructure tools invoked by the system (e.g. `extract-facts`, `extract-relationships`, `scheduler-report`) intentionally have no agent owner.
5. **Timestamps:** When a skill returns timestamps for user-facing display, use `toLocalIso()` from `src/time/timestamp.ts` to convert to the user's local timezone (available as `ctx.timezone`). Never return raw UTC Z-suffix strings for times the user will see — LLMs cannot reliably perform timezone conversion. Include `displayTimezone: formatDisplayTimezone(ctx.timezone)` in the result data so the LLM can label its output.

### Versioning skills and agents

**Do not bump `version` in a PR.** Not in `tool.json`, `skills/<bundle>/SKILL.md` or `agents/<name>.yaml`. Two parallel PRs that each bump the same file collide, and the bump says nothing the diff does not. The release PR does it once, for every skill and agent that changed since the last tag: run `pnpm bump:versions` (a dry run against the latest `v*` tag), review the list, then `pnpm bump:versions --write` and commit the result with the other release-PR version changes.

- The script raises the **patch** version of every agent, tool (any non-test file in its directory) and bundle `SKILL.md` that differs from the last tag. It skips a file whose version already differs from the tag's, so it is safe to re-run and never overrides a deliberate bump.
- For a **minor** bump (new capability, new input/output field, new pinned skill), edit the version by hand in the release PR before running the script; it leaves that file alone.
- New skill or agent → start at `"0.1.0"`. That is the one hand-set version a feature PR carries; the script skips files that are new since the tag.
- `skills/_shared/` is not tracked by the script. A change there does not bump the tools that import it.

The version is surfaced in structured logs, the registry listing and the tool-execution audit row (`toolVersion`), and is useful for correlating prod behaviour with a known config state. Nothing in the runtime requires it to move per PR. Tests may assert a version floor (valid semver, not below a given release) but must not pin an exact version: an exact pin forces every PR touching that agent to edit the test.

### Autonomy Awareness

When adding a new skill, declare its action risk in `tool.json`. This field is **required** — manifests that omit it are rejected at startup, and the execution layer enforces it against the live autonomy score:

```json
"action_risk": "medium"
```

Values by capability class:
- `"none"` — reads, retrieval, summarization (no external effect; min score 0)
- `"low"` — internal state writes, memory, contacts (min score 60)
- `"medium"` — outbound communications (min score 70; a send to the principal alone is exempt, #2337)
- `"high"` — calendar writes, commitments on behalf of CEO (min score 80)
- `"critical"` — financial / destructive / irreversible actions (min score 90)

A raw number (0–100) may be used for precision. Numbers outside [0, 100] produce a validation error at skill load time.

When adding a new agent, ensure it receives the autonomy block via the runtime injection mechanism (same pattern as date/timezone injection — pass `autonomyService` in `AgentRuntime` config if the agent needs autonomy awareness). See `docs/specs/14-autonomy-engine.md`.

### New Agent
1. Create `agents/<name>.yaml` with required fields (name, description, model, system_prompt)
2. Optionally add `handler: ./<name>.handler.ts` for custom logic

### Fixing agent behavior

Don't append a paragraph to `system_prompt`. Put the rule on the highest rung that works: code enforcement → injection with its trigger → tool description → lazy playbook → always-on prompt. See [ADR-046](docs/adr/046-agent-behavior-fix-placement.md). `tests/unit/agents/prompt-budget.test.ts` fails CI when a budgeted agent's always-on prompt or local tool definitions grow past budget — the coordinator plus calendar, ceo-inbox, contacts and meeting-debrief (#2025). Prefer a behavioral test (scenario, smoke, or a unit test of the code) over one that pins prompt text. Writing a case is free; running one is not (see Testing).

### Setup wizard — keep the catalog current

When adding a **significant new capability** — a new channel adapter, a new
third-party integration, a credential-requiring skill bundle, or a major skill
that changes what a new user would want to configure — check whether the setup
wizard catalog needs a matching entry:

- The catalog lives in `skills/setup/tools/setup-status/catalog.yaml`. It is the canonical
  list of "what a new user sets up" and is owned by the setup-wizard agent, not
  core.
- If your change adds a configurable capability, add a catalog entry with:
  - A `completion_check` (how setup-status detects it is done)
  - A `credential_how_to` summary (one-sentence inline guide)
  - A `docs_url` pointing to the relevant curia-docs page
- If the docs page does not exist yet, create it in `curia-docs` as part of
  shipping the capability — not as a follow-up.
- If your change **removes** or **renames** a capability, remove or update the
  catalog entry and its docs link.

Keeping the catalog current is part of shipping the capability, not a follow-up
task.

### Reaching the principal

The runtime injects a **`## Who you serve`** section into every agent's effective
system prompt on each task turn, ahead of the YAML body. Its **`### Principal Contact
Details`** block lists the principal's verified channel identities (email, Signal,
phone, etc.) loaded from `contact_channel_identities` at startup. They are
authoritative and labelled as such in the block.

To **send** to the principal, agents pass the reserved alias `principal` as the
recipient of `email-send`, `signal-send`, `sms-send` or `slack-send`, or in `email-reply`'s
`cc`; the skill looks the address up from those verified identities (#2033, #2131,
[ADR-047](docs/adr/047-send-skills-address-recipients-by-reference.md)). A model with
the right address in context still mistypes it, so no prompt or task payload should
ask an agent to copy the principal's address into a send skill. The block's values are
for tools that need a literal address.

The `${principal_contact_id}` placeholder is also injected at bootstrap by
`interpolateRuntimeContext()` for agents that reference it. Use the contact ID
when calling skills like `entity-context` to discover calendar IDs, timezone, or
other non-channel facts. Do not call `contact-lookup` by role for the principal —
the platform resolves the ID once at bootstrap.

For **other contacts** (third parties, external people), use `${principal_contact_id}`
with `entity-context` or resolve via the contacts specialist — do not hardcode
their addresses. Send skills and `email-draft-save` take the contact's UUID; there is no
raw-address path. Someone with no contact record is added first with `contact-create`,
which returns the UUID (#2041, ADR-047).

#### Where the placeholder resolves — and where it does not

Two places interpolate `${principal_contact_id}`:

- **Agent system prompts** — `interpolateRuntimeContext()` at bootstrap.
- **Scheduled-job payloads** — the scheduler, when it builds the `agent.task` content at
  fire time (#1800). One rule covers every job whatever created it: a `schedule:` block in
  `agents/*.yaml`, a `POST /api/jobs` request, and a `scheduler-create` call all land in
  the same `task_payload` column and fire through the same path.

Any *other* `${...}` token in a payload is left as literal text. The scheduler substitutes
nothing and logs a warning naming the token — inventing a value would be worse than the
agent seeing the token it was handed.

Everywhere else the token is inert text that the model reads as literal advice and copies
straight into tool arguments, where it is rejected as a non-UUID. In particular, **never
put `${...}` in a `tool.json`** — manifests are passed through verbatim to the model, and
`tests/unit/skills/manifest-placeholder-free.test.ts` fails the build if one appears.
Describe the value instead: "the principal's contact ID as given in your system prompt".

Skills that take a contact ID should reject a bare token with
`isUnresolvedPlaceholder()` / `unresolvedPlaceholderError()` from
`src/skills/_shared/placeholder-guard.ts`, so a model that gets this wrong is told what
actually went wrong rather than "must be a UUID".

## Creating Issues

When creating a new GitHub issue:

1. **Apply pre-existing labels** — query the repo's labels and apply all applicable ones. Never leave an issue uncategorized. Never invent new labels without asking.

2. **Add a size label** — every issue must have exactly one `size:` label estimating implementation effort:
   - `size:XS` — 0-9 lines (one-line fix, config change, adding a log statement)
   - `size:S` — 10-29 lines (small guard clause, simple bug fix, adding a warning)
   - `size:M` — 30-99 lines (moderate change, adding a field + migration, small feature)
   - `size:L` — 100-499 lines (new skill handler, moderate feature, refactor)
   - `size:XL` — 500-999 lines (significant feature, new agent, new service)
   - `size:XXL` — 1000+ lines (major feature, new system layer, multi-file epic)

   Estimate based on the implementation PR, ignoring generated files and tests. When in doubt, round up.

3. **Include acceptance criteria** — every issue must list specific, testable conditions that define when the work is done.

## Creating Pull Requests

Every PR that resolves a tracked issue must include `Closes #N` (or `Fixes #N`) in the PR body. GitHub uses this to auto-close the linked issue on merge. Include it in the Summary section.

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

### Every PR adds a changelog fragment — never edit CHANGELOG.md

Add one file, `changes/<branch-name>.md` (`/` in the branch name becomes `-`), before
creating the PR. Two PRs never touch the same file, so there are no changelog conflicts.
`pnpm changelog:assemble` merges the fragments into CHANGELOG.md at release time; format
details are in `changes/README.md`, and `tests/unit/changelog-fragments.test.ts` checks
every fragment. Exceptions: the release PR (the new release heading is the record) and
ADR-only or comment/TODO-only PRs that ship nothing.

The fragment holds the same headings and bullets CHANGELOG.md uses — no `## [Unreleased]`
heading. Use these sections as needed:
- **Added** — new skills, agents, channels, specs, or features
- **Changed** — behavior changes to existing functionality
- **Fixed** — bug fixes
- **Removed** — deleted features or files
- **Security** — security fixes or hardening

One bullet per logical change. Lead with the **feature name in bold**, then a brief description.

**Hard cap: 15 words maximum after the em-dash. A limit, not a target — count them.**
Say only *what* changed and its key consequence. The mechanism, root cause, and "how"
belong in the PR and commit body, never here. If it won't fit in 15 words, you're
keeping implementation detail — cut it. For example:

- **`extract-facts`** — programming errors in the per-fact loop now re-throw instead of silently incrementing `failed`. (#493)

Too long → trimmed:
- ✗ "…`verify-pgaudit.sh` probed the socket-only temp init server, racing `CREATE DATABASE`… so a fresh volume never created `curia`…"
- ✓ "…probe the real server over TCP so fresh volumes create `curia` instead of crash-looping."

Reference spec numbers where relevant (e.g. "spec 14").

### When to bump the version number

**Do not bump the version during regular commits or PRs.** All in-progress work accumulates as fragments in `changes/`. The version is bumped only when deliberately cutting a release — see *Preparing a release* below.

When cutting a release, use this table to determine the bump size:

| Change type | Bump | Examples |
|---|---|---|
| New skill, agent, or channel | **minor** (`0.X.0`) | Adding `web-search`, adding Signal channel |
| New spec shipped for the first time (brand-new capability) | **minor** (`0.X.0`) | Autonomy engine shipped, entity context enrichment |
| Completing a partially-shipped spec or feature | **patch** (`0.x.Y`) | Context summarization completing §01-memory-system.md |
| Bug fix, small improvement, doc-only | **patch** (`0.x.Y`) | Fixing a skill error path, updating a guide |
| Breaking change to public API surface | **minor** + note in changelog | Renaming a `ToolContext` field, changing `tool.json` schema |

**Public API surfaces** (changes here must be called out explicitly in the changelog even pre-1.0):
- `tool.json` manifest schema (fields, types, required/optional)
- `ToolHandler` / `ToolContext` / `ToolResult` TypeScript interfaces
- Agent YAML schema (`agents/*.yaml` fields)
- Bus event type definitions (`src/bus/events.ts`)
- Channel adapter interface

**1.0.0** is reserved for when these surfaces are stable enough to commit to — do not bump to
1.0.0 without explicit discussion. The milestone is API stability + production deployment,
not just "it works."

### Preparing a release

Use the **`release` skill** (`.claude/skills/release/SKILL.md`) — it covers the pre-flight
docs sync, security and behavior gates, naming, version bump, release PR, tag, GitHub
release and artifact verification, and assembling the changelog fragments. Load it when
asked to prepare or cut a release, run pre-release checks, or tag a version.

## Scope Discipline

- Fix what was asked. Don't refactor surrounding code.
- If you spot issues nearby, mention them — don't touch them.
- No drive-by type annotations on code you didn't change.
