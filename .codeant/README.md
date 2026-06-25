# CodeAnt review configuration

In-repo configuration for the [CodeAnt](https://www.codeant.ai/) AI reviewer, so the
rule set is versioned, diff-reviewable, and a single source of truth instead of living
only in the dashboard.

CodeAnt reads three files from this `.codeant/` folder (repo root, beside `.git`):

| File | Purpose |
| --- | --- |
| `instructions.json` | Guidance / suppression — tells the reviewer how to interpret the code and what **not** to flag. This is where we correct over-eager findings. |
| `review.json` | Custom rules to **enforce** (not used yet — see below). |
| `configuration.json` | `file_filters` for what gets reviewed at all (not used yet; default reviews everything). |

Each `instructions`/`rules` entry: `id`, `description`, `files` (glob array), `scope`
(`["ide", "pr"]`). Docs: https://docs.codeant.ai/ide/review/code_review_instructions

> **Update (2026-06-25):** all 256 dashboard "learnings" have been purged, so the dashboard
> management discussed in *The six instructions* and *Precedence* below is now **historical** —
> `instructions.json` is the sole suppression layer. See *Update (2026-06-25)* near the end for
> what that means going forward.

## Why these instructions exist

Across the contacts-cutover review (curia#1074), CodeAnt's style/error-handling
`[custom_rule]` findings were ~95% false positives we declined, while its semantic
findings (`[logic error]`, `[api mismatch]`, etc.) were genuinely useful. The noise had
two roots, both fixed by `instructions.json`:

1. **Production rules applied to test files and one-shot scripts** — Vitest already
   fails on unhandled rejections; `!` in a test documents a test-established invariant;
   scripts use a log-plus-exit-code contract, not `AgentError`.
2. **Rules that didn't know project idioms** — `!= null` as the combined null/undefined
   guard; "log + record + surface via exit/return" is not swallowing; `AgentError` is
   judged at the user/bus boundary, not every internal throw.

We use `instructions.json` (not `review.json`) because we are correcting over-eager
flags, not adding new things to enforce — and its scoping is *positive*, which matters
(see caveats).

## The six instructions

These consolidate ~190 narrowly-scoped, near-duplicate CodeAnt dashboard "learnings"
(each recorded when the same base rule re-fired on a different file) into a few broadly
scoped rules:

1. `tests-relax-production-rules` — async/null/error/naming rules don't apply to test files.
2. `nullish-equality-idiom` — `!= null` / `== null` is the intentional combined guard.
3. `agent-error-is-bus-boundary-only` — `AgentError` is bus-layer only; skills return `SkillResult`, routes/services/frontend use their own patterns.
4. `error-propagation-and-pg-codes` — services may propagate to the caller's error boundary; direct `pgCode` checks are fine.
5. `scripts-maintenance-conventions` — `scripts/` use log + exit-code, not `AgentError`.
6. `apps-console-frontend-conventions` — Vite/React frontend ≠ Node backend (extensionless imports, `console.error`, etc.).

~30 genuinely *specific* dashboard learnings (real architectural decisions, not generic
patterns — e.g. the dispatch outbound-context design, the system-origin skill bypass,
Gate C semantics) are intentionally **not** folded in here; they stay in the dashboard.
The dashboard cleanup (delete the duplicates these six replace, keep the specifics) is a
separate manual step — see the precedence note below for why it's still required and why
it's safe.

## Precedence: repo config vs dashboard "learnings"

Researched against CodeAnt's docs (2026-06):

- **Override is documented for exactly one file — `quality_gates_conditions.json`:** *"its
  settings take full precedence… [and] override any organization or repository database
  settings."* ([docs](https://docs.codeant.ai/pull_request/quality_gates/repository_configuration))
- **For `instructions.json` / `review.json` vs the dashboard learnings, precedence is NOT
  documented.** "Learnings" are a dashboard/DB-managed store (created from review
  interactions, edited/deleted in the dashboard, applied across repos) with no documented
  file-based deletion — which implies `instructions.json` **coexists with (augments)** them
  rather than replacing them. This is inference, not a quoted spec.

**Why this doesn't block the cleanup:** the six instructions here and the ~158 dashboard
learnings they replace are *both suppressions* of the same patterns. If the repo file
overrides → deleting the learnings is a no-op. If it only augments → deleting them removes
now-redundant suppressions while the repo equivalents still suppress. Either way, deleting a
learning that's fully covered by an equivalent repo instruction cannot increase false
positives. Two consequences:

1. The dashboard duplicates **won't auto-clear** by adding this file — delete them in the
   dashboard (use the triage sheet). This file is for going-forward suppression + versioning.
2. The real prerequisite is simply that `instructions.json` is **honored as a suppression**
   (its documented purpose). Confirm empirically on the first normal code PR after this
   merges: if the test / `!= null` / `AgentError` noise is gone, the six rules are working
   and the 158 are safe to bulk-delete. The 3 enforcement learnings (#37/#86/#22) *generate*
   findings and must be deleted in the dashboard directly — the repo file won't suppress them.

## Update (2026-06-25): all dashboard learnings purged — `.codeant/` is now the sole layer

Two things settled the precedence question above, in order:

1. **Empirical confirmation (PR #1180).** On `feat/wakeat-originator-1153` (two integration test
   files) the async/await-guard rule **re-fired 6×** on `tests/integration/*.test.ts` — flagging
   awaited `pool.query` cleanup/`DELETE`s, read helpers, and `await repo.createTask(...)` /
   `updateTask(...)` calls to the system under test — *despite* `tests-relax-production-rules`
   already globbing those files and already saying "awaited calls need no try/catch." The findings
   arrived under a **"PR Custom Suggestions"** section, distinct from the main review. So an
   in-repo instruction does **not** suppress a dashboard-managed **enforcement learning**:
   `instructions.json` *augments but does not override* — the inference above, confirmed.

2. **The dashboard was purged wholesale.** All **256** learnings were deleted (2026-06-25) — the
   ~158 noise duplicates **and** the ~30 "specific" architectural ones the plan above meant to
   keep. So the dashboard now carries **no** learnings.

**Net effect:** the precedence problem is moot — there is nothing left in the dashboard to override
or augment, so **these six instructions are the sole suppression layer.** The async-guard learning
that caused the PR #1180 re-fire is gone, so it should stop firing; **re-confirm on the next code PR
that touches tests** (if test-async noise is truly gone, the in-repo file is doing the whole job).

**Consequence to watch:** the ~30 *specific* architectural suppressions (e.g. dispatch
outbound-context design, system-origin skill bypass, Gate C semantics) were purged too. They are
**not** encoded here. If any was load-bearing and its base rule starts re-firing, re-add it as a
scoped entry in `instructions.json` (or `review.json`) — **not** as a new dashboard learning, so it
stays versioned and in-repo. The sections *The six instructions* and *Precedence* above are now
**historical** (they describe the pre-purge dashboard); this section supersedes their "delete the
duplicates / keep the specifics / then bulk-delete" plan.

The defense-in-depth hardening that shipped alongside this note — sharpening
`tests-relax-production-rules` to name the integration-test DB-await pattern, and adding the bare
top-level glob forms (`*.test.ts`, `tests/**`, …) — is still worth keeping now that the in-repo file
is the only layer, even though the purge (not the glob hedge) is what removes the re-fire cause.

## Open questions / caveats (verify before relying on this)

One item remains genuinely unverified:

1. **Glob syntax / negation.** The configuration page says Python `fnmatch` (where `*`
   crosses `/`, so `**` is redundant) and that a leading `!` is **treated literally and
   silently fails to match** — so negation cannot be used to exclude paths. The
   instructions page says minimatch. We therefore scope **positively** (target the files
   we want quiet) and hedge by listing both `*.test.ts` and `**/*.test.ts` forms. Do not
   add `!`-negation patterns until confirmed.

When these are answered, update this README and, if useful, add narrowed enforce-rules to
`review.json`.
