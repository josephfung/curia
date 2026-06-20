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
separate manual step, gated on the precedence question below.

## Open questions / caveats (verify before relying on this)

The CodeAnt docs are thin and partly self-contradictory here. Two things are unverified:

1. **Precedence: does `.codeant/` override or only augment dashboard-configured rules?**
   If it only augments, the noisy dashboard `[custom_rule]` rules will keep firing and
   must also be disabled in the dashboard. Confirm with a test PR.
2. **Glob syntax / negation.** The configuration page says Python `fnmatch` (where `*`
   crosses `/`, so `**` is redundant) and that a leading `!` is **treated literally and
   silently fails to match** — so negation cannot be used to exclude paths. The
   instructions page says minimatch. We therefore scope **positively** (target the files
   we want quiet) and hedge by listing both `*.test.ts` and `**/*.test.ts` forms. Do not
   add `!`-negation patterns until confirmed.

When these are answered, update this README and, if useful, add narrowed enforce-rules to
`review.json`.
