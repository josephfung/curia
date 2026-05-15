# Design: Move ceo-inbox agent and skills into curia core

**Date:** 2026-05-14
**Issue:** josephfung/curia#592
**Branch:** feat/ceo-inbox-to-core

## Problem

The `ceo-inbox` agent and its 9 skills currently live in `curia-deploy/custom/`. This splits
CI coverage, causes type stub drift, and makes the skills untestable within curia's own suite.
These skills depend on bullpen, signal-send, memory, entity-context, and contact-register — all
first-class curia services — so they belong in core.

## What moves

**Agent:**
- `curia-deploy/custom/agents/ceo-inbox.yaml` → `curia/agents/ceo-inbox.yaml`

**Shared library:**
- `curia-deploy/custom/skills/_lib/nylas-client.ts` → `curia/skills/_shared/ceo-nylas-client.ts`
  - Renamed to avoid collision with the core `nylas-client.ts` used by the email channel
  - Content unchanged — the Logger interface already matches curia's pino pattern

**9 skills (each `skills/<name>/` directory moves wholesale):**
- `ceo-inbox-list` (has handler.test.ts)
- `ceo-inbox-read`
- `ceo-inbox-archive`
- `ceo-inbox-draft-reply` (has handler.test.ts)
- `ceo-inbox-mark-read`
- `ceo-inbox-label`
- `ceo-inbox-search`
- `ceo-inbox-download-attachment` (has handler.test.ts)
- `ceo-inbox-update-folders`

**Deleted from curia-deploy:**
- `curia-deploy/custom/skills/_lib/types.ts` — superseded by `curia/src/skills/types.ts`
- All 9 `ceo-inbox-*` skill directories from `curia-deploy/custom/skills/`
- `curia-deploy/custom/agents/ceo-inbox.yaml`

## Import updates

Every `handler.ts` (and `handler.test.ts` where present) has exactly two import lines to update:

| Old (curia-deploy) | New (curia) |
|---|---|
| `from '../_lib/types.js'` | `from '../../src/skills/types.js'` |
| `from '../_lib/nylas-client.js'` | `from '../_shared/ceo-nylas-client.js'` |

`ceo-inbox-label` additionally imports a named type (`NylasFolder`) from `nylas-client.js` — same
path update applies.

No other changes to handler logic, `skill.json` manifests, or the agent YAML.

## What does NOT change

- `skill.json` manifests — already schema-compatible with curia's `SkillManifest`
- The Nylas client implementation — continues using `fetch()` directly against the Nylas v3 REST
  API, intentionally isolated from the core `NylasClient`/Nylas SDK that serves channel accounts
- The agent's `pinned_skills` — all 10 non-inbox skills it pins already exist in `curia/skills/`
- Required secrets (`nylas_api_key`, `ceo_nylas_grant_id`, `nylas_self_email`) — declared in
  `skill.json`, resolved at runtime

## Test coverage

curia's `vitest.config.ts` already includes `skills/**/*.test.ts`, so the 3 migrated test files
will be picked up automatically with no config changes.

## Acceptance criteria

- All 9 `ceo-inbox-*` skills appear in skill loader output at startup
- `ceo-inbox` agent appears in agent registry at startup
- 15-minute schedule is registered by the scheduler service
- `pnpm typecheck` passes clean
- Full test suite passes (no regressions)
- `curia-deploy` no longer contains any `ceo-inbox-*` skill directories or the `ceo-inbox.yaml` agent
