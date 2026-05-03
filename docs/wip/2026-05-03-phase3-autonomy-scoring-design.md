# Phase 3 Autonomy Scoring — Design

**Issue:** josephfung/curia#148
**Date:** 2026-05-03
**Status:** Draft

---

## Overview

Phase 3 makes the autonomy score self-adjusting based on an action log and an
LLM-as-judge scoring pipeline. A daily background pass (hosted in the
DreamEngine) scores completed actions on three dimensions — Competence,
Commitment, and Compatibility — then nudges the autonomy score up or down
based on a weighted composite, subject to guards that prevent runaway swings
and respect CEO overrides.

This issue also creates the `action_log` table, which serves as the
foundation for the approval lifecycle (#427, #428, #429) and the scoring
engine described here.

**What this issue delivers:**

1. `action_log` migration and TypeScript types (full ADR-018 schema)
2. `AutonomyScoringPass` — LLM judge + deterministic scoring for approval outcomes
3. Adjustment formula — delta-based, time-decay weighted, with guards
4. DreamEngine integration as a sibling pass alongside memory decay
5. `get-autonomy` trend surfacing

**What this issue does NOT deliver (follow-on issues):**

- Gate B writing `pending_approval` rows (#427)
- `approve-action`/`deny-action`/`dismiss-action`/`list-pending-actions` skills (#428)
- Expiry sweep and daily digest (#429)

---

## Design Decisions

### Delta-based adjustment, not target-seeking

The composite capability score (0.0–1.0) maps to a **delta** (±5) on the
current autonomy score, not a target score the system seeks.

A target-seeking model would equate performance with ideal autonomy level —
a capability score of 0.78 would mean "autonomy should be 78." This creates
conflict when the CEO deliberately holds a lower score (e.g., preferring
approval-required mode even when performance is high). Target-seeking would
fight the CEO's intent.

Delta-based respects the CEO's chosen baseline. Above 0.5 capability means
"things are going well, nudge up." Below 0.5 means "things are going poorly,
nudge down." The CEO's last manual setting is the anchor; the system only
provides incremental momentum from there.

### DreamEngine as the scoring host

The DreamEngine is a background maintenance system that runs periodic passes
on system state — currently memory decay. Autonomy scoring is the same
pattern: a periodic sweep that reviews accumulated data and adjusts system
state. Adding it as a sibling pass reuses the existing lifecycle management
(start/stop, per-pass intervals, error isolation) without introducing a
second independent background worker.

The scoring pass is a separate class (`AutonomyScoringPass` in
`src/autonomy/`) called by the DreamEngine — same pattern as a future
contradiction-resolution pass would live in `src/memory/` but be invoked by
the engine. The LLM dependency (for the judge) is isolated to the scoring
pass; a failed LLM call does not affect memory decay.

### Summary-based judge context (approach B)

The LLM judge receives the `action_log` row plus a `task_summary` field — a
human-readable description of what triggered the skill invocation. This
provides enough context for the judge to assess whether the skill choice was
appropriate without requiring full conversation transcript retrieval.

<!-- TODO: Future upgrade to approach C — use conversation_id to query the
     audit log for the full conversation transcript, giving the judge richer
     context for Competence and Compatibility scoring. The schema already
     stores conversation_id for this purpose. See issue #148 discussion. -->

### Deterministic scoring for approval outcomes

CEO approval decisions are direct trust signals that don't need LLM
interpretation. Only `success` and `failure` outcomes require an LLM judge
call. This keeps LLM costs proportional to actual skill executions.

### Daily cadence

The scoring pass runs daily, not more frequently. The autonomy score is a
slow-moving trust signal — the CEO should not experience the score changing
under them faster than they can observe and react to. Daily cadence combined
with the ±5 cap means the score moves at most 5 points per day, giving the
CEO comfortable visibility into the trend.

---

## `action_log` Schema

Migration 031 creates the `action_log` table. This is the foundation for the
approval lifecycle (#427/#428/#429) and Phase 3 scoring.

```sql
CREATE TABLE action_log (
  id                   BIGSERIAL PRIMARY KEY,
  task_id              TEXT NOT NULL,
  conversation_id      TEXT,
  skill_name           TEXT NOT NULL,
  action_risk          TEXT NOT NULL,
  outcome              TEXT NOT NULL CHECK (outcome IN (
    'success', 'failure', 'rejected',
    'pending_approval', 'approved', 'denied', 'expired', 'resolved_externally'
  )),
  task_summary         TEXT,

  -- Phase 3 scoring flags (LLM judge or CEO decision)
  competence_flag      SMALLINT CHECK (competence_flag IN (0, 1)),
  commitment_flag      SMALLINT CHECK (commitment_flag IN (0, 1)),
  compatibility        SMALLINT CHECK (compatibility IN (0, 1)),
  scored_by            TEXT,       -- 'llm-judge' for now; 'ceo' reserved for future manual override

  -- ADR-018 approval lifecycle columns (populated by #427/#428/#429)
  payload              JSONB,
  notification_sent_at TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  resolved_by          TEXT,
  expires_at           TIMESTAMPTZ,
  parent_action_id     BIGINT REFERENCES action_log(id),
  short_ref            TEXT,
  description          TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the scoring pass: find unscored terminal rows
CREATE INDEX idx_action_log_unscored
  ON action_log (created_at)
  WHERE scored_by IS NULL
    AND outcome IN ('success', 'failure', 'approved', 'denied', 'expired', 'resolved_externally');

-- Index for the approval lifecycle (#427/#428/#429)
CREATE INDEX idx_action_log_pending ON action_log (expires_at)
  WHERE outcome = 'pending_approval';

-- Index for short_ref lookups (#428)
CREATE INDEX idx_action_log_short_ref ON action_log (short_ref)
  WHERE short_ref IS NOT NULL;

-- Index for conversation_id lookups (future approach C upgrade)
-- TODO: conversation_id enables the judge to query the audit log for the full
-- conversation transcript, replacing summary-based scoring with richer context.
CREATE INDEX idx_action_log_conversation ON action_log (conversation_id)
  WHERE conversation_id IS NOT NULL;

-- Index for task_id lookups (deduplication in #427)
CREATE INDEX idx_action_log_task ON action_log (task_id);
```

TypeScript types in `src/autonomy/action-log-types.ts` mirror the schema.

---

## LLM-as-Judge Scorer

### What gets scored

Terminal `action_log` rows where `scored_by IS NULL`:

- `success`, `failure` — require LLM judge call
- `approved`, `denied`, `expired`, `resolved_externally` — deterministic scoring
- `rejected` (gate block) — deterministic scoring
- `pending_approval` — skipped (not terminal)

### Scoring dimensions

| Flag | Question |
|---|---|
| `competence_flag` | Was this the right action to take? (1 = correct, 0 = error) |
| `commitment_flag` | Was this proactive follow-through? (1 = proactive, 0 = passive) |
| `compatibility` | Was this aligned with the CEO's context and preferences? (1 = aligned, 0 = misaligned) |

### Deterministic scoring table

Approval outcomes and gate blocks have fixed scoring signals — the CEO's
decision (or the gate's decision) is the score:

| Outcome | competence | commitment | compatibility | Rationale |
|---|---|---|---|---|
| `approved` | 1 | 1 | 1 | CEO endorsed the action as correct and contextually appropriate |
| `denied` | 0 | NULL | 0 | CEO said wrong action, wrong context; proactiveness wasn't the issue |
| `expired` | NULL | 1 | 0 (weak) | Proactive but CEO didn't engage; ambiguous, weighted down |
| `resolved_externally` | 1 | 1 | NULL | Correctly identified action needed; CEO handled it differently |
| `rejected` (gate block) | 0 | 1 | NULL | Tried to act beyond clearance — proactive but misjudged constraints |

"Weak" `expired` compatibility is handled by a reduced weight multiplier
(default 0.3x) on top of time-decay, not by changing the flag value. The
flag is 0 (misaligned); the formula weights it less.

### LLM judge (for `success` and `failure` outcomes)

The judge receives the `action_log` row fields:

- `skill_name`, `action_risk`, `outcome`
- `task_summary` — human-readable context for what triggered the invocation

The judge returns three binary flags using a structured rubric prompt. The
model is configurable (default: `claude-haiku-4-5`) — a cheaper model
distinct from the coordinator, per ADR-012's independence principle.

**Failure handling:** If the LLM call fails, the row stays unscored
(`scored_by` remains NULL) and is retried on the next daily pass. Failures
logged at warn level.

**Batch size:** Configurable cap (default: 50 rows per pass), oldest-first.
Overflow waits for the next day.

---

## Adjustment Formula

### Composite capability score

```
capabilityScore =
  0.45 x weightedAvg(competence_flag) +
  0.35 x weightedAvg(commitment_flag) +
  0.20 x weightedAvg(compatibility)
```

Each dimension's weighted average is computed across all scored `action_log`
rows, with per-row weights determined by time-decay. NULL flags are excluded
from that dimension's average — the row does not contribute to that dimension
rather than dragging it toward zero.

### Time-decay weighting

Each row's weight decays exponentially by age:

```
weight = 0.5 ^ (days_since_action / half_life_days)
```

Default half-life: 30 days. An action from yesterday carries ~98% weight;
two weeks ago ~71%; two months ago ~25%. Recent performance dominates.

`expired` rows with compatibility 0 use an additional reduced weight
multiplier (default: 0.3x) on top of time-decay. An expired row from
yesterday has ~29% effective weight vs ~98% for a denied row from yesterday.

### Delta derivation

```
delta = round((capabilityScore - 0.5) x 10)
```

| capabilityScore | delta |
|---|---|
| 1.0 | +5 |
| 0.8 | +3 |
| 0.5 | 0 (no change) |
| 0.2 | -3 |
| 0.0 | -5 |

0.5 is the steady state — Curia is performing adequately, no adjustment.
Above 0.5 = trending positive, below = trending negative.

### Guards and constraints

| Constraint | Rule |
|---|---|
| Minimum sample | No adjustment until >= 30 scored rows exist (all time) |
| Max delta per run | +/-5 points (inherent in the delta formula) |
| Error rate guard | Score cannot increase if `competence_flag = 0` rate among the last 30 scored rows exceeds 20% |
| Zero delta | If delta rounds to 0, no write occurs |
| CEO cooldown | If the most recent `autonomy_history` row has `changed_by = 'ceo'`, no auto-adjustment for a configurable cooldown period (default: 7 days) |

### What gets written

When an adjustment fires:

- `autonomy_config` updated via `AutonomyService.setScore()` with new score
  and derived band
- `autonomy_history` row with `changed_by: 'system'` and a reason string:
  `"auto-adjust: +3 (capability 0.78, 47 scored, trend: improving)"`

---

## DreamEngine Integration

### Configuration

New key under `dreaming:` in `config/default.yaml`:

```yaml
dreaming:
  decay:
    # ... existing ...
  autonomy_scoring:
    intervalMs: 86400000          # daily
    model: "claude-haiku-4-5"     # cheaper model for the judge
    batchSize: 50                 # max rows scored per pass
    minScoredActions: 30          # minimum before any adjustment fires
    halfLifeDays: 30              # time-decay half-life for weighting
    weakExpiredWeight: 0.3        # reduced weight for 'expired' compatibility
    ceoCooldownDays: 7            # days after CEO set-autonomy before auto-adjust resumes
    errorRateThreshold: 0.20      # competence_flag=0 rate that blocks score increases
```

### DreamEngine changes

- Constructor accepts an optional `AutonomyScoringPass` instance
- `start()` registers a second `setInterval` for the scoring pass
- `stop()` clears both intervals
- The two passes run independently — a slow LLM judge call does not block
  memory decay

### AutonomyScoringPass dependencies

- `Pool` — read unscored rows, write scoring flags, write adjustments
- `AnthropicProvider` — LLM judge calls (configured cheaper model)
- `AutonomyService` — read current config, write auto-adjustments
- `Logger`

### Pass lifecycle (one run)

1. Query unscored terminal rows, oldest-first, up to `batchSize`
2. Score each row: deterministic for approval/gate outcomes, LLM for
   `success`/`failure`
3. Update each row's scoring flags and `scored_by`
4. Check adjustment guards (min 30, CEO cooldown, error rate)
5. If guards pass: compute capability score, derive delta, apply via
   `AutonomyService.setScore(newScore, 'system', reason)`

---

## `get-autonomy` Trend Surfacing

The existing `get-autonomy` skill adds three fields to its response:

- **`lastSetBy`**: `'ceo'` or `'system'` — from the most recent
  `autonomy_history` row
- **`trend`**: `'improving'`, `'declining'`, or `'stable'` — derived from the
  last 2+ `autonomy_history` rows where `changed_by = 'system'`. If fewer
  than 2 system entries exist, trend is `null`
- **`scoredActionCount`**: total `action_log` rows where
  `scored_by IS NOT NULL` — shows how much data feeds the formula and how
  close to the 30-action minimum

Trend is computed simply: compare the most recent system-set score to the one
before it. The +/-5 cap means each entry is already a bounded signal.

Example output:

```
Autonomy score: 78 — Approval Required

Last adjusted by system (auto-scoring, +3)
Trend: improving (over 12 system adjustments)
Scored actions: 47

At this level, I'll confirm before taking consequential actions like
sending email or creating commitments, but can proceed independently
on research and summarization.

Recent changes:
  2026-05-03  75 -> 78  (approval-required)  "auto-adjust: +3 (capability 0.78, 47 scored, trend: improving)"  — system
  2026-05-02  75 -> 75  (approval-required)  — system (no change, below min actions)
  2026-04-28  75 -> 75  (approval-required)  "starting point"  — ceo
```

---

## Dependencies

- **Phase 2 (#147):** Closed. Execution layer gates are implemented.
- **ADR-017:** Accepted. CEO-authorized action pattern.
- **ADR-018:** Accepted. Unified action log as approval state machine.
- **#427, #428, #429:** Follow-on issues that populate the approval lifecycle
  columns this migration creates. The scoring engine consumes those outcomes
  but does not depend on them being implemented first — rows simply won't
  exist until those issues land, and the 30-action minimum prevents premature
  adjustment.
