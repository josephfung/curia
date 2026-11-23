# Reviewing Curia changes

The starting point for anyone reviewing a Curia PR: CodeRabbit (through `.coderabbit.yaml`), the agents that review a PR before it opens, and people. It says which standards apply, how to weigh a finding, and how to review each kind of test. It links to the standards rather than repeating them.

## The standards

- **Code conventions:** `CLAUDE.md` covers TypeScript (ESM, no `any`, strict null patterns, CommonJS imports), error handling (`AgentError`, no empty catches, skills return results rather than throw), logging (pino, no `console.log`), the database (parameterized queries, migration numbering), where tests live, and how to add tools, agents and channels.
- **Finding classes that keep coming back:** `docs/dev/review-checklist.md` is the author's self-check, distilled from 644 past review findings. A diff that trips one of its lines has a real finding.
- **Judgment calls:** `docs/dev/principles.md` covers where a behavior fix belongs, what counts as evidence, the single-principal threat model, and what goes to the maintainer.
- **Decisions already made:** the ADRs in `docs/adr/` and the specs in `docs/specs/`. A change that contradicts one is a finding. A finding that would reverse one goes to the maintainer, not into the PR.

## Weighing a finding

A finding costs a fix, a re-review and sometimes a paid test run. Each one has to be worth that. In November 2026, review rounds kept asking for wider heuristics, more test cases and more guard options. Each request was reasonable on its own, but together they grew code and tests that then drew the next round of findings.

### Raise a finding when

- **It has a realistic failure scenario.** Name the concrete inputs or state, and what goes wrong. "Could in theory", "for robustness" and "consider also handling" are not findings.
- **It breaks a send, write or hide path.** That covers who gets a message, which address it goes to, what personal data leaves, whether an approval is needed, and what gets deleted or hidden. These stay strict: flag anything that could send to the wrong person, leak, skip an approval or lose data.
- **It's a correctness bug a test would catch:** a wrong result, a swallowed error, a missing await, an unbounded query, a broken migration.
- **It breaks a standard above**, or trips a line on the checklist.

### Don't raise

- **Races that need two concurrent actions by the principal.** Curia serves one principal, so these don't happen in practice. Real single-user bugs still count.
- **Defenses against implausible spoofs on everyday paths.** Curia is held to a human assistant's standard. Don't add friction to daily use to stop an attack that needs an unrealistic setup. Send, write and hide paths keep their strictness.
- **Wider coverage for heuristics that fail closed.** Quote and forward detection, trigger patterns and similar code withhold or over-block when they miss, so a miss costs an extra question, not a leak. Ask for wider coverage only if the miss sends something, leaks something or skips an approval. Don't ask for more languages, formats or variants for their own sake.
- **New guards, options or config keys without a failure scenario.** If a guard is warranted, say what simpler change was considered (removing the capability, narrowing an input) and why it doesn't work.
- **Guarantees beyond what the feature is for.** Judge the PR against its description and the issue it closes. Delivery proof for a notification, an audit trail nobody reads, retries or a new outcome state are new capabilities, not fixes. Mention the cost if you think one is worth having, as a follow-up, never as changes requested. On #2714, review rounds added about 1,100 lines to prove one confirmation email was delivered, reaching into the outbound queue, and all of it was cut ("it's an email notification").
- **Behavior that existed before the PR, in code outside the diff,** unless the change makes that code newly reachable. Raise it as a follow-up (a note in the review body, or an issue), not as changes requested.

### Broadly acceptable

None of these is worth a finding when the change is otherwise sound:
- **Pre-existing style or structure** in code the diff doesn't touch.
- **A reasonable design the author chose** over one the reviewer would have picked, when both work.
- **Small duplication**, in tests especially, where sharing the code would hide what each test does.
- **Comments that explain why** rather than what. Long ones are fine when the reason isn't obvious.
- **Wording, formatting and style nitpicks** in docs, comments and test cases, unless the text is wrong or misleads.

## Reviewing tests

### Unit tests

- **Assert behavior and returned values,** not implementation details. A test that only checks that a call happened is weak (checklist "Test each new branch").
- **Don't pin text the model reads.** Prefer a test of the code or a behavior case over one that pins prompt or description wording (ADR-046).
- **Versions:** assert a version floor, never an exact pin (CLAUDE.md "Versioning skills and agents").
- **Flaky tests:** fix the cause (an unpinned clock, an order assumption), never add retries.
- **Don't ask for** tests of trivial code, for coverage numbers for their own sake, or for a test per input permutation when one test shows the rule.

### Integration tests

- **Real Postgres, no mocks** of the database.
- **Each test owns its rows:** it cleans up and counts only rows it created, never table-wide totals (checklist "Own your rows").
- **Local failures:** a failure seen only on the shared local database isn't evidence until it repeats on a clean one. CI's fresh database decides.

### Behavior tests (`tests/scenarios/cases/**`)

These run real models and cost money on every run. Review them against `docs/dev/behavior-tests.md`.

**Flag:**
- a critical check that can't fail (one that would pass a wrong run too);
- a stub that contradicts the case's own message;
- a fixed date, or wording that only works on some weekdays;
- a judged behavior whose criteria two graders would read differently, or that a check on tool calls could replace;
- a new harness option added for one case.

**Don't ask for:** more cases, exhaustive edge cases, extra runs, new harness options, or coverage that unit tests already give.

## When the author pushes back

A reasoned pushback that cites this page, the checklist, `docs/dev/principles.md`, an ADR or a maintainer decision settles the thread. Don't raise the same point again in different words.
