# scheduler-update skill — resume / pause / edit scheduled jobs from an agent

**Issue:** #1409
**Status:** implemented, pre-PR

## Context

The CEO asked Curia to unsuspend some scheduled jobs. The coordinator replied it had
"no resume/unsuspend tool — the only way to resume these is through the web UI" and
handed over links. That was accurate: agents had `scheduler-create`, `scheduler-list`,
`scheduler-cancel`, `scheduler-report` and nothing to resume, pause, or edit a job.

Jobs auto-enter a held state two ways, neither previously agent-reversible:
- `suspended` after 3 consecutive failures (`SUSPEND_THRESHOLD`).
- `paused` by the drift detector.

The mutations already existed server-side (`unsuspendJob`, `updateJob` in
`src/scheduler/scheduler-service.ts`) but were wired only to the web UI's
`PATCH /api/jobs/:id`. This closes that agent-facing gap.

## Design

One unified `scheduler-update` skill with an `action` discriminator —
`resume | pause | edit` — rather than three sibling skills. Rationale: all three are
reversible, `action_risk: low` internal-state writes, so the usual reason to split
(different risk gates) doesn't apply; and it mirrors the web PATCH handler that already
unifies resume + edit.

**`scheduler-cancel` stays separate** (deliberately not subsumed): cancel is a terminal
delete, it's special-cased by name in `approval-notification.ts`, and it already ships
in prod. Keeping it separate preserves the clean `create → update → cancel` lifecycle
and mirrors the web API's PATCH-vs-DELETE split.

**Drift policy:** `resume` releases both `suspended` and `paused` (drift) jobs via the
existing `unsuspendJob`. No extra notification on resume — the CEO was already notified
when the drift pause fired.

## Changes

- `src/scheduler/scheduler-service.ts` — extract the shared pause CTE into a private
  `setPaused(jobId)`; `pauseJobForDrift` now delegates to it (behavior unchanged); add
  neutral `pauseJob(jobId)` for operator-initiated pause.
- `skills/scheduler-update/{skill.json,handler.ts}` — new skill; handler dispatches
  `resume → unsuspendJob`, `pause → pauseJob`, `edit → updateJob` (rejects edit with no
  field, normalizes whitespace-only schedule strings like the PATCH handler).
- `config/registry-defaults.yaml` + `agents/coordinator.yaml` — enable and pin the skill;
  bump coordinator `version` 0.11.6 → 0.12.0; add a prompt note so the coordinator reaches
  for it instead of pointing at the web UI.
- Tests: `tests/unit/scheduler/scheduler-service.test.ts` (`pauseJob`),
  `tests/unit/skills/scheduler-update.test.ts` (all actions + guards).
- `CHANGELOG.md` — Added entry.

Not touched: HTTP routes, DB schema (`status` is free-text TEXT; `paused`/`pending`
already valid), drift detector, existing scheduler skills.

## Verification

- `pnpm run typecheck` (core/skills/tests projects) clean.
- 775 scheduler + skills unit tests pass, including the capability-gate loader test.
- End-to-end: drive the coordinator (or invoke the skill) against a `suspended`/`paused`
  job in a dev DB — confirm resume flips it to `pending` with recomputed `next_run_at`,
  pause holds job + task, edit changes cron/run_at/payload, and the coordinator acts
  instead of returning web links.

## Prod rollout note

Even though it's in `registry-defaults.yaml`, confirm `scheduler-update` is enabled in the
prod `skill_registry` after deploy (new skills don't auto-enroll on existing installs).
