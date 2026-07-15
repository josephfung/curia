# Issues to file — Email Observation, Voice Learning & Capability Growth

**Repo:** `josephfung/curia`
**Milestone:** `v0.42` (create it first if it does not exist — see step 0)
**Design doc:** [`docs/wip/2026-07-15-email-observation-learning-design.md`](2026-07-15-email-observation-learning-design.md) — read for full rationale.

> **For the agent filing these:** Follow the repo's `CLAUDE.md` issue conventions:
> 1. **Apply pre-existing labels only.** Query the repo's labels (`gh label list`) and apply all that fit. The `Labels:` line on each issue below is a *suggestion* — verify each exists; **do not invent new labels**. If a suggested label doesn't exist, drop it or ask.
> 2. **Exactly one `size:` label per issue** (already specified below).
> 3. **Acceptance criteria** are included in every body.
> 4. All issues go on the **`v0.42`** milestone.
> 5. After creating them, replace the `Depends on:` / epic checklist placeholders with the **real issue numbers**.

---

## Step 0 — Ensure the milestone exists

```bash
gh api repos/josephfung/curia/milestones --jq '.[].title' | grep -qx 'v0.42' \
  || gh api repos/josephfung/curia/milestones -f title='v0.42' -f state='open' \
       -f description='Email observation: voice learning, task-completion & capability growth'
```

---

## Suggested filing order & dependencies

1. **Epic** (file first; edit its checklist once children have numbers)
2. **Issue 1** — ADR 029 + spec updates (no code deps; can land early or alongside)
3. **Issue 2** — Draft capture → blocks 3, 4, 7
4. **Issue 3** — Sent-mail observer → blocks 4, 5, 7
5. **Issue 4** — Voice-learn (needs 2, 3)
6. **Issue 5** — Task-completion detection (needs 3)
7. **Issue 6** — Digest surfaces (needs 4, 5)
8. **Issue 7** — Shadow drafting + competence rows (needs 2, 3)
9. **Issue 8** — Autonomy-band-aware ceo-inbox (independent; pairs with 7)

---

## Epic — Email observation: voice learning, task-completion & capability growth

**Labels:** `epic`, `enhancement` *(verify)*
**Size:** `size:XXL`
**Milestone:** `v0.42`

**Body:**

Give Curia a passive feedback loop from the CEO's outbound email. Three loops over one shared observer, reusing existing stores (no new memory/record types):

1. **Voice learning** — remember Curia's drafts, compare against what the CEO actually sends, and refine the `ExecutiveProfile.WritingVoice` over time.
2. **Task-completion detection** — notice when a sent email fulfils an open to-do and close/confirm it (risk-tiered).
3. **Capability growth** — shadow-draft the emails Curia punts, score them against the CEO's actual sends, and feed that competence into the *existing* autonomy Phase 3 scoring so the global score (and thus how much Curia handles) grows on evidence.

Design: `docs/wip/2026-07-15-email-observation-learning-design.md`.

**Children:**

- [ ] #\_\_ Issue 1 — ADR 029 + spec updates
- [ ] #\_\_ Issue 2 — Draft capture to OKF
- [ ] #\_\_ Issue 3 — Sent-mail observer
- [ ] #\_\_ Issue 4 — Voice-learn skill + weekly job
- [ ] #\_\_ Issue 5 — Task-completion detection
- [ ] #\_\_ Issue 6 — Digest surfaces
- [ ] #\_\_ Issue 7 — Shadow drafting + competence rows
- [ ] #\_\_ Issue 8 — Autonomy-band-aware ceo-inbox

**Acceptance:** all children merged; ADR 029 landed; existing specs updated (04/13/14/19); end-to-end demo — draft → CEO edits & sends → observed → voice diff proposed + task auto-closed + a punted email producing a shadow-draft competence row that moves the global score via the Phase 3 pass.

---

## Issue 1 — ADR 029 + fold changes into existing specs (no new spec)

**Labels:** `documentation`, `spec` *(verify)*
**Size:** `size:M`
**Milestone:** `v0.42`

**Body:**

Document this capability without adding a new spec file (reduce doc fragmentation). Write **ADR 029** and update existing specs in place.

- **ADR 029** records: (a) the counterfactual-competence decision — treating shadow (not-taken) actions as a valid Competence input to the existing autonomy Phase 3 scoring; and (b) the passive-observation / reuse-existing-stores pattern (no new memory or record types). Add the row to `docs/adr/README.md`.
- **Spec updates (in place):**
  - `docs/specs/04-channels.md` — the sent-mail observer + draft-capture pipeline; retention/TTL rule for raw diff evidence in OKF.
  - `docs/specs/13-office-identity.md` — voice-profile learning from reconciled (draft, sent) diffs.
  - `docs/specs/14-autonomy-engine.md` — shadow-draft competence rows as a Phase 3 `autonomy_action_log` input.
  - `docs/specs/19-tasks-and-backlog.md` — task-completion detection from sent mail.

**Acceptance criteria:**
- `docs/adr/029-*.md` created from the template; index row added to `docs/adr/README.md`.
- The four specs above each updated to describe the relevant behavior; no new `docs/specs/23-*` file exists.
- CHANGELOG `[Unreleased]` updated.

---

## Issue 2 — Capture Curia-authored drafts to the OKF document workspace

**Labels:** `enhancement`, `skill` *(verify)*
**Size:** `size:M`
**Milestone:** `v0.42`
**Depends on:** —
**Blocks:** Issue 3, Issue 4, Issue 7

**Body:**

Extend the three CEO-inbox draft skills (`ceo-inbox-draft-reply`, `ceo-inbox-draft-compose`, `ceo-inbox-draft-edit`) to snapshot what Curia proposed into an OKF scratch doc keyed by the Nylas `draft_id`:

```
/scratch/voice-learning/<draft_id>.md
  frontmatter: draft_id, thread_id, recipients, subject, created_at,
               linked_task_ids[], agent_version
  body: the drafted content
```

Version-bump each skill.

**Acceptance criteria:**
- Every draft produced by the three skills writes a snapshot doc with the frontmatter above.
- Capture failure logs (pino) and **does not block** draft creation.
- Unit tests cover the snapshot payload and the failure-is-non-blocking path.
- CHANGELOG `[Unreleased]` updated.

---

## Issue 3 — `ceo-inbox-sent-observe` skill + daily scheduled job

**Labels:** `enhancement`, `skill`, `agent` *(verify)*
**Size:** `size:L`
**Milestone:** `v0.42`
**Depends on:** Issue 2
**Blocks:** Issue 4, Issue 5, Issue 7

**Body:**

New skill that polls the CEO's **Sent** folder via the existing `ceo-inbox` Nylas grant (no new credential), watermarked like the checkpoint pattern. Scope: **all sent mail**. Each run:

1. List Sent messages since the stored watermark.
2. **Draft match** — correlate to captured snapshots (Issue 2) by `thread_id` + recipients + send time → append `(draft, sent)` diff pairs to a rolling OKF evidence doc (`/scratch/voice-learning/pending-diffs.md`).
3. **Task match** — correlate to open `owner='ceo'` tasks by recipient + subject + semantic similarity → produce completion candidates for Issue 5.
4. Emit a `ceo.sent_observed` audit event; advance the watermark.

Run as a **daily** cron entry on `agents/ceo-inbox.yaml` (twice daily at most) with its own "Operating Modes" task text — **not** folded into the 15-min triage task. Reuse the `T2125-expense-tracker` self-throttling pattern (config-store `last_run_found_nothing_at` backoff) and guard markers.

**Acceptance criteria:**
- Re-running is idempotent (watermark honored; no reprocessing).
- Matched pairs land in the evidence doc; completion candidates persisted for Issue 5.
- `action_risk` set (`none`/read); `ceo.sent_observed` added to `src/bus/events.ts`.
- Cron entry added to `agents/ceo-inbox.yaml` at daily cadence with task-scope-fenced task text.
- Unit tests for watermarking, draft-match, and task-match.
- CHANGELOG `[Unreleased]` updated.

---

## Issue 4 — `voice-learn` skill + weekly job (hybrid-by-confidence)

**Labels:** `enhancement`, `skill` *(verify)*
**Size:** `size:L`
**Milestone:** `v0.42`
**Depends on:** Issue 2, Issue 3

**Body:**

Weekly job (`0 8 * * 1`, cron entry on `ceo-inbox`) that reads accumulated `(draft, sent)` diffs and proposes a `WritingVoice` delta. Two signal sources: **differential** (draft→sent diffs, for refining set fields) and **absolute** (raw sent-mail style, for bootstrapping empty/seed fields). Application is **hybrid by confidence**, decided per field via provenance (`seeded` / `learned` / `operator-set`):

- Auto-apply high-confidence/low-magnitude changes and fills into empty (seeded) fields via `executive-profile-update`.
- Propose higher-magnitude or operator-set-field changes in the digest (Issue 6) for one-tap approval.
- Enforce minimum-sample thresholds (see design §7.2): vocabulary ≥3 pairs & ≥70% consistency (auto); sign-off ≥3; patterns ≥5 & ≥60%; formality-band ≥8. `slow_decay` weighting over ~90 days. Dismissed proposals get a guard marker + cooldown.
- **Cold-start:** near-default profile → bootstrap posture (aggressive fill of empties + one-time onboarding summary email). Never fabricate on zero data; tone always proposes.

**Acceptance criteria:**
- Auto-applied changes appear in `executive_profile_versions` and emit `config.change`.
- Proposed changes render in the digest (Issue 6); no change below sample threshold.
- Per-field provenance respected (operator-set fields never auto-overwritten).
- Tests cover the auto path, the propose path, and the cold-start/bootstrap path.
- CHANGELOG `[Unreleased]` updated.

---

## Issue 5 — Task-completion detection (risk- and confidence-tiered)

**Labels:** `enhancement`, `skill` *(verify)*
**Size:** `size:M`
**Milestone:** `v0.42`
**Depends on:** Issue 3

**Body:**

Consume the completion candidates from Issue 3. Classify **task risk** (from the task itself — has a `plan`/subtasks, high `priority`, or sensitive tags = high-risk) and **match confidence**, then act:

| | Low-risk task | High-risk task |
|---|---|---|
| High-confidence match | Auto-complete with undo | Confirm in digest |
| Low-confidence match | Confirm in digest | Confirm in digest |

- Auto-completes call `task-complete` and post a reversible note in the digest ("Marked *X* done — you emailed Y. Undo?").
- Confirmations render as a digest section (Issue 6).
- Fuzzy candidates get a guard marker (`completion_asked: {date}`) so they aren't re-surfaced each run.

**Acceptance criteria:**
- High-risk tasks (e.g. "Plan AGM") never auto-complete.
- Auto-completes are reversible (undo path works).
- Matching logic unit-tested with fixtures including a high-risk case and a fuzzy-match case.
- CHANGELOG `[Unreleased]` updated.

---

## Issue 6 — Digest surfaces for voice proposals & completion confirmations

**Labels:** `enhancement`, `skill` *(verify)*
**Size:** `size:M`
**Milestone:** `v0.42`
**Depends on:** Issue 4, Issue 5

**Body:**

Extend the `pending-actions-digest` (rendered by the `list-pending-actions` skill) with two new sections: **proposed voice diffs** (approve/dismiss) and **task-completion candidates / undo notes**.

**Acceptance criteria:**
- Both sections render only when items exist.
- Approve/dismiss wired to `executive-profile-update` (+ dismissal guard marker); undo wired to reopen the task.
- Snapshot tests for both sections (present and empty states).
- CHANGELOG `[Unreleased]` updated.

---

## Issue 7 — Shadow drafting + competence rows into `autonomy_action_log`

**Labels:** `enhancement`, `skill`, `agent` *(verify)*
**Size:** `size:L`
**Milestone:** `v0.42`
**Depends on:** Issue 2, Issue 3

**Body:**

For emails Curia triages but **punts** (Seen / Urgent / Stuck), generate a **non-surfaced, non-sent** shadow draft and store it. On reconciliation against the CEO's actual send, write a **pre-scored** `autonomy_action_log` row so the *existing* Phase 3 pass consumes it — **no new competence model**:

- `competence_flag = 1` if the shadow draft reached the same **decision/outcome** as the actual send (equivalence, not phrasing), `0` if it diverged.
- Leave `commitment_flag` and `compatibility` **null** (pure competence signal; `computeCapabilityScore` handles per-dimension nulls).
- `scored_by = 'shadow-reconciler'` (so `findUnscoredTerminal` skips it; `findAllScored` includes it).
- Score from ground truth (the actual send), not the generic LLM judge.
- Mark rows unmistakably: `skill_name: 'shadow-draft-eval'`, `action_risk: 'none'`, `payload.shadow: true`. Add a new terminal `outcome` value via migration.
- Exclude high-sensitivity threads (board, investors, legal, spouse — KG sensitivity tier) from shadow capture (capture-scoping, not scoring).

See design §9. This is the sole mechanism by which capability growth feeds autonomy — the global score does all "graduating" via the existing bands and guards (≥30 scored, 20% error-rate block on increases, ±5/day cap, 7-day CEO cooldown).

**Acceptance criteria:**
- Shadow drafts never surface, send, or create approvals/notifications.
- `competence_flag` scored on decision equivalence from ground truth; `commitment`/`compatibility` null.
- Rows included by `findAllScored`, skipped by `findUnscoredTerminal`.
- New terminal `outcome` value added via migration (verify migration numbering per `CLAUDE.md`).
- High-sensitivity threads excluded from capture.
- Tests cover a matching case (`competence_flag = 1`) and a divergent case (`competence_flag = 0`).
- CHANGELOG `[Unreleased]` updated.

---

## Issue 8 — Autonomy-band-aware `ceo-inbox`

**Labels:** `enhancement`, `agent` *(verify)*
**Size:** `size:S`
**Milestone:** `v0.42`
**Depends on:** —

**Body:**

Inject `autonomyService` into the `ceo-inbox` agent (per the spec 14 "Adding a New Agent — Autonomy Checklist" — standalone/scheduled agents need explicit injection rather than inheriting the Coordinator's block) so its draft-vs-punt triage aggressiveness tracks the live autonomy band. **No new score, no gate** — behavior simply follows the existing global score.

**Acceptance criteria:**
- `ceo-inbox` receives the autonomy block on scheduled runs.
- Higher bands measurably shift triage toward drafting/handling rather than punting.
- The loop never writes the global score itself (only the Phase 3 pass does).
- Tests cover band injection and its effect on triage disposition.
- CHANGELOG `[Unreleased]` updated.

---

## Appendix — example `gh` invocation

Once labels are verified and the milestone exists:

```bash
gh issue create \
  --repo josephfung/curia \
  --title "Capture Curia-authored drafts to the OKF document workspace" \
  --milestone "v0.42" \
  --label "enhancement,skill,size:M" \
  --body-file issue-2-body.md
```

Repeat per issue. File the Epic first, then children, then edit the Epic body to replace `#__` with the real child numbers and set each child's `Depends on:` to real numbers.
