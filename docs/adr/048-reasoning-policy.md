# ADR-048: Reasoning policy — pass reasoning back in tool loops, one effort setting per tier on every provider

Date: 2026-10-08
Status: Accepted

## Context

#2042 made Curia archive the model's reasoning. Three questions were left open (#2044):

1. Should a tool loop pass the model's reasoning back on the next request?
2. Should Anthropic models think (extended or adaptive thinking)?
3. Should Curia send a reasoning effort, and at what scope?

The temperature question from the coordinator prompt trim plan (PR 11) was moved here as well.

**What Curia did before this ADR.**
- The OpenRouter provider sent no `reasoning` parameter.
- The Anthropic provider sent no `thinking` parameter, so Anthropic models never reasoned.
- The tool loop rebuilt each assistant turn from text and tool calls only (`tool-loop-messages.ts`), so reasoning never reached the next request.
- Agent calls sent no temperature. The judges sent `temperature: 0` (#2038).

**Models in use.**

| Where | fast | standard | powerful | judges |
|---|---|---|---|---|
| Production (curia-deploy) | `claude-haiku-4-5` (Anthropic direct) | `deepseek/deepseek-v4.1-flash` (OpenRouter) | `openai/gpt-4o` (OpenRouter) | `google/gemini-3.1-flash-lite` (OpenRouter) |
| Core defaults (`config/default.yaml`) | `claude-haiku-4-5` | `claude-sonnet-4-6` | `claude-opus-4-6` | `claude-haiku-4-5` |

Production does use Anthropic. Over the 30 days to 2026-10-08, Haiku served `contacts` (605 calls), `digest` (107), `research-analyst` (68), voice turns (14), the scoring pass, and the `extract-facts` and `extract-relationships` infra skills.

**What production measured.** These are the 726 standard-tier calls on 2026-10-08 (02:00–22:30 UTC) that carried #2048's reasoning-token count.

| Agent | Calls | Reasoning share of output tokens | Reasoning tokens p50 / p90 | Latency p50 / p90 |
|---|---|---|---|---|
| all | 726 | 74% | 180 / 2,721 | 3.6s / 21.0s |
| ceo-inbox | 517 | 76% | 196 / 2,721 | 3.7s / 21.3s |
| t2125-expense-tracker | 110 | 87% | 168 / 3,540 | 2.9s / 19.9s |
| social-media | 36 | 50% | 333 / 3,826 | 6.9s / 35.3s |
| coordinator | 27 | 67% | 151 / 1,130 | 3.7s / 11.6s |
| meeting-debrief | 14 | 45% | 94 / 716 | 2.9s / 6.7s |
| calendar | 12 | 72% | 184 / 2,629 | 3.6s / 19.1s |
| security-triage | 10 | 24% | 15 / 58 | 1.1s / 2.0s |

- **Latency follows reasoning.** Calls with no reasoning ran at a p50 of 2.0s. The 14% of calls that reasoned 2,000 tokens or more ran at 22.5s (2,000–4,999 tokens) and 37.3s (5,000+, p90 89.7s).
- **Cost does not.** Reasoning was about 15% of the estimated spend, roughly $0.39 of $2.58. Latency is the lever, not cost.
- **Later steps of a tool loop reason more.** The first call of a loop averaged 160 reasoning tokens. Calls 2 and later averaged 700–1,400. That fits the model re-deriving its plan from the transcript at every step, but it also fits reasoning over tool results.
- **Every call that reported reasoning tokens also returned readable reasoning text.**

**What the providers say about passing reasoning back.** Docs were read on 2026-10-08.

| Provider / model | Passing reasoning back in a tool loop | Source |
|---|---|---|
| DeepSeek V4.1 Flash (via OpenRouter) | **Required** whenever `tools` are sent: reasoning "must be fully passed back… the API will return a 400 error" otherwise. Without tools it is ignored. | [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) |
| Anthropic (Haiku 4.5, Sonnet 4.6, Opus 4.6) | **Required** within a tool-use turn once thinking is on, unmodified, including `redacted_thinking`. Not applicable while thinking is off. | [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) |
| Gemini 3.x (judges, via OpenRouter) | **Required** for thought signatures during function calling. Not applicable to the judges, which make single-shot calls without tools. | [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) |
| OpenAI reasoning models (via OpenRouter) | **Required** for encrypted `reasoning_details`. | [OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) |
| `openai/gpt-4o` | **Unsupported.** Not a reasoning model; OpenRouter lists `reasoning: null`. | OpenRouter models API |

OpenRouter takes reasoning back as `reasoning`, `reasoning_content` or `reasoning_details`. Its guidance is that blocks must be passed back "unmodified" and in their original order.

**What a probe found** (2026-10-08, 45 calls, $0.015). The model was `deepseek/deepseek-v4.1-flash` with `provider.require_parameters: true`.
- **Effort values.** `low`, `high`, `max` and `medium` all route, on both DeepSeek's endpoint and CoreWeave's. OpenRouter lists `low`, `high` and `max` as supported, with `high` as the default. `none` and `enabled: false` turn thinking off.
- **Unsupported parameters.** Pinned to DeepSeek's endpoint, an unsupported parameter (`top_k`) fails with a 404: "No endpoints found that can handle the requested parameters".
- **Effort is honored.** On a fixed puzzle that every run answered correctly:

  | Endpoint | `low` | `high` | `max` |
  |---|---|---|---|
  | DeepSeek | 728 tokens, 4.4s | 1,336 tokens, 6.9s | 2,088 tokens, 10.7s |
  | CoreWeave | 663 tokens, 3.3s | 2,681 tokens, 17.6s | not run |

  Figures are mean reasoning tokens and mean latency.
- **`none` does not remove reasoning on a hard task.** The model wrote its step-by-step working into the visible reply instead (747–882 tokens).
- **Omitting reasoning still returns 200** in a two-step tool loop, on DeepSeek's own endpoint as well. So OpenRouter tolerates something DeepSeek documents as an error, and it does not document how.
- **Passed-back reasoning reaches the model.** A canary planted in passed-back reasoning was repeated by the model through all three fields.

**Routing caveat.** Production's standard tier is pinned to CoreWeave's endpoint, an operator choice made for responsiveness and price. The production figures above are CoreWeave's. DeepSeek's first-party endpoint reasons differently at the same effort (`high`: 1,336 against CoreWeave's 2,681 tokens on the puzzle). Measurements are therefore only comparable within one endpoint, and `llm.call` does not record the endpoint today.

**Temperature.**
- DeepSeek's API reference says temperature "has no effect in thinking mode", which is on by default.
- Anthropic rejects `temperature` (and `top_k`) while thinking.
- Google "strongly recommend[s]" keeping Gemini 3 at its default 1.0.

## Decision

### 1. Pass reasoning back within a tool loop, on every provider, always

Within one task's tool loop, each assistant turn carries the reasoning that produced its tool calls back to the next request. The reasoning goes back exactly as the provider returned it:
- **OpenRouter:** `reasoning_details`.
- **Anthropic:** `thinking` and `redacted_thinking` blocks with their signatures.

It is never rebuilt from the archive's redacted copy. Each block is tagged with the model that wrote it and is dropped when the loop continues on a different model (tier fallback, #813).

There is no setting. Every model Curia can route to either requires pass-back (DeepSeek with tools, Anthropic with thinking, Gemini and OpenAI reasoning models with tools) or does not reason at all. Today Curia depends on OpenRouter quietly tolerating a request DeepSeek documents as invalid.

Reasoning is **not** carried across user turns in conversation history. History is stored as text. Anthropic strips earlier turns' thinking itself, and OpenRouter accepted the omission in the probe. DeepSeek's docs ask for earlier turns' reasoning too, so this is a deliberate deviation. The behavior gate is the check.

Risks the issue raised, and how this decision bounds them:
- **Anchoring a mistake (#2033).** Reasoning carries for one task only, never across retries of a new task. The A/B runs the #2033-type scenarios.
- **Exfiltration and audit.** Passed-back reasoning returns only to the model that wrote it. It never reaches a channel, so the outbound filters' job is unchanged.
- **Input growth.** Passed-back reasoning becomes part of the cached prefix from the next step on. The context budget counts it.

### 2. Reasoning is supported on every provider through one provider-neutral setting

Curia expresses reasoning as one setting: `reasoning.effort`, with the values `low`, `medium`, `high` and `max`. Call sites may also send `none`; tiers may not (see 3). Each provider maps it onto the model's own control. A structured `reasoning` entry in the model registry describes which control the model uses and which efforts it honors.
- **OpenRouter:** sends `reasoning: { effort }`. OpenRouter maps it to DeepSeek's effort, Gemini's thinking level, OpenAI's `reasoning_effort` and Anthropic's budget. This covers OpenAI parity, because OpenAI chat models reach Curia only through OpenRouter.
- **Anthropic direct, models with adaptive thinking (Sonnet 4.6, Opus 4.6):** sends `thinking: { type: "adaptive" }` and `output_config.effort`.
- **Anthropic direct, budget-only models (Haiku 4.5):** sends `thinking: { type: "enabled", budget_tokens }`. The budget comes from the effort ratio of `max_tokens` that OpenRouter uses (low 20%, medium 50%, high 80%, max 95%). It is clamped to at least 1,024 and strictly below `max_tokens`.

Anthropic's constraints are handled where they bite:
- **Temperature.** Thinking rejects `temperature`. If a call sets both, the explicit temperature wins, thinking is omitted with a warning, and `llm.call` records what was actually sent.
- **`max_tokens`.** The thinking budget counts against it. A call whose `max_tokens` cannot hold the 1,024 minimum (the infra classifier sends 10) does not think.
- **Caching.** Changing thinking settings invalidates cached prefixes. The setting is static per tier, so it costs one cache miss when an operator changes it.
- **Voice latency.** Voice turns never inherit a reasoning setting (see 3).

Haiku 4.5 does not interleave thinking between tool calls. On the fast tier, thinking helps only the start of each assistant turn, so any fast-tier A/B should expect less than on adaptive models.

### 3. Effort is a per-tier setting that applies to agent turns, unset by default

The setting is `model_routing.tiers.<tier>.reasoning.effort`, and it is optional.
- **Unset means the provider's default.** DeepSeek thinks at `high`, Anthropic does not think, Gemini thinks at `minimal`. A deployment that sets nothing changes nothing.
- **Validated at boot.** `ModelRouter` rejects a tier effort its model's registry entry does not list, the same way it rejects an unknown tier model. It also rejects `none` on a tier, because on a hard task the model then writes its reasoning into the user-visible reply.
- **Agent turns only.** The tier setting applies to agent turns. A fallback call uses the fallback tier's own setting.
- **Other call sites set their own.** The judges, infra skills, scoring pass, summarization, drift detector and voice state their own reasoning, as they state their own temperature. None of them sends one today, so their behavior is unchanged.

The value for each tier comes from an A/B, not from this ADR. Production's standard tier runs three arms on the behavior gate: unset (`high`), `low` and `max`.
- `low` ships if it clears the gate on every run with scores inside unset's run-to-run spread.
- `max` ships only if it beats that spread and its latency cost is acceptable.
- Otherwise the tier stays unset.

### 4. Agent calls send no temperature

There is no per-tier temperature, and the trim plan's PR 11 temperature probe is dropped.
- On the standard tier, temperature is a no-op while DeepSeek thinks.
- On Anthropic it conflicts with thinking.
- On Gemini 3 the vendor asks for the default.

The judges keep their call-site `temperature: 0`. Google's guidance for Gemini 3 is recorded as a known risk; production judge outcomes showed no failures over the 14 days measured.

### 5. `llm.call` records what reasoning cost and what was sent

`llm.call` gains three optional fields:
- `reasoningTokens`: next to `outputTokens`. Without it, reasoning trends live only in the archive, which can be disabled or pruned after 90 days.
- `reasoningEffort`: the effort sent, or `null` when unset, the same way #2038 records temperature.
- `upstreamProvider`: the endpoint that served an OpenRouter call.

The behavior suites print reasoning tokens and latency per agent, so every A/B above can report them.

### Rejected options

- **Pass-back as a per-agent or per-tier option.** Pass-back is a provider contract, not a tuning knob.
- **Persisting reasoning into conversation history.** It would keep model-written text no filter has seen, and it adds nothing the in-loop pass-back does not.
- **Leaving Anthropic without reasoning support**, or enabling it only on the fast tier. Other installations run every tier on Anthropic. Parity through one setting costs less than an exception per provider.
- **A per-agent effort in agent YAML.** It would be a public schema change with no evidence yet that agents on one tier need different efforts. It is revisited only if the tier A/B passes for some agents and fails for others. **No decision here changes the agent YAML schema.**
- **Per-call-site effort as the main control.** Agent turns are where the volume is, and a tier setting reaches them in one place (ADR-046's "one place per decision").
- **`effort: none` on agent tiers.** The model writes its reasoning into the visible reply instead.
- **A per-tier temperature.** It does nothing on the production model and conflicts with thinking elsewhere.

## Consequences

- **Public API changes.**
  - `llm.call` (bus events) gains three optional fields. The change is additive, and the changelog calls it out.
  - The config schema gains `model_routing.tiers.<tier>.reasoning`.
  - The agent YAML schema is unchanged.
- **Providers carry opaque reasoning blocks through the tool loop.** The prompt archive replaces each passed-back block with a marker, so encrypted reasoning and signatures never reach `llm_call_archive`, and `audit.llmCallArchive.includeReasoning: false` still holds. The readable text is already archived on the call that produced it.
- **Pass-back changes the reasoning baseline.** Effort A/Bs run after pass-back lands. They compare arms within one upstream endpoint, using `upstreamProvider`.
- **Order of work:**
  1. This ADR.
  2. `llm.call` telemetry.
  3. Pass-back, with an A/B.
  4. The reasoning setting.
  5. The effort A/B and any resulting curia-deploy change.

  `docs/wip/2026-10-08-reasoning-policy-design.md` has the design and the A/B protocol.
- **Effort A/Bs run on the endpoint production uses** (CoreWeave as of 2026-10-08). `upstreamProvider` shows which endpoint every measurement came from, so a later routing change is visible in the data.
- **If the effort A/B finds no winner, the tiers stay unset.** The plumbing still lets any installation choose an effort per tier, including thinking on Anthropic.
