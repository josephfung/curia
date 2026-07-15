# Design: Email Observation, Voice Learning & Task-Completion Detection

**Status:** Draft for discussion
**Date:** 2026-07-15
**Author:** Joseph (with Claude)
**Related specs:** 01-memory-system, 07-scheduler, 14-autonomy-engine, 19-tasks-and-backlog, 21-agent-document-workspace
**New artifacts proposed:** ADR `029` only. **No new spec** — fold the changes into existing specs (04-channels, 13-office-identity, 14-autonomy-engine, 19-tasks-and-backlog) to reduce doc fragmentation.

## 1. Motivation

The `ceo-inbox` agent drafts email well but learns nothing from what happens next. Two capabilities are missing:

1. **Voice learning.** Curia drafts a reply, the CEO edits it in Gmail and sends. Curia never sees the sent version, so it can't learn how the CEO actually writes and can't improve its drafts over time.
2. **Task-completion detection.** The CEO frequently completes a to-do *by sending an email* ("follow up with John"). Curia doesn't observe those sends, so its task list drifts out of sync with reality.

Both stem from one gap: **Curia has no feed of what the CEO actually sends.**

## 2. Key finding — the output stores already exist

Neither feature requires a new memory type or data record. The destinations already exist:

- **Voice** → `ExecutiveProfile.WritingVoice` (`src/executive/types.ts`): a versioned, DB-backed struct (`tone[]`, `formality` 0–100, `patterns[]`, `vocabulary.{prefer,avoid}`, `signOff`). Read by `executive-profile-get`, written by `executive-profile-update`. That update skill's description already anticipates this feature: *"after analyzing their writing patterns, or when they give feedback on drafted content."*
- **To-dos** → the `tasks` table (spec 19). `owner='ceo'` items are "for you to do"; completion is `task-complete` (autonomy floor 60 — silently permissible at any normal band).
- **Intermediate evidence** (the raw draft→sent pairs and accumulated edit diffs) → the **OKF document workspace** (spec 21). This is freeform WIP prose, which the KG deliberately rejects; the workspace is its correct home ("the workspace is the scratchpad, the KG is the record").

The **knowledge graph proper is not used** by this feature — worth stating explicitly, since the initial instinct was to reach for it. Voice lives in the executive profile, todos in the tasks table, evidence in OKF, cadence in the scheduler.

## 3. What is genuinely new

Only one new *capability* (not a new data type): a **sent-mail observer**. Today the `ceo-inbox-draft-*` skills create a Nylas draft and persist nothing — no bus event, no DB row. When the CEO sends from Gmail, no `outbound.delivered` fires (that event only covers Curia-initiated sends). So there is no captured `(draft → sent)` pair and no completion signal.

The observer polls the CEO's **Sent** folder through the *existing* `ceo-inbox` Nylas grant — no new credential, no new channel adapter.

## 4. Architecture — three moving parts

### 4.1 Capture (draft snapshots)

Extend the three draft skills (`ceo-inbox-draft-reply`, `ceo-inbox-draft-compose`, `ceo-inbox-draft-edit`) to write a snapshot of what Curia proposed into an OKF scratch doc keyed by the Nylas `draft_id`:

```
/scratch/voice-learning/<draft_id>.md
  frontmatter: draft_id, thread_id, recipients, subject, created_at,
               linked_task_ids[], agent_version
  body: the drafted content Curia produced
```

Low-risk, additive change. If capture fails it must not block the draft (log + continue).

### 4.2 Observe (the sent-mail observer)

A new skill (`ceo-inbox-sent-observe`) run on a scheduler cron. Each run:

1. Lists recent **Sent** messages via the `ceo-inbox` Nylas grant since a stored watermark (reuse the checkpoint-watermark pattern).
2. For each sent message, attempts two matches:
   - **Draft match** — correlate to a captured snapshot by `thread_id` + recipients + send time (a Gmail draft becomes a Sent message on send). Produces a `(draft, sent)` diff pair, appended to a rolling OKF evidence doc (`/scratch/voice-learning/pending-diffs.md`).
   - **Task match** — correlate to open `owner='ceo'` tasks by recipient + subject + semantic similarity of body to task title/description. Produces completion candidates.
3. Emits an audit event (`ceo.sent_observed`) and advances the watermark.

**Scope decision (confirmed): all sent mail.** The observer reads the full Sent folder, not just Curia-touched threads, to maximize completion coverage and voice signal. This widens the privacy surface — see §6.

### 4.3 Learn / act

**Voice learning** — a periodic job (proposed weekly, `0 8 * * 1`) reads accumulated `(draft, sent)` diffs, and an LLM identifies *consistent* edits across many messages (not one-offs): e.g. "shortens greetings," "drops exclamation marks," "prefers 'Thanks' to 'Best'," "tightens by ~20%." It maps these to a proposed `WritingVoice` delta.

Application is **hybrid by confidence** (confirmed):
- **High-confidence, low-magnitude** tweaks (e.g. a vocabulary prefer/avoid entry seen consistently across N≥ threshold messages) apply automatically via `executive-profile-update`, recorded in the version history and surfaced as an FYI.
- **Lower-confidence or high-magnitude** shifts (e.g. a formality-band change, tone descriptor change) are surfaced as a proposed diff in the digest for one-tap confirmation. This honors the existing "requires CEO authorization" posture on `executive-profile-update`.

Every applied change is already versioned (`executive_profile_versions`) and emits `config.change`, so it's fully auditable and reversible.

**Task-completion** — for each completion candidate, action is **hybrid by confidence *and* task risk** (confirmed):

| | Low-risk task | High-risk task |
|---|---|---|
| **High-confidence match** | Auto-complete with undo | Confirm in digest |
| **Low-confidence match** | Confirm in digest | Confirm in digest |

- *Risk* is inferred from the task, not a new field: high-risk = has a `plan`/subtasks (spec 20), high `priority`, or matching tags (e.g. `board`, `legal`). Single-action, low-priority tasks ("follow up with John") are low-risk; multi-step tasks ("Plan AGM") are high-risk and never auto-close.
- *Confidence* comes from match strength (exact recipient + strong semantic overlap = high).
- Auto-completes post a reversible note in the digest ("Marked *Follow up with John* done — you emailed him Tuesday. Undo?"). Confirmations render as a new digest section.

## 5. Reuse map (no new stores / event-record types)

| Concern | Reused mechanism |
|---|---|
| Draft snapshots + diff evidence | OKF document workspace (spec 21) |
| Learned voice | `ExecutiveProfile.WritingVoice` + `executive-profile-update` |
| Todo state | `tasks` table + `task-complete` / `task-update` |
| Cadence (observe, learn) | Scheduler declarative jobs (spec 07) |
| CEO surfacing | Existing `pending-actions-digest` |
| Autonomy gating | Existing `action_risk` floors (spec 14) |
| Capability/competence signal | Existing `autonomy_action_log` + Phase 3 scoring pass — no new scores |
| Watermarking | Checkpoint-watermark pattern |

New code surfaces: 2 new skills (`ceo-inbox-sent-observe`, `voice-learn`), edits to 3 draft skills, 2 scheduled jobs, digest additions, and agent wiring. One new bus event (`ceo.sent_observed`) for audit.

## 6. Autonomy, privacy & safety notes

- **Reading all Sent mail** is sensitive. The observer runs System-layer/scheduled, its extraction should respect the same sensitivity tiers as the KG, and the raw diff evidence in OKF should be swept (TTL) once folded into the profile — not retained indefinitely. Capture an explicit retention rule in the relevant spec update (04-channels or 01-memory-system).
- **Voice auto-apply** is bounded to low-magnitude changes; anything touching formality band or tone descriptors requires confirmation. This prevents a few unusual emails from skewing the profile.
- **Auto-completion** never fires for high-risk tasks and is always reversible. The false-positive cost is a wrong auto-close, mitigated by undo + risk tiering.
- **Autonomy floors already fit** the voice + task loops: `task-complete` is `low` (60), profile update is `medium` (70). No new autonomy mechanics needed there (consistent with spec 19 §8).
- **The third loop (§9) adds no new scoring.** Shadow-draft outcomes feed the *existing* Phase 3 competence dimension in `autonomy_action_log`, which already auto-adjusts the single global score (bounded ±5/day, guarded by the 20% error-rate block and 7-day CEO cooldown). The only new surfaces are a producer of competence rows and making `ceo-inbox` autonomy-band-aware. ADR 029 records the decision to treat counterfactual (shadow) actions as a valid competence input.
- **ADR-worthy decision:** passive observation of a real-world side effect (CEO sending mail) to drive silent internal state changes, reusing existing stores rather than new event/record types, plus the risk-tiered auto-action pattern. → ADR `029`.

## 7. Resolved design decisions (spec-phase)

### 7.1 Agent placement — routines on `ceo-inbox`, not a new specialist

Capture lives inside the ceo-inbox draft skills (that's where drafts are made). Observe and voice-learn run as **separate cron entries on the `ceo-inbox` agent** with their own task text and an "Operating Modes" block — the `T2125-expense-tracker` multi-cron/mode pattern — never folded into the 15-min triage task.

- **Why ceo-inbox owns it:** the sent-observer needs the `ceo_nylas_grant_id` secret, which ceo-inbox already holds. A separate specialist would re-grant that secret to a second principal (wider secret surface, duplicated entity resolution) for no benefit. t2125 shows one agent carrying multiple modes safely; the scheduler task-scope fence (`channelId: 'scheduler'` + hard "this task only" instruction) prevents an observe run from drifting into triage or sending.
- **Cadence isolation:** observe daily (twice daily at most), voice-learn weekly — kept out of the latency- and error-budget-sensitive 15-min triage loop.
- **Future-proofing:** the observe/learn skills are written **agent-agnostic** (no ceo-inbox internals), so promoting them to a standalone specialist later (heavier reflection, or observing Signal too) is a config change, not a rewrite.
- Fires directly at ceo-inbox (not via coordinator like writing-scout) — nothing goes to third parties; voice-learn writes the profile, completion writes tasks, surfacing rides the existing `pending-actions-digest`.

### 7.2 Minimum sample thresholds

A **qualifying pair** = a Curia draft the CEO sent with *meaningful* edits. Exclude verbatim sends (no signal) and near-total rewrites (content was wrong, not voice — poisons the signal). Only qualifying pairs count toward the denominator.

| Dimension | Lane | Threshold |
|---|---|---|
| Vocabulary prefer/avoid | auto-apply | ≥3 pairs **and** ≥70% consistency |
| Sign-off (when currently set) | propose | ≥3 pairs showing the same new sign-off |
| Patterns[] add/remove | propose | ≥5 pairs **and** ≥60% consistency |
| Formality band shift | propose | ≥8 pairs, mean delta crosses a band boundary by ≥10 pts |

- Require both a floor count **and** a consistency ratio (% of opportunities where the change could have appeared) — 3-of-3 is signal, 3-of-20 is noise.
- Weight the last ~90 days; store with `slow_decay` so old style ages out.
- On a dismissed proposal, write a guard marker (`voice_proposal_dismissed: {dimension} {date}`) and require ~2× samples or a 30-day cooldown before re-proposing.
- These are starting points; calibrate against a labeling pass on real (draft, sent) data.

### 7.3 Cold-start — two signal sources, per-field provenance

The design serves both an empty voice and an established one by drawing on two signals:

- **Differential (refine)** — the (draft → sent) diff. Sharp, few samples needed, but may *override* → confirmation-heavier (thresholds in 7.2).
- **Absolute (bootstrap)** — the style of **raw sent mail**, no Curia draft required (the CEO's unedited writing *is* the voice). Noisier per-sample, needs more volume, but writes only into empty fields where override risk is nil. Enabled by the "all sent mail" scope decision.

Posture is decided **per field** via provenance tracking — each `WritingVoice` field tagged `seeded` / `learned` / `operator-set` (the profile is versioned; version 1 = the YAML seed):

- **Seeded field** = a gap to enrich (t2125's "file fast, gaps are the queue"): fill aggressively from the absolute signal; auto-fill empties like sign-off after ≥3 consistent observations.
- **Operator-set field** = a considered choice: only the differential signal touches it, only via the confirmation lane.
- **Bootstrap posture** (near-default profile) sends a one-time onboarding summary (t2125's setup-email pattern): *"I've started learning your voice from your sent mail — here's a first-pass profile, tweak anything."*
- **Never fabricate on zero data** — no sent mail, no learning. Tone descriptors (subjective) always go through propose, even when still seeded.

### 7.4 Still open for the spec

- Exact match heuristics + confidence thresholds for draft↔sent and sent↔task correlation (the labeling pass in 7.2).
- Retention/TTL for raw diff evidence in OKF once folded into the profile.

## 8. Proposed issue breakdown

An epic plus six issues. Sizes per CLAUDE.md.

**Epic — Email observation: voice learning, task-completion & capability growth**
Tracks the capability (three loops: voice, task-completion, capability/autonomy growth). Links the issues below. Acceptance: all children merged, ADR 029 landed + existing specs updated (04/13/14/19), end-to-end demo (draft → edit → send → observed → voice diff proposed + task auto-closed + punted emails producing shadow-draft competence rows that move the global score via the Phase 3 pass).

1. **ADR 029 + fold changes into existing specs (no new spec)** — `size:M`
   *Acceptance:* ADR 029 records the counterfactual-competence decision (shadow actions as a valid Phase 3 competence input) + the passive-observation/reuse-existing-stores rationale; ADR index row added. Existing specs updated in place: **04-channels** (sent-mail observer + draft capture + retention rule), **13-office-identity** (voice-profile learning), **14-autonomy-engine** (shadow competence input to Phase 3), **19-tasks-and-backlog** (task-completion detection). No new spec file — reduces fragmentation.

2. **Capture Curia-authored drafts to OKF** — `size:M`
   Extend `ceo-inbox-draft-reply|compose|edit` to snapshot draft + metadata (incl. `linked_task_ids`) to `/scratch/voice-learning/<draft_id>.md`. Version-bump each skill.
   *Acceptance:* every draft creates a snapshot doc; capture failure logs and does not block drafting; unit tests cover the snapshot payload.

3. **`ceo-inbox-sent-observe` skill + scheduled job** — `size:L`
   New skill polling the Sent folder via the ceo-inbox grant, watermarked, producing draft-diff pairs + task-completion candidates, emitting `ceo.sent_observed`. Declarative cron in `agents/ceo-inbox.yaml`.
   *Acceptance:* re-running is idempotent (watermark honored); matched pairs land in the evidence doc; candidates persisted; `action_risk` set (`none`/read); event added to `src/bus/events.ts`; tests.

4. **`voice-learn` skill + weekly job** — `size:L`
   Analyze accumulated diffs → propose `WritingVoice` delta; apply hybrid-by-confidence via `executive-profile-update` (auto for high-confidence/low-magnitude; else digest proposal). Enforce minimum-sample threshold.
   *Acceptance:* auto-applied changes appear in `executive_profile_versions` + emit `config.change`; proposed changes render in digest; no change below sample threshold; tests cover both paths.

5. **Task-completion detection + risk tiering** — `size:M`
   Consume completion candidates; classify task risk (plan/subtasks, priority, tags) and match confidence; auto-`task-complete` low-risk/high-confidence with undo note, else digest-confirm.
   *Acceptance:* high-risk tasks never auto-complete; auto-completes are reversible; matching logic unit-tested with fixtures incl. a "Plan AGM" high-risk case.

6. **Digest surfaces for voice proposals & completion confirmations** — `size:M`
   Add sections to the `pending-actions-digest` (rendered by the `list-pending-actions` skill): proposed voice diffs (approve/dismiss) and completion candidates/undo.
   *Acceptance:* both sections render only when items exist; approve/dismiss/undo wired to the respective skills; snapshot tests.

7. **Shadow drafting + competence rows into `autonomy_action_log`** — `size:L`
   In triage, generate a non-surfaced, non-sent shadow draft for punted emails (Seen/Urgent/Stuck) and store it. On reconciliation against the actual send, write a pre-scored competence row (`competence_flag` from decision-equivalence; `commitment`/`compatibility` null; `scored_by: 'shadow-reconciler'`; `skill_name: 'shadow-draft-eval'`, `action_risk: 'none'`, `payload.shadow: true`). Add the new terminal `outcome` value (migration). See §9.1–9.3.
   *Acceptance:* shadow drafts never surface, send, or create approvals; `competence_flag` scored on decision equivalence (not phrasing) from ground truth; rows picked up by `findAllScored` but skipped by `findUnscoredTerminal`; high-sensitivity threads excluded from capture; tests cover the divergent case (`competence_flag = 0`).

8. **Autonomy-band-aware `ceo-inbox`** — `size:S`
   Inject `autonomyService` into the ceo-inbox agent (per spec 14 agent checklist) so its draft-vs-punt triage aggressiveness tracks the live band. No new score, no gate — behavior follows the existing global score. See §9.4.
   *Acceptance:* ceo-inbox receives the autonomy block on scheduled runs; higher bands measurably shift triage toward drafting/handling; the loop never writes the global score itself (only the Phase 3 pass does); tests.

**Suggested labels (confirm against live repo labels before filing):** `spec`, `skill`, `agent`, `enhancement`, plus one `size:` each. Query the repo's existing labels at filing time — do not invent new ones.

## 9. Third loop: capability learning & autonomy growth

The first two loops learn *how the CEO writes* (voice) and *what got done* (tasks). A third loop learns *what Curia punted but should be able to handle* — so it handles more email over time. Same observer, but **no new score**: shadow drafting turns punted emails into competence evidence that feeds the *existing* autonomy engine (spec 14, Phase 3), which already auto-adjusts the single global score.

### 9.1 Shadow drafting (the new primitive)

For an email Curia triages but declines to handle (📌 Seen, 🚨 Urgent, ⚠️ Stuck), Curia silently generates a draft it **does not surface and does not send** — it only stores it. When the CEO later replies themselves, the observer captures `(shadow draft, actual send)`: a demonstration of how the human handled the punted item.

- **Zero-risk** — nothing shown, nothing sent — so it runs even at low autonomy and quietly builds an evidence base for a future increase.
- **Match quality = competence.** If shadow drafts consistently reach the same outcome as the CEO's send, the class is demonstrably replicable; if they diverge, it's judgment-laden → keep punting. Ground truth is the CEO's real behaviour, not self-assessment.
- Reuses the same diff/observer machinery as the voice loop.

### 9.2 Two axes, kept separate

Measure competence on **decision/outcome equivalence** ("did the shadow draft convey the same answer, commitment, or action?"), **not** phrasing. Phrasing is the voice loop. A shadow draft that reaches the right decision but sounds slightly off is a handling *success* and a voice *data point* — two separate ledgers. Conflating them would penalize handling competence for unlearned tone.

### 9.3 Feed the existing competence signal — no new scores

Curia already auto-adjusts the single global score. Phase 3 (`src/autonomy/scoring-pass.ts`) runs a daily pass that scores terminal `autonomy_action_log` rows on Competence / Commitment / Compatibility, computes a time-decayed composite (0.45 / 0.35 / 0.20), and nudges the score by ≤±5/day — guarded by ≥30 scored actions, a 7-day CEO cooldown, and a hard block on *increases* when the recent competence error rate exceeds 20%. System adjustments write `autonomy_history` with `changed_by: 'system'`. There is no separate competence model to build; shadow drafting should feed this one.

Mechanism — on reconciliation the observer writes a **pre-scored `autonomy_action_log` row**:

- `competence_flag = 1` if the shadow draft reached the same outcome as the CEO's actual send (decision-equivalence, §9.2), `0` if it diverged.
- Leave `commitment_flag` and `compatibility` **null** — `computeCapabilityScore` accumulates each dimension independently and ignores nulls, so a shadow row is a **pure competence signal**.
- Set `scored_by = 'shadow-reconciler'` so the daily pass's `findUnscoredTerminal` skips it (no double-scoring) but `findAllScored` still includes it in the composite.
- Score from **ground truth** (the actual send), not the generic LLM judge — the judge guesses "was this right?"; with the real send in hand, we know.
- Mark shadow rows unmistakably: `skill_name: 'shadow-draft-eval'`, `action_risk: 'none'`, `payload.shadow: true`, so they never create approvals/notifications and are never confused with real actions. Likely a new terminal `outcome` value via migration.

This is arguably the *ideal* competence signal — the exact counterfactual the autonomy score exists to answer: "if we let Curia handle these, would it get them right?" And the existing 20% error-rate guard is precisely the safety: while shadow drafts are frequently wrong, the score cannot rise.

### 9.4 "Handle more over time" is emergent from the one dial

No per-class gate, no per-class thresholds, no graduation state machine. As shadow competence accrues, the single global score rises through the existing bands; the band description is already injected into the agent's prompt, so a higher band makes it draft (and eventually handle) more rather than punt — across the board, consistent with spec 14's deliberate single-global-score design. Fully autonomous *sending* still sits behind the existing `medium`/70 floor, exactly as today. The CEO's manual `set-autonomy` and 7-day cooldown still dominate; system drift is bounded to ±5/day.

Two new surfaces only:

- **A competence-row writer** (the reconciler in §9.3).
- **Autonomy-band awareness on `ceo-inbox`.** It runs on its own schedule, so per spec 14's agent checklist it needs explicit `autonomyService` injection (like date/timezone) rather than inheriting the Coordinator's block — so its triage draft-vs-punt aggressiveness tracks the live band.

**Capture-scoping, not scoring:** the agent may decline to shadow-draft the most sensitive threads (board, investors, legal, spouse — KG sensitivity tier) so those never contribute competence evidence. This is a filter on what gets probed, not a parallel score.

## 10. Generalizing the pattern: an observe → reflect → remember loop

Email voice learning is one instance of a more general shape. Every instance has four parts:

1. **A passive observation surface** — a real-world side effect the CEO produces (sent mail, calendar accept/decline/reschedule, expense rows).
2. **A periodic reflection pass** — a scheduled job that reads accumulated observations and extracts *consistent* patterns, ignoring one-offs.
3. **A typed "remember" target** — an existing structured store, never a new memory type (WritingVoice profile; scheduling preferences; expense field values).
4. **Confidence-gated write-back with cheap in-band state** — a watermark to avoid reprocessing, guard markers to avoid retrying un-learnable cases, and a hybrid auto/confirm split so noisy signal doesn't corrupt the store.

**Two custom agents already validate this loop in production** (`curia-deploy/custom/agents/`). Their patterns should be borrowed directly rather than reinvented.

**`T2125-expense-tracker`** — the "reflect/remember over a record store" instance. Verified techniques from its YAML:

- **File fast, enrich later.** Capture the record immediately with whatever data exists; a separate scheduled pass fills the gaps. → Analogue: snapshot the draft on creation, reconcile/learn on a later pass.
- **The store is the queue.** *"The spreadsheet is the source of truth. Rows with gaps are implicitly pending enrichment. No separate queue or state."* → Captured drafts without a matched send, and unfilled preference slots, are implicitly the backlog — no parallel "to-learn" table.
- **In-band guard markers.** A Notes column carries `fx_lookup: manual_needed`, `receipt_hunt: not_found`, `classification_pending: asked CEO {date}`, `deductibility_review: needed`. These stop infinite retry of un-fillable fields *and* encode "asked the CEO, awaiting reply" state on the record itself. → The email loop should mark a fuzzy task-completion candidate `completion_asked: {date}` so it isn't re-surfaced every run.
- **Self-throttling loop via config-store.** A `last_run_found_nothing_at` backoff watermark: on an idle run it stores the timestamp and skips further runs for 2h; when work appears it resets the gate to epoch. Plus `sheet_id.{year}`, a `seq.{year}` counter. → Reuse verbatim for the sent-observer's watermark.
- **Ask when unsure, remember the answer — the actual rule-learning mechanism.** On a classification it can't make, it asks the CEO and stores the answer as a KG fact: `entity: t2125_vendor_classification`, `field: {vendor_slug}`, `value: business|personal + reason`, `decay_class: permanent`, queried before every future decision. A baked-in default layer handles the common cases; the KG layer is the *learned overrides*; the human handles only the residual. This three-layer shape (defaults → learned rules → ask) is the template for calendar preference rules.
- **Dedup by scanning the store** (vendor + amount + date ±1 day) before filing. → Directly reusable for draft↔sent and sent↔task matching.

**`writing-scout`** — the "learn preferences from CEO feedback" instance, and notably *already voice-adjacent*. Verified techniques:

- **Proactive recall before acting.** Each run opens with `memory-query` for "CEO writing preferences", "topics to avoid", "ideas already reported" — reads its learned context before doing work.
- **Real-time negative-feedback capture.** When the CEO says "we've already covered that", it *immediately* stores `field: avoid_topic`, `value: reason`, `decay_class: slow_decay` — not on a batch cycle. Worth stealing for voice: if the CEO tells Curia "stop signing off with 'Cheers'", capture that instantly, don't wait for the weekly pass.
- **Decay class chosen by signal durability.** Durable prefs = `slow_decay`; ephemeral near-misses = `fast_decay`; hard facts = `permanent`.
- **Best-effort, non-blocking writes.** Memory writes come *after* the deliverable and never block it; every store-outcome (`stored`/`conflict`/`rate_limited`/`ambiguous`) is handled explicitly.

Note the complementarity: `writing-scout` already learns *what the CEO writes about* (topics, avoid-list). The email voice loop learns *how the CEO writes* (the WritingVoice mechanics). Together they cover both halves — worth keeping their memory namespaces distinct but aware of each other.

**Calendar specialist — a strong next candidate.** The observation surface is calendar activity (declines, reschedules, added buffers, accept patterns by organizer/type); consistent patterns become **scheduling-preference rules**. The "remember" target already exists — spec 11 (entity-context enrichment) carries the principal's *scheduling preferences*. Examples of learnable rules: "no meetings before 9am," "protect Friday afternoons," "add a 15-min buffer after external meetings," "auto-decline single-invite sales demos." Same cadence, same hybrid-confidence application, same digest confirmation surface.

**Other candidates:** inbox triage (learn which senders/subjects the CEO treats as urgent vs. ignores, to sharpen the six triage categories); contacts (relationship/preference facts — partly covered by `extract-facts` already).

**Recommendation — build concrete first, then extract.** Ship the email loop end to end, borrowing the t2125 techniques directly. Once email + calendar exist as two clean instances alongside t2125, consider extracting a shared **preference-learning primitive** (a small spec + helper: declare an observation source, a reflection prompt, a target store, and confidence thresholds) so specialists plug in rather than each re-implementing watermarks, guard markers, and digest wiring. Resist abstracting before the second instance — the three instances will disagree in instructive ways (field-fill vs. struct-delta vs. rule-set), and premature abstraction would lock in the wrong shape.
