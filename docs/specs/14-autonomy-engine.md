# 14 — Autonomy Engine

**Status:** Implemented (Phase 1)

---

## Overview

A single global autonomy score (0–100) governs how independently Curia operates across all agents and skills. The score is CEO-controlled, Postgres-persisted, and injected into the Coordinator's system prompt on every task — so Curia self-governs in real time without a restart.

**Phase 1 (implemented):** Score storage, CEO read/write skills, behavioral prompt injection.
**Phase 2 (future):** Hard execution gates — skill invocations blocked when score is below the skill's declared `action_risk` floor.
**Phase 3 (future):** Automatic score adjustment driven by a structured action log and a Competence / Commitment / Compatibility scoring formula.

---

## Why a Single Global Score

Curia is a single deployed instance serving one principal. There is no meaningful distinction between "Curia's email autonomy" and "Curia's calendar autonomy" at this stage — trust is a property of the whole relationship, not individual capabilities.

A global score is:
- **Interpretable** — the CEO can reason about what "75" means without understanding the system internals
- **Adjustable in real time** — one command changes behavior across all channels and skills immediately
- **A clear foundation** — per-capability scoring can layer on top in Phase 2 once the global baseline is established

---

## Autonomy Bands

The score maps to one of five named bands. Each band has a behavioral description that is injected verbatim into the Coordinator's system prompt.

| Band | Score | Label |
|---|---|---|
| **Full** | 90–100 | `full` |
| **Spot-check** | 80–89 | `spot-check` |
| **Approval Required** | 70–79 | `approval-required` |
| **Draft Only** | 60–69 | `draft-only` |
| **Restricted** | < 60 | `restricted` |

### Band Behavioral Descriptions

These are injected as-is into the Coordinator's system prompt. They define self-governance behavior at each band.

**Full (90–100)**
> Act independently. No confirmation needed for standard operations. Flag only genuinely novel, irreversible, or high-stakes actions — where the downside of acting without checking outweighs the cost of the pause.

**Spot-check (80–89)**
> Proceed on routine tasks. For consequential actions — sending external communications, creating commitments, or acting on behalf of the CEO — note what you're doing in your response so the CEO maintains visibility. No need to stop and ask.

**Approval Required (70–79)**
> For any consequential action, present your plan and explicitly ask for confirmation before proceeding. Routine reporting, summarization, and information retrieval can proceed without approval. When in doubt, draft and ask.

**Draft Only (60–69)**
> Prepare drafts, plans, and analysis, but do not send, publish, schedule, or act on behalf of the CEO without an explicit instruction to do so. Surface your work for review; execution requires a direct go-ahead.

**Restricted (< 60)**
> Present options and analysis only. Take no independent action. All outputs are advisory. Every step that would have an external effect requires explicit CEO instruction.

---

## Data Model

### `autonomy_config` — live state (single row)

```sql
CREATE TABLE autonomy_config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  score       INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band        TEXT NOT NULL,        -- derived label, stored for query convenience
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL,        -- 'ceo' or 'system' (Phase 3+)
  CONSTRAINT single_row CHECK (id = 1)
);
```

The `CONSTRAINT single_row` enforces exactly one row at the database level. All writes use `INSERT ... ON CONFLICT (id) DO UPDATE`. The `band` label is derived from `score` at write time and stored — no recomputation on every read.

**Default:** 75 (`approval-required`). Conservative starting point — Curia confirms consequential actions until the CEO adjusts from here as trust is established.

### `autonomy_history` — append-only audit trail

```sql
CREATE TABLE autonomy_history (
  id             BIGSERIAL PRIMARY KEY,
  score          INTEGER NOT NULL,
  previous_score INTEGER,           -- NULL on first write
  band           TEXT NOT NULL,
  changed_by     TEXT NOT NULL,     -- 'ceo' or 'system'
  reason         TEXT,              -- optional CEO note
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every write to `autonomy_config` appends a row here. Never updated or deleted. This table is the exact foundation Phase 3's auto-adjustment will write to when recording system-initiated changes.

---

## Skills

Both skills are pinned to the Coordinator only — not available to other agents.

### `get-autonomy`

- **Sensitivity:** `normal`
- **Action risk:** `none`
- **Inputs:** none
- **Behavior:** Queries `autonomy_config` for the current score and band, plus the last 3 rows from `autonomy_history`. Returns a human-readable summary.

Example output:
```
Autonomy score: 75 — Approval Required

At this level, I'll confirm before taking consequential actions like
sending email or creating commitments, but can proceed independently
on research and summarization.

Recent changes:
  2026-04-03  75 → 75  (approval-required)  "starting point"  — ceo
```

### `set-autonomy`

- **Sensitivity:** `elevated` (requires CEO `CallerContext`)
- **Action risk:** `high`
- **Inputs:** `score` (integer 0–100), `reason` (string, optional)
- **Behavior:**
  1. Validates `score` is in `[0, 100]`
  2. Reads current score from `autonomy_config`
  3. Derives new `band` label from `score`
  4. Upserts `autonomy_config` with new score and band
  5. Appends to `autonomy_history` with `previous_score`, `changed_by: "ceo"`, and optional `reason`
  6. Returns confirmation with old score → new score and band name

Any invocation without a valid CEO `CallerContext` fails closed.

---

## Prompt Injection

The autonomy block is loaded from Postgres and appended to the Coordinator's system prompt **on every task**, following the same runtime enrichment pattern used for date/timezone injection.

**Why per-task, not once at startup:** The CEO may change the score mid-session. Per-task loading ensures a `set-autonomy` call takes effect immediately on the next action — no restart required. Cost is one single-row Postgres read per task.

### Injected block format

```
## Autonomy Level

Your current autonomy score is {score} ({band-label}).

{band-behavioral-description}
```

---

## Skill `action_risk` Declaration

Every skill manifest must declare an `action_risk` field indicating the minimum autonomy score at which this skill may run without explicit CEO confirmation.

```json
{
  "name": "send-email",
  "action_risk": "medium"
}
```

Named labels map to minimum score thresholds:

| Label | Min score | Capability class |
|---|---|---|
| `none` | 0 | Read-only, no side effects |
| `low` | 60 | Internal state writes (memory, contacts) |
| `medium` | 70 | Outbound communications |
| `high` | 80 | Calendar writes, commitments on behalf of CEO |
| `critical` | 90 | Financial / destructive / irreversible actions |

A raw integer (0–100) may be used for precision (e.g. `75` for a skill that should unlock just above `approval-required` but below `spot-check`). Values outside `[0, 100]` produce a validation error at skill load time and prevent startup.

**This field is required in all skill manifests.** Phase 1 validates presence at load time. Phase 2 will enforce it at runtime by blocking skill execution when the live score is below the skill's floor.

### Quick reference by capability class

| Capability class | Recommended value | Rationale |
|---|---|---|
| Read / retrieve / summarize | `none` | No external effect — always safe |
| Internal state writes (memory, contacts) | `low` | Affects future behavior but reversible |
| Outbound communications | `medium` | External effect; CEO should have visibility |
| Calendar writes / commitments | `high` | Creates real-world commitments |
| Financial / destructive / irreversible | `critical` | Never fully autonomous |

---

## Adding a New Agent — Autonomy Checklist

1. **Coordinator handles injection automatically** — standalone agents wired outside the Coordinator need explicit `autonomyService` injection (same pattern as date/timezone)
2. **Review pinned skills** against the `action_risk` floor table above
3. **Document cross-band capabilities** in agent YAML comments if the agent has skills across multiple bands

See [adding-an-agent.md](../dev/adding-an-agent.md) for the full agent setup guide.

---

## Phase 2: Hard Execution Gates (Future)

When Phase 2 is implemented, these are the first gate candidates:

| Condition | Gate |
|---|---|
| `score < skill.action_risk_floor` | Skill invocation returns advisory failure — no throw, same `{ success: false }` shape |
| `score < 70` | `OutboundGateway` requires an explicit approval event before dispatching any external message |
| `score >= 90` | Elevated skills callable without per-action CEO confirmation |

The `OutboundGateway` (see [15-outbound-safety.md](15-outbound-safety.md)) is already the natural choke point — adding an autonomy check there requires no architectural change.

---

## Phase 3: Automatic Score Adjustment (Future)

Phase 3 will implement automatic score adjustment based on an action log, using a composite formula:

```
Capability Score =
  0.45 × Competence +
  0.35 × Commitment +
  0.20 × Compatibility
```

Key constraints:
- Minimum 30 actions before any automatic adjustment
- Time-decay weighting (recent actions weighted more heavily)
- Score cannot increase if factual error rate is high or overconfidence penalty is active
- All automatic adjustments write to `autonomy_history` with `changed_by: "system"`

The `autonomy_history` table from Phase 1 is the exact foundation Phase 3 writes to. Phase 3 gets its own design doc when the time comes. See `docs/wip/2026-04-03-autonomy-engine.md` for the detailed Phase 3 roadmap.
