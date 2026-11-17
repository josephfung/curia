# Behavior test reliability: plan

Working note · 2026-11-17 · Draft for maintainer review

## Why

The v0.45.0 release gate took two long sessions to clear, and most of the effort went into the tests, not the product.

**Where the gate failures came from:**
- Of about 17 failures across the two sessions, about 10 were fixed by changing the test:
  - stale fixture dates;
  - a judge misread;
  - a stub that contradicted its prompt;
  - a harness change that broke another case;
  - a case passing 1/1 one day and failing 2/2 the next with no code change.
- Several product rules were tuned so that a particular failing case would pass, rather than decided as product decisions.

**The framework has become a product of its own:**
- It's about 54k lines:
  - 196 scenario cases and 55 smoke cases (26k lines of YAML);
  - 14.7k lines of harness;
  - 2.7k lines of test-mode code in `src/`;
  - 9k lines of unit tests for the harness.
- 296 commits touched it since v0.44.0.

**Gating on single runs of fuzzy behavior doesn't work:**
- Smoke grades every critical behavior with an LLM judge: 122 of 122 are judged, none checked in code.
- The finesse baseline (#2556) measured that judge against human grades at κ 0.06–0.31.
- A single run of such a case is close to a coin flip, and the release gate was asking each one to pass exactly, once.

**Fixes kept widening the heuristics:**
- Review rounds asked for wider heuristics, more cases and more options:
  - forward-header patterns in about ten languages;
  - a batch-send guard built on flags the model declares about itself.
- Each addition needed its own tests, and drew the next round of findings.

## What changes

Two instruments, kept apart:

| | Gate | Evals |
|---|---|---|
| Purpose | Catch regressions in behavior that would hurt the principal | Steer development of fuzzy behavior (finesse, judgment) |
| Size | Small: the behaviors that matter (no fixed count) | As large as useful |
| Checks | Deterministic first (tool calls, gateway outcomes); judged only where unavoidable | Rates by layer (decision, voice); judged where needed |
| Runs | Each case 3–5 times against a pass-rate threshold | A task slice ×3 while iterating; full set at checkpoints |
| When | Weekly on main, and at release | On demand, by whoever works the area |
| Blocks | A release, when below threshold | Nothing |

**Graduation from eval to gate:** a case moves into the gate only when all of these hold:
- its behavior has shipped;
- it's stable (about 90%+ over 10 runs);
- its critical behaviors are deterministic checks.

## Work, in order

Each step is its own PR.

### 1. Guidelines and CodeRabbit config

Goes first, so the later PRs are reviewed under it.

- **`docs/dev/behavior-tests.md`** (replaces `docs/dev/smoke-tests.md`): how to write and run behavior tests.
  - Gate vs eval, and the graduation rule.
  - Deterministic checks first. A judged behavior needs criteria a human would grade the same way twice.
  - Fixtures:
    - dates relative to the run;
    - no wording that only works on some weekdays;
    - stubs that never contradict the case's prompt;
    - wrong paths left open so a mistake can show.
  - No harness options to make one case pass: change the case or delete it.
  - Triage:
    - a deterministic failure is a bug;
    - an LLM case below its threshold is compared with its baseline rate, not root-caused from one transcript;
    - the time-box and the "no known_failure on the gate" rule stay for deterministic failures only.
  - Evals:
    - iterate on a slice;
    - fix root causes, not cases;
    - keep a held-out case per task to check that fixes carry over;
    - humans grade voice until a judge agrees with them.
  - Cost rules, unchanged from CLAUDE.md.
- **`docs/dev/reviewing.md`**: guidance for code reviewers (CodeRabbit and the pre-PR review agents).
  - **Proportionality:** a finding needs a realistic failure scenario with concrete inputs. "Could in theory" is not enough.
  - **Threat model:** a single-principal deployment.
    - Don't ask for guards against races that need the principal acting concurrently.
    - Don't ask for friction on daily paths to stop implausible spoofs. Send, write and hide paths keep their strictness.
  - **Heuristic code** (quote and forward detection, triggers): it fails closed, so a miss over-blocks. Don't ask to widen coverage (more languages, more patterns) unless the miss leaks something or sends something unapproved.
  - **Test cases:**
    - Don't ask for more cases, exhaustive edge cases, or new harness options.
    - Do flag a check that can't fail, a stub that contradicts its prompt, an absolute date, or a judged behavior that could be a check.
  - **Severity:** no nitpicks on docs, YAML cases or wording. A suggestion that adds a guard should say what it removes or why nothing simpler works.
- **`.coderabbit.yaml`** (the repo has none today):
  - a less aggressive review profile;
  - the two guides as review guidelines;
  - per-path instructions for `tests/scenarios/cases/**`, the harness, and the heuristic modules (`src/autonomy/send-evidence.ts`, `src/dispatch/turn-guidance-triggers.ts`).

  Setting names get checked against CodeRabbit's current docs when the file is written.
- **`CLAUDE.md`:** the Testing section points at `behavior-tests.md`; "Creating Pull Requests" points the pre-PR reviewers at `reviewing.md`.

### 2. Remove the batch-send guard

Decided: no code guard. `ceo-inbox-send-draft` sends one draft per call, as it always has.

- **Delete:**
  - `batch_size` and `batch_confirmed` (a `tool.json` public API change, noted in the changelog);
  - the per-turn send record, the batch refusal texts, and their handler tests;
  - scenario cases 30v, 30w and 30x, and the smoke case `ceo-inbox-batch-readback`.
- **Keep:** one sentence in the tool description: for two or more drafts, list each recipient and subject and get a yes before sending.
- **Update:**
  - ADR-062 (one line, recording the decision);
  - spec 14 if it mentions the guard;
  - the prompt-budget note in `tests/unit/agents/prompt-budget.test.ts` (the +82 bytes come back).
- **Close #2650 and #2653** as superseded.

### 3. Fold smoke into scenarios, then delete smoke

Smoke's 55 cases are all judged; the scenarios already cover most of their ground with deterministic checks.

- **Port, as deterministic scenario checks where possible**, only cases whose behavior no scenario covers and that would hurt if they broke. Candidates:
  - `unknown-sender-schedule-request` (a stranger can't book time);
  - `escalation-production-outage` (urgent mail reaches the principal);
  - `calendar-create-event` (core scheduling);
  - `cold-compose-no-address` (no guessed addresses);
  - `decline-gate-refusal-relayed-faithfully` (honest failure reports).

  The reschedule case is left to finesse task 51.
- **Delete:**
  - `tests/smoke/`;
  - the `pnpm smoke` script;
  - smoke-only shared code;
  - `docs/dev/smoke-tests.md`;
  - smoke from the release skill and CLAUDE.md.
- **Close #2651** (the smoke judge can't see specialist results).
- **Keep:** the `pnpm e2e:setup-wizard` walkthrough. It isn't smoke and stays in the release gate.

### 4. Trim the gate and set thresholds

Proposed gate, about 25 cases, each run 5 times:

| Area | Cases | Threshold |
|---|---|---|
| **Never leaks** | 34g stranger asks for SIN · 34m quoted SIN never reaches a newcomer · 34i unsubscribe keeps the phone out · 34e trusted directive holds for the principal | 5/5 |
| **Never sends unapproved** | 30af and 30ag inbox triage doesn't send · 45b purchase-order confirmation holds · 45g autonomous purchase order never sends · 34k ask, then send on yes | 5/5 |
| **Never acts for an outsider** | 36a outsider pushback on a calendar write · the ported unknown-sender case | 5/5 |
| **The principal can direct** | 34d principal directive sends intact · 46d send my draft | 4/5 |
| **Core jobs** | 16f principal request over email (real delegation) · 31m weekly meeting as one series · 30b triage end states · 30aa routine ack sends · 32f debrief reply · 22 task wake resumes · ported escalation and create-event | 4/5 |
| **Honesty** | 15 delegated draft not reported as sent · 19a calendar delegate failure | 4/5 |

The rest of today's 90 gate cases become `release_gate: false`, which keeps them runnable on demand; none are deleted. Each one's comment says why it moved.

**Gate pass rule:** every case at or above its threshold. A safety case below 5/5 is a real failure and gets root-caused. A core-job case below threshold is compared with its last baseline before anyone investigates.

### 5. Weekly run on main

- A scheduled GitHub Actions workflow in this repo (schedule plus manual dispatch), with:
  - a pgvector service container;
  - a seeded vault, from repository secrets that fork PRs can't reach;
  - `pnpm scenarios` for the gate, on production's standard-tier model.
- It posts a summary (pass rates against thresholds, spend) to a pinned tracking issue, and opens an issue for a case below threshold.
- It costs about $1–2 a run, on a spending-capped OpenRouter key.
- The release gate then re-uses the latest weekly result on the release commit, or runs once more if main moved.

## Decisions for the maintainer

1. The gate list in step 4: add or drop cases, and the 5/5 versus 4/5 split.
2. Smoke ports in step 3: which of the five candidates to keep.
3. Where the weekly run lives: GitHub Actions in this repo (proposed), curia-deploy, or a local scheduled job.
4. Its key: a separate spending-capped OpenRouter key for CI (proposed), or the existing one.

## Not in this plan

- Changes to PR #2557 (finesse). It's already an eval, outside the gate.
- Pruning harness features used only by cases leaving the gate. That's worth an audit once steps 2–4 land. It's left out here so the cuts stay reviewable.
- #2652 (flaky barge-in test): a normal small fix.
