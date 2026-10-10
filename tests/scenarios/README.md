# Coordinator scenario suite

Behavioral tests for the coordinator rules that only its prompt enforces (#1956). Each
case is one inbound message with seeded state and stubbed tools. It runs N times on the
production prompt and the model you choose. A behavior is scored either in code
(was `delegate` called with this entry id?) or by an LLM judge that sees the tool calls
and the reply. A `critical` behavior must fully pass at least 80% of its runs, or the
suite exits non-zero.

Smoke (`tests/smoke/`, spec 16) asks "does the whole stack produce a good answer?". This
suite asks "did the coordinator make the right decision?", which is usually a tool call:
it routed instead of answering, it released the entry, it edited instead of duplicating.

By default `delegate` is stubbed, so no specialist runs and a case isolates the
coordinator's decision. A case with `delegation: real` runs the specialist too, through
production's delegate path, to test the round trip: the brief the specialist gets, what it
does with it, and what the coordinator makes of the result. See
[Real delegation](#real-delegation).

## Run it

```bash
# Release gate: every case, 5 runs, on the production standard-tier model
pnpm scenarios --model deepseek/deepseek-v4.1-flash

# Iterate on one case
pnpm scenarios --case "sweep-on-close" --runs 2 --model deepseek/deepseek-v4.1-flash
```

| Flag | Meaning |
|---|---|
| `--model <id>` | Route every agent to this model (registry id). Default: the configured `model_routing`. |
| `--case <text>` | Only cases whose name contains this text (case-insensitive). |
| `--tags a,b` | Only cases with one of these tags. |
| `--runs <n>` | Runs per case, overriding the case's `runs` and the default of 5. |
| `--concurrency <n>` | Cases run at once (default 4). A case's own runs are always one at a time. |
| `--allow-other-connections` | Run even though another client is connected to the database (see below). |
| `--on-demand` | Also run the cases marked `release_gate: false`. `--case` and `--tags` select them without it. |

`SCENARIO_TIMEOUT_MS` sets the default per-run wait (180s). A case can set its own
`timeout_seconds`. The wait is a hard bound: a turn that outlives it is scored as an
errored run and cancelled (every run is cancelled when it ends, so leftover work never
outlives it). Its later model calls fail at once, so it stops spending; its
later tool calls are refused (never answered by another run's stubs); and its
conversation rows are cleaned when it finally ends.

**Provider failures** are re-run, not scored. A run that errors with a model fallback, a
provider-type agent error (`PROVIDER_ERROR`, `TIMEOUT`, `RATE_LIMIT`), or a timeout that
fired while a model call had made no progress for 90 seconds is thrown away and run again, up to twice
(`tests/shared/case-scope.ts`: `providerFailure`). Each re-run is printed, listed in the
summary, and recorded on the run (`providerRetries`). A failure that is still there after
two re-runs is scored as an errored run, as before.

A run narrowed with `--case`, `--tags` or `--runs` can exit 0, but it says it is **not**
a release-gate result, and the results JSON records the filters. An unfiltered run leaves
out the cases marked `release_gate: false` and says how many it left out
(`onDemandSkipped` in the results JSON); it is still the release gate.

### What it needs

- `DATABASE_URL` pointing at a **migrated** database with a principal. The suite is meant
  for the local dev database, the same one smoke uses.
- `SECRET_ENCRYPTION_KEY`. LLM keys come from the vault only (#911). The vault needs:
  - `openrouter_api_key`, for the judge (`openai/gpt-4o` through OpenRouter) and for
    OpenRouter models such as the production standard tier;
  - `anthropic_api_key`, if you run an Anthropic model;
  - `openai_api_key` (valid), for embeddings. Seeding a contact creates its KG node.

  To add one key without touching the others, put it in `.env` and scope the seeder to
  it (the seeder loads all of `.env`, and would otherwise re-upsert every secret there):

  ```bash
  SEED_VAULT_ONLY=openrouter_api_key pnpm run seed-vault
  ```

  Then remove the key from `.env`; the vault is where it lives.

- **No running Curia instance on that database.** A run writes real rows (see below), and
  a live instance would act on them. The CLI refuses to start, and stops before any case,
  while another client is connected (`pg_stat_activity`, including other roles' sessions).
  Stop the instance (`docker stop curia-curia-1`). Pass `--allow-other-connections` only
  when the other client is not Curia, such as a psql session. A second `pnpm scenarios`
  against the same database is refused by an advisory lock.
- **A database whose data you are willing to send to the judge.** The judge (OpenAI,
  via OpenRouter) sees each run's tool calls and results, which can include real dev-DB
  reads and the principal's name. The model under test sees the same data already.

### Output

- A line per run, listing the tools called. `name!` means the stub layer refused the call.
  `name~` means an unstubbed MCP tool got the canned stand-in (also a stub hole).
  `name?` means a real read-only tool failed — a real outcome production would also
  return (e.g. `date-resolve` rejecting an expression), not a harness gap. A real
  specialist's call carries its name: `calendar:calendar-list-events`. A run that timed out
  while a specialist was still working prints `SLOW SPECIALIST` instead of `ERROR`.
- Per case, once its runs are rated: its estimated spend (split by agent when more than one
  ran), then per behavior its pass rate and an example justification when it is under 100%.
- In the summary, each case's spend and the run's total, split by agent and judge. The
  results JSON holds the split per run, per case and for the suite (`usage`). These are
  estimates from registry prices; see
  [docs/dev/smoke-tests.md](../../docs/dev/smoke-tests.md#concurrency-cost-and-provider-failures).
- `tests/scenarios/results/<timestamp>.json` (gitignored), with the commit, the model and
  every run's tool calls, reply and ratings.
- `tests/scenarios/stub-coverage.json` (committed). See [Stub coverage](#stub-coverage).
- **Exit 1** when any of these is true:
  - a critical behavior fully passed fewer than 80% of its runs;
  - a run errored (timeout, `agent.error`, a `model.fallback`, seeded state not visible),
    including one that timed out on a slow specialist (reported on its own line);
  - the judge itself failed on a run (reported separately from model failures);
  - cleaning up a run's rows failed;
  - a case's worst run had stub holes above its allowance;
  - the CLI found a case problem before running, or another client connected mid-suite.

## The gate

A `critical` behavior must be rated a full **PASS** in at least **80%** of its runs. A
PARTIAL counts as a miss here: the table below is binomial (pass/fail), and with PARTIAL
at 0.5, three PASS and two PARTIAL would clear 0.8 on a behavior that fully held in 60% of
runs. PARTIAL still earns half credit in the weighted score shown per case.

The default is **5 runs** because the gate's discrimination depends on the run count.
The figures come from curia-deploy's eval README:

| Runs | 0.8 means | Fails a truly 95%-reliable behavior | Catches a truly 60% behavior |
|---|---|---|---|
| 3 | 3/3 | 14.3% | 78.4% |
| **5** | **4/5** | **2.3%** | 66.3% |
| 9 | 8/9 | 7.1% | 92.9% |

At 3 runs the gate demands unanimity and is flaky. At 5 runs it rarely blocks a good
prompt. Use 9 runs for a decision that needs to catch a mediocre behavior.

**Known failures.** A case can carry `known_failure: { issue: "#1234", reason: … }` for a
tracked regression. It still runs, and its critical failures are printed under "Known
failures" with their pass rates, but they do not fail the gate. Errored runs, judge
errors, cleanup failures and stub holes in that case still do. When the case passes, the
CLI warns that the marker may be stale. Remove the marker in the PR that fixes the issue.

## How a run works

Cases run `--concurrency` at a time; each case's runs are one after another. Two cases
that seed the same contact identity or display name never run at once: seeding deletes a
fixture already on that identity, and a run's coordinator could find another case's
fixture by name with a real contact read (`seed.ts`: `seedConflictKeys`). Each run's
seeded rows, stubs, model calls and spend are found through its own case context
(`tests/shared/case-scope.ts`), so overlapping runs never see each other's state.

1. **Seed** the case's rows through the real services (see the next section).
2. **Send** the inbound through production's Dispatcher, which resolves the sender,
   injects `[ACTIVE OUTBOUND CONTEXT]` and builds the `agent.task`. Bullpen cases instead
   post on the thread and publish `agent.discuss`, which production's `BullpenDispatcher`
   turns into the coordinator's task. Scheduler cases publish the `agent.task` a
   recurring job with no linked task fires: channel `scheduler`, content
   `{"task": <content>}`, no Dispatcher.
3. **Capture** `tool.invoke` / `tool.result` and the coordinator's `agent.response` as the
   `system` layer. A `NO_REPLY` turn, or a reply Gate C holds for a non-principal, still
   ends the run. The runtime publishes an exact `NO_REPLY` as empty content with
   `suppressDelivery` (#1732), so capture restores the sentinel. With real delegation,
   each specialist's brief, calls and response too (`delegation-capture.ts`).
4. **Clean up** every seeded row and the run's own conversation rows.
5. **Rate:** apply each `check` in code and send the other behaviors to the judge, one run
   at a time. To try a cheaper judge on saved runs, see `pnpm rejudge` in
   [docs/dev/smoke-tests.md](../../docs/dev/smoke-tests.md#concurrency-cost-and-provider-failures).

### Seeded state and the shared database

| State | Seeded with | Kept from interfering |
|---|---|---|
| Sender contacts | `ContactService.createContact` + `linkIdentity` | Tagged in `notes`, deleted with their KG node after the run. A leftover from a crashed run is only removed if it carries the tag. |
| Outbound-context entries | `OutboundContextService.register`, backdated to `sent_minutes_ago` | The Dispatcher's `getActive()` returns only this run's entries, each read through the real `getEntry` SQL. Deleted after the run. |
| Bullpen threads | `BullpenService.openThread` | Runtimes see only this run's threads (the `wrapBullpenService` stack option). Deleted after the run. |
| Scheduler jobs | the `scheduler-list` stub | Never written to the database. Within a run, a later list replays that run's stubbed creates, edits and cancels onto the stub. |
| The run's conversation | | `working_memory`, `conversation_checkpoints` and `conversation_resolved_entities` rows are deleted. |
| Specialists' conversations (real delegation) | | The same rows for each `scenario-delegate-…` conversation. A specialist the run abandoned is cleaned again when it finishes. |
| Delegation claims (real delegation) | production's `pending_delegations` claims | Rows whose origin is the run's conversation or whose delegate conversation is a specialist's are deleted. |
| Entries a specialist changes or registers | the run-scoped outbound-context view | Every read or write outside the run's entries finds nothing. A registered entry joins the run's and is deleted with them. |
| Prior history | | Withheld. *Contact recent history* (a sender's turns from other conversations) returns nothing during a run (the `wrapWorkingMemory` stack option), so a case never inherits smoke runs' or the real principal's turns from the dev database. |

`audit_log` keeps the runs' events. It is append-only by design.

**Interrupted runs.** Every fixture carries a marker: contacts a `notes` tag, their KG
nodes `source = 'scenario-test'` (the suite mints each fixture's node itself, so a contact
never adopts a real node), entries a `scenario-origin-` conversation id (or, registered
during a run, the run's or a specialist's), threads a `scenario:` `source_message_id`,
specialist conversations a `scenario-delegate-` id, and delegation claims those
conversations. On Ctrl-C/SIGTERM, and at every start-up, the CLI sweeps anything carrying
those markers — and nothing else.

### Stubs, and why nothing can send

The stub layer (`stub-layer.ts`) wraps the test-mode ExecutionLayer:

1. A **matching stub** answers the call. The real tool never runs. Within one run, scheduler, task and draft reads then replay that run's stubbed writes onto the stub, the same way smoke does (`docs/dev/smoke-tests.md`). A stub whose match names `draft_id` still answers that `ceo-inbox-read` itself. A success stub for
   `email-send`, `email-reply`, or `email-draft-save` still refuses an attachment whose `file_url` is outside
   the temp store, with the error production's gateway returns (#2059). That call is
   recorded as stubbed: the model is told what went wrong and can recover, and it is
   not a stub hole.
2. **No stub, and the tool must be stubbed** — `action_risk` above `none`, `delegate`, or
   any tool declaring the `executionLayer`, `outboundGateway`, `actionLogRepo` or
   `secretCapture` capability (some of those say `none` but can re-invoke tools, send or
   resolve approvals): the call is refused with a `<skill_error>`. It never falls through.
   The runtime formats the error as production's `<task_error>`.
3. **No stub, read-only tool test mode can serve:** the real tool runs (memory reads,
   `date-resolve`, `web-fetch`). A read test mode cannot serve (missing capability) is
   refused instead, whether the coordinator is offered it, finds it through
   `tool-registry`, or loads it with `skill-activate` (`drive-download-file` needs the
   temp store, #2050, #2059).
4. **No stub, MCP tool:** it runs. The stack serves each configured MCP server from a
   tools/list snapshot (`tests/fixtures/mcp/`, #2024) with a session that reaches no
   account, so its `action_risk` does not matter: a call missing a required argument
   gets the server's validation error, any other a canned "nothing to return" result.
   The call is recorded as `canned` and counts as a stub hole, like a refusal, so stub
   every Drive/Docs/Sheets call a case's model makes with realistic data.
5. **A call from another conversation** (a timed-out earlier turn) is refused.

This sits on top of the test-mode stack's own guarantee: a gateway with no transport
client (spec 16). So a run cannot send, and `tests/unit/scenarios/stub-layer.test.ts`
asserts that unstubbed and stubbed sends never reach the real tool, from the coordinator
or from a real specialist. Unless a case sets `delegation: real`, `delegate` is always
stubbed, so no specialist runs.

**Every agent gets the same layer.** A real specialist's calls are answered from the run's
stubs and refused by the same rules. A stub can be scoped to one agent with `agent:`
(`agent: calendar` on a `calendar-list-events` stub answers the specialist, not the
coordinator); an unscoped stub answers every agent.

**Stub sets** live in `stubs/`. A case can name some in `stub_sets`, and its own stubs for
a tool are matched first.

- `voice-profile` answers `executive-profile-get`, for an agent that drafts in the
  principal's voice. `calendar-office` is a quiet calendar for a real calendar specialist,
  scoped to it: calendars, events, free time, conflicts and its stored rules (none).

- `defaults` applies to **every** case. It is an empty office: reads that test mode
  can't serve (`email-list` with no mail client, `task-list`, `doc-search`, …) answer as a
  quiet day instead of failing in ways production never does. `task-update` and
  `task-complete` answer only for the task `task-create` returns; updating any other
  task is refused and counted (#2059).
- `human-channels` makes every send succeed. `deferred-work` does the same for creating
  tasks and jobs.

**A forbidden tool must be stubbed to succeed.** If a behavior says `not_called:
[signal-send]`, the case must stub `signal-send` (usually through `human-channels`). The
wrong path has to be available, or the case tests a refusal instead of the model's choice.

Before any paid call the CLI also checks that every tool a check names is registered (a
typo in `not_called` would otherwise pass forever), that `called`/`order` tools are
offered to the coordinator, loaded by a `skill-activate` it may call (the
google-workspace tools, #2024) or returned by a `tool-registry` search (#2050), and that `with`/`contains` keys are real inputs of the
tool (for an MCP tool, its JSON Schema properties).
The loader rejects unknown keys anywhere in a case, so `weigth:` or `checks:` is an error,
not a silently un-gated behavior. Reply-content checks (`reply_excludes*`) miss on a
silent reply: saying nothing is not "naming no internals".

### Stub coverage

A refused call is the harness's gap — an unstubbed side-effecting tool, or a tool test
mode cannot serve (missing capability; those are refused up front rather than allowed
to fail in a way production never does). So is a `canned` call: an unstubbed MCP tool
answered with an empty stand-in. Whatever the model
does next is scored against it. The CLI records each case's worst run in
`stub-coverage.json` (committed, so the gate can't pass vacuously on a clean clone).
A case fails when its count exceeds its allowance.

To accept a known gap, add `"allowUnstubbed": { "count": 1, "reason": "…" }` to the case's
entry. The reason is required. CI (`tests/unit/scenarios/cases.test.ts`) checks that
every case loads and has a well-formed entry.

## Writing a case

Cases are `cases/NN<letter>-<slug>.yaml`, numbered by #1956's list. Start the file with a
comment that cites the rule it tests: a section of `agents/coordinator.yaml`, or the
trigger guidance in `src/agents/prompts/` that now carries it (#1959). A stub that stands
in for a tool whose real result carries `next_step` must carry it too. Two
principles:

- **Make the wrong answer available and attractive.** Stub the wrong channel so it
  succeeds. Hand the model a specialist result full of internals when testing that it
  doesn't relay them.
- **Assert tool calls in code.** Use the judge only for prose ("asks which one",
  "reports progress honestly"). Every case has at least one `check`.

```yaml
name: transfer-ownership trivial yes      # unique
description: >                            # shown to the judge
  …
tags: [outbound-context, routing]
delegation: stubbed                       # stubbed (default) | real — see Real delegation
release_gate: true                        # optional; false = only on demand
runs: 5                                   # optional; CLI --runs overrides
timeout_seconds: 300                      # optional
known_failure: { issue: "#1234", reason: … }   # optional; reported, not gated
stub_sets: [human-channels]               # optional; `defaults` always applies
seed:
  contacts:                               # → {{contact:<key>}}
    - key: sam
      display_name: Sam Rivera
      tier: known                         # known | unknown
      kind: person                        # person | organization | automated
      channel: email
      identifier: sam@example.test        # always under example.test
  outbound_context:                       # → {{entry:<key>}}
    - key: offsite
      channel: signal
      agent: ceo-inbox
      content: Draft reply … Want me to send it?
      expected_reply: approval to send
      delegation_hint: ceo-inbox
      metadata: { bind_reply: true }      # optional
      sent_minutes_ago: 12                # optional, default 10
      resume:                             # optional → metadata.resume_token, {{resume_token:<key>}}
        agent: research-analyst           #   a relayed clarification (encodeResumeToken)
        original_task: …
        context: …
  bullpen:                                # → {{thread:<key>}}
    - key: brief
      topic: Q3 competitor brief
      creator: research-analyst
      participants: [research-analyst, coordinator]
      content: Opening message.
      mentions: []
inbound:
  from: principal                         # principal | bullpen | scheduler | <contact key>
  channel: cli                            # principal only; default cli
  thread: brief                           # bullpen only
  content: "Yes"
  email: { nylas_message_id: …, account: ops, auto_generated: false }   # email inbound only
tool_stubs:
  delegate:
    - match: { agent: ceo-inbox }         # subset match; null = argument absent
      return: { agent: ceo-inbox, response: Sent. }
    - match: {}
      error: specialist unavailable       # a scripted failure
  calendar-list-events:
    - agent: calendar                     # only this agent's calls (real delegation)
      match: {}
      return: { events: [], count: 0 }
expected_behaviors:
  - id: routes_to_owner
    weight: critical                      # critical | important | nice-to-have
    description: Delegates to ceo-inbox with the entry id.
    check:                                # omit to have the judge score it
      called: delegate                    # or: not_called: [..] | order: [a, b]
      with: { agent: ceo-inbox }          #     | reply: no_reply | not_no_reply
      contains: { task: "{{entry:offsite}}" }   # | reply_excludes: [regex]
      max: 1                              #     | reply_excludes_internal_names: true
      success: true                       #     | briefed: <agent> + brief_contains: [..]
      returns: { outbound_entry: { status: released } }   # | any_of: [checks]
failure_modes:
  - Replies "Done!" without delegating
```

`success` is only valid on `called`. It keeps calls whose result has that value, and
`min` / `max` count only those calls. A refused send still counts for `not_called`.

`returns` (on `called` and `not_called`) keeps calls that succeeded with result data
containing it, as a nested subset: `not_called: [delegate]` with `returns: { declined: true }`
passes unless a specialist declined. `called` may list several tools; their matching calls
are counted together (`called: [signal-send, email-send]` with `max: 1`).

`called`, `not_called` and `order` read the coordinator's calls. With real delegation they
can read another agent's (`agent: calendar`) or every agent's (`agent: any`). `briefed:
<agent>` passes when a real run of that specialist received a brief containing every string
in `brief_contains`: the brief after the delegate handler's additions, such as the
`Message ID:` and `Account:` lines (#1909) or a resume's rebuilt brief.

`{{principal_contact_id}}` resolves too. A placeholder that names nothing the case seeds is
a load error.

**Dates are relative to the run.** Never write an absolute date the model reasons about
(a meeting, a free slot, a job's next run): it goes stale, and the case starts testing
the calendar instead of the coordinator. Use the date placeholders smoke uses
(`tests/shared/date-placeholders.ts`), in the principal's timezone:

| Placeholder | Example on Mon 2026-10-05 |
|---|---|
| `{{day:next-monday+1}}` | Tuesday, October 13 (Tuesday of next week) |
| `{{date:today+1}}` | 2026-10-06 |
| `{{time:next-monday 09:00}}` | 2026-10-12T09:00:00.000-04:00 |
| `{{weekday:today}}` | Monday |
| `{{at:now+60m}}` | an hour from now, same format as `time` |
| `{{timezone}}` | America/Toronto |

A day is `today`, `today±N` or `next-<weekday>[+N]`, where `next-<weekday>` is the first
one strictly after today. They work in `seed`, `inbound`, `tool_stubs` and
`expected_behaviors`, and resolve once per run against that run's clock, which the run
records (`clock`) so rating uses the same days. A malformed one is a load error. They are
refused in `description` and `failure_modes`, which reach the judge as written: say
"next week" there. Past timestamps (a fact's `last_confirmed_at`) can stay absolute.

After adding a case, run it (`--case`, a few runs) so the CLI records its stub coverage,
and commit the updated `stub-coverage.json`.

## Real delegation

`delegation: real` (#2027) lets `delegate` run. Production's handler does everything it does
in production: it links and settles the `[ACTIVE OUTBOUND CONTEXT]` entry the reply answers,
stamps the email `Message ID` / `Account` lines into the brief, takes the
`pending_delegations` dispatch claim, publishes the `agent.task` with the forwarded
originator (so the specialist builds its requester-identity block, #1871), and waits for
the answer with production's wait and timeout. The specialist runs in the same case context,
under the same stub layer.

What test mode adds for it, and nothing else:

- The specialist's conversation is named `scenario-delegate-…` (a `conversation_id` the
  model chose is kept within the run, never shared across runs), so the run can clean it.
- The ExecutionLayer gets an outbound-context service narrowed to the run's own entries
  (`scopedOutboundContext`, `seed.ts`), and production's delegation claims
  (`delegationClaims` on the test-mode stack).
- `delegate`, `context-bridge-keep-open` and `context-bridge-clear` run unstubbed in such a
  run (`REAL_IN_DELEGATION`, `stub-layer.ts`). The two context-bridge tools write only the
  run's entries. Every other rule is unchanged: a specialist's unstubbed send is refused.
  `context-bridge-release` still needs the task repo, which test mode never has, so a case
  stubs it.

**Timeouts.** A real-delegation run waits for the longest delegate wait any specialist gets
(from `expected_duration_seconds`, or `delegate.defaultTimeoutMs`), plus two minutes, unless
the case sets `timeout_seconds`. So a slow specialist normally ends as production's delegate
timeout result (`failed`, `reason: timeout`, `possibly_succeeded`), which the case scores
like any other result. If the run's own wait runs out first while a `delegate` call is still
waiting, the run is recorded with `timeoutKind: delegate_wait` and reported as a slow
specialist, apart from a stuck run (`timeoutKind: run`). Both fail the gate: neither run
was scored.

**Cost.** Each specialist turn is several more model calls, and the specialists' spend is
reported per agent: per case in the run output, per run and case in the results JSON
(`usage.byAgent`), and for the suite in the summary. On the 2026-10-09 baseline (below), a
real-delegation run cost $0.01 to $0.04 with its judging, two to five times a stubbed run,
and took 14 to 133 seconds on average. The three gated cases add about $0.25 and two minutes
to a release gate run.

### Which real-delegation cases gate a release

The release gate runs three of them (`release_gate` left at its default): the paths no
stubbed case can reach, behind bugs that took the coordinator down or lost the principal's
answer.

| Case | In the gate | Why |
|---|---|---|
| 16a transfer ownership | yes | The answer reaches the entry's owner and the owner acts on it, across two agents (#1972). Whether the platform then releases the entry is scored but not gated (below). |
| 16d clarification resume | yes | The resume token round trip: only the real handler rebuilds the brief (#1858, #1893). |
| 16f principal request over email | yes | The specialist treats the principal's request as the principal's (#1871, a P1 outage). |
| 16b calendar borrow | on demand | The relay half is covered by stubbed cases; the identity half by 16f. |
| 16c calendar read fails | on demand | Failure honesty (#1854); a stubbed failing result covers the coordinator half. |
| 16e email identifiers | on demand | The stamping is deterministic and unit-tested (`delegate.test.ts`); this checks it end to end. |
| 16g one message per item | on demand | Duplicate sends (#1860, #1917); the stubbed cases cover the coordinator's own sends. |
| 17a scheduled job tells principal | on demand | A scheduler turn's reply reaches no one (#2091). The dispatcher audits a reply that skipped the send, so a miss is visible in production. |

Run them all with `pnpm scenarios --on-demand`, or one with `--case`. Before changing a
specialist prompt or the delegate handler, run `--tags real-delegation`.

Baseline: `deepseek/deepseek-v4.1-flash` (the production standard tier), 5 runs each,
2026-10-09, all seven cases in one suite run at `da43807e`, after the coordinator prompt
trim (#1954). Every critical behavior passed all five runs, with no stub holes. Spend is for
the five runs, judge included.

| Case | Score | Below 100% | Avg run | Spend |
|---|---|---|---|---|
| 16a transfer ownership | 100% | | 34s | $0.08 |
| 16b calendar borrow | 96% | `one_read` 3/5: twice the coordinator delegated before resolving the date, the delegate guard refused it ("requires date-resolve first"), and it re-delegated after `date-resolve` | 14s | $0.05 |
| 16c calendar read fails | 100% | | 38s | $0.09 |
| 16d clarification resume | 100% | | 35s | $0.13 |
| 16e email identifiers | 100% | | 133s | $0.20 |
| 16f principal request over email | 100% | | 16s | $0.06 |
| 16g one message per item | 100% | | 53s | $0.15 |

17a was measured separately on 2026-10-10 (#2091), three times at 5 runs: 80%, 100%, 80%
on `one_send_to_principal`, about $0.12 a time. Both misses were the coordinator searching
only its own mailbox, never asking ceo-inbox, and ending with `NO_REPLY`. That is a search
miss, not a dropped reply. With the turn guidance switched off it also scored 80%: the
one-reply-no-send failure from the 2026-10-09 incident did not recur in five runs, so the
case guards the delivery path rather than reproducing the incident at a measurable rate.

Two checks are scored but deliberately not critical, because each was measured at 4/5 before
this baseline, exactly on the 80% line, where one more miss in a sample of five fails the
release:

- 16a `platform_released_entry`. In one measurement ceo-inbox called
  `context-bridge-keep-open` after drafting, once in five runs, so the entry stayed open
  (20/20 since). In another, it released the entry itself although the platform had
  (`no_second_release`, also `important`).
- 16d `resumes_with_token`. It is an exact match on the 700-character token, so a
  transcription slip fails it even when the resume works: one run miscopied one character
  and the brief was still rebuilt. `specialist_gets_resumed_brief` is the check that gates
  the resume.

Raise either to `critical` only once a larger sample clears 80% with room.
