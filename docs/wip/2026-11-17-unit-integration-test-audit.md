# Curia unit and integration test audit

Working note · 2026-11-17 · Draft for maintainer review

The first cleanup batch can remove **12 collected cases and one file**. A structural scan found matching bodies in **2,304 of 17,005 declarations**. Review of ten related families identified **27–41 further candidate removals**, subject to validating each surviving contract. The browser fixture consolidation models at **14–21 seconds of elapsed savings** on the three worker lanes indicated by CI.

This audit covers `main` at [`516812cb3f02f522aa6543953575b3e404946eec`](https://github.com/josephfung/curia/commit/516812cb3f02f522aa6543953575b3e404946eec). The CI run collected **19,204 cases across 1,104 files**, with **19,161 passed and 43 skipped**. The case-level review was targeted. The CI analysis, source scan, and history analysis are complete. The scratch executor disconnected during the isolated unit run. The paired worker-reuse measurement, per-file import ranking, and export of the full cluster and weak-candidate CSVs are pending. Paid suites were excluded. [Audited CI job](https://github.com/josephfung/curia/actions/runs/44203357833/job/134462885109)

## CI baseline and critical path

| Main CI run | Vitest elapsed | Tests | Import and collect | Transform wait | Worker prepare | Environment |
|---|---:|---:|---:|---:|---:|---:|
| [516812cb](https://github.com/josephfung/curia/actions/runs/44203357833/job/134462885109) | 192.45 s | 75% | 19% | 4% | 1% | 1% |
| [93147fe8](https://github.com/josephfung/curia/actions/runs/44199817044/job/134450716023) | 227.49 s | 72% | 22% | 5% | 1% | 1% |
| [19eab6c5](https://github.com/josephfung/curia/actions/runs/44195187060/job/134434650837) | 195.68 s | 77% | 17% | 4% | 1% | 1% |
| [11b96cf3](https://github.com/josephfung/curia/actions/runs/44189603211/job/134415153216) | 228.77 s | 72% | 21% | 4% | 1% | 1% |

Vitest 5.1 reports rounded shares of summed tracked worker time. It subtracts transform wait from collection before reporting the `import` share. `Setup` fell below the reporting threshold on all four runs. On the latest run, file results sum to 349.5 test worker-seconds, or about 466 tracked worker-seconds at a 75% test share. Three continuously occupied lanes would cover that tracked work in about 155 seconds. The remaining elapsed time includes costs outside the tracked phases and imperfect overlap. [Vitest duration calculation](https://github.com/vitest-dev/vitest/blob/v5.1.0/packages/vitest/src/node/reporters/durationBreakdown.ts)

The isolation diagnostic indicates three configured worker lanes across these runs. On the latest run, 1,104 spawns at about 98 ms give roughly 108 worker-seconds of startup. Vitest's estimated 35.88 seconds of elapsed startup savings is consistent with dividing that amount by three and accounting for the remaining spawns. The diagnostic also reported startup across all files of about 93–129 ms per file over the four runs. [Vitest isolation calculation](https://github.com/vitest-dev/vitest/blob/v5.1.0/packages/vitest/src/node/reporters/base.ts#L1044)

### Scheduling model

Estimate dispatch order by sorting files on their logged completion timestamp minus the file's reported test duration. Dispatch each file to the next available lane. Fit a uniform per-file allowance for unmeasured costs and scheduling effects to reproduce each observed baseline. Keep that allowance fixed in the counterfactuals. For the optimized scenario, estimate 28–38 fewer worker-seconds in the visibility file and 14–24 fewer in the card-fill file from the timings of repeated cases.

| Scenario | Latest, 4 lanes | Elapsed savings across 4 runs | Latest, 3 lanes | Elapsed savings across 4 runs |
|---|---:|---:|---:|---:|
| Calibrated baseline | 192.5 s | — | 192.5 s | — |
| Both Chromium files removed as a counterfactual | 150.5 s | 42–45 s | 136.7 s | 56–60 s |
| Both files retained with fewer navigations | 176.9–181.9 s | 11–16 s | 171.8–178.4 s | 14–21 s |

The visibility file finished about 1–17 seconds before the suite ended. Merge its five read-only listing checks into one navigation and retain its distinct click, targeting, and drawer cases. In card-fill, share checkout setup while preserving real label-to-value selection, text entry, cross-origin iframe behavior, and secret redaction. Keep coverage that public expiry text remains readable. Profile launch, navigation, settle, and action time before shortening fixture waits. [Visibility cases](https://github.com/josephfung/curia/blob/516812cb/tests/integration/web-browser-element-visibility.test.ts#L103) · [Card-fill cases](https://github.com/josephfung/curia/blob/516812cb/tests/integration/web-browser-card-fill.test.ts#L171) · [Settle timing](https://github.com/josephfung/curia/blob/516812cb/skills/web/tools/web-browser/settle.ts#L66)

### Ranked experiments

| Experiment | Modeled elapsed savings | Validation |
|---|---:|---|
| Reuse workers for an audited unit subset | 23–31 s of startup opportunity if all 728 backend unit files qualify. Scale down for a smaller subset. | Run matched isolated and reuse passes first. Reproduce failures alone and with preceding files to distinguish mock, environment, working-directory, and singleton leaks. |
| Combine repeated Chromium fixture work | 14–21 s at three lanes or 11–16 s at four | Compare the two file durations and end-to-end CI elapsed time across several like-for-like runs. Keep real browser checks for layout and secret handling. |
| Replace unrelated sleeps in mocked retry cases | About 8 s at three lanes or 6 s at four if the three files shed about 24 worker-seconds | Use fake timers for retry contracts and non-retryable fixtures for partial-failure contracts. Preserve client attempt-count and judge result assertions. [Nylas retry tests](https://github.com/josephfung/curia/blob/516812cb/skills/_shared/ceo-nylas-client.test.ts#L58) · [Judge retry case](https://github.com/josephfung/curia/blob/516812cb/tests/unit/scenarios/judge.test.ts#L224) |

The local setup used Node 26, a dedicated pgvector container, and no paid-provider credentials. The executor disconnected during the isolated unit run. Capture the standard JSON reporter and a module diagnostic reporter in the matched rerun. The latter needs collection, setup, transform wait, prepare, environment, and execution time because the standard JSON reports test execution timestamps and assertions. Rank files by `(collect + setup) / test time` and include raw milliseconds so small denominators are visible. The optional per-file coverage subset comparison is also pending. [Vitest JSON reporter](https://github.com/vitest-dev/vitest/blob/v5.1.0/packages/vitest/src/node/reporters/json.ts)

## Duplication and assertion screens

A throwaway TypeScript compiler API scan covered all 1,104 test files and extracted 17,005 `it` or `test` declarations. Exact groups use the raw callback body. Token matches discount comments and whitespace. Structural groups also replace identifiers, strings, and numbers. Each parameterized declaration counts once.

| Screen | Clusters | Declarations in clusters | Members beyond one per cluster |
|---|---:|---:|---:|
| Exact raw body | 36 | 97 (0.57%) | 61 |
| Same tokens, ignoring formatting and comments | 44 | 113 (0.66%) | 69 |
| Structural body | 723 | 2,304 (13.55%) | 1,581 |
| Structural, preserving repeated identifier relationships | 697 | 2,237 (13.15%) | 1,540 |

The structural count includes exact groups. Even an exact body can exercise a different handler or close over a distinct fixture. The largest structural cluster has 111 declarations, which shows why the structural counts are for triage. The 61 raw-exact excess members are the narrower review pool.

**342 declarations (2.01%)** tripped at least one assertion screen. These flags overlap.

| Screen | Count |
|---|---:|
| Zero direct `expect` or `assert` calls | 42 |
| All assertions inside an `if`, `try`, conditional expression, or `catch` | 179 |
| All assertions behind a branch or `catch` after discounting plain `try` | 20 |
| Sole `expect(true)` | 2 |
| Sole `toBeDefined()` | 8 |
| Sole `.not.toThrow()` | 26 |
| Sole `.resolves` assertion | 91 |

One declaration conclusively cannot fail on its own, the runner smoke test. The dispatcher case also has a tautological assertion and misses its stated subscription regression. Of the 42 zero-direct-assertion cases, 29 call an assertion-named helper. A required database insert and a promise that must settle can also serve as implicit assertions. The report-planning test can return without running an `EXPLAIN` when the tables are absent. Establish the prerequisite and assert the expected statement set. [Runner smoke test](https://github.com/josephfung/curia/blob/516812cb/tests/smoke.test.ts#L6) · [Dispatcher subscription test](https://github.com/josephfung/curia/blob/516812cb/tests/unit/dispatch/dispatcher.test.ts#L353) · [Report planning test](https://github.com/josephfung/curia/blob/516812cb/scripts/report-agent-context.test.ts#L629)

The scan found 423 parameterized declarations. The 322 literal tables contain 1,780 rows, and 101 table sizes require evaluation. The 330 branchless callbacks are candidates to review for repeated paths. Their rows are outside the duplicate count. There is one 317-byte inline snapshot and zero `.snap` files. [Inline snapshot](https://github.com/josephfung/curia/blob/516812cb/skills/_shared/learning-digest.test.ts#L33)

The scratch scan wrote `curia-test-audit-clusters.csv` with hashes and file and line locations, and `curia-test-audit-candidates.csv` with assertion and table flags. Export is pending recovery or regeneration. The measurements above were captured before the executor disconnected.

## Top ten related families

The threshold of three distinct shared structural hashes found 78 file pairs across 64 files and 45 candidate groups after expanding and deduplicating shared intersections. The ten screened families below account for 150 file-by-shape matches. Their proposed cuts preserve checks for distinct contracts.

| Family | Files × shared shapes | Candidate net removals | Disposition |
|---|---:|---:|---|
| Principal mailbox selection | 5 × 6 | 15–20 | Put lookup outcomes in the shared helper. Keep operation, mailbox selection, and result wiring in every handler. [Handler matrix](https://github.com/josephfung/curia/blob/516812cb/skills/ceo-inbox/tools/ceo-inbox-mark-read/handler.test.ts#L6) · [Lookup](https://github.com/josephfung/curia/blob/516812cb/skills/_shared/principal-mailbox-client.ts#L233) |
| Deny and dismiss approval | 2 × 15 | 4–7 | Use the shared parser's input matrix. Keep representative reference and fail-closed wiring, decision events, concurrency, and card-use handling. [Deny](https://github.com/josephfung/curia/blob/516812cb/skills/autonomy/tools/deny-action/handler.test.ts#L180) · [Dismiss](https://github.com/josephfung/curia/blob/516812cb/skills/autonomy/tools/dismiss-action/handler.test.ts#L197) · [Parser coverage](https://github.com/josephfung/curia/blob/516812cb/skills/_shared/approval-ref.test.ts#L6) |
| Inbox list and search | 2 × 10 | 5–7 | Move cutoff, timezone, and provenance variants to the shared draft helper. Keep per-handler wiring, paging, and partial failures. Eight matches are draft cases. [List](https://github.com/josephfung/curia/blob/516812cb/skills/ceo-inbox/tools/ceo-inbox-list/handler.test.ts#L472) · [Search](https://github.com/josephfung/curia/blob/516812cb/skills/ceo-inbox/tools/ceo-inbox-search/handler.test.ts#L344) |
| Slack and SMS sends | 2 × 9 | 2–4 | Centralize shared recipient-reference and result-format variants. Preserve channel-specific identities, approval replay, and gateway and delivery wiring. [Slack](https://github.com/josephfung/curia/blob/516812cb/skills/slack-send/handler.test.ts#L83) · [SMS](https://github.com/josephfung/curia/blob/516812cb/skills/sms-send/handler.test.ts#L91) |
| Email archive and mark read | 2 × 7 | 1–3 | Reuse the validator matrix and retain a boundary check and operation outcomes per handler. Collapse default-account checks where the gateway expectation survives. [Archive](https://github.com/josephfung/curia/blob/516812cb/tests/unit/skills/email-archive.test.ts#L15) · [Mark read](https://github.com/josephfung/curia/blob/516812cb/tests/unit/skills/email-mark-read.test.ts#L15) |
| Anthropic and OpenRouter adapters | 2 × 5 | 0 | A common harness may cut test code. Exercise response translation against both providers. [Anthropic](https://github.com/josephfung/curia/blob/516812cb/tests/unit/agents/llm/anthropic.test.ts) · [OpenRouter](https://github.com/josephfung/curia/blob/516812cb/tests/unit/agents/llm/openrouter.test.ts) |
| Channel and MCP registry routes | 2 × 5 | 0 | Share request setup where useful. Keep auth and error checks on both route registrations. [Channel routes](https://github.com/josephfung/curia/blob/516812cb/tests/unit/channels/http/routes/channel-registry.test.ts#L52) · [MCP routes](https://github.com/josephfung/curia/blob/516812cb/tests/unit/channels/http/routes/mcp-registry.test.ts#L52) |
| HTML-to-text converters | 2 × 3 | 0 | Keep both until production implementations share behavior and their output differences are reviewed. [Email conversion](https://github.com/josephfung/curia/blob/516812cb/tests/unit/channels/email/html-to-text.test.ts) · [Nylas conversion](https://github.com/josephfung/curia/blob/516812cb/tests/unit/skills/ceo-nylas-client.test.ts#L34) |
| Document workspace and working-memory TTL | 2 × 3 | 0 | Share fixture setup and keep each setting's valid bounds, defaults, and error inputs. [Document workspace](https://github.com/josephfung/curia/blob/516812cb/tests/unit/config.document-workspace.test.ts#L13) · [Working memory](https://github.com/josephfung/curia/blob/516812cb/tests/unit/config.working-memory.test.ts#L13) |
| Scheduler recovery and suspension | 2 × 3 | 0 | Use the existing common fixture and retain separate event wiring and failure contracts. [Recovery](https://github.com/josephfung/curia/blob/516812cb/tests/unit/scheduler/recovery-notifier.test.ts#L81) · [Suspension](https://github.com/josephfung/curia/blob/516812cb/tests/unit/scheduler/suspension-notifier.test.ts#L75) |

## Verified cleanup and coverage decisions

| Candidate | Disposition |
|---|---|
| Runner smoke test | Delete the file. Its only assertion is `expect(true).toBe(true)`. [Test](https://github.com/josephfung/curia/blob/516812cb/tests/smoke.test.ts#L1) |
| Model context windows | Keep the three shared cases in the registry suite and move any wanted unique model pins there. [Registry](https://github.com/josephfung/curia/blob/516812cb/tests/unit/agents/llm/model-registry.test.ts#L36) · [Estimator](https://github.com/josephfung/curia/blob/516812cb/tests/unit/agents/llm/token-estimator.test.ts#L94) |
| Vault refuses an undeclared key | Drop the second identical standalone PUT case. Keep the PUT/DELETE coverage. [Duplicate](https://github.com/josephfung/curia/blob/516812cb/tests/unit/channels/http/routes/vault.test.ts#L291) · [PUT/DELETE matrix](https://github.com/josephfung/curia/blob/516812cb/tests/unit/channels/http/routes/vault.test.ts#L345) |
| Contact authorization and listing | Collapse the identical CFO-on-email trust test and the second offset-zero case. [Authorization](https://github.com/josephfung/curia/blob/516812cb/tests/unit/contacts/authorization.test.ts#L286) · [Offset boundary](https://github.com/josephfung/curia/blob/516812cb/skills/contacts/tools/contact-list/handler.test.ts#L224) |
| Contact confidence | Drop the repeated zero-input assertion and trusted-versus-known comparison. Keep the separate principal-tier case. [Tier comparisons](https://github.com/josephfung/curia/blob/516812cb/tests/unit/contacts/confidence-scorer.test.ts#L91) · [Zero check](https://github.com/josephfung/curia/blob/516812cb/tests/unit/contacts/confidence-scorer.test.ts#L172) |
| Startup validator and error classification | Keep one empty-config fixture test and one bare `ECONNREFUSED` provider-error assertion. Retain the present empty file and DB-tagged error cases. [Startup validator](https://github.com/josephfung/curia/blob/516812cb/tests/unit/startup/validator.test.ts#L162) · [Error classification](https://github.com/josephfung/curia/blob/516812cb/tests/unit/errors/classify.test.ts#L126) · [DB precedence](https://github.com/josephfung/curia/blob/516812cb/tests/unit/db/resilience.test.ts#L66) |
| Fuzzy contact match | Both copies permit a null result. The isolated classifier probe returned a fuzzy match. Keep one test with an unconditional fuzzy assertion. [Pair cases](https://github.com/josephfung/curia/blob/516812cb/tests/unit/contacts/dedup-classifier.test.ts#L331) |
| Heartbeat blocker exclusion | Seed a blocked child beyond the 48-hour stale threshold with a recent, unfinished blocker. The current 10-hour child is ineligible regardless of the blocker predicate. Keep the completed-blocker positive case. [Fixture and thresholds](https://github.com/josephfung/curia/blob/516812cb/tests/integration/heartbeat-selection.test.ts#L81) · [SQL](https://github.com/josephfung/curia/blob/516812cb/src/db/queries/tasks.ts#L155) |
| Dispatcher `agent.error` | Assert the warning fields if logging is the contract. The current test passes even if the subscription is removed or throws, because the bus catches subscriber errors. [Case](https://github.com/josephfung/curia/blob/516812cb/tests/unit/dispatch/dispatcher.test.ts#L352) · [Bus delivery](https://github.com/josephfung/curia/blob/516812cb/src/bus/bus.ts#L216) |
| Dispatcher round trip and unknown sender | Keep the CLI vertical slice and assert causal parent links and required relative event order. Fold the duplicated unknown-sender slice assertion into the unit test. [Vertical slice](https://github.com/josephfung/curia/blob/516812cb/tests/integration/vertical-slice.test.ts#L80) · [Unit routing](https://github.com/josephfung/curia/blob/516812cb/tests/unit/dispatch/dispatcher.test.ts#L568) |
| Audit-log startup scan | Use one controlled Postgres fixture for empty state and a known unacknowledged row. Keep real append-only and idempotent acknowledgement checks. [Audit scan cases](https://github.com/josephfung/curia/blob/516812cb/tests/integration/audit-log.test.ts#L186) |
| Overly specific fixtures | Use one arbitrary gateway closing and assert both body and signature placement. Drop the both-invalid tier case after retaining an invalid case per operand. Trigger an SSE renderer failure with valid string content and assert the fallback frame. [Gateway sign-offs](https://github.com/josephfung/curia/blob/516812cb/tests/unit/skills/outbound-gateway.test.ts#L4232) · [Tier comparator cases](https://github.com/josephfung/curia/blob/516812cb/tests/unit/contacts/types.test.ts#L78) · [SSE fallback case](https://github.com/josephfung/curia/blob/516812cb/tests/unit/channels/http/event-router.test.ts#L164) |

Preserve the real Postgres recommendation race, the scheduler regression for a previously failed wake, and the approval-number ambiguity checks. Approval numbers have a non-unique index. Review support for stale pending wakes in old or repaired data before culling that case. Ordinary CI also skips 22 deterministic vault and migration cases because the encryption key is absent. Decide the supported upgrade paths and isolate those fixtures before enabling them. Give the two conditionally skipped test-mode cases their own principal fixture. [Grant recommendation race](https://github.com/josephfung/curia/blob/516812cb/tests/integration/grant-recommendation-create-race.test.ts#L52) · [Terminal task wakes](https://github.com/josephfung/curia/blob/516812cb/tests/integration/scheduler-terminal-task-wake.test.ts#L100) · [Approval index](https://github.com/josephfung/curia/blob/516812cb/src/db/migrations/098_approval_number.sql#L8) · [CI test environment](https://github.com/josephfung/curia/blob/516812cb/.github/workflows/ci.yml#L118)

## Growth since September 1

The first-parent comparison includes historical co-located tests under `src/`. The September relocation moved about 2,342 declarations into `tests/unit/` and added only 30 net test lines. Counting historical snapshots with today's path patterns overstates actual growth. [Relocation commit](https://github.com/josephfung/curia/commit/29bcc4c2) · [Baseline tree](https://github.com/josephfung/curia/tree/702fe32035b07ac88243c0e096868796e28db294)

| Change | Type | Net declarations | Net test lines | Net non-test JS/TS lines |
|---|---|---:|---:|---:|
| [Authority-aware PII and gateway scenarios](https://github.com/josephfung/curia/commit/606f155a) | Feature and harness | +620 | +9,228 | Incomplete diff |
| [Autonomous inbox sends](https://github.com/josephfung/curia/commit/73f27984) | Feature | +238 | +2,928 | +1,468 |
| [Knowledge graph node merge](https://github.com/josephfung/curia/commit/6c18f50e) | Feature | +220 | +3,923 | +6,048 |
| [On-request inbox sends](https://github.com/josephfung/curia/commit/1a27cae8) | Feature | +181 | +2,242 | +1,367 |
| [Saved cards core](https://github.com/josephfung/curia/commit/84638117) | Feature | +146 | +1,779 | +1,748 |
| [Turn-injection harness](https://github.com/josephfung/curia/commit/b72aaccf) | Harness and regression coverage | +142 | +4,024 | +1,784 |
| [Console docs round trip](https://github.com/josephfung/curia/commit/4865ed64) | Feature | +121 | +1,847 | +3,320 |
| [Secrets page redesign](https://github.com/josephfung/curia/commit/a2c92c43) | Feature and UI refactor | +116 | +1,577 | +1,672 |
| [Bundled embedding model](https://github.com/josephfung/curia/commit/9adce4a2) | Feature | +107 | +1,710 | +1,375 |
| [Self-hosted embeddings](https://github.com/josephfung/curia/commit/57fdfe71) | Feature | +100 | +1,460 | +1,447 |

Under `skills/`, test lines rose 97% and source lines rose 71%. In `apps/`, test lines rose 356% from a smaller base and source lines rose 76%. The mix of feature and harness work makes line ratios useful for investigation. The duplicate families and failing-condition checks provide specific deletion criteria.

## Proposed testing rules

1. **Give every regression test a failing condition.** Assert a result, side effect, explicit rejection, or settlement contract. For a reported bug, verify the old behavior fails the test.
2. **Make the fixture eligible for the branch under test.** Satisfy unrelated guards in negative cases. Pair a negative case with a positive one when a threshold, SQL predicate, or fallback can mask the failure.
3. **Put the full input matrix at the layer that owns the rule.** Keep representative caller wiring. Preserve distinct transport, authorization, transaction, and persistence contracts at their boundaries.
4. **Choose table rows by distinct behavior.** Select cases that cross a boundary, change an outcome, or preserve a documented incident.
5. **Make offline tests advance controlled clocks.** Use fake timers for retries. Share expensive setup across read-only checks and isolate state-changing cases.
6. **Review existing coverage when adding a regression case.** Extend or replace a case that already owns the behavior. Give required CI coverage deterministic fixtures and document intentional opt-ins.

## Review order

1. Review the 12-case duplicate batch and the heartbeat rewrite. Temporarily disable the unfinished-blocker predicate in a disposable checkout to verify the rewritten heartbeat test fails for the intended reason.
2. Recover or regenerate the cluster and assertion CSVs, then review the five families with candidate removals.
3. Measure worker reuse, browser fixture consolidation, and timer changes independently. Compare elapsed CI time and case results across matched runs.
4. Decide the supported legacy upgrade paths and give retained skipped cases deterministic fixtures.
