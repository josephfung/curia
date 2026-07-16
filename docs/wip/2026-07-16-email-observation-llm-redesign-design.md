# Email-observation learning: LLM-based voice & decision assessment

Date: 2026-07-16
Status: Approved (brainstorm) — pending implementation plan
Supersedes the heuristic engines shipped in the #1419 epic (PR #1429); revises ADR-029.

## Context

The #1419 epic (PR #1429) shipped three email-observation loops on the CEO's Sent
folder: voice learning, task-completion detection, and shadow-draft competence. Review
of that PR found the two *assessment* engines fundamentally wrong-modelled:

- **Voice learning** derived `WritingVoice` from hand-rolled heuristics (sign-off
  extraction, vocabulary set-diff, formality-by-length, sample counts + "magnitude"
  thresholds). This produces artificial confidence and misses everything that actually
  makes a voice — humour, directness, formatting, structure. It is brittle and
  over-architected.
- **Shadow competence** scored decision equivalence with token-overlap + affirm/deny
  polarity heuristics. Real inbox decisions are not binary approve/deny — they are
  meeting replies, policy answers, doc-review requests, project-status updates. Token
  comparison cannot judge whether two emails reached the same *substantive* decision.

The platform already has the right tool: `ctx.infraLlm` — a constrained, telemetered
LLM capability (`classify()` fast-tier, `extract()` standard-tier, emits `llm.call` bus
events, no raw chat). It also has `SensitivityClassifier`, built from `sensitivity_rules`
in `config/default.yaml`, which already covers the categories the feature hardcoded.

This redesign replaces both heuristic engines with LLM assessment, reuses the shared
sensitivity classifier, and is scoped to land in PR #1429 before the epic merges.

## Decisions (approved)

1. **Voice model → free-form guide.** The LLM maintains a concise markdown "how the CEO
   writes" guide; the structured `WritingVoice` fields stay as an operator-set baseline.
2. **Shadow competence → binary LLM flag.** The LLM judges same-decision yes/no; the
   existing `competence_flag` 0/1 → `autonomy_action_log` → Phase 3 pass is unchanged.
3. **Sensitive threads are included fully** in shadow learning (they are the highest-stakes
   decisions); the capture-time exclusion is removed. Retention relies on OKF scratch
   conventions + existing access controls.
4. **Redesign lands in PR #1429** before the epic merges (no heuristic engine ships).
5. **Keep the seeded structured voice fields** as a baseline (less churn; the guide carries
   all *learned* nuance).
6. **ADR-029 is edited in place** (it is unpublished — no decision history to preserve),
   not superseded by a new ADR.

## Design

### 1. Voice model — free-form learned guide

`WritingVoice` (`src/executive/types.ts`) gains one field:

```ts
export interface WritingVoice {
  tone: string[];
  formality: number;
  patterns: string[];
  vocabulary: { prefer: string[]; avoid: string[] };
  signOff: string;
  /** Learned, free-form markdown describing how the executive actually writes.
   *  Maintained by the weekly voice-learn LLM pass; empty until first learned. */
  guide: string;
}
```

- The seeded structured fields remain (operator baseline, config/executive-profile.yaml,
  validation unchanged). Voice-learning **only** writes `guide`.
- `compileWritingVoiceBlock()` (`src/executive/service.ts`) appends a new section after the
  structured guidance:

  ```
  **How the executive actually writes (learned from their edits):**
  <guide markdown>
  ```

  So `executive-profile-get` delivers it to the ceo-inbox draft prompt with no wiring
  change. When `guide` is empty the section is omitted.
- `validateProfile()` accepts an optional string `guide` (default `''`). DB load/migrate:
  `guide` defaults to `''` for existing rows (the profile is stored as JSON in
  `executive_profile_versions.config`, so no column migration — just a defaulting read).

### 2. Weekly voice-learn pass (LLM extraction)

`voice-learn` gains the `infraLlm` capability. The heuristic body of
`skills/_shared/voice-learn-logic.ts` (`proposeDeltasFromPairs`, `THRESHOLDS`,
`extractSignOff`, `extractVocabularySignals`, `meanLengthDelta`, `decideApplication`,
`formatProposalBlock`, the provenance/dismissed machinery) is **deleted**. Retained:
`parsePendingDiffs` and the `(draft, sent)` capture/parse helpers (deterministic, correct).

Flow:
1. Read accumulated `(draft → sent)` diffs from `pending-diffs.md` (unchanged capture).
2. If no pairs → no-op.
3. One **batched** `ctx.infraLlm.extract(prompt)` call: the prompt includes the current
   `guide` plus the batch of draft→sent diffs and asks the model to return an **updated
   guide** — concrete, high-signal observations about how the CEO edits Curia's drafts
   (tone, directness, humour, formatting, phrasing, length, sign-off), phrased as drafting
   guidance. Bounded `maxTokens`; if the corpus is large, cap the number of diffs per pass
   (most-recent-first) and log the cap.
4. The proposed guide is written to the **daily digest** as a single approve/dismiss item
   (medium-risk profile write stays human-in-the-loop). On `approve_voice`,
   `executive-profile-update` writes `{ writingVoice: { ...current, guide } }`.
5. Consumed diffs are swept per the existing retention rule.

Digest surface: the learning-digest voice item becomes a single "updated writing-voice
guide" proposal (diff/preview of the new guide) rather than per-field deltas. `approve_voice`
/ `dismiss_voice` in `resolve-learning-digest` operate on the whole guide, not a `field`.
The shared `skills/_shared/learning-digest.ts` voice helpers change from per-field parsing
(`## Proposal — <field>` / `markProposalStatus(field)`) to a single-guide proposal
(`parseVoiceGuideProposal` / `renderVoiceGuideSection` / status-mark by the guide block).
`voice-learn`'s `blockedProposalFields` / `patchIsNoop` per-field dedup collapses to a
single "is there already a pending guide proposal?" check.

### 3. Shadow decision comparison (LLM, batched)

- **Capture** (`ceo-inbox-shadow-draft`) is unchanged except the sensitive-thread exclusion
  is removed: `isHighSensitivityThread` and `SENSITIVE_RE` are deleted; every punt is
  captured. The ceo-inbox system-prompt shadow-drafting instruction (which currently says
  "Skip board/investor/legal/spouse threads") is updated to match — no thread is skipped.
- **Reconciliation** (`ceo-inbox-sent-observe`) gains the `infraLlm` capability.
  `scoreDecisionEquivalence` and `detectDecisionPolarity` (`skills/_shared/shadow-draft.ts`)
  are deleted.
- During a run, collect all reconciled `(shadow, sent)` pairs (shadow body + sent body +
  thread/subject). After the message loop, make **one batched `extract()` call** that
  returns, per pair:

  ```json
  { "source_message_id": "...", "same_decision": true, "reason": "..." }
  ```

  The prompt frames it as substantive decision/recommendation equivalence (would Curia's
  draft have reached the same outcome as the CEO's actual send — meeting scheduling, policy
  answer, doc-review ask, status update, etc.), NOT phrasing similarity.
- For each judged pair, write the pre-scored `autonomy_action_log` row exactly as today:
  `competence_flag = same_decision ? 1 : 0`, `commitment_flag`/`compatibility` null,
  `scored_by: 'shadow-reconciler'`, `skill_name: 'shadow-draft-eval'`, `outcome:
  'shadow_evaluated'`. Mark the shadow doc `reconciled_at` (idempotency guard, unchanged).
- Batch bound: cap pairs per LLM call (e.g. ≤20); split into multiple calls above the cap.
  With a daily cadence this is one call on almost every run.

### 4. Reuse `SensitivityClassifier`

- Expose the classifier to skills: add `ctx.sensitivityClassifier` (capability
  `sensitivityClassifier`), injected in `src/index.ts` from the already-built
  `SensitivityClassifier.fromRules(yamlConfig.sensitivity_rules)`.
- `task-completion-risk.classifyTaskRisk`: replace the hardcoded `SENSITIVE_TAGS` set with
  `classifier.classify(\`${title}\n${description}\`)`; `restricted` or `confidential` → high
  risk. Keep the plan-block / subtasks / priority checks. The bare-"plan" title heuristic is
  already removed; the `agm/board/legal/investors` title regex is dropped in favour of the
  classifier (categories `board`, `litigation`, `strategy`, `financial` cover it).
  - Note: `classifyTaskRisk` becomes classifier-dependent, so it takes the classifier as a
    parameter (keeps it pure/testable) — the handler passes `ctx.sensitivityClassifier`.
- The shadow hardcoded sensitivity list is gone (§3).

### 5. Platform + small fixes

- **Skill version on `ctx`.** Add `skillVersion: string` (and `skillName: string`) to
  `SkillContext`, populated by the execution layer from the loaded manifest. Remove the
  three hardcoded `SKILL_VERSION` consts in `ceo-inbox-draft-{compose,edit,reply}` and use
  `ctx.skillVersion` for the voice-learning snapshot `agent_version`.
- **Agent version** `agents/ceo-inbox.yaml` → `0.14.0` (was over-bumped to `0.18.1`).
- **Autonomy-band prompt line.** Rewrite the ceo-inbox scheduled-mode autonomy note to drop
  the "Phase 3 scoring pass" jargon and the redundant "never write the global score"
  sentence — the agent can't act on either. Keep the actionable part: higher band → lean
  toward drafting/handling, lower band → lean toward punting.

### 6. Docs

- **ADR-029** edited in place: the "counterfactual competence" section changes from
  ground-truth deterministic scoring to **LLM-judged** substantive decision equivalence;
  the voice mapping changes from structured `WritingVoice` fills to a **learned free-form
  guide**; the "exclude sensitive threads from shadow capture" consequence is **reversed**
  (sensitive threads are included; note the widened privacy surface + retention reliance).
- **Spec 13** (office identity): writing-voice learning section describes the guide + weekly
  LLM pass instead of the differential/absolute heuristic + threshold table.
- **Spec 14** (autonomy engine): shadow-draft competence section describes LLM judging, not
  token/number/commit heuristics.
- **Spec 04** (channels): note voice learning now uses an LLM extraction pass.

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `WritingVoice.guide` + `compileWritingVoiceBlock` | Carry & render the learned voice | executive types/service |
| `voice-learn` handler | Weekly: batch diffs → LLM → propose guide to digest | `infraLlm`, `workingDocs`, `executiveProfileService` |
| `voice-learn-logic` (slimmed) | Parse `(draft,sent)` pairs; build the LLM prompt | none (pure) |
| `ceo-inbox-shadow-draft` | Capture every punt (no exclusion) | `workingDocs` |
| `ceo-inbox-sent-observe` reconcile | Batch `(shadow,sent)` → LLM → competence rows | `infraLlm`, `actionLogRepo`, `workingDocs` |
| `shadow-draft` (slimmed) | Shadow doc parse/path; batched-judge prompt builder | none (pure) |
| `task-completion-risk` | Risk tiering via injected classifier | `sensitivityClassifier` |
| `SkillContext.skillVersion` | Manifest version to handlers | execution layer |

The pure prompt-builders (`voice-learn-logic`, `shadow-draft`) keep LLM I/O out of the
helpers so unit tests cover prompt shape and result parsing without a live model.

## Error handling

- `infraLlm` calls are wrapped: a failure logs and degrades gracefully — voice-learn
  proposes nothing (no guide change) and reports; shadow reconcile skips scoring for that
  batch (no `autonomy_action_log` rows written), leaving `reconciled_at` unset so the next
  run retries. Never throws (skill never-throw contract, already in place).
- Malformed LLM output (unparseable JSON / missing fields) is treated as a batch failure:
  log, skip, retry next run. Partial batches: per-pair entries missing from the response are
  left unreconciled for retry.
- All existing durability guards (watermark-hold on evidence-persist failure, idempotency
  markers) are unchanged.

## Testing

- Unit tests mock `ctx.infraLlm.extract`/`classify` (return canned structured results).
- Delete heuristic tests: `voice-learn-logic` threshold/vocabulary/sign-off/rewrite cases
  that no longer apply; `shadow-draft` `scoreDecisionEquivalence`/`detectDecisionPolarity`
  cases. Keep `parsePendingDiffs` and shadow-doc parse tests.
- New tests:
  - voice-learn: batch prompt includes current guide + diffs; a returned guide is proposed
    to the digest; LLM failure → no guide change, success result.
  - shadow reconcile: batched judge → `competence_flag` 1 and 0 rows written with correct
    markers; malformed/partial response → unreconciled + retry; sensitive thread is NOT
    excluded from capture/scoring.
  - task-completion-risk: `restricted`/`confidential` classification → high risk;
    ordinary task → low; classifier injected.
  - `SkillContext.skillVersion` populated; snapshot uses it.
  - resolve-learning-digest: whole-guide approve/dismiss.
- `pnpm run typecheck` + targeted vitest across all touched skills.

## Out of scope (tracked follow-ups from #1429)

#1431 (oldest-first backfill), #1432 (durable idempotency), #1433 (task keyset paging),
#1434 (reopenTask integration test) remain separate.
