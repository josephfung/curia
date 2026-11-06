# Pre-PR review checklist

Read your diff against this list before opening a PR. Each line is a finding class
CodeRabbit raised repeatedly on curia from August to November 2026 (644 findings over
207 PRs). The checks CI can run are already tests (`tests/unit/changelog-format.test.ts`,
`tests/unit/integration-db-hygiene.test.ts`); this list covers the ones that need judgment.

## Logic and failure paths

- **Sibling paths:** for every guard, filter or fix you add, grep for the other call sites, queries and install paths that need it too. *(edge cases; ~5% of all findings are this alone)*
- **Failure outcomes:** when a write may have committed before it threw, report "unknown", not "failed"; never report success when only a later step succeeded. *(error propagation)*
- **Best-effort steps:** decide whether each new catch must propagate, or is best-effort; say which in a comment, and normalize what propagates to `AgentError`. *(error propagation)*
- **Check before work:** authenticate, authorize and validate before buffering, writing or sending, not after. *(authz / trust boundary)*
- **Who can reach this:** for a new path, name who can trigger it (principal, contact, unauthenticated sender, another agent) and which check stops the rest. *(authz / trust boundary)*
- **Check-then-write:** put the check and the write in one transaction or under a lock; handle a 23505 race. *(concurrency)*
- **Stale responses:** in the console, ignore a response that is not for the latest request; keep side effects out of state updaters. *(console UI state)*
- **Bounds:** every external call, query and listener gets a timeout, a size or row bound, and a teardown. *(timeouts / leaks)*
- **Pages and caps:** follow the cursor past the first page, and filter before applying a row cap. *(pagination)*

## Inputs and text the model reads

- **Normalize at the boundary:** trim, reject whitespace-only and empty entries, reject a YAML root that is not a mapping, store the canonical form. *(input validation)*
- **User-keyed lookups:** use own-property lookups or `Object.create(null)` for objects keyed by user or model data. *(input validation)*
- **Untrusted text in prompts:** pass it as labelled data, never as instructions; strip newlines, separators and control characters first. *(prompt-data injection)*
- **Manifest and prompt text:** read each `tool.json` description, agent YAML line and `SKILL.md` claim against what the handler actually does. *(model-facing contract)*
- **Times:** user-facing times go through `toLocalIso()` with an IANA zone; date-only values stay dates. *(timezone / dates)*
- **Logs:** log ids, counts and hosts, not message content, raw identifiers or full URLs. *(log hygiene)*

## Tests, docs and migrations

- **Test each new branch:** assert returned values and audit rows, not just that a call happened. *(missing or weak tests)*
- **Own your rows:** integration tests clean up and count only rows they created; never assert on table-wide counts. *(test isolation)*
- **Scenario checks:** each critical check must fail a wrong run and pass a correct one; bind it to the specific tool call or task. *(scenario / smoke precision)*
- **Docs follow code:** re-read every spec, ADR, `docs/dev` page and code comment that describes the behavior you changed. *(doc drift)*
- **Migrations:** never edit an applied migration (add a new one); schema-qualify; make downgrades preserve pre-existing rows; from 118 on, guard every create and shape-check every added column or constraint (ADR-061). *(migration safety)*
- **Shell:** quote and default variables deliberately (`-` vs `:-`), and treat a failed probe as "unknown", not "absent". *(shell robustness)*
