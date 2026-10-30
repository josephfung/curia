# Scenario suite

Behavioral tests for the rules that only an agent's prompt enforces: the coordinator's
(#1956) and the specialists' (#2025). Each case is one inbound message with seeded state
and stubbed tools. It runs N times on the production prompt and the model you choose. A
behavior is scored either in code (was `delegate` called with this entry id?) or by an LLM
judge that sees the tool calls and the reply. A `critical` behavior must fully pass at
least 80% of its runs, or the suite exits non-zero.

Most cases test the coordinator. A case can instead fire a task straight at a specialist
(see [Cases for a specialist](#cases-for-a-specialist)), and a deployment can run its own
agents' cases on this runner (see [A deployment's own agents](#a-deployments-own-agents)).

Smoke (`tests/smoke/`, spec 16) asks "does the whole stack produce a good answer?". This
suite asks "did the agent make the right decision?", which is usually a tool call: the
coordinator routed instead of answering, released the entry, edited instead of
duplicating; a specialist placed the hold, linked the child task, kept the slot string.

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

**Every run costs money:** each case runs 5 times by default, and the judge is billed too. The unfiltered suite is the release gate. While developing, run only the cases your change touches, with few runs, and compare against saved transcripts rather than re-running `main`.

| Flag | Meaning |
|---|---|
| `--model <id>` | Route every agent to this model (registry id). Default: the configured `model_routing`. |
| `--reasoning-effort <e>` | Reasoning effort for agent turns (ADR-048): `low` sets every tier; `fast=none,standard=low` sets only the tiers named. Boot fails if a tier's model does not list the effort. The run header and results record the arm. |
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
  - for `through_gateway` cases, the key of the band-review judge's provider
    (`escalation.judge.model`: `claude-haiku-5-5`, so `anthropic_api_key`, by default).
    Band review without its judge holds every detected item, so the CLI refuses to start
    when a selected case is `through_gateway` and that key is missing, and a stack booted
    without the check errors each such run instead of scoring it;
  - `openai_api_key` (valid), for embeddings, unless `EMBEDDING_BASE_URL` names your own
    embedding server (ADR-051). Seeding a contact creates its KG node.

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
  results JSON holds the split per run, per case and for the suite (`usage`). Then the
  number of `web-search` calls that reached Tavily (`liveSearch` in the JSON), with a warning
  when Tavily refused any for an exhausted quota (HTTP 432 or 433). These are
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
   `{"task": <content>}`, no Dispatcher. Task-wake cases publish what a task's `wake_at`
   fires: the body `formatTaskWakeContent` builds for `Scheduler.fireJob` from the case's
   `task` (with the wake instruction), its intent anchor and the bound-task metadata. No
   task row is written; the case stubs the task tools it expects on the task's `id`.
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
| Sign-in verifications (#2017) | the verification runtime's `open`, then backdated (and closed, for a non-pending `status`) | The coordinator's "## Sign-in verifications" block, the Dispatcher's code tracking and the ExecutionLayer see only the run's rows (`scopedVerification`, the `wrapVerification` stack option), and only the run's sessions read as alive (`browserSessionAlive`). Cases seeding one site never run at once (one pending row per site). Deleted after the run. |
| Principal identities (#2017) | `seed.principal_identities`: a verified, active identity for the principal, added only when they have no active one on that channel | Labelled `scenario-fixture (#2017)`; cleanup deletes only the row its run added, and the sweep only labelled rows. Cases adding one on the same channel never run at once. A raw insert, so the principal's identity list in every agent's prompt (read at boot) is unchanged. |
| The principal backlog (prompt trim PR 7) | `seed.backlog` counts | The Dispatcher's backlog line reads the run's own counts (`scopedPrincipalBacklog`), never the shared tables. A case stubs the list tools to show the items its counts promise. |
| Pinned context (#2339) | `seed.pinned`: `/shared/` document text and config values by key, and entries whose read fails | Agents' `## Pinned context` block reads the run's own values (`scopedPinnedContextReader`, the `wrapPinnedContextReader` stack option), never the copied database's documents or settings. An entry the case does not name reads as not yet created or not set. A write is the case's to stub (`doc-write`, `config-store`). |
| Scheduler jobs | the `scheduler-list` stub | Never written to the database. Within a run, a later list replays that run's stubbed creates, edits and cancels onto the stub. |
| The run's conversation | | `working_memory`, `conversation_checkpoints` and `conversation_resolved_entities` rows are deleted. |
| Specialists' conversations (real delegation) | | The same rows for each `scenario-delegate-…` conversation. A specialist the run abandoned is cleaned again when it finishes. |
| The principal's later turn (`inbound.then`, #2312) | | The same rows for its `scenario-then-…` conversation, and what its tools wrote there. |
| Delegation claims (real delegation) | production's `pending_delegations` claims | Rows whose origin is the run's conversation or whose delegate conversation is a specialist's are deleted. |
| Entries a specialist changes or registers | the run-scoped outbound-context view | Every read or write outside the run's entries finds nothing. A registered entry joins the run's and is deleted with them. |
| Standing tasks (#2312) | `seed.tasks`: an open `tasks` row with its originator, as `task-create` writes one, but no bus event and no wake job | `created_by` is `scenario-suite (#2312)`; cleanup and the sweep delete only rows carrying it. The Dispatcher's outreach link reads a task's status only for the run's own. |
| Outreach rows (#2312) | `seed.outreach`: a `task_outreach` row, inserted as it is (not merged into another open row) | The Dispatcher's outreach link (`OutreachMatcher`) sees only the run's seeded rows and the rows its sends wrote (`scopedOutreachRepo`). Deleted after the run, with what its sends recorded. |
| What through-gateway sends write (#2312) | the gateway's approvals, the principal's answers to asks, outreach records | Approvals, `disclosure_decisions` and `task_outreach` rows in the run's conversations are deleted after the run; approve-action and deny-action see only the run's approvals (`scopedActionLog`). |
| Prior history | | Withheld. *Contact recent history* (a sender's turns from other conversations) returns nothing during a run (the `wrapWorkingMemory` stack option), so a case never inherits smoke runs' or the real principal's turns from the dev database. |

`audit_log` keeps the runs' events. It is append-only by design.

**Interrupted runs.** Every fixture carries a marker: contacts a `notes` tag, their KG
nodes `source = 'scenario-test'` (the suite mints each fixture's node itself, so a contact
never adopts a real node), entries and verifications a `scenario-origin-` conversation id (or, registered
during a run, the run's or a specialist's), threads a `scenario:` `source_message_id`,
specialist conversations a `scenario-delegate-` id, and delegation claims those
conversations. Seeded tasks carry their `created_by` marker; seeded outreach, and what
through-gateway sends wrote, a run's or a `scenario-origin-` conversation id. A through-gateway
Signal third party's conversation, `signal:<fixture number>`, has no prefix of its own: the sweep
finds it by the exact numbers the loaded through-gateway cases seed. On Ctrl-C/SIGTERM, and at
every start-up, the CLI sweeps anything carrying those markers — and nothing else.

### Stubs, and why nothing can send

The stub layer (`stub-layer.ts`) wraps the test-mode ExecutionLayer:

1. A **matching stub** answers the call. The real tool never runs. Within one run, scheduler, task and draft reads then replay that run's stubbed writes onto the stub, the same way smoke does (`docs/dev/smoke-tests.md`). A stub whose match names `draft_id` still answers that `ceo-inbox-read` itself. A success stub for
   `email-send`, `email-reply`, or `email-draft-save` still refuses an attachment whose `file_url` is outside
   the temp store, with the error production's gateway returns (#2059). That call is
   recorded as stubbed: the model is told what went wrong and can recover, and it is
   not a stub hole.
2. **No stub, and the tool must be stubbed** — `action_risk` above `none`, `delegate`, or
   any tool declaring the `executionLayer`, `outboundGateway`, `actionLogRepo`,
   `secretCapture`, `approvalDelivery` or `disclosureDecisions` capability (some of those
   say `none` but can re-invoke tools, send or resolve approvals): the call is refused with a `<skill_error>`. It never falls through.
   The runtime formats the error as production's `<task_error>`.
3. **No stub, read-only tool test mode can serve:** the real tool runs (memory reads,
   `date-resolve`, `web-fetch`). `web-search` is one too, but `defaults` stubs it, because each real
   call spends a Tavily credit (#2106). Only a case with `live_search: true` reaches it. A read test mode cannot serve (missing capability) is
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
6. **A `through_gateway` case's send and approval tools** run for real (#2312): see
   [Sends through the gateway](#sends-through-the-gateway). Every other case is unchanged.

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
  task is refused and counted (#2059). `web-search` finds nothing. A case that needs
  results stubs them, as 16d does for its research specialist. A case about searching
  itself sets `live_search: true`, which drops this one stub, and may not stub
  `web-search` itself.
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

Cases are `cases/NN<letter>-<slug>.yaml`, numbered by #1956's list (specialists
from 30, #2025). Start the file with a comment that cites the rule it tests: a section of the
agent's YAML, or the trigger guidance in `src/agents/prompts/` that now carries it (#1959). A stub that stands
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
live_search: true                         # optional; web-search runs for real (Tavily credits)
identity: style-brief-dry                 # optional; run-level office identity, see Style cases
autonomy: { score: 84, gating: band }     # optional; this case's autonomy, see Per-case fixtures
through_gateway: true                     # optional; sends run production's review, see Sends through the gateway
seed:
  contacts:                               # → {{contact:<key>}}
    - key: sam
      display_name: Sam Rivera
      tier: known                         # trusted | known | unknown
      kind: person                        # person | organization | automated
      channel: email
      identifier: sam@example.test        # under a .test name (example.test, vendorco.test)
      # principal_wrote: true             # email only: the principal has mailed Sam (see below)
  outbound_context:                       # → {{entry:<key>}}
    - key: offsite
      channel: signal
      agent: ceo-inbox
      content: Draft reply … Want me to send it?
      expected_reply: approval to send
      delegation_hint: ceo-inbox
      metadata: { bind_reply: true }      # optional
      recipients: [sam]                   # optional: contact keys it was sent to (#2261)
      replies:                            # optional: what they already sent back; a task
        - { from: sam, content: … }       #   wake lists it (from: one of recipients)
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
  verifications:                          # → {{verification:<key>}} (the row's id), #2017
    - key: otp
      site: example-insurer.ca            # the site the principal asked about
      page_domain: login.example-insurer.ca   # the page showing the challenge
      delivery: sms                       # email | sms | app
      browser_session_id: s-1             # the session the case stubs web-browser on
      task: 7a3c9e21-…                    # optional; a fixed UUID the task stubs match
      status: pending                     # optional; pending | expired | satisfied | abandoned
      requested_minutes_ago: 3            # optional; default 1 if pending, else 15
      session_alive: true                 # optional; default: alive while pending
  principal_identities:                   # optional; for an inbound as the principal on a channel
    - { channel: signal, identifier: "+15555550142" }   # the database's principal may lack (#2017)
  backlog:                                # optional; what the backlog line reports on a principal turn
    pending_approvals: 1                  #   decay_warnings, pending_approvals, principal_tasks;
    decay_warnings: 0                     #   absent counts are 0, and one must be positive
  pinned:                                 # optional; what agents' pinned_context reads (#2339)
    docs:                                 #   /shared/ path → document text, as the block shows it
      /shared/calendar/rules.md: |
        ## Drinks
        - Applies to: drinks
    configs:                              #   <namespace>/<key> → value
      ceo_inbox/decision_tagging: '{"enabled": true}'
    unavailable: [debrief/config]         #   reads that fail: the block shows them as unavailable
inbound:
  from: principal                         # principal | bullpen | scheduler | task-wake | <contact key>
  channel: cli                            # principal only; default cli
  thread: brief                           # bullpen only
  content: "Yes"                          # every kind but task-wake
  followup:                               # optional; a second message while this turn runs (#2018)
    after: first_tool_call                # or { ms: N } (an integer, 1..120000)
    from: principal                       # principal or a seeded contact key
    content: "actually, use email for the code, not SMS"
    channel: signal                       # optional; defaults to this inbound's channel
  email: { nylas_message_id: …, account: ops, auto_generated: false }   # email inbound only
  # email: { to: [dana], cc: [curia] }    # optional envelope; see Email envelopes
  task:                                   # task-wake only, in place of content
    id: 5f1c2d3e-…                        #   a fixed UUID the case's task-* stubs match on
    title: Collect comments on the deck
    intent: Collect both sets of comments, then summarize them.   # the intent anchor
    notes:                                #   progress.notes, oldest first
      - { at: "{{time:today-1 16:40}}", note: Priya replied; next, nudge Marcus. }
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
                                          #     | text: reply | {tool, arg} + max_words / excludes
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

`text` (#2143) limits what the agent wrote: `text: reply` reads its reply, `text: { tool:
signal-send, arg: message }` reads that argument of every call it made to the tool, and
each one must pass. `max_words` caps the word count; `excludes` lists case-insensitive
regexes none may match. Silence, or no call to read, is a miss.

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
| `{{date:workday+2}}` | 2026-10-07 (the second Monday-to-Friday day after today) |
| `{{timezone}}` | America/Toronto |

A day is `today`, `today±N`, `next-<weekday>[+N]` or `workday+N`, where `next-<weekday>` is
the first one strictly after today and `workday+N` the Nth weekday after it (on a Friday,
`workday+1` is Monday). They work in `seed`, `inbound`, `tool_stubs` and
`expected_behaviors`, and resolve once per run against that run's clock, which the run
records (`clock`) so rating uses the same days. A malformed one is a load error. They are
refused in `description` and `failure_modes`, which reach the judge as written: say
"next week" there. Past timestamps (a fact's `last_confirmed_at`) can stay absolute.

The judge sees the run's clock (`## When it ran`: weekday, date, time and timezone), so a
behavior such as "offers times a week or two out" can be judged against the dates in the
tool calls. Still put what code can check in a `check`: in practice the judge passes a
window that a hold outside it breaks (`not_called` with `contains: { start:
"{{date:today+1}}" }` catches that).

### Email envelopes

By default an email inbound's participants are the sender alone, as if Curia were its only
recipient. `inbound.email.to` and `cc` set the envelope the email adapter would see. Each
entry is `curia` (Curia's own address, `curia@example.test`), `principal`, a seeded contact
key, or an address under `example.test`. `curia` must appear exactly once. From them the
harness builds the adapter's metadata: the participants, the To list as primary
recipients, and `curiaRole: 'cc'` when `curia` is in `cc`. The Dispatcher then adds the
`[OWNER CC — …]` preamble and the thread-participants block, and the CC turn guidance
fires, as in production. The principal CCing Curia on an email to Dana:

```yaml
inbound:
  from: principal
  channel: email
  content: "Subject: …"
  email: { nylas_message_id: m-1, to: [dana], cc: [curia] }
```

### Senders the principal knows

The Dispatcher elevates a verified `unknown` email sender the principal knows to `known`
before routing (#2227, `src/contacts/principal-acquaintance.ts`). Two fields drive it:

- `inbound.email.sender_verified: true` is the adapter's `senderVerified` (SPF, DKIM and
  DMARC pass). The check runs only when it is set. Unset leaves it out of the metadata, so
  existing cases never meet the rule.
- `principal_wrote: true` on a seeded email contact means the principal has sent them mail:
  the run's stand-in for the principal's Sent folder answers yes for that address.

The scenario office's `security.principal_org_domains` is `example.test`, the test
principal's own domain. So a verified sender at `…@example.test` counts as a colleague, and
one at `…@lumen.example.test` does not.

The harness Dispatcher scores senders as production does: channel trust from
`config/channel-trust.yaml`, the `security.trust_score` weights and the confidence pipeline.
The stack's resolver evaluates production's permission model. So the coordinator sees the
same trust score and AUTHORIZATION section that production would show it.

After adding a case, run it (`--case`, a few runs) so the CLI records its stub coverage,
and commit the updated `stub-coverage.json`.

## Cases for a specialist

`agent: <specialist>` (#2025) points a case at a specialist: the inbound reaches it, its
reply ends the run, and checks, stubs and the judge read its calls unless they name
another agent. It hears from the places it does in production:

```yaml
agent: ceo-inbox
inbound:
  from: delegate            # the coordinator's delegate call
  requester: principal      # or a seeded contact key: whose request it is (default principal)
  email: { nylas_message_id: m-1, account: ops }   # optional: the stamped Message ID / Account lines
  content: "List my inbox rules."                   # the brief
```

- `from: delegate` publishes the agent.task production's delegate handler would
  (`skills/delegate/handler.ts`): the internal channel from the coordinator, the brief, the
  delegation origin, and the requester's originator and live-turn signal, so the specialist
  builds its requester-identity block and passes the same skill gates.
- `from: bullpen` with `thread:` posts on a seeded thread the agent participates in. Set
  `author:` to the participant posting it (default: the thread's creator), as when calendar
  answers a consult ceo-inbox opened.
- `from: scheduler` fires one of the agent's cron jobs: copy its `schedule:` task text.
- `from: task-wake` wakes one of its tasks; `task.tags` go on the bound task, as
  Scheduler.fireJob puts them.

Only the case's agent runs, so a stub or check scoped to another agent is a load error,
and `delegation: real` is for coordinator cases. A specialist case holds only its own
`tool_stubs` to the agent's reach: a shared set such as `human-channels` stubs sends a
narrow specialist never has, and those stubs go unused.

Specialist cases are numbered by agent: 30 ceo-inbox, 31 calendar, 32 meeting-debrief,
33 contacts. The ones that end in a bullpen reply run on demand (`release_gate: false`)
until #2126: in about a quarter of runs, on main's prompt as on any other, the specialist
repeats a `bullpen` reply with no `content` until its turn budget runs out, which errors
the run and would fail the gate. Each carries the tag `specialist-<agent>`, so `--tags specialist-calendar`
runs one agent's cases. Before changing a specialist's prompt, run its cases on both
prompts; see [A/B against main](#ab-against-main).

### A/B against main

`--overlay <dir>` lays a directory's `agents/`, `skills/` and `config/` over the checkout
(next section). A directory holding only `agents/<agent>.yaml` from `origin/main` is main's
prompt on this branch's harness, which is the main arm of an A/B:

```bash
mkdir -p /tmp/main-arm/agents
git show origin/main:agents/calendar.yaml > /tmp/main-arm/agents/calendar.yaml
pnpm scenarios --tags specialist-calendar --runs 5 --overlay /tmp/main-arm --coverage /tmp/ab.json --model …
pnpm scenarios --tags specialist-calendar --runs 5 --coverage /tmp/ab.json --model …
```

Pass a scratch `--coverage` for A/B runs, so only a clean run of the branch writes the
committed record.

## Style cases

The seven style cases, 40a–40g (#2143, tag `style`), measure how Curia writes: length,
filler and register, under a brief, dry office identity. Run them as a group:

```bash
pnpm scenarios --tags style --model deepseek/deepseek-v4.1-flash
```

A case's `identity: <name>` names a fixture in `identities/`: everything in the office
identity but the assistant (tone, standing preferences, constraints), and
a `judge_brief` the judge sees as "The office's configured style". The stack lays the
fixture over the database's identity in memory: every agent's block still comes from the
real renderer, and nothing is written to the identity history.

One stack serves a whole run, so a run has one identity. A case with a fixture runs only
in a selection of fixture cases alone, and all of them must name the same fixture:
- it is never in the release gate (the loader requires `release_gate: false`), and an
  unfiltered run leaves it out even with `--on-demand`;
- a wider selection that also picks ordinary cases (`--tags ceo-inbox`,
  `--tags specialist-ceo-inbox`) leaves it out and says so.

Length and filler are scored in code (`text` checks), register and kept content by the
judge. Only content is `critical`: brevity must never drop a fact. 40a needs a principal
with a Signal identity in the database the run uses. The design, and the baseline the
later tone & style PRs compare against, are in
[docs/wip/2026-10-15-tone-and-style-design.md](../../docs/wip/2026-10-15-tone-and-style-design.md#measurement).

## Per-case fixtures: autonomy

`autonomy: { score, gating }` runs a case at that autonomy score and gating (`tier`, or
`band` as production's deployment runs, #2159): the band descriptions in the prompt, the
ExecutionLayer's score-keyed gates, the content filter's tier-keyed rules and the
Dispatcher's relay Gate C all follow it. The OutboundGateway's band review follows it too,
for the sends that reach it: a `through_gateway` case's (see [Sends through the gateway](#sends-through-the-gateway)).
Every other case stubs its sends. The stack lays it
over the database's autonomy config in memory (`FixtureAutonomyService`,
`src/startup/test-mode-stack.ts`). Nothing is written.

Unlike `identity:`, it is the case's own (#2312). Each attempt enters its case's fixture
(`runWithAutonomyFixture`, an `AsyncLocalStorage`) around everything it does: the bus
delivers an event by awaiting every subscriber in the publisher's call chain, so the
dispatcher, the turns and their tool calls all read it. The gateway, the content filter
(through the gateway), the Dispatcher and the review ExecutionLayer read the gating from the
autonomy config on each call, not at construction.

The ExecutionLayer agents call reads the fixture's score but keeps its Gate C on tier gating,
as before #2312, unless the case is `through_gateway` (`agentLayerAutonomy`,
`src/startup/test-mode-stack.ts`). So a band fixture case that stubs its sends (25a–25n)
runs tier Gate C, with no escalation-judge call, exactly as on `main`; only a through-gateway
case's gates follow its fixture's band gating. So:

- cases under different fixtures, and cases without one, run in the same suite run, at
  `--concurrency` beside each other;
- a case with one can be in the release gate.

Inside each attempt the harness reads the autonomy config back before seeding. If the
case's fixture is not what the stack reads, the run fails with "autonomy fixture not in
force" (an errored run fails the gate). The header counts the fixture cases by fixture, the
summary marks each one ("autonomy 74 (band gating)"), and the results record them under
`caseAutonomy`.

Without a fixture, a case reads the database's score and takes gating from
`autonomy.gating` (so a curia-deploy `--overlay` gets band descriptions and band gates).
The CLI reads that back after boot and prints it ("Autonomy in force"). Stubbed tools still
answer before Gate A, so a case scores what the model chooses at that score, not
production's refusal.

### Principal-involved scheduling (25a–25n)

The principal CCs or forwards Curia on scheduling, a counterpart sends a booking link, or
someone the principal knows asks Curia for time. The design and the behaviors are in
[docs/wip/2026-10-21-principal-scheduling-scenarios-design.md](../../docs/wip/2026-10-21-principal-scheduling-scenarios-design.md).
All run real delegation, on demand. They form three batches:

```bash
pnpm scenarios --tags ps-core  --model …   # autonomy 84 (band): 25a, 25b, 25d, 25e, 25j–25n
pnpm scenarios --tags ps-ask   --model …   # autonomy 74 (band): 25c
pnpm scenarios --tags ps-prefs --model …   # autonomy 84 + identity scheduling-prefs: 25f–25i
```

**Why they stay out of the release gate (#2227).** They are the suite's most expensive
cases: real delegation, and about $0.05–0.10 a run. All 14 at five runs adds roughly $4 and
45 minutes to a gate. ps-prefs also needs an office identity, which applies to a whole run,
so the loader requires `release_gate: false` on it. (Their autonomy fixtures no longer keep
them out: since #2312 those are per case, so `--tags ps-core,ps-ask` can run as one batch.)

**When to run them instead.** Run all three batches, 9 runs each, before merging a change to:
- the coordinator's or the calendar specialist's prompts;
- the turn guidance (`src/agents/prompts/turn-guidance.ts`, `src/dispatch/turn-guidance-triggers.ts`);
- sender trust or authorization (`src/contacts/principal-acquaintance.ts`, the trust
  thresholds, `config/role-defaults.yaml`);
- the calendar tools.

Every critical behavior should hold at 8/9 or better. 25a sits near that line on `main`
as well: `coffee_shaped` was 7/9 in one 9-run measurement. A miss there is worth reading
before calling it a regression.

## Sends through the gateway

`through_gateway: true` (#2312) runs a case's sends the way production does, up to the
network. The send tools (`email-send`, `email-reply`, `signal-send`, `sms-send`,
`slack-send`, `send-draft`) skip the stub table and run their real handlers, through the
ExecutionLayer's gates and production's `OutboundGateway` review: PII detection and
redaction, the content filter, band review over the drafting turn's evidence (under the
case's `autonomy:` fixture), holds and personal-data asks, outreach records. So do
`deliver-approval`, `approve-action` and `deny-action`, so a held send can reach the
principal and be approved. Every other tool is stubbed or refused as in any case, and a
case may not stub a tool that runs for real.

**Nothing can send.** The stack builds this review on a second ExecutionLayer
(`recordSends`, `src/startup/test-mode-sends.ts`) that only these calls reach. Its gateway
has recording fakes in place of the Nylas, Signal, Slack and SMS clients (no real client
class is ever constructed) and no outbound queue, so nothing is deferred to a flush a real
instance would perform. What passes the review is kept in the run that sent it; a send
outside every run fails. The layer agents call keeps the no-send gateway, so a case without
the key runs exactly as before. `tests/unit/startup/test-mode-sends.test.ts` checks it.

**Relayed replies.** Curia's usual answer to a third party is its reply, which the dispatcher
relays as an `outbound.message` for the channel adapter to send. In a through-gateway run that
relay takes production's path too: the real `EmailAdapter` and `SignalAdapter` outbound side
(`subscribeOutbound`, never started: no poll, no socket) sends it through the recording
gateway, with the reply-all recipients, the quote, provenance, the relay hold recipe, the
gated-draft fallback and, for a held reply, the coordinator's approval-delivery wake. That
wake turn is filed under the run (its tools get the run's stubs, `deliver-approval` runs) and
its calls join the run's. A Signal third party's conversation is `signal:<their number>`, the
address the adapter replies to (cases seeding one identity never run at once); the principal's
Signal turns keep a `scenario-` conversation, so a reply relayed to them is not sent. Other
cases' relays stay on the bus, unsent, as before. Slack and SMS relays are not wired.

An `email-reply` fetches the message it answers: the fake mailbox serves the run's inbound
email, with an Authentication-Results header that passes only when the case sets
`inbound.email.sender_verified: true`.

**Approvals.** A held send, or a tool an ExecutionLayer gate holds (through production's
approval trigger), writes production's approval row under the run's conversation. The action
log approve-action, deny-action and approval delivery see is the run's: "approve" with no
number is the run's sole pending approval, another run's number or reference reads as not
found, and delivery claims and binds only the run's rows. An approval carrying personal
details must be delivered (`deliver-approval`) first, as in production.

Approving is elevated, so it needs a live principal turn. Two ways to give one:

- `inbound.followup` from the principal, joining a turn the principal started (a follow-up
  from anyone else is not queued into another sender's turn);
- `inbound.then`, the principal's next message as a turn of its own, once the first turn has
  ended. It arrives from the principal's verified identity on `channel` (default `signal`;
  seed one with `principal_identities` if the database's principal has none), in a second
  conversation filed under the run: same stubs, its calls listed with the run's, its rows the
  run's and cleaned with them. This is how a hold raised on a third party's turn is approved
  within the run. The checks read the run after this turn has settled; its reply is
  `then.reply` in the results. With `reply_to_approval: true` (email only, #2333) the turn is
  a reply on the thread of the approval email the run delivered to the principal, read from
  the `email-thread` binding approval delivery wrote; a run that delivered none errors. The
  approvals the principal's turn lists (`awaitingAnswers`) are production's read over the
  run's own conversations.

```yaml
inbound:
  from: pat
  content: Could you send the account number for the form?
  then:
    content: Yes, approve it.
    channel: signal
```

**Fail-open cap.** Band review holds every send once its judge has failed on more than five
in an hour. Production keeps one cap per process; here each run has its own, so one run's
judge failures never hold another's sends, and a run whose cap tripped is an error (it tested
the judge's outage, not the agent).

**Checks** read what the run sent, held and recorded, in code:

```yaml
check: { delivered: { channel: email, to: pat, cc_includes: principal, contains: [quote], excludes: ["130 692 544"], count: 1 } }
check: { not_delivered: { to: pat } }      # or not_delivered: true — nothing delivered at all
check: { held: { contains: [SIN] } }       # or held: true — an approval was raised this run
check: { not_held: true }                  # or not_held: { contains: [SIN] } — no such approval
check: { outreach_recorded: { domain: vendor.example.test, confirmed: true } }
check: { decision_recorded: { label: sin_ca, decision: "yes" } }
check: { reviewed: { label: phone_us } }   # or { label: phone_us, outcome: bounce } — the review ruled on it
check: { delivered: { to: pat, contains: ["692"], count: 0, own_text: true } }   # Curia's own words only
```

`to` and `cc_includes` name a seeded contact key, `principal`, or an address. `contains` and
`excludes` are case-insensitive substrings of the delivered subject and body (an email's
HTML reduced to text). An email draft is not a delivery; a sent draft is. Approval messages
`deliver-approval` sends to the principal are deliveries too, so `not_delivered: true` misses
on a run that delivered an approval; to check that nothing reached a third party, name them
(`not_delivered: { to: pat }`). "Nothing went out containing X" is
`delivered: { contains: [X], count: 0 }`. A justification never repeats a `contains` or
`excludes` term, or a `held` / `not_held` text: it says how many. `held` matches the
approval's description and what the principal is shown at its top (an ask's question).

A reply quotes the message it answers, and the sender's own details in that quote are not a
disclosure to them (the gateway exempts a quote everyone on the send was on). `own_text: true`
matches only the reply's own words: the subject and the body above the quote. So "Curia did not
send Pat the SIN Pat wrote to it" is `delivered: { to: pat, contains: [SIN], count: 0, own_text: true }`.

`own_text` falls back to the whole body when the delivery has no separate own text (no quote
to split off), so it fails closed only for `count: 0` checks: a quoted term then counts against
the case. For a positive check (`count` of 1 or more) it can match quoted text, so don't rely
on it to prove the reply itself said something.

On a case with `inbound.then`, each delivery records its turn: `first` before the principal's
next turn began, `then` from it on. `turn` narrows a `delivered` check to one (#2333), so
"nothing carrying the address reaches Dana before Avery answers" is
`delivered: { to: dana, contains: ["@example.test"], count: 0, turn: first }`: without it, a
detail leaked on the first turn and approved again on the second passes every other check.
The loader rejects `turn` on a case without `inbound.then`.

The `label` of `reviewed` and `decision_recorded` must be a detection label: a built-in
pattern name (`phone_us`, `sin_ca`, `email`, ...) or `extra_N` for the operator's Nth extra
pattern. The loader rejects any other, so a typo can't make a check pass or fail silently.

`reviewed: { label }` passes when band review ruled on a detected item with that label in a
send's own text (body or subject; a quote's items do not count), with that `outcome`
(`send`, `bounce`, `block`, `hold`) when set. It tells a run whose drafter never wrote the
item apart from one the review stopped, so a "nothing went out" check that passes because
nothing was ever drafted shows as not exercised. Make it `important`, not `critical`: whether
the drafter reaches for an item is the model's choice. The recording gateway records each
review's labels and outcome, never the values (`recordingBandReview`,
`src/startup/test-mode-sends.ts`).

These checks are allowed only on `through_gateway` cases.

**Seeds** these cases need: `tier: trusted` on a contact (granted after creation),
`seed.tasks` and `seed.outreach`:

```yaml
seed:
  tasks:                                   # → {{task:<key>}}, e.g. a task wake's inbound.task.id
    - key: onboarding
      title: Finish the vendor onboarding forms
      originator: principal                # principal | a seeded contact key
  outreach:                                # → {{outreach:<key>}}
    - key: forms
      task: onboarding                     # optional; a seeded task
      via: email                           # email | web_form | signal | sms | slack | phone | other
      org_name: Vendor Co
      domains: [vendorco.test]             # a .test name
      addresses: [pat@vendorco.test]
      contacts: [pat]                      # seeded contact keys
      summary: Sent the onboarding forms
      confirmed: true                      # an explicit act on a principal turn: a strong link
```

The Dispatcher links a reply to the run's own outreach as production does, without the
model step production uses for a last, weak-only match. Third parties' addresses and domains
may be under any `.test` name (`pat@vendorco.test`), and should be when a case relies on an
org-domain link: everything under `example.test` shares one registrable domain, the
principal's (`principal_org_domains`), so it never links by domain. The principal's own
identities stay under `example.test`.

**Cost.** Each through-gateway send calls the review's judges as production does: the
escalation judge (Stage 2.5, or band review under band gating) and the content filter's
Stage 2 judge. Budget a few judge calls per send on top of the agents' own.

## A deployment's own agents

A deployment repo (curia-deploy) keeps its agents' cases next to their prompts and runs
them on this runner:

| Flag | Meaning |
|---|---|
| `--overlay <dir>` | Lay the deployment's `custom/` over core's agents, skills and config, as its image does: agents and skills copied over core's, `config/skills.yaml` replaced, `config/local.yaml` added (`overlay.ts`). |
| `--cases <dir>` | Run these cases instead of `tests/scenarios/cases`. |
| `--stubs <dir>` | Stub sets searched before core's (a set here can replace one of core's). |
| `--coverage <file>` | Read and write this stub-coverage record instead of core's. |
| `--mcp-snapshots <dir>` | MCP tools/list snapshots searched before `tests/fixtures/mcp`, for the deployment's own servers. |

The results record the deployment repo's commit (`overlayCommit`) beside core's. The
database needs the `agent_registry` (and `tool_registry`) rows that enable the deployment's
agents, as its production database has them.

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

### Cases that need an opt-in agent

One stubbed case is on demand too: 21c route diagnostics question. diagnostics is opt-in
(`config/registry-defaults.yaml`, #1356), so it is in the coordinator's roster only where
`agent_registry` enables it. Enable it in the database the run uses, then run the case with
`--case`. Run it before changing diagnostics' `delegate_when`.

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

17a was measured separately on 2026-10-10 (#2091), about $0.12 per 5 runs. On the first
guidance wording it scored 80%, 100% and 80% on `one_send_to_principal`; both misses were
the coordinator searching only its own mailbox, never asking ceo-inbox, and ending with
`NO_REPLY`, a search miss rather than a dropped reply. With the guidance switched off it
also scored 80%: the one-reply-no-send failure from the 2026-10-09 incident did not recur
in five runs, so the case guards the delivery path rather than reproducing the incident at
a measurable rate. On the final wording (send only when the task asks to tell, notify or
remind the principal) it scored 100%. With the check tightened to require the `principal`
recipient (`sends_to_principal`) as well as one send in all, both critical checks again
passed 5/5. Its stubbed counterpart 17b, a maintenance job
that must send nothing, scored 100% in the gate.

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

### Mid-turn follow-up

`inbound.followup` publishes a second message on the same conversation while the first
turn is still running (#2018). `after: first_tool_call` holds that call and publishes
while it is in flight, or for five seconds. A reply with no tool call publishes at the
exit hook instead, before the turn finishes, so the correction drains there.
A follow-up drained at `turn_start` fails the run, and the drain points are
recorded on the run result.
`after: { ms: N }` waits, then publishes, and does not hold the tool. The harness does
not await either publish: awaiting the host waits for the whole turn, and awaiting the
follow-up waits until it is drained, which cannot happen while the first tool is held.

Capture still expects one reply. With injection on, the follow-up joins that turn.
With it off, the harness errors the run before publishing: a second live turn on
the same conversation is not a second reply, so it must not be scored. If the
follow-up is published and not queued within five seconds, the run fails the same
way. `26-mid-turn-correction` is in the release gate. The passing standard-tier
run with the official judge drained at `round:1`, and every critical check
passed. It is not a `known_failure`: that marker would hide a real miss. A
follow-up is only valid on a channel inbound (`principal` or a seeded contact),
and `from` is the same kind of sender. It carries no email envelope.
