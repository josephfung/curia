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
a release-gate result, and the results JSON records the filters.

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
  return (e.g. `date-resolve` rejecting an expression), not a harness gap.
- Per case, once its runs are rated: its estimated spend, then per behavior its pass rate
  and an example justification when it is under 100%.
- In the summary, each case's spend and the run's total, split by agent and judge. The
  results JSON holds the split per run, per case and for the suite (`usage`). These are
  estimates from registry prices; see
  [docs/dev/smoke-tests.md](../../docs/dev/smoke-tests.md#concurrency-cost-and-provider-failures).
- `tests/scenarios/results/<timestamp>.json` (gitignored), with the commit, the model and
  every run's tool calls, reply and ratings.
- `tests/scenarios/stub-coverage.json` (committed). See [Stub coverage](#stub-coverage).
- **Exit 1** when any of these is true:
  - a critical behavior fully passed fewer than 80% of its runs;
  - a run errored (timeout, `agent.error`, a `model.fallback`, seeded state not visible);
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
   `suppressDelivery` (#1732), so capture restores the sentinel.
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
| Scheduler jobs | the `scheduler-list` stub | Never written. A real row would be fired by any scheduler that comes up later. |
| The run's conversation | | `working_memory`, `conversation_checkpoints` and `conversation_resolved_entities` rows are deleted. |
| Prior history | | Withheld. *Contact recent history* (a sender's turns from other conversations) returns nothing during a run (the `wrapWorkingMemory` stack option), so a case never inherits smoke runs' or the real principal's turns from the dev database. |

`audit_log` keeps the runs' events. It is append-only by design.

**Interrupted runs.** Every fixture carries a marker: contacts a `notes` tag, their KG
nodes `source = 'scenario-test'` (the suite mints each fixture's node itself, so a contact
never adopts a real node), entries a `scenario-origin-` conversation id, threads a
`scenario:` `source_message_id`. On Ctrl-C/SIGTERM, and at every start-up, the CLI sweeps
anything carrying those markers — and nothing else.

### Stubs, and why nothing can send

The stub layer (`stub-layer.ts`) wraps the test-mode ExecutionLayer:

1. A **matching stub** answers the call. The real tool never runs. A success stub for
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
asserts that unstubbed and stubbed sends never reach the real tool. `delegate` is always
stubbed, so no specialist runs: the suite tests the coordinator's decisions.

**Stub sets** live in `stubs/`. A case can name some in `stub_sets`, and its own stubs for
a tool are matched first.

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
  email: { nylas_message_id: …, auto_generated: false }   # email inbound only
tool_stubs:
  delegate:
    - match: { agent: ceo-inbox }         # subset match; null = argument absent
      return: { agent: ceo-inbox, response: Sent. }
    - match: {}
      error: specialist unavailable       # a scripted failure
expected_behaviors:
  - id: routes_to_owner
    weight: critical                      # critical | important | nice-to-have
    description: Delegates to ceo-inbox with the entry id.
    check:                                # omit to have the judge score it
      called: delegate                    # or: not_called: [..] | order: [a, b]
      with: { agent: ceo-inbox }          #     | reply: no_reply | not_no_reply
      contains: { task: "{{entry:offsite}}" }   # | reply_excludes: [regex]
      max: 1                              #     | reply_excludes_internal_names: true
      success: true
failure_modes:
  - Replies "Done!" without delegating
```

`success` is only valid on `called`. It keeps calls whose result has that value, and
`min` / `max` count only those calls. A refused send still counts for `not_called`.

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
