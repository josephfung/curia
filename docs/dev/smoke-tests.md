# Writing Smoke Tests

Curia's smoke test suite runs the full agent stack against real conversations and uses an LLM-as-judge to evaluate behavior. It's the best way to catch regressions and the easiest place for contributors to add meaningful coverage without touching core code.

**We'd love help here.** If you've found a behavior Curia handles poorly, or a scenario you'd like to make sure keeps working, a smoke test is the right way to encode it.

---

## How It Works

Each test is a YAML file describing a conversation and a list of expected behaviors. The runner:

1. Boots a headless Curia stack in test mode (full bus, agents, skills — no channels, and nothing can send)
2. Plays through the conversation turns against the live Coordinator, recording its tool calls and replies
3. Sends the transcript + expected behaviors to an LLM judge (GPT-4o, through OpenRouter)
4. Scores each expected behavior as `PASS`, `PARTIAL`, or `MISS`
5. Applies the gate (below), writes an HTML report with the judge's justifications, and exits `1` if any case fails

The judge provides a reasoning trace for every behavior rating — useful for debugging why a test passes or fails.

---

## Running the Tests

```bash
# Full suite on the production standard-tier model (what the release pre-flight runs)
pnpm smoke --model deepseek/deepseek-v4.1-flash

# Full suite on the configured model_routing
pnpm smoke

# Single case (substring match on name)
pnpm smoke --case "urgent"

# Filter by tag
pnpm smoke --tags email-triage,briefing
```

**Requirements:** `DATABASE_URL` (a migrated database with a principal contact) and `SECRET_ENCRYPTION_KEY`. Model keys come from the vault, never from env (#911): the model's provider key (`anthropic_api_key` or `openrouter_api_key`), plus `openrouter_api_key` for the judge.

Smoke usually runs against the dev database. Each case's conversation rows (working memory, checkpoints, resolved entities) are deleted after it runs, and leftovers from an interrupted run are swept at start-up, so test turns do not leak into the real instance's prompts.

Reports land in `tests/smoke/reports/` as self-contained HTML files. Results are saved as JSON in `tests/smoke/results/` (with the model and commit) for historical tracking.

### The gate

A case **passes** when all of these hold:

- it ran to completion (no timeout or agent error);
- the judge scored it (a judge failure is reported separately, as not the model's fault);
- its weighted score is **at least 80%**;
- no `critical` behavior is rated `MISS`.

The run **passes** when every case passes. Otherwise `pnpm smoke` exits `1` and lists each failing case with its reasons. A run narrowed with `--case` or `--tags` says so, because it is not a full-suite result.

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
judge_tool_calls: false         # optional — show the judge each turn's tool calls

turns:                          # required — at least one turn
  - role: user
    content: "The message text"
    delayMs: 500                # optional — pause before this turn (ms)

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

### Judging tool calls

By default the judge sees each turn's message and Curia's reply. Set `judge_tool_calls: true` when the behavior is an action rather than a reply, such as "looks the contact up before answering" or "does not send anything". The judge then also sees each tool call, its arguments, and its result (a failed call is marked `FAILED`).

Test mode can't reach email, calendars, the scheduler, tasks, documents or human channels, so those tools fail. A case about them should test what Curia does when they fail, such as saying so plainly instead of making something up. For coordinator decisions that need those tools to succeed, use the scenario suite (`tests/scenarios/README.md`), where tool results are stubbed.

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
    delayMs: 1000
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

1. Run it: `pnpm smoke --case "your-case-name" --model deepseek/deepseek-v4.1-flash`
2. Open the HTML report in `tests/smoke/reports/` — read the judge's justifications for each behavior
3. If behaviors are consistently rated `PARTIAL`, the description may be too vague — tighten it
4. Run it a few times: the release gate runs every case once, so a case that passes only some of the time will block releases at random
5. If the test reveals a real bug, open an issue alongside the PR
6. Submit the YAML file — no other changes needed

A good smoke test is a gift to the next person who touches that feature. It doesn't have to be complex to be useful.

---

## Refreshing eval-harness prompt blocks (`inspect-prompts`)

Smoke tests in `curia-deploy` mock the system-prompt injection blocks (office identity, executive profile, trust thresholds, agent list) so the LLM judge sees a stable prompt across runs. When any of those resolved blocks change, the mocks have to be refreshed — otherwise the judge is grading against stale context.

`scripts/inspect-prompts.ts` prints the current resolved blocks as JSON. Run it from a Curia checkout connected to a bootstrapped database and pipe the output into `curia-deploy`:

```bash
pnpm inspect-prompts > /path/to/curia-deploy/tests/eval/prompt-blocks.json
```

On a live server the same command runs against the production checkout:

```bash
pnpm --prefix /opt/curia tsx --env-file=.env scripts/inspect-prompts.ts
```

**Re-run after:**
- editing `config/office-identity.yaml` or applying identity changes via the API
- editing `config/executive-profile.yaml` or applying profile changes via the API
- changing `security.trust_thresholds` in `config/default.yaml`
- adding or removing specialist agents (`agents/*.yaml`)

The script connects to the database directly and does not require Curia to be running.
