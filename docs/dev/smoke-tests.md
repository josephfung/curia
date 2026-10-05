# Writing Smoke Tests

Curia's smoke test suite runs the full agent stack against real conversations and uses an LLM-as-judge to evaluate behavior. It's the best way to catch regressions and the easiest place for contributors to add meaningful coverage without touching core code.

**We'd love help here.** If you've found a behavior Curia handles poorly, or a scenario you'd like to make sure keeps working, a smoke test is the right way to encode it.

---

## How It Works

Each test is a YAML file describing a conversation and a list of expected behaviors. The runner:

1. Copies the database to a throwaway one, so nothing the agents write reaches the real database
2. Boots a headless Curia stack in test mode on the copy (full bus, agents, skills — no channels, and nothing can send) and seeds the fixture office
3. Plays through the conversation turns against the live Coordinator (or, for a [targeted case](#target-addressing-a-specialist), the specialist it names), recording its tool calls and replies
4. Sends the transcript + expected behaviors to an LLM judge (GPT-4o, through OpenRouter)
5. Scores each expected behavior as `PASS`, `PARTIAL`, or `MISS`
6. Applies the gate (below), retries each failing case once, writes an HTML report with the judge's justifications, exits `1` if any case still fails, and drops the copy

Cases run four at a time by default, and the summary prints what the run spent on model calls (see [Concurrency, cost and provider failures](#concurrency-cost-and-provider-failures)).

The judge provides a reasoning trace for every behavior rating — useful for debugging why a test passes or fails.

---

## Running the Tests

```bash
# Full suite on the production standard-tier model (what the release pre-flight runs)
pnpm smoke --model deepseek/deepseek-v4.1-flash

# Full suite on the configured model_routing
pnpm smoke

# Selected cases (substring match on name; repeat --case for several)
pnpm smoke --case "urgent" --case "board chair"

# Filter by tag
pnpm smoke --tags email-triage,briefing

# Print every agent's tool calls per case (what to stub when writing a case)
pnpm smoke --case "urgent" --show-calls

# One case at a time (default: 4 at once)
pnpm smoke --concurrency 1
```

Flags are parsed strictly: an unknown flag, a missing value or `--model=x` stops the run instead of being ignored. The database needs a principal contact, and `DATABASE_URL` must point at this machine (`--allow-remote-db` overrides). Before any case runs, every stub is checked against the tool registry: a misspelt tool name or input is an error, since such a stub would never fire. The `Commit:` line ends in `-dirty` when tracked files have uncommitted changes.

**Requirements:** `DATABASE_URL` (a migrated database with a principal contact) and `SECRET_ENCRYPTION_KEY`. Model keys come from the vault, never from env (#911): the model's provider key (`anthropic_api_key` or `openrouter_api_key`), plus `openrouter_api_key` for the judge.

**It runs on a copy.** Smoke copies `DATABASE_URL`'s database (`CREATE DATABASE <name>_smoke_<pid> TEMPLATE <name>`), runs every case there and drops the copy afterwards, including on Ctrl-C. Copies a crashed run left behind are dropped at the next start. Agents write contacts, knowledge-graph facts and settings as they work, and one early run on the dev database added 17 contacts and stored a fake Zoom link as the principal's. Postgres copies a database only while nothing else is connected to it, so stop the dev instance first (`docker stop curia-curia-1`). Contact recent history is withheld, so a case never sees another case's turns. Agents see no pending bullpen threads except a targeted case's own, so threads left open on the dev database can't leak into a case.

Reports land in `tests/smoke/reports/` as self-contained HTML files. Results are saved as JSON in `tests/smoke/results/` (with the model and commit) for historical tracking.

### The gate

A case **passes** when all of these hold:

- it ran to completion (no timeout or agent error);
- the judge scored it (a judge failure is reported separately, as not the model's fault);
- its weighted score is **at least 80%**;
- no `critical` behavior is rated `MISS`.

A case that fails is **run once more**, and it fails the gate only if the retry fails too. The same case on the same code can score 94% one run and 38% the next, and a release gate that blocks at random teaches people to ignore it. A case that passed only on its retry is marked `PASS*` in the summary. If the same case keeps needing a retry, it is flaky, so tighten it.

A **provider failure** is not a model failure, so it does not use that retry. An attempt that hits one is thrown away and run again, up to twice, before the gate sees it. Provider failures are:

- a model fallback (some agent ran on another model than the run is labelled with);
- an agent error of a provider type (`PROVIDER_ERROR`, `TIMEOUT`, `RATE_LIMIT`);
- a timeout that fired while a model call had made no progress for 90 seconds (no response, or no streamed event). Calls on the standard tier normally take seconds, so that means the provider stalled. A model that loops until the timeout makes many quick calls instead, and a slow call that finished earlier in the case does not count: those timeouts stay the model's.

Each re-run is printed as it happens (`[provider] …`) and listed under the case in the summary and in the results JSON (`providerRetries`), so a provider having a bad day is visible rather than hidden.

The run **passes** when every case passes, apart from cases marked `known_failure` (below). Otherwise `pnpm smoke` exits `1` and lists each failing case with its reasons. A run narrowed with `--case` or `--tags` says so, because it is not a full-suite result.

### Concurrency, cost and provider failures

**Concurrency.** `--concurrency N` (default 4) sets how many cases run at once. A case's turns still run in order. Everything a case owns is kept per case, not per run: its stubs, the calendar writes it has made, the bullpen threads its agents are shown, model fallbacks and spend. The harness finds which case a tool call or model call belongs to through an `AsyncLocalStorage` context that follows the case's work across the bus, so a specialist the coordinator delegates to (in its own conversation) is still that case's (`tests/shared/case-scope.ts`). What concurrency cannot separate is real database writes from unstubbed tools: cases share the throwaway copy, as they already did one after another, but a write can now show up mid-case rather than only between cases. Higher concurrency also risks OpenRouter rate limits; the judge retries a 429 with a longer backoff.

**Finished cases stop their work.** When a case ends, passed or timed out, it is cancelled: its later model calls fail at once and its tool calls are refused. The runtime has no way to cancel a turn, so before this an abandoned turn kept spending until it finished on its own, and its retry paid again. The harness waits up to 30 seconds for the case's leftover work to wind down before reading its spend; anything billed after that is printed as spend outside any case.

**Work that escapes its case fails the run.** Test mode runs no scheduler, so every tool call and model fallback should belong to some case. One that does not was answered without that case's stubs, or ran on another model, so the CLI lists it under `[ISOLATION]` and exits `1` even when every case passed.

**Cost.** The summary prints the run's estimated spend, split by agent and judge, and each case's total. The results JSON holds the same split per case (`usage`), for the run (`usage`), and for work outside every case such as the warm-up (`overheadUsage`). Agents' figures come from the runtime's `llm.call` events (token counts priced by the model registry). The judge publishes no event, so it prices its own responses. The figures are **estimates**, not OpenRouter's bill:

- OpenRouter cache reads are reported as zero (#1962), so cached input is priced as uncached. On a provider that caches, the estimate runs high, and the `(N cached)` column reads 0 whether or not the prefix was cached.
- A call that fails after the provider billed it publishes no `llm.call`, so it is missing.

To see the real figure, note OpenRouter's credit balance (or the activity page) before and after a full run.

**Estimate vs. bill.** TODO(#1980): one full run of both suites (2026-10-05, 02:03:56–02:16:17 UTC) was estimated at $4.39; record OpenRouter's billed cost for that window and the difference here.

**Changing the judge.** The judge (`openai/gpt-4o`) costs more per token than the production standard tier. A cheaper one can be tried on transcripts a run already saved, without running any model:

```bash
pnpm rejudge --judge google/gemini-3.1-flash-lite tests/smoke/results/<run>.json tests/scenarios/results/<run>.json
```

It re-judges every judged case (scenario runs too), prints how many verdicts and ratings match, lists every verdict change with both judges' reasons, and prices the candidate's calls. A new judge needs the same pass/fail verdict on at least 95% of cases, and every disagreement read by a person, before `JUDGE_MODEL` (`tests/scenarios/judge.ts`) changes.

---

## Writing a Test Case

Create a new file in `tests/smoke/cases/your-case-name.yaml`. The name should be lowercase, hyphenated, and descriptive.

### Full schema

```yaml
name: Unique Case Name          # required — must be globally unique
description: |                  # required — what this tests
  One or two sentences describing the scenario and what we're
  checking for. Helps the judge understand context.
tags: [tag1, tag2]              # required — used for filtering; see tags below
sender: principal               # optional — principal (default) | unknown
target:                         # optional — address a specialist instead (see "Target")
  agent: ceo-inbox
  via: bullpen
  from: calendar
  topic: Scheduling consult — Alice Chen
  opening: |
    CONSULT REQUEST
    ...
judge_tool_calls: false         # optional — show the judge each turn's tool calls
known_failure: { issue: "#123" } # optional — a tracked bug this case catches (reported, not gated)
tool_stubs:                     # optional — fixture answers for tools (see "The fixture office")
  calendar-list-events:
    - match: {}                 # subset match on the call's arguments; {} matches any call
      return: { events: [], count: 0 }

turns:                          # required — at least one turn
  - role: user
    content: "Book lunch with {{principal:first}}'s CFO on {{day:next-tuesday}}"
    delay_ms: 500               # optional — pause before this turn (ms)
    tool_stubs: {}              # optional — stubs for this turn only, tried before the case's

expected_behaviors:             # required — at least one
  - id: unique-behavior-id      # snake_case, unique within the case
    description: |
      What the agent should do. Write as an observable outcome,
      not an internal mechanism. The judge evaluates this.
    weight: critical             # critical | important | nice-to-have

failure_modes:                  # optional — things the agent should NOT do
  - "Should not hallucinate a meeting time"
  - "Should not reveal internal contact IDs"
```

Unknown keys are rejected, so a typo cannot silently fall back to a default.

### Sender

- `principal` (default) — the principal, on the local `smoke-test` channel. Curia knows who is talking and acts with full standing.
- `unknown` — an email address with no contact record (`unknown-sender@example.test`). The coordinator gets the low-trust treatment an unknown sender gets in production. Use it for cases about what Curia will and won't do for a stranger.

### Target: addressing a specialist

By default every turn goes to the coordinator. Some behaviors belong to a specialist acting on an event only it receives. For example, ceo-inbox resumes a parked scheduling email when the calendar specialist answers its consult. Sending that consult reply to the coordinator as if the principal had typed it tests the wrong agent. `target` delivers each turn to the specialist the way production does:

| Field | Meaning |
|---|---|
| `agent` | The agent under test. Its turn is captured and judged: its tool calls and its final response. |
| `via` | How the turns reach it. `bullpen` is the only path so far. |
| `from` | The agent that posts each turn on the thread, mentioning `agent`. |
| `topic` | The bullpen thread's topic. |
| `opening` | The thread's first message. `agent` opened the thread with it, addressed to `from`. |

For each case run, the harness opens the thread on the database copy and posts each turn as `from`, mentioning `agent`. Production's `BullpenDispatcher` turns that into `agent`'s task, with the thread as its conversation and the thread injected into its prompt. The thread is closed after the case, so later cases never see it.

- `sender` can't be combined with `target`, because the turns come from `from`.
- Both agents must be registered in the stack under test. This is checked before any case runs.
- Placeholders work in `topic` and `opening`.
- The judge is told which agent it is judging. It sees the thread's opening, that agent's calls and response for each turn, and (with `judge_tool_calls`) other agents' calls separately. Most targeted behaviors are actions, such as "drafts a reply" or "calls memory-query first", so set `judge_tool_calls: true`.
- Test mode has no bullpen service, so the `bullpen` tool is normally refused. For the case's own thread, `get_thread` returns the real thread and `reply` really posts to it, as in production. Other bullpen calls stay refused unless the case stubs them.
- A post the specialist makes on the bullpen does not wake anyone mid-case. Only the case's own posts are dispatched, so a reply chain can't run on into the next case. To test a hand-off between two agents, use one case per side.

`tests/smoke/cases/ceo-inbox-branch-a-*.yaml` are worked examples.

### The fixture office

Test mode can't reach a real calendar, mailbox, scheduler or task store. So every case runs in a small fixture office. Without it, the specialists would find every system down and decline, and a case could only test how Curia says "I couldn't".

- **`tests/smoke/stubs/office.yaml`** answers those tools for any agent: the coordinator or the specialist it delegates to.
  - A calendar week: a meeting an hour from now, a packed Wednesday, a Thursday flight, a board-chair call.
  - The principal's inbox: an investor asking to talk, the board deck, a contract renewal, an invoice and newsletters.
  - Task, scheduler, document and approval stores that work.
  - A plain executive voice profile, since test mode withholds the real one.

  List and search results are narrowed to the call's time range or query, the way the real tools narrow them. Writes succeed and echo their inputs (`{{input:title}}`).
- **`tests/smoke/fixtures/people.yaml`** seeds the people cases mention (Sarah Chen, David Kim, the board chair…) as real contacts in the copy. They use the reserved `.example` domain only.

A case's own `tool_stubs` are tried first, then the office's, so a case can change one answer (a scheduler that now lists the job turn 1 created) or break one (a specialist that declines). Calendar writes are remembered for the rest of the case, so an event created in a case shows up when it re-reads the day. Calls nothing stubs run for real, on the copy. `--show-calls` prints every agent's calls, which tells you what a new case needs.

A stubbed call is answered before the real tool layer, so trust and autonomy checks don't run on it: a stubbed write "succeeds" even where production would gate it. Stub a write when the case is about what Curia does next, not about whether it may write.

### Placeholders

Cases and fixtures name dates relative to the day the suite runs, in the principal's timezone, so nothing drifts into the past:

| Placeholder | Becomes |
|---|---|
| `{{date:today+1}}` | `2026-10-03` |
| `{{day:next-wednesday}}` | `Wednesday, October 7` (for prose in a message) |
| `{{weekday:today+3}}` | `Monday` |
| `{{time:next-thursday 09:00}}` | `2026-10-08T09:00:00.000-04:00` (the format calendar tools return) |
| `{{at:now+60m}}` | an hour from now, same format (`+Nh`, `-Nm` also work) |
| `{{timezone}}` | `America/Toronto` |
| `{{principal:name}}`, `{{principal:first}}`, `{{principal:contact_id}}` | the principal in the database under test |

A day is `today`, `today±N` or `next-<weekday>` (strictly after today), optionally `+N` days. A malformed placeholder fails when the case loads.

### Known failures

`known_failure: { issue: "#N" }` marks a case that catches a tracked bug. It still runs and is reported (`KNOWN`), but it doesn't fail the gate. A case that errors or isn't judged still fails, because that says nothing about the bug. When a marked case passes, the run warns that the marker may be stale. Remove it once the issue is fixed.

### Judging tool calls

By default the judge sees each turn's message and Curia's reply. Set `judge_tool_calls: true` when the behavior is an action rather than a reply, such as "looks the contact up before answering" or "does not send anything". The judge then also sees each tool call, its arguments, and its result (a failed call is marked `FAILED`), plus the calls of every specialist the coordinator delegated to, so "created the event on the principal's calendar" is judged on what was done, not on what the reply says.

For coordinator decisions that must be checked exactly, across several runs with a pass rate, use the scenario suite (`tests/scenarios/README.md`). It asserts tool calls in code and refuses any unstubbed write.

### Behavior weights

Weights determine how much each expected behavior contributes to the case's final score.

| Weight | Value | Use for |
|---|---|---|
| `critical` | 3 | The test fails meaningfully if this is missed |
| `important` | 2 | Core expected behavior (default if omitted) |
| `nice-to-have` | 1 | Desirable but not a regression if missed |

A case with only `critical` behaviors is stricter — a single miss tanks the score. Use `nice-to-have` for behaviors you want visibility on but wouldn't call a bug.

### Writing good expected behaviors

The judge reads the full conversation transcript alongside your `description` text and decides PASS / PARTIAL / MISS. Good descriptions:

- **Describe the outcome, not the mechanism** — "Proposes two alternative times" not "calls the calendar skill"
- **Are specific** — "Includes the meeting title in the reply" is better than "responds appropriately"
- **Are falsifiable** — the judge should be able to point to something in the transcript to justify its rating
- **Are independent** — each behavior should stand alone; avoid "does A and B" in a single description

Avoid:
- Behaviors that check internal state (DB writes, bus events) — the judge sees the conversation, plus tool calls when `judge_tool_calls` is set, and nothing else
- Behaviors that are always trivially true ("responds to the user")
- Behaviors so vague the judge can't reasonably disagree

### Failure modes

`failure_modes` are negative constraints — things that, if they appear in the response, indicate something went wrong. They're passed to the judge as guidance. Use them for common hallucination patterns or security-relevant behaviors you want to explicitly guard against.

---

## Tags

Tags are free-form but try to reuse existing ones for consistency. Current tags in use:

| Tag | Used for |
|---|---|
| `briefing` | Daily briefing, meeting prep, summaries |
| `email-triage` | Inbox reading, thread summaries, urgency detection |
| `calendar` | Scheduling, calendar operations, timezone handling |
| `meeting-coord` | External scheduling, reschedule flows |
| `contacts` | Contact lookup, ambiguous identity, profile recall |
| `tracking` | Follow-up tracking, promise detection |
| `proactive` | Agent-initiated behaviors (not just responding) |
| `multi-turn` | Conversations that require multiple exchanges |
| `single-turn` | One user message, one response |
| `security` | Prompt injection, spoofing, leakage |
| `edge-case` | Unusual or tricky inputs |
| `ceo-inbox`, `resume-mode` | Targeted cases for the inbox specialist resuming parked work |

---

## Example: A Simple Single-Turn Case

```yaml
name: Expense Summary Request
description: |
  CEO asks for a weekly expense summary. Curia should retrieve recent
  expenses, group them by category, and present a clean summary.
tags: [single-turn]

turns:
  - role: user
    content: "Can you give me a summary of this week's expenses?"

expected_behaviors:
  - id: groups_by_category
    description: Groups expenses by category (e.g. travel, meals, software)
    weight: critical

  - id: includes_totals
    description: Includes a total amount per category and a grand total
    weight: important

  - id: covers_current_week
    description: Covers expenses from the current week, not all time
    weight: important

  - id: offers_detail_on_request
    description: Mentions that detailed breakdowns are available if needed
    weight: nice-to-have

failure_modes:
  - "Should not fabricate expense entries that weren't retrieved"
```

## Example: A Multi-Turn Case

```yaml
name: Rescheduling Flow
description: |
  CEO asks to reschedule a specific meeting. Curia should find the
  meeting, check availability, propose alternatives, and confirm once
  the CEO picks one.
tags: [calendar, meeting-coord, multi-turn]

turns:
  - role: user
    content: "I need to move my 2pm call with Jenna on Thursday."
  - role: user
    delay_ms: 1000
    content: "Friday at 3pm works for me."

expected_behaviors:
  - id: identifies_correct_meeting
    description: Identifies the Thursday 2pm meeting with Jenna specifically
    weight: critical

  - id: checks_availability
    description: Checks calendar availability before proposing alternatives
    weight: important

  - id: confirms_reschedule
    description: Confirms the reschedule to Friday 3pm after CEO selects it
    weight: critical

  - id: mentions_notifying_jenna
    description: Mentions that Jenna will be notified of the change
    weight: important
```

---

## After Writing Your Test

1. Run it: `pnpm smoke --case "your-case-name" --model deepseek/deepseek-v4.1-flash --show-calls`
2. Open the HTML report in `tests/smoke/reports/` — read the judge's justifications for each behavior
3. If behaviors are consistently rated `PARTIAL`, the description may be too vague — tighten it
4. Run it a few times: the gate retries a failure only once, so a case that passes half the time will still block releases at random
5. If the test reveals a real bug, open an issue alongside the PR
6. Submit the YAML file — no other changes needed

A good smoke test is a gift to the next person who touches that feature. It doesn't have to be complex to be useful.

---

## Refreshing the eval-harness prompt inputs (`inspect-prompts`)

curia-deploy's model-comparison eval harness renders every agent's system prompt locally with curia's own builders (`buildBaseSystemPrompt`, `resolveSystemPromptSources`, pin resolution). It reads this deployment's prompt **inputs** from a snapshot, `tests/eval/prompt-blocks.json`: the identity and security blocks, the specialist roster, the autonomy score, the timezone, and Curia's and the principal's contact details. When any of those change, refresh the snapshot. Otherwise the harness scores a prompt built from stale inputs.

`scripts/inspect-prompts.ts` prints those inputs as JSON. It reads them from the coordinator's runtime config in the test-mode stack (`createTestModeStack({ llm: 'offline' })`), so the roster honours registry enablement and `security.trust_thresholds` are validated, not defaulted.

For production, run it through curia-deploy, which execs it in the app container, adds the image's core revision as `curia.commit`, and validates the snapshot before writing it:

```bash
# from the curia-deploy checkout
scripts/fetch-prompt-blocks.sh <ssh-host> tests/eval/prompt-blocks.json
```

Against a local database, `pnpm inspect-prompts` prints the same JSON. It needs both `DATABASE_URL` and `SECRET_ENCRYPTION_KEY`. Without the vault key it exits with an error rather than emit a degraded snapshot: the Signal number and the email grant check would be missing, and nothing in the JSON would say so.

**Re-run after:**
- changing the office identity (wizard or `PUT /api/identity`) or the autonomy score
- changing `security.trust_thresholds` in `config/default.yaml`
- adding, removing or enabling specialist agents
- changing the principal's verified identities, or Curia's own email or Signal number

The script does not need Curia running. It writes only the idempotent bootstrap rows every boot writes (office identity seed, agent self-contact), so it is safe beside a live instance.
