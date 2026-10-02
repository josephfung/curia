# Coordinator scenario suite

Behavioral tests for the coordinator rules that only its prompt enforces (#1956). Each
case is one inbound message with seeded state and stubbed tools. It runs N times on the
production prompt and the model you choose. A behavior is scored either in code
(was `delegate` called with this entry id?) or by an LLM judge that sees the tool calls
and the reply. A `critical` behavior must pass at least 80% of its runs, or the suite
exits non-zero.

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
| `--allow-other-connections` | Run even though another client is connected to the database (see below). |

`SCENARIO_TIMEOUT_MS` sets the default per-run wait (180s). A case can set its own
`timeout_seconds`.

### What it needs

- `DATABASE_URL` pointing at a **migrated** database with a principal. The suite is meant
  for the local dev database, the same one smoke uses.
- `SECRET_ENCRYPTION_KEY`. LLM keys come from the vault only (#911). The vault needs:
  - `openrouter_api_key`, for the judge (`openai/gpt-4o` through OpenRouter) and for
    OpenRouter models such as the production standard tier;
  - `anthropic_api_key`, if you run an Anthropic model;
  - `openai_api_key` (valid), for embeddings. Seeding a contact creates its KG node.

  To add one key without touching the others, put it in `.env` and blank the rest. A
  variable already set in the shell beats `--env-file`, and empty values are skipped:

  ```bash
  ANTHROPIC_API_KEY= OPENAI_API_KEY= API_TOKEN= WEB_APP_BOOTSTRAP_SECRET= NYLAS_API_KEY= \
  NYLAS_GRANT_ID= NYLAS_SELF_EMAIL= TAVILY_API_KEY= pnpm run seed-vault   # seeds OPENROUTER_API_KEY only
  ```

- **No running Curia instance on that database.** A run writes real rows (see below), and
  a live instance would act on them. The CLI refuses to start while any other client is
  connected (`pg_stat_activity`). Stop the instance (`docker stop curia-curia-1`). Pass
  `--allow-other-connections` only when the other client is not Curia, such as a psql
  session.

### Output

- A line per run, listing the tools called. `name!` means the stub layer refused the call.
  `name?` means a real read-only tool failed because test mode can't serve it.
- Per behavior: its pass rate, and an example justification when it is under 100%.
- `tests/scenarios/results/<timestamp>.json` (gitignored), with the commit, the model and
  every run's tool calls, reply and ratings.
- `tests/scenarios/stub-coverage.json` (committed). See [Stub coverage](#stub-coverage).
- **Exit 1** when any of these is true:
  - a critical behavior is under 0.8;
  - a run errored (timeout, `agent.error`);
  - a case's worst run had stub holes above its allowance;
  - the CLI found a case problem before running.

## The gate

A `critical` behavior's pass rate is the mean over runs (PASS = 1, PARTIAL = 0.5,
MISS = 0), and it must be at least **0.8**. The default is **5 runs** because the gate's
discrimination depends on the run count. The figures come from curia-deploy's eval README
(binomial):

| Runs | 0.8 means | Fails a truly 95%-reliable behavior | Catches a truly 60% behavior |
|---|---|---|---|
| 3 | 3/3 | 14.3% | 78.4% |
| **5** | **4/5** | **2.3%** | 66.3% |
| 9 | 8/9 | 7.1% | 92.9% |

At 3 runs the gate demands unanimity and is flaky. At 5 runs it rarely blocks a good
prompt. Use 9 runs for a decision that needs to catch a mediocre behavior.

## How a run works

1. **Seed** the case's rows through the real services (see the next section).
2. **Send** the inbound through production's Dispatcher, which resolves the sender,
   injects `[ACTIVE OUTBOUND CONTEXT]` and builds the `agent.task`. Bullpen cases instead
   post on the thread and publish `agent.discuss`, which production's `BullpenDispatcher`
   turns into the coordinator's task.
3. **Capture** `tool.invoke` / `tool.result` and the coordinator's `agent.response` as the
   `system` layer. A `NO_REPLY` turn, or a reply Gate C holds for a non-principal, still
   ends the run. The runtime publishes an exact `NO_REPLY` as empty content with
   `suppressDelivery` (#1732), so capture restores the sentinel.
4. **Clean up** every seeded row and the run's own conversation rows.
5. **Rate:** apply each `check` in code and send the other behaviors to the judge, one run
   at a time.

### Seeded state and the shared database

| State | Seeded with | Kept from interfering |
|---|---|---|
| Sender contacts | `ContactService.createContact` + `linkIdentity` | Tagged in `notes`, deleted with their KG node after the run. A leftover from a crashed run is only removed if it carries the tag. |
| Outbound-context entries | `OutboundContextService.register`, backdated to `sent_minutes_ago` | The Dispatcher's `getActive()` returns only this run's entries, each read through the real `getEntry` SQL. Deleted after the run. |
| Bullpen threads | `BullpenService.openThread` | Runtimes see only this run's threads (the `wrapBullpenService` stack option). Deleted after the run. |
| Scheduler jobs | the `scheduler-list` stub | Never written. A real row would be fired by any scheduler that comes up later. |
| The run's conversation | | `working_memory`, `conversation_checkpoints` and `conversation_resolved_entities` rows are deleted. Otherwise *contact recent history* injects one principal case's turns into the next. |

`audit_log` keeps the runs' events. It is append-only by design.

### Stubs, and why nothing can send

The stub layer (`stub-layer.ts`) wraps the test-mode ExecutionLayer:

1. A **matching stub** answers the call. The real tool never runs.
2. **No stub, and the tool must be stubbed** (`action_risk` above `none`, or `delegate`):
   the call is refused with a `<skill_error>`. It never falls through. The runtime formats
   the error as production's `<task_error>`.
3. **No stub, read-only tool:** the real tool runs (memory reads, `date-resolve`).

This sits on top of the test-mode stack's own guarantee: a gateway with no transport
client (spec 16). So a run cannot send, and `tests/unit/scenarios/stub-layer.test.ts`
asserts that unstubbed and stubbed sends never reach the real tool. `delegate` is always
stubbed, so no specialist runs: the suite tests the coordinator's decisions.

**Stub sets** live in `stubs/`. A case can name some in `stub_sets`, and its own stubs for
a tool are matched first.

- `defaults` applies to **every** case. It is an empty office: reads that test mode
  can't serve (`email-list` with no mail client, `task-list`, `doc-search`, …) answer as a
  quiet day instead of failing in ways production never does.
- `human-channels` makes every send succeed. `deferred-work` does the same for creating
  tasks and jobs.

**A forbidden tool must be stubbed to succeed.** If a behavior says `not_called:
[signal-send]`, the case must stub `signal-send` (usually through `human-channels`). The
wrong path has to be available, or the case tests a refusal instead of the model's choice.
The CLI checks this before any paid call.

### Stub coverage

A refused call, or a failed passthrough read, is the harness's gap. Whatever the model
does next is scored against it. The CLI records each case's worst run in
`stub-coverage.json` (committed, so the gate can't pass vacuously on a clean clone).
A case fails when its count exceeds its allowance.

To accept a known gap, add `"allowUnstubbed": { "count": 1, "reason": "…" }` to the case's
entry. The reason is required. CI (`tests/unit/scenarios/cases.test.ts`) checks that
every case loads and has a well-formed entry.

## Writing a case

Cases are `cases/NN<letter>-<slug>.yaml`, numbered by #1956's list. Start the file with a
comment that cites the rule it tests (section of `agents/coordinator.yaml`). Two
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
stub_sets: [human-channels]               # optional; `defaults` always applies
seed:
  contacts:                               # → {{contact:<key>}}
    - key: sam
      display_name: Sam Rivera
      tier: known                         # known | trusted | unknown
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
  from: principal                         # principal | bullpen | <contact key>
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
failure_modes:
  - Replies "Done!" without delegating
```

`{{principal_contact_id}}` resolves too. A placeholder that names nothing the case seeds is
a load error.

After adding a case, run it (`--case`, a few runs) so the CLI records its stub coverage,
and commit the updated `stub-coverage.json`.
