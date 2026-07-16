# ADR-029: Passive email observation and counterfactual competence

Date: 2026-07-16
Status: Accepted

## Context

The `ceo-inbox` agent drafts email well but learns nothing from what happens next. When the CEO edits a Curia draft in Gmail and sends it, or completes a to-do by emailing someone, or handles a message Curia punted — Curia has no feed of those outcomes. Three product loops depend on that feed:

1. **Voice learning** — refine `ExecutiveProfile.WritingVoice` from draft→sent diffs.
2. **Task-completion detection** — close or confirm open `owner='ceo'` tasks when a send fulfils them.
3. **Capability growth** — for emails Curia triages but punts, silently shadow-draft what it *would* have sent, then score that counterfactual against the CEO's actual send so the global autonomy score can rise on evidence.

Two architectural questions had to be settled before implementation:

**A. Where do the intermediate evidence and learned outputs live?** Options considered:

1. New memory/record types in the knowledge graph (or new tables) for draft snapshots, diffs, and competence evidence.
2. Reuse existing stores: OKF scratch docs for evidence, `ExecutiveProfile.WritingVoice` for voice, `tasks` for completion, `autonomy_action_log` for competence — no new memory or event-record types.
3. A dedicated "preference learning" subsystem with its own schema.

**B. How should shadow (not-taken) actions feed autonomy?** Options considered:

1. A new per-class competence model / graduation state machine for inbox handling.
2. Treat shadow drafts as a valid Competence input to the *existing* Phase 3 scoring pass (`autonomy_action_log` → `computeCapabilityScore`), with no new score dial.
3. Defer capability growth until a separate autonomy redesign.

Design: `docs/wip/2026-07-15-email-observation-learning-design.md`. Epic #1419.

## Decision

**Reuse existing stores for a passive observe → reflect → remember loop; treat counterfactual (shadow) actions as a valid Phase 3 competence input.**

### Passive observation / reuse-existing-stores

> Curia observes a real-world side effect (the CEO's Sent folder via the existing `ceo-inbox` Nylas grant), accumulates freeform evidence in the OKF document workspace, and writes learned state only into stores that already exist — never inventing a parallel memory or record type for this feature.

Concrete mapping:

| Concern | Store |
|---|---|
| Draft snapshots + `(draft, sent)` diffs | OKF `/scratch/voice-learning/…` (spec 21) |
| Learned voice | free-form `WritingVoice.guide`, maintained by a weekly batched LLM pass and approved via the digest |
| Todo completion | `tasks` + `task-complete` / digest confirm |
| Capability evidence | Pre-scored rows in `autonomy_action_log` |
| Cadence / watermarks / guard markers | Scheduler crons + `config-store` |

Rationale for rejecting new stores (options 1 and 3): the destinations already exist and are versioned/auditable; a parallel schema would duplicate versioning, digest surfacing, and autonomy gating. The KG is the wrong home for raw draft prose and edit diffs (spec 21: "the workspace is the scratchpad, the KG is the record").

### Counterfactual competence

> A silent shadow draft of a punted email, reconciled against the CEO's actual send, is a legitimate Competence signal for Phase 3. It answers the counterfactual the autonomy score exists to answer: "if we had let Curia handle this, would it have reached the same decision?"

Mechanism (no new competence model):

- On reconciliation, collect `(shadow draft, actual sent reply)` pairs and make a **batched LLM call** (`ctx.infraLlm.extract()`, batch size 20) that judges whether the shadow draft reached the same substantive decision/recommendation as the actual send. This is a semantic equivalence judgment, not token or approve/deny matching.
- Write a **pre-scored** `autonomy_action_log` row with the resulting `competence_flag` (binary, `0` or `1`), `commitment_flag` and `compatibility` null, `scored_by = 'shadow-reconciler'`.
- Mark rows unmistakably (`skill_name: 'shadow-draft-eval'`, `action_risk: 'none'`, `payload.shadow: true`, `outcome: 'shadow_evaluated'`).
- `findUnscoredTerminal` skips them (no double-scoring); `findAllScored` includes them in the composite.
- The global score remains the only dial; existing guards (≥30 scored, 20% error-rate block on increases, ±5/day, 7-day CEO cooldown) apply unchanged.
- High-sensitivity threads (board / investors / legal / spouse) are **included** in shadow capture, not excluded. Those are the highest-stakes decisions, where competence evidence matters most.

Rationale for rejecting a parallel competence model (option 1): Phase 3 already auto-adjusts one global score from competence evidence; a second dial would fight ADR-011's single-score design and invent graduation machinery the band injection already provides emergently.

## Consequences

- **Three loops share one observer.** Voice, task-completion, and shadow competence all hang off `ceo-inbox-sent-observe` + draft/shadow capture — one Sent-folder poll, not three pipelines.
- **Privacy surface widens.** The observer reads *all* Sent mail (not only Curia-touched threads), and shadow capture now includes sensitive threads (board / investors / legal / spouse) since those are the highest-stakes decisions. Spec 04 records retention/TTL for raw OKF evidence, per OKF scratch conventions.
- **Hybrid auto/confirm is required.** Voice and task-completion write-back are confidence- and risk-tiered so noisy signal cannot silently corrupt the profile or close high-risk tasks.
- **`ceo-inbox` must become autonomy-band-aware.** Per the spec 14 checklist, scheduled specialists need explicit `autonomyService` injection so triage aggressiveness tracks the live band as shadow competence raises the score.
- **No new public memory API.** Skills and bus events are additive (`ceo.sent_observed`, new skills); the skill/handler surfaces grow, but knowledge-graph and task schemas do not gain parallel "learning" tables.
- **Accepted trade-off:** shadow rows are judged by a batched LLM assessment of substantive decision/recommendation equivalence at reconciliation time, not by the live per-action scoring-pass judge. They arrive pre-scored, so the scoring-pass judge path never sees them directly. Operators must understand `scored_by = 'shadow-reconciler'` in audits.
