# Autonomy Engine — Design Spec

**Date:** 2026-04-03
**Spec:** 12
**Status:** Draft

---

## Overview

A single global autonomy score (0–100) for the Nathan Curia instance that governs how
independently Nathan operates across all agents and skills. The score is CEO-controlled,
Postgres-persisted, and injected into the coordinator's system prompt on every task so
Nathan self-governs accordingly.

Phase 1 establishes the score, CEO read/write access, and behavioral prompt injection.
Phase 2 (future) will add automatic score adjustment driven by an action log.

---

## Background

The autonomy framework is derived from Gorick Ng's Competence / Commitment / Compatibility
model. A composite score maps to one of five autonomy bands, each with explicit behavioral
guidance. This spec covers the Phase 1 foundation only — the full scoring formula,
auto-adjustment rules, relationship signals, and gating engine are documented in the
source spec (to be filed at `docs/specs/designs/office-ceo-agent-scoring-spec.md`) and deferred to Phase 2.

**Why a single global score rather than per-agent or per-capability scoring?**
Nathan is a single deployed instance — there is no meaningful distinction between "Nathan's
email autonomy" and "Nathan's calendar autonomy" at this stage. A global score is
interpretable, adjustable, and directly tied to the CEO's lived trust in the system. Per-
capability scoring can be layered on top in Phase 2 once the global baseline is established.

---

## Autonomy Bands

| Band | Score Range | Label |
|---|---|---|
| Full | 90–100 | `full` |
| Spot-check | 80–89 | `spot-check` |
| Approval Required | 70–79 | `approval-required` |
| Draft Only | 60–69 | `draft-only` |
| Restricted | < 60 | `restricted` |

### Band Behavioral Descriptions

These descriptions are injected verbatim into the coordinator system prompt. They define
Nathan's self-governance posture at each band.

**Full (90–100)**
> Act independently. No confirmation needed for standard operations. Flag only genuinely
> novel, irreversible, or high-stakes actions — where the downside of acting without
> checking outweighs the cost of the pause.

**Spot-check (80–89)**
> Proceed on routine tasks. For consequential actions — sending external communications,
> creating commitments, or acting on behalf of the CEO — note what you're doing in your
> response so the CEO maintains visibility. No need to stop and ask.

**Approval Required (70–79)**
> For any consequential action, present your plan and explicitly ask for confirmation
> before proceeding. Routine reporting, summarization, and information retrieval can
> proceed without approval. When in doubt, draft and ask.

**Draft Only (60–69)**
> Prepare drafts, plans, and analysis, but do not send, publish, schedule, or act on
> behalf of the CEO without an explicit instruction to do so. Surface your work for review;
> execution requires a direct go-ahead.

**Restricted (< 60)**
> Present options and analysis only. Take no independent action. All outputs are advisory.
> Every step that would have an external effect requires explicit CEO instruction.

---

## Data Model

### `autonomy_config` — live state (single row)

```sql
CREATE TABLE autonomy_config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  score       INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band        TEXT NOT NULL,        -- derived label stored for query convenience
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL,        -- 'ceo' or 'system' (Phase 2+)
  CONSTRAINT single_row CHECK (id = 1)
);
```

The `CONSTRAINT single_row CHECK (id = 1)` enforces exactly one row at the database level.
Upserts use `ON CONFLICT (id) DO UPDATE`.

The `band` label is derived from `score` at write time and stored for readability — no need
to recompute on every read.

**Default starting value:** 75 (`approval-required`). This is a conservative starting point
that requires Nathan to confirm consequential actions. The CEO adjusts from here as trust
is established.

### `autonomy_history` — append-only audit trail

```sql
CREATE TABLE autonomy_history (
  id             BIGSERIAL PRIMARY KEY,
  score          INTEGER NOT NULL,
  previous_score INTEGER,           -- NULL on first write
  band           TEXT NOT NULL,
  changed_by     TEXT NOT NULL,
  reason         TEXT,              -- optional CEO note
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every write to `autonomy_config` appends a row here. This table is never updated or
deleted. It is the foundation Phase 2's auto-adjustment will write to when recording
score changes from the action log.

---

## Skills

Both skills are pinned to the coordinator agent only. They are not available to other agents.

### `get-autonomy`

- **Sensitivity:** normal
- **Inputs:** none
- **Behavior:** Queries `autonomy_config` for the current score and band, plus the last
  3 rows from `autonomy_history`. Returns a human-readable summary Nathan relays to
  the CEO.
- **Example output:**
  ```
  Autonomy score: 75 — Approval Required

  At this level, I'll confirm before taking consequential actions like sending email
  or creating commitments, but can proceed independently on research and summarization.

  Recent changes:
    2026-04-03  75  (approval-required)  "starting point"  — ceo
  ```

### `set-autonomy`

- **Sensitivity:** elevated (requires `CallerContext` with `role: "ceo"`)
- **Inputs:** `score` (integer 0–100), `reason` (string, optional)
- **Behavior:**
  1. Validates `score` is in range [0, 100]
  2. Reads current score from `autonomy_config`
  3. Derives new `band` label from `score`
  4. Upserts `autonomy_config`
  5. Appends to `autonomy_history` with `previous_score`, `changed_by: "ceo"`, and
     the optional `reason`
  6. Returns confirmation with old score → new score and band label
- **Caller verification:** Uses the same elevated-skill gate from PR #65. Any invocation
  without a valid CEO `CallerContext` fails closed.

---

## Prompt Injection

The autonomy score is loaded from Postgres and injected into the coordinator's system prompt
**on every task**, following the same runtime enrichment pattern established in PR #32
(date/timezone injection).

### Injection mechanism

During the coordinator's context assembly phase, before the LLM call:

1. Read `autonomy_config` (single row, fast)
2. Look up the band's behavioral description (static map, keyed by `band`)
3. Append a structured block to the system prompt:

```
## Autonomy Level

Your current autonomy score is {score} ({band-label}).

{band-behavioral-description}
```

### Why per-task (not once at startup)

The CEO may change the score mid-session. Loading per-task ensures a `set-autonomy` call
takes effect on Nathan's next action without requiring a process restart. The cost is one
single-row Postgres read per task — negligible.

---

## Guidelines for New Agents & Skills

Every new skill manifest (`skill.json`) should declare an `autonomy_floor` field indicating
the minimum autonomy band at which this skill is appropriate to run without explicit CEO
approval:

```json
{
  "name": "send-email",
  "autonomy_floor": "spot-check",
  ...
}
```

This field is **not enforced by the execution layer in Phase 1** — it is documentation for
the developer and for Phase 2's gate wiring. When the execution layer is extended to enforce
autonomy floors, the field will already be present.

### Autonomy floor guidelines by capability class

| Capability class | Recommended floor | Rationale |
|---|---|---|
| Read / retrieve / summarize | `full` | No external effect; always safe |
| Internal state writes (memory, contacts) | `spot-check` | Affects future behavior but reversible |
| Outbound communications | `spot-check` | External effect; CEO should have visibility |
| Calendar writes | `approval-required` | Creates commitments on behalf of CEO |
| Financial actions | `draft-only` | High-stakes; always require explicit instruction |
| Destructive / irreversible actions | `restricted` | Never autonomous |

### New agent checklist

When adding a new agent:

1. Ensure it receives the autonomy block via the standard prompt injection mechanism
   (coordinator does this automatically; standalone agents need explicit wiring)
2. Review pinned skills against the floor guidelines above
3. If the agent has capabilities that cross band boundaries, document which capabilities
   apply at which floor in the agent YAML comments

---

## Intended Future Hard Gates (Phase 2)

These gates are deferred to Phase 2 but documented here as the intended target. When
wiring, these are the first candidates:

| Condition | Gate |
|---|---|
| `score < 70` | `outbound-gateway` requires an explicit approval event before dispatching any email |
| `score < 60` | All skill invocations in `agent.task` context return early with an advisory message |
| `score >= 90` | Elevated skills (sensitivity: `elevated`) are callable without per-action confirmation from CEO |

The outbound gateway (`OutboundGateway`) is already a natural choke point — adding an
autonomy check there in Phase 2 requires no architectural change.

---

## Phase 2: Auto-Adjustment (Future)

Phase 2 will implement automatic score adjustment based on an action log. The formula from
the source spec:

```
Capability Score =
  0.45 × Competence +
  0.35 × Commitment +
  0.20 × Compatibility
```

Key constraints from the spec:
- Minimum 30 actions before any automatic adjustment
- Time-decay weighting applied (recent actions weighted more heavily)
- Autonomy cannot increase if factual error rate is high or overconfidence penalty is active
- All automatic adjustments write to `autonomy_history` with `changed_by: "system"`

The `autonomy_history` table designed in Phase 1 is the exact foundation Phase 2 writes to.

The full Phase 2 schema (action log, relationship signals, confidence model) is in the
source spec. Phase 2 gets its own design doc when the time comes.

---

## README Update

Add to the Project Status table:

| Spec | Area | Status |
|---|---|---|
| 12 | Autonomy engine (score, CEO controls, prompt injection) | Planned |

---

## CLAUDE.md Addition

Add to the "Adding Things" section of `CLAUDE.md`:

```markdown
### Autonomy Awareness

When adding a new skill, declare its autonomy floor in `skill.json`:
- `"autonomy_floor": "full"` — safe to run at any autonomy level (reads, retrieval)
- `"autonomy_floor": "spot-check"` — outbound communications, internal state writes
- `"autonomy_floor": "approval-required"` — calendar writes, commitments
- `"autonomy_floor": "draft-only"` — financial actions
- `"autonomy_floor": "restricted"` — irreversible or destructive actions

See `docs/specs/12-autonomy-engine.md` for the full guidelines table.

When adding a new agent, ensure it receives the autonomy prompt block via the runtime
injection mechanism (same pattern as date/timezone injection — see spec 12 for details).
```
