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

### Type Checking

Always run `pnpm --prefix <worktree> run typecheck` (not raw `tsc --noEmit`) —
CI uses `pnpm run typecheck` which may resolve a different tsconfig chain than
a bare `tsc` invocation. Run this before every commit that touches `.ts` files.

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
- No `console.log` anywhere — enforced by lint rule
- Log levels: error, warn, info, debug

### Testing
- Vitest for unit and integration tests
- Integration tests use real Postgres (via Docker), not mocks
- Tests live next to the code they test, or in `tests/unit/` and `tests/integration/`

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
- `skills/*/skill.json` — skill manifests
- `config/default.yaml` — base configuration

## Adding Things

### New Channel Adapter
1. Create `src/channels/<name>/` implementing the `Channel` interface from `src/channels/channel.ts` (`name`, `isToggleable`, `start()`, `stop()`)
2. Add a `ChannelDescriptor` to `src/channels/catalog.ts` (credential fields + required secret keys)
3. Register as `layer: "channel"` with the bus
4. Add config section to `config/default.yaml`
5. Write tests

### New Skill
1. Create `skills/<name>/skill.json` (manifest) + `handler.ts`
2. Declare permissions and secrets in the manifest
3. Write `handler.test.ts`
4. **Pin it to at least one agent.** Add the skill name to `pinned_skills` in the relevant agent YAML (`agents/coordinator.yaml` for most skills). A skill that isn't pinned to any agent is invisible to that agent unless dynamic discovery happens to surface it — which is unreliable. Exception: pure infrastructure skills invoked by the system (e.g. `extract-facts`, `extract-relationships`, `scheduler-report`) intentionally have no agent owner.
5. **Timestamps:** When a skill returns timestamps for user-facing display, use `toLocalIso()` from `src/time/timestamp.ts` to convert to the user's local timezone (available as `ctx.timezone`). Never return raw UTC Z-suffix strings for times the user will see — LLMs cannot reliably perform timezone conversion. Include `displayTimezone: formatDisplayTimezone(ctx.timezone)` in the result data so the LLM can label its output.

### Versioning skills and agents

Bump the `version` field in `skill.json` (for skills) or the `version` field in `agents/<name>.yaml` (for agents) whenever you make a meaningful change:

- New skill or agent → start at `"0.1.0"`.
- New capability, new input/output field, new pinned skill → bump **minor** (`0.X.0`).
- Bug fix, prompt clarification, error message improvement → bump **patch** (`0.x.Y`).

The version is surfaced in structured logs and useful for correlating prod behaviour with a known config state. An unversioned file should get `"0.1.0"` as its first explicit version when you first touch it.

### Autonomy Awareness

When adding a new skill, declare its action risk in `skill.json`. This field is **required** — manifests that omit it are rejected at startup, and the execution layer enforces it against the live autonomy score:

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

### Reaching the principal

The runtime injects a **`## Principal Contact Details`** block into every agent's
effective system prompt on each task turn. The block lists the principal's verified
channel identities (email, Signal, phone, etc.) loaded from `contact_channel_identities`
at startup. Agents should use those values when they need to reach the principal —
they are authoritative and labelled as such in the block.

The `${principal_contact_id}` placeholder is also injected at bootstrap by
`interpolateRuntimeContext()` for agents that reference it. Use the contact ID
when calling skills like `entity-context` to discover calendar IDs, timezone, or
other non-channel facts. Do not call `contact-lookup` by role for the principal —
the platform resolves the ID once at bootstrap.

For **other contacts** (third parties, external people), use `${principal_contact_id}`
with `entity-context` or resolve via the contacts specialist — do not hardcode
their addresses.

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
Aim for one clause — what changed and the key consequence. Cut implementation detail; if it
needs more than ~15 words after the em-dash, it's too long. For example:

- **`extract-facts`** — programming errors in the per-fact loop now re-throw instead of silently incrementing `failed`. (#493)

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

Name each release after a sci-fi character whose nature embodies the dominant theme of the changes. Choose characters that readers are likely to know; draw from a broad canon (films, novels, games — not just one franchise). The fit should be genuinely tight, not forced. If no character fits well, defer to a short evocative phrase.

Use the bump table above to determine the version bump. If the unreleased batch mixes types, the highest applicable bump wins (any minor → minor; all patches → patch).

**3. Update CHANGELOG.md**

- Create a new heading immediately after `## [Unreleased]`:
  ```
  ## [X.Y.Z] — YYYY-MM-DD — "Character Name"
  ```
- Immediately below the heading, add a blockquote with the character's name, source (work + year + creator), and a brief statement about who they are and why the fit is apt:
  ```
  > **Character Name** *(Work, Year, creator)* — one or two sentences: who they are, what defines them, and why this release embodies that.
  ```
- Move all `[Unreleased]` bullets under it. Leave `## [Unreleased]` in place above it, empty, ready for the next batch.
- Condense and group the bullets — aim for clarity over completeness. Merge related entries, cut implementation detail, and make it readable to someone who uses Curia but didn't write the code. The CHANGELOG is a reader document, not a commit log.

**4. Update version numbers**

- `package.json` → `"version": "X.Y.Z"`
- `README.md` line 18 → update the shields.io badge URL (`version-X.Y.Z`) and its `alt` attribute (`Version: X.Y.Z`)

**5. Generate a release haiku**

Write a haiku thematically aligned with the release — drawn from the changes, the fixes, the dominant mood. It should feel like a small hidden gift at the end of the release notes, not a gimmick. Tone: quiet, precise, a little wry.

**6. Open a release PR**

- Branch: `chore/release-X.Y.Z`
- PR title: `chore: release vX.Y.Z — "Character Name"`
- PR body: the character blockquote, followed by the new CHANGELOG section, followed by the haiku
- No other code changes — this PR is the release commit only
- Watch CI; wait for merge before proceeding

**7. After merge: pre-release security gate**

Once the release PR is merged, `main` is the exact commit you are about to tag. Run the on-demand security scans against it and review the results **before** tagging. (Trivy fs, Semgrep, and Gitleaks already ran on the release PR; the gate below covers the scans that do *not* run on a normal push — the Docker image scan, a fresh CodeQL pass, and the repo-level Scorecard.)

```bash
gh workflow run trivy.yml     # on-demand Trivy image scan (base image + OS package CVEs)
gh workflow run codeql.yml    # fresh CodeQL security-extended pass (takes several minutes)
gh workflow run scorecard.yml # repo-level supply-chain posture
gh workflow run dast.yml      # OWASP ZAP passive DAST against the running HTTP API (slow: boots the full app)
# Wait for each to finish, then review results:
gh run list --limit 5
```

Review **GitHub → Security → Code Scanning** for the results of all scanners. **Block the release on any unresolved CRITICAL finding.** A HIGH is a judgment call — fix it or document why it's accepted (e.g. unreachable code path, no fix available) before proceeding.

The ZAP DAST scan (`zap-dast` category) is alert-only and review-only for now — until its first run is triaged into the `alertFilter` baseline in `.zap/plan.yaml`, its findings are informational and do not block a release. Once a triaged baseline exists (and `failOnError` flips), treat its unresolved CRITICALs the same as the other scanners.

**8. Tag and publish**

Confirm the merge landed, then tag `origin/main` directly (do not rely on local branch state — the release worktree is on `chore/release-X.Y.Z`, not `main`):

```bash
# Confirm the merge landed — grep must return a result before proceeding
git -C /path/to/repo fetch origin main
git -C /path/to/repo show origin/main:CHANGELOG.md | grep "X.Y.Z"

# Tag origin/main directly — no checkout or pull needed
git -C /path/to/repo tag -a vX.Y.Z -m "vX.Y.Z — Character Name" origin/main
git -C /path/to/repo push origin vX.Y.Z
```

Then write the release notes (open with the character blockquote; rewrite the CHANGELOG bullets into natural, friendly prose — past tense, as if narrating what changed; prioritize what a user of Curia would care about; close with a horizontal rule and the haiku) and create the GitHub release:

```bash
gh release create vX.Y.Z \
  --title 'vX.Y.Z — "Character Name"' \
  --notes "$(cat <<'EOF'
[character blockquote here]

[release prose here]

---

[haiku here]
EOF
)"
```

Tagging stays `git tag -a` (annotated, **unsigned**) — releases are signed at the artifact layer (step 9), not the tag.

**9. Verify release artifacts (SBOM + signatures)**

Publishing the release triggers `release.yml`, which generates an SPDX SBOM and a source tarball, signs both with cosign (keyless, via GitHub OIDC), and attaches all four files to the release. This step is **not optional and not silent** — the workflow fails loudly if anything is missing or a signature fails to verify (this is the fix for v0.34.0, which shipped with no SBOM because the old auto-attach skipped silently).

Confirm the workflow succeeded and the four assets are present:

```bash
gh run list --workflow=release.yml --limit 1   # must be green
gh release view vX.Y.Z --json assets --jq '.assets[].name'
# expect: sbom.spdx.json, sbom.spdx.json.sigstore, curia-vX.Y.Z.tar.gz, curia-vX.Y.Z.tar.gz.sigstore
```

If the run failed or assets are missing, re-run it (do **not** consider the release done until they are present):

```bash
gh workflow run release.yml -f tag=vX.Y.Z
```

Anyone can verify a downloaded artifact against the GitHub Actions OIDC issuer:

```bash
# The signer identity is release.yml in this repo. The ref after @ is the tag
# (refs/tags/vX.Y.Z) for a normally-published release, or refs/heads/main for a
# release whose artifacts were built via the workflow_dispatch backfill path
# (e.g. v0.34.0). The regexp below matches both; tighten the @ suffix if you
# know which path produced a given release.
cosign verify-blob --bundle sbom.spdx.json.sigstore \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/<owner>/curia/.github/workflows/release.yml@' \
  sbom.spdx.json
```

## Scope Discipline

- Fix what was asked. Don't refactor surrounding code.
- If you spot issues nearby, mention them — don't touch them.
- No drive-by type annotations on code you didn't change.
