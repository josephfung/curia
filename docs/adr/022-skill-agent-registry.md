# ADR-022: DB-gated skill/agent registry

Date: 2026-06-09
Status: Accepted

## Context

Before this change, skills and agents loaded automatically from the filesystem at
startup. Any skill file present in the `skills/` directory was live — there was no
way to stage a skill, disable it without a deploy, or gate it on install-time setup
(e.g. configuring secrets or registering webhooks).

This created several problems:

- **All-or-nothing loading.** A skill shipped in a release became active immediately
  on every instance, regardless of whether the instance operator had completed the
  required setup.
- **No disable-without-deploy path.** Temporarily disabling a misbehaving skill
  required removing the file (a deploy) or blocking it in config (no such mechanism
  existed).
- **Security concern.** A skill file added to the repo (or uploaded to a running
  instance in a future operator flow) could self-activate — there was no gatekeeping
  layer between "exists on disk" and "receives calls."

The goal is a lifecycle model with four observable states:

- **Uninstalled** — on disk, no registry row → not loaded
- **Installed** — row present, `enabled = false` → not loaded, admin can enable
- **Enabled** — row present, `enabled = true` → loaded and callable
- **Ghost** — row present, file missing → row kept for audit but not loaded

## Decision

Two new tables — `skill_registry` and `agent_registry` — gate skill and agent loading.
Only items with an `enabled = true` row are registered at startup. State is derived from
the on-disk × row cross-reference.

**Core set.** A trusted in-repo file (`config/registry-defaults.yaml`) lists the skills
and agents that belong in every fresh install. The reconciliation step on startup enrolls
items from this list if they have no row yet (default `enabled = true`), without ever
overriding a row an admin has already set. The defaults live in the repo, not in
individual manifests — so an uploaded skill cannot self-enable by declaring itself a
default. Only items in the trusted in-repo file can self-enrol on startup.

**Enforcement is restart-based.** State changes (enable/disable) take effect on the next
process restart. No hot-reload in this PR; hot-reload is a larger change with ordering
and dependency concerns and is explicitly deferred.

**`install`/`uninstall` manifest blocks are parsed but inert in PR1.** `skill.json` and
agent YAML gain optional `install`/`uninstall` blocks (schema reserved for PR2: secrets
registration, and PR3: config schema). Parsers accept them now so existing manifests
compile unchanged; the execution layer ignores them until the follow-up PRs wire the
lifecycle hooks.

**`allowed_callers` validation.** The security check that verifies a calling agent is
known now considers all *discovered* agents (enabled or disabled) — not just enabled
ones. This prevents a skill's manifest from failing validation just because the agent
listed in `allowed_callers` is currently disabled.

**Alternatives considered:**

- **Config-file gating** (a YAML allowlist in `default.yaml`). Rejected because it
  conflates deployment config with per-instance operator state, and because the file
  lives on disk rather than in the DB where it can be changed without a file edit.
- **Auto-load with a runtime kill switch** (a `disabled_skills` set in DB). Rejected
  because it keeps the load path all-or-nothing and doesn't model the installed-but-not-
  enabled state needed for the PR2/PR3 lifecycle hooks.

## Consequences

**Easier / safer:**

- Skills and agents can be disabled without a deploy. An admin flips a DB row; the
  next restart drops the item.
- A new skill file on disk doesn't become callable until an admin explicitly enables it.
  Uploaded skills (future operator flow) cannot self-activate.
- The four states (uninstalled / installed / enabled / ghost) make operator-visible status
  legible in the Settings UI.

**Accepted trade-offs / risks:**

- **Adds two tables and a reconciliation step to startup.** The reconciliation is a cheap
  read-then-upsert pass over the core set; it adds negligible startup time but is an
  additional DB dependency at boot.
- **Existing prod deployments are migrated by backfill.** `scripts/backfill-registry-enable-all.ts`
  inserts enabled rows for every skill and agent currently on disk, preserving the
  pre-registry behaviour (everything that was loaded before is still loaded after). The
  backfill is a one-shot script; it must be run before the first restart on the new code.
- **A disabled-but-pinned skill is silently dropped from an agent's toolset.** If an
  agent's `pinned_skills` references a disabled skill, that skill is absent from the
  tool list. A `warn`-level log entry is emitted; the agent is not blocked from starting.
- **State changes are restart-gated.** Operators enabling or disabling a skill must
  restart the process. Hot-reload is explicitly deferred and tracked as a follow-up.
