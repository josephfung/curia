# Reviewing Curia changes

Guidance for code reviewers: CodeRabbit (through `.coderabbit.yaml`) and the agents that review a PR before it opens. `docs/dev/review-checklist.md` is the author's self-check. This page is about how to weigh findings.

**Why it exists:** in November 2026, review rounds kept asking for wider heuristics, more test cases and more guard options. Each request was reasonable on its own. Together they grew code and tests that then drew the next round of findings. A finding costs a fix, a re-review and often a paid test run, so each one has to be worth that.

## Raise a finding when

- **It has a realistic failure scenario.** Name the concrete inputs or state and what goes wrong. "Could in theory", "for robustness" and "consider also handling" are not findings.
- **It breaks a send, write or hide path.** Who gets a message, which address it goes to, what personal data leaves, whether an approval is needed, what gets deleted or hidden. These stay strict: flag anything that could send to the wrong person, leak, skip an approval or lose data.
- **It's a correctness bug a test would catch:** wrong result, swallowed error, missing await, unbounded query, broken migration.
- **It's on the self-check list** (`docs/dev/review-checklist.md`) and the diff actually trips it.

## Don't raise

- **Races that need two concurrent actions by the principal.** Curia serves one principal, so these don't happen in practice. Real single-user bugs still count.
- **Defenses against implausible spoofs on everyday paths.** Curia is held to a human assistant's standard. Don't add friction to daily use to stop an attack that needs an unrealistic setup. Send, write and hide paths keep their strictness.
- **Wider coverage for heuristics that fail closed.** Quote and forward detection, trigger patterns and similar code withhold or over-block when they miss. A missed pattern costs an extra question, not a leak. Ask for wider coverage only if the miss sends something, leaks something or skips an approval. Don't ask for more languages, more formats or more variants for their own sake.
- **New guards, options or config keys** without a failure scenario. If a guard is warranted, say what simpler change (removing the capability, narrowing an input) was considered and why it doesn't work.
- **Nitpicks on docs, test cases or wording,** unless the text is wrong or misleads.
- **Findings on code the diff doesn't touch,** unless the change makes it newly reachable.

## Behavior test cases (`tests/scenarios/cases/**`)

These run real models and cost money on every run. Review them against `docs/dev/behavior-tests.md`.

**Flag:**
- A critical check that can't fail: it would pass a wrong run too.
- A stub that contradicts the case's own message.
- A fixed date, or wording that only works on some weekdays.
- A judged behavior whose criteria two graders would read differently.
- A judged behavior that a check on tool calls could replace.
- A new harness option added for one case.

**Don't ask for:**
- More cases, or exhaustive edge cases.
- Extra runs.
- New harness options.
- Coverage of paths that unit tests already cover.

## Weighing a fix the author pushed back on

A reasoned pushback that cites one of the rules above, `docs/dev/principles.md`, an ADR or a maintainer decision settles the thread. Don't re-raise the same point in different words.
