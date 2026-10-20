# ADR-048: Reasoning policy — pass reasoning back in tool loops, one effort setting per tier on every provider

Date: 2026-10-08
Status: Accepted
Amended: 2026-10-20 — unset is the provider default on every model; call sites state `none`; Anthropic reasoning is adaptive thinking plus effort; stale passed-back thinking is dropped (#2044, #2077)

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

**What changed after the decision (amendment, 2026-10-20).** #2157 moved the core default fast tier and both default judges to `claude-haiku-5-5`, and curia-deploy#301 moved production's fast tier to it. Voice stays on `claude-haiku-4-5` through `channels.voice.model`, because Haiku 5.5's first token was slower. #2157 kept Haiku 4.5's behavior: Curia sends Haiku 5.5 `thinking: {type: "disabled"}` and no sampling parameters. Anthropic's docs, read on 2026-10-20, say this about Haiku 5.5:
- **Thinking.** Adaptive thinking is on by default, and `thinking: {type: "enabled", budget_tokens}` returns a 400. `disabled` is accepted at effort `high` or below; at `xhigh` and `max` the request must use adaptive thinking.
- **Effort.** `low`, `medium`, `high`, `xhigh` and `max` are accepted, and `medium` is the default. Effort shapes every output token, so it applies with thinking off as well.
- **Display.** Thinking blocks come back with an empty `thinking` field and only a signature, unless the request sets `display: "summarized"`.
- **Prefix binding.** A thinking block is valid only while everything sent before it is unchanged. Passing one back after a change to `system`, `tools` or an earlier message returns a 400. This holds on accounts created on or after 2026-08-31 and, on older accounts, on requests that opt in. Dropping thinking blocks from some point to the end of the history is valid; the model loses that reasoning. The check also applies to Sonnet 5.5, Opus 5.5 and Fable 5.1, and not to the 4.6 models.

Curia's text tool loop is not append-only. `refreshBullpenContext` replaces the Bullpen system message each round, and tool discovery adds tools mid-loop. Anthropic models in the registry also carry no `maxOutputTokens`, so their calls are capped at 4,096 output tokens, which thinking would share with the reply.

Sources: [Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide), [Effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).

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

**Prefix guard (amendment, 2026-10-20).** For models whose thinking is bound to the prefix (Haiku 5.5 today, flagged in the model registry), each Anthropic block also records a hash of the request it answered: `system`, `tools` and every earlier message, as the provider sent them. Before a request goes out, the provider recomputes that hash for each assistant turn that carries a block. At the first turn whose hash differs, it drops that turn's block and every later one, and logs the drop. The docs allow dropping from a point to the end, so the request succeeds; the model loses the reasoning written before the change. Making the loop append-only would keep it, but that changes how Bullpen context and discovered tools reach the model, so it is a separate change.

There is no setting. Every model Curia can route to either requires pass-back (DeepSeek with tools, Anthropic with thinking, Gemini and OpenAI reasoning models with tools) or does not reason at all. Today Curia depends on OpenRouter quietly tolerating a request DeepSeek documents as invalid.

Reasoning is **not** carried across user turns in conversation history. History is stored as text. Anthropic strips earlier turns' thinking itself, and OpenRouter accepted the omission in the probe. DeepSeek's docs ask for earlier turns' reasoning too, so this is a deliberate deviation. The behavior gate is the check.

Risks the issue raised, and how this decision bounds them:
- **Anchoring a mistake (#2033).** Reasoning carries for one task only, never across retries of a new task. The A/B runs the #2033-type scenarios.
- **Exfiltration and audit.** Passed-back reasoning returns only to the model that wrote it. It never reaches a channel, so the outbound filters' job is unchanged.
- **Input growth.** Passed-back reasoning becomes part of the cached prefix from the next step on. The context budget counts it.

### 2. Reasoning is supported on every provider through one provider-neutral setting

Curia expresses reasoning as one setting: `reasoning.effort`, with the values `none`, `low`, `medium`, `high` and `max`. Each provider maps it onto the model's own control. A structured `reasoning` entry in the model registry describes which control the model uses and which efforts it honors.

**`none` means "no reasoning, where the model can turn it off cleanly"** (amendment, 2026-10-20). The registry lists `none` only for those models: the Anthropic models, where it maps to `thinking: disabled`. DeepSeek V4.1 Flash and Gemini 3.1 Flash-Lite do not list it. On DeepSeek, `none` makes the model write its working into the reply; on Gemini it would turn off the `minimal` thinking the judges run with today. A call site that sends `none` to a model that does not list it gets the provider default, and a debug log.
- **OpenRouter:** sends `reasoning: { effort }`. OpenRouter maps it to DeepSeek's effort, Gemini's thinking level, OpenAI's `reasoning_effort` and Anthropic's budget. This covers OpenAI parity, because OpenAI chat models reach Curia only through OpenRouter.
- **Anthropic direct:** an effort sends `thinking: { type: "adaptive", display: "summarized" }` and `output_config.effort`. This covers Haiku 5.5, Sonnet 4.6 and Opus 4.6. `display: "summarized"` keeps readable reasoning in the archive on Haiku 5.5, which would otherwise return only signatures. `none` sends `thinking: { type: "disabled" }` and no effort. Unset sends neither key.

*Amended 2026-10-20.* The original decision also mapped effort to `budget_tokens` for budget-only models (Haiku 4.5). That path is dropped. Haiku 5.5 rejects `budget_tokens`, and Haiku 4.5 now serves only voice, which never inherits a setting. Haiku 4.5 gets no registry `reasoning` entry, so a tier effort on it fails at boot.

Anthropic's constraints are handled where they bite:
- **Temperature.** On models that accept `temperature` with thinking off (Sonnet and Opus 4.6), thinking rejects it. If a call sets both, the explicit temperature wins, thinking is omitted with a warning, and `llm.call` records what was actually sent. Haiku 5.5 is never sent a temperature (#2077), so it has no conflict.
- **`max_tokens`.** Thinking counts against it. When a request will think (it sets an effort, or it leaves reasoning unset on a model that thinks by default, as Haiku 5.5 does) and the caller set no `max_tokens`, the cap rises from the model's default to 32,768, the cap the OpenRouter reasoning models already use. A caller that sets an effort with `max_tokens` below 1,024 does not think, and a warning is logged. A caller with a small `max_tokens` on a model that thinks by default must send `none`; the infra classifier does (see 3).
- **Caching.** Changing thinking settings invalidates cached prefixes. The setting is static per tier, so it costs one cache miss when an operator changes it.
- **Prefix binding.** Handled by the prefix guard (see 1).
- **Voice latency.** Voice turns never inherit a reasoning setting (see 3).

### 3. Effort is a per-tier setting that applies to agent turns, unset by default

The setting is `model_routing.tiers.<tier>.reasoning.effort`, and it is optional.
- **Unset means the provider's default**, as an unset `temperature` does. DeepSeek thinks at `high`, Gemini thinks at `minimal`, the 4.6 Anthropic models do not think, and Haiku 5.5 thinks adaptively at `medium`.
- **Haiku 5.5 agent turns change** (amendment, 2026-10-20). #2077 sends Haiku 5.5 `thinking: {type: "disabled"}` on every request, to keep its behavior equal to Haiku 4.5's until this policy was decided. That provider rule is removed, so fast-tier agent turns in production (contacts, research-analyst, digest) start thinking. This is a behavior change, so the release carrying it waits on a fast-tier A/B (see below).
- **Validated at boot.** `ModelRouter` rejects a tier effort its model's registry entry does not list, the same way it rejects an unknown tier model. That covers `none` on DeepSeek, where the model would write its reasoning into the user-visible reply; `none` on an Anthropic tier is accepted.
- **Agent turns only.** The tier setting applies to agent turns. A fallback call uses the fallback tier's own setting.
- **Other call sites set their own.** The judges, infra skills, scoring pass, summarization, drift detector and voice state their own reasoning, as they state their own temperature. Each sends `none` (amendment, 2026-10-20). On Haiku 5.5 that is the `thinking: disabled` #2077 sends today, which the 10-token classifier and the judges' verdict caps depend on. On models that do not list `none` nothing is sent, so the production judges on Gemini are unchanged. Every non-agent request stays as it is today; the rule moves from a hidden provider default to a stated call-site choice.

The value for each tier comes from an A/B, not from this ADR. Production's standard tier runs three arms on the behavior gate: unset (`high`), `low` and `max`.
- `low` ships if it clears the gate on every run with scores inside unset's run-to-run spread.
- `max` ships only if it beats that spread and its latency cost is acceptable.
- Otherwise the tier stays unset.

The fast tier gets its own check before the release that removes #2077's rule (amendment, 2026-10-20): Haiku 5.5 unset (adaptive at `medium`) against `none` (today's requests), varying only `tiers.fast`, on the contacts scenarios. Unset ships if it clears the gate within `none`'s spread and its latency is acceptable. Otherwise curia-deploy sets `tiers.fast.reasoning.effort: none`.

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
- **`effort: none` on every agent tier.** On DeepSeek the model writes its reasoning into the visible reply instead. *Amended 2026-10-20:* `none` stays rejected where the registry does not list it, and is accepted on Anthropic tiers, where it is a clean `thinking: disabled`.
- **Unset keeps #2077's `thinking: disabled` on Haiku 5.5** (amendment, 2026-10-20). It would change nothing in production, but unset would then mean "Curia's choice" on one model and "the provider's default" everywhere else. Call sites that need thinking off say so instead.
- **A `budget_tokens` mapping for budget-only Anthropic models** (amendment, 2026-10-20). Haiku 5.5 rejects it, and the only model that needs it, Haiku 4.5, serves voice alone.
- **`xhigh` in the effort vocabulary** (amendment, 2026-10-20). Haiku 5.5 and OpenRouter accept it, but no tier needs it yet. It can be added later as a registry entry and enum value.
- **Anthropic's `drop_block` prefix-mismatch behavior** (amendment, 2026-10-20). It needs a beta header, the docs call it a stopgap, and they measured up to 67% more output tokens. The provider guard drops the same blocks without it.
- **An append-only tool loop, as part of this policy** (amendment, 2026-10-20). Bullpen updates would become appended messages and discovered tools would use inline tool additions. It keeps reasoning after a change, but it changes what the model sees mid-loop and needs its own A/B. It is a follow-up.
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
- **Providers without a registry `reasoning` entry stay out** (amendment, 2026-10-20). A tier effort on such a model fails at boot. This covers the Bedrock provider proposed in #2148 until it maps Converse's reasoning fields itself.
- **The prefix guard costs reasoning on Haiku 5.5 after a Bullpen refresh or a tool discovery.** It applies to fast-tier agent turns from the release that removes #2077's rule. The provider logs each drop, so the fast-tier A/B measures its rate.
- **Unset Haiku 5.5 reasoning is not readable in the archive.** With no `thinking` key, Haiku 5.5 returns thinking blocks without text. `llm.call` and the archive still record the reasoning tokens, with `reasoningOmitted: "encrypted"`. A tier that sets an effort gets summarized text.
- **`thinksByDefault` stays in the registry as a fact.** It no longer changes the request; it sizes `max_tokens` (see 2).
