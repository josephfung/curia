# ADR-046: Agent behavior fixes go on the highest rung that works, and the always-on prompt has a budget

Date: 2026-10-06
Status: Accepted

## Context

The coordinator's `system_prompt` was 9KB in April 2026. #957 restructured it in June at about 32KB, and its section layout gave every future addition an obvious home. Each incident fix after that appended a paragraph. By the start of the context diet (#1954) the YAML was 56KB, with 225 commits and +11KB in September alone. Calendar routing was stated nine times and "don't expose internals" about eighteen.

That prompt is sent on every call, alongside about 67KB of local tool definitions and, before #1957, about 200KB of `google-workspace` MCP tools. Its problems were density and distance more than missing rules. About 100 prohibitions overlapped in slightly different words, and guidance on delegate result shapes sat hundreds of lines from where those results appeared.

The cause was the process, not the text. There was no rule for where a fix goes and nothing that pushed back when the always-on prompt grew. A one-off trim would grow back the same way.

The tool definitions were also invisible to monitoring. The `context.budget` event estimated the system prompt and the injected tiers but never the tools, which were the largest fixed component.

Alternatives considered:

- **A periodic trim.** That is what #957 was. Without a rule and a gate it lasts a few months.
- **Prompt-text review only.** Reviewers see a diff of a single paragraph, which always looks reasonable. They do not see the total.
- **A hard cap with no ladder.** A cap alone makes the next fix fail CI with no guidance on where the rule should go instead. People then raise the cap.

## Decision

### The placement rule

For any change to how an agent behaves, use the highest rung that works:

1. **Enforce it in code.** Block, validate, or reshape the action in the skill handler, execution layer or dispatcher. The refusal message tells the model what to do next. Example: the coordinator's calendar discovery ban became `allowed_callers` plus the reserved-bundle check (#1958).
2. **Inject it with its trigger.** Put the guidance where the condition shows up: the tool result (`next_step`), the injected block's header, the scheduled job's payload, or only on that channel's turns (`turnGuidance`, #1959). It costs nothing when the trigger is absent and sits next to the trigger when present.
3. **Put it in the tool description,** for "how to call X correctly." This improves locality but does not shrink total context, and a `tool.json` description is shared by every agent that pins the tool (#958). MCP tool descriptions come from the upstream server and cannot be edited here.
4. **A lazily loaded playbook:** `skill-activate` plus `references/`, or `doc-read`. Only for rare procedures the model can recognise it needs.
5. **The always-on system prompt.** Only for rules that apply on every turn: identity and voice, audience, the routing decision, honest reporting, proactive surfacing.

Before adding a rule to rung 5, delete or rewrite any existing statement of it. A rule should be stated once.

### The budget

`tests/unit/agents/prompt-budget.test.ts` fails CI when an opted-in agent exceeds either budget, and its failure message points here:

- **Always-on prompt:** the YAML `system_prompt` plus the pinned SKILL.md bodies, estimated at 4 characters per token. The code-owned runtime blocks (identity, security, roster, autonomy, time, contact details, turn budget) are not counted.
- **Local tool definitions:** the JSON bytes of every local tool definition the agent is sent, including the discovery tools. MCP tools are excluded; their size is governed by the server's `--tools` allowlist (#1957).

Both are measured through `assembleAgent()`, the same assembly production boots with, over the real `agents/` and `skills/` directories. The coordinator is enforced first, with budgets set from its numbers after #1958, #1959 and #1960 plus about 3% headroom. Another agent opts in by adding a row to the test's `AGENT_BUDGETS`.

Raising a budget is allowed, but the PR must say why the addition could not go on a higher rung. Lowering it after a trim is encouraged, so the gain cannot quietly grow back.

### Tool definitions in `context.budget`

The runtime charges the tool definitions sent with the first round of a call as their own required tier, `tool_definitions`. It appears in `audit_log` with the other tiers. Like the system prompt, it is always included. It is charged after `sender_context`, so it can never push out the sender's authorization block, and it reduces the budget left for bullpen, resolved entities and history.

### Tests for prompt text

When adding a rule, prefer a behavioral check: a scenario case (`tests/scenarios/`), a smoke case, or a unit test of the code or injection that carries it. A test that slices the prompt by heading pins where the text is, not what the agent does. When a rule moves up the ladder, move its test with it to assert the new mechanism (the refusal, the injected block, the tool description), rather than keeping the old test to hold the text in place.

## Consequences

- A behavior fix now starts with "which rung?" Most fixes land in code or in a trigger-time injection, which are testable without an LLM and cost nothing on turns that do not need them.
- Growing the coordinator's always-on prompt or its local tools by more than the headroom fails CI. The author either places the rule higher, removes something, or raises the budget with a stated reason in review.
- The always-on prompt is still above the epic's target of about 4k tokens for the YAML alone (#1954). The budget holds today's line; reaching the target is a separate trim, after which the budget should be lowered.
- Text moved into injected blocks and tool results is no longer in `system_prompt`, so it is not covered by the outbound prompt-exfiltration markers unless it is added to `src/agents/prompts/trigger-guidance-sources.ts`. Any new trigger guidance must be registered there.
- Moving rules into `tool.json` descriptions makes the tool-definition budget the one that grows. It is enforced for the same reason.
- `context.budget` totals now include tool definitions. Utilization figures rise accordingly, and on small-context models less history fits than before. That reflects what the provider actually receives.
- The same pattern exists in `ceo-inbox`, `calendar`, `meeting-debrief` and instance-custom agents. They can opt into the budget once the placement rule has been applied to them.
