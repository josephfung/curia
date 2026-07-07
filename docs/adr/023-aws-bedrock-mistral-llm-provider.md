# ADR-023: AWS Bedrock as the configured LLM provider

Date: 2026-07-06
Status: Accepted

## Context

ADR-007 established Anthropic as Curia's primary LLM provider behind a
provider-agnostic `LLMProvider` interface specifically so that switching or
adding providers would be a config change, not an architecture change. The
operator running this deployment wants to run entirely on AWS Bedrock, serving
Mistral models, instead of the Anthropic API — this allows for easier swapping between models.

This is exactly the scenario ADR-007 anticipated: "different agents may
benefit from different providers" and "switching the primary provider... requires
only a config change, not code changes," backed by "a thin adapter per
provider." `OpenRouterProvider` already demonstrated that a second adapter
plugs in cleanly. This ADR records the decision to add a third.

Two implementation questions were resolved before building:

1. **Bedrock access path.** Calls go directly to Bedrock via `@aws-sdk/client-bedrock-runtime`.
2. **Credential storage.** ADR-021 (vault-only secret resolution) requires
   every provider credential except the four vault-bootstrap values to live in
   the encrypted secrets vault, not `.env`. The AWS access key and secret
   follow that path (`aws_access_key_id`/`aws_secret_access_key` vault keys,
   resolved by `applyVaultSecrets()` like every other provider key). Region and
   request timeout are non-secret operational config and stay in `.env`,
   matching `TIMEZONE`/`HTTP_PORT`.

## Decision

Add `BedrockMistralProvider` (`src/agents/llm/bedrock-mistral.ts` — the
filename predates the final model choice below; the class itself is not
Mistral-specific, it works for any Converse-compatible Bedrock model)
implementing `LLMProvider` via Bedrock's **Converse API**, register it in
`providerRegistry` in `src/index.ts` alongside (not instead of, at the code
level) Anthropic and OpenRouter.

Final `config/default.yaml` `model_routing.tiers`:
- **fast**: `mistral.mixtral-8x7b-instruct-v0:1`
- **standard/powerful**: `anthropic.claude-3-sonnet-20240229-v1:0` — served
  via Bedrock, not the direct Anthropic API.

**Why Claude via Bedrock, not a Mistral model, for the coordinator's tiers:**
this went through a real model search, not a single guess, because the
consequence of guessing wrong here is a silent safety failure (see the
"narrated tool call" finding below), not just a validation error. In order:

1. `mistral.mistral-large-3-675b-instruct` (originally configured) — rejected
   outright by Bedrock (`ValidationException: The provided model identifier is
   invalid`); the ID didn't match Bedrock's usual
   `mistral.<name>-v<major>:<minor>` shape.
2. `mistral.mistral-large-2402-v1:0` (Mistral Large, Feb 2024) — a real,
   working model. **Confirmed via isolated load testing to silently fail at
   tool-calling under the coordinator's actual conditions**: with a large
   system prompt (~11.8K tokens) and many available tools (~48, matching the
   coordinator's real pinned-skill count), it narrates an intended tool call as
   prose/JSON text instead of emitting a real Converse `toolUse` block —
   confirmed via 5 isolated test runs (100% failure) and one live production
   call, where the coordinator told the CEO it would check scheduled jobs and
   never actually called `scheduler-list`. The same model in isolation (one
   tool, no large prompt) calls tools correctly — the failure is specifically
   load-dependent, not a blanket incapability.
3. `us.anthropic.claude-sonnet-4-6` (a cross-region inference profile) — a
   real tool call was observed once, but the model requires an AWS Marketplace
   subscription grant (`aws-marketplace:ViewSubscriptions`/`Subscribe`) beyond
   plain `bedrock:InvokeModel`, which wasn't available on this account; repeated
   attempts after adding the base IAM permission still failed consistently.
4. `meta.llama3-8b-instruct-v1:0` — valid model, but Bedrock returns
   `ValidationException: This model doesn't support tool use` outright. The
   original Llama 3 (pre-3.1) instruct models have no Converse tool-calling
   support at all.
5. `anthropic.claude-3-sonnet-20240229-v1:0` — **the model shipped.** An older,
   native on-demand foundation model (no inference profile, no Marketplace
   gate). Confirmed 6/6 across an unloaded call plus 5 repeated calls under the
   full production-shaped load (47 tools + ~20K-char system prompt) — 100% real
   `tool_use`, zero narrated-call failures.

A useful side effect: because the coordinator's tiers now run Claude while
`filter.llmJudge`/`escalation.judge` stay pinned to Mixtral (fast tier, a
genuinely different model family), the model-diversity property those judges
were designed around (see their config comments) is intact — not a
degradation, despite everything running through the same Bedrock account.

**Why Converse over Bedrock's raw `InvokeModel` API:** Converse normalizes tool
use, message roles, and response shape across every model family Bedrock
hosts, into one API. That maps directly onto Curia's existing
provider-neutral `ToolCall`/`ToolResult`/`ContentBlock` types — the same shape
`OpenRouterProvider` already maps onto the OpenAI-compatible chat API. Using
Bedrock's raw per-model invoke format instead would mean hand-rolling each
model family's native request/response schema and reimplementing tool-calling
semantics Converse already provides uniformly — and, per the search above,
still needing per-model validation regardless.

**A necessary side effect: Anthropic is no longer unconditionally required at
boot.** `src/index.ts` previously hard-failed startup if `ANTHROPIC_API_KEY`
(now `anthropic_api_key` in the vault) was absent, regardless of whether any
agent tier actually used a Claude model. That assumption breaks for an
all-Bedrock deployment. Anthropic, OpenRouter, and Bedrock are now registered
symmetrically — each conditional on its own credentials being present — and
the existing "every tier-mapped model has a registered provider" validation
loop is what enforces that *this deployment's actual configuration* has what
it needs, rather than hardcoding one vendor as mandatory for all deployments.
`seed-vault.ts`'s `REQUIRED_SECRET_NAMES` was updated to match — provider keys
were removed from that list for the same reason.

**New safety net: `detectUncalledToolIntent()`.** Since a model can return a
perfectly valid, successful Converse response that still represents a silent
failure (narrating a tool call instead of making one), `bedrock-mistral.ts`
now scans text responses (when tools were offered) for a fenced JSON block
matching an offered tool's name, and logs at `error` level if found —
deliberately conservative to avoid false alarms on replies that merely mention
a tool by name. This is a detector, not a fix: it makes the failure mode
visible in logs rather than catching every phrasing (a live test found a
narrated-call variant with no JSON block at all, which this detector does not
catch — see `scripts/smoke-bedrock-tool-use.ts` below for the mechanism that
actually gates on this). We may want to use a LLM-as-judge pass over responses
that should invoke a tool call in future to be able to catch and fix these 
issues in real-time for the user.

**New regression gate: `pnpm run smoke:bedrock-tools`**
(`scripts/smoke-bedrock-tool-use.ts`). Runs the real `BedrockMistralProvider`
(not a bypassing raw-SDK script) against live Bedrock, reproducing the same
production-shaped load (large system prompt + ~48 tools) that exposed the
Mistral failure, and asserts a real `tool_use` call comes back. Requires live
AWS credentials and a reachable Postgres, so it's deliberately **not** part of
`pnpm test` — same reasoning as `tests/integration` needing Docker Postgres,
or `redteam` needing its own setup. Run it whenever the configured
standard-tier model changes.

**New safety net: `normalizeMessageSequence()`.** After shipping, a real
production conversation broke every subsequent turn with
`ValidationException: A conversation must start with a user message.` Root
cause was two compounding, pre-existing bugs in `AgentRuntime`/`WorkingMemory`,
neither introduced by this change:

1. A failed LLM call persists the user's turn to `working_memory` *before* the
   call, but never writes an assistant turn back on failure — repeated
   failures during this deployment's own model-search debugging (above) left
   several orphaned `user` turns with no paired `assistant` reply, so later
   messages stacked up as consecutive `user` turns.
2. `WorkingMemory`'s summarization pass writes its synthetic summary as a
   `role: 'system'` row *inline* in conversation history, not hoisted to the
   top-level system prompt. Every provider (Anthropic, OpenRouter, Bedrock)
   strips `role: 'system'` messages out of the regular array when building the
   top-level system param — so whatever turn immediately followed that
   mid-history system row became the new first element, which in this case was
   `assistant`.

Anthropic's and OpenAI's APIs are apparently lenient enough not to reject
either pattern; Bedrock's Converse API is strict about both (must start with
`user`, must strictly alternate) and was the first provider to surface this.
Fixed defensively at the Bedrock provider boundary —
`normalizeMessageSequence()` drops leading non-`user` messages and merges
consecutive same-role messages — rather than in `AgentRuntime`/`WorkingMemory`,
which is out of scope here and where the actual root cause still lives (see
Consequences). 3 tests reproduce the exact production sequences found.

## Consequences

**Easier:**
- Confirms ADR-007's hypothesis: adding a third provider took one new adapter file, a
  few conditional-registration lines mirroring the existing OpenRouter pattern,
  and no changes to `AgentRuntime`, `ModelRouter`, or any agent/skill code.
- Deployments can now run entirely on Bedrock, entirely on Anthropic, entirely
  on OpenRouter, or any mix per capability tier, with no provider treated as
  load-bearing infrastructure by the bootstrap sequence itself.
- AWS credentials follow the same vault-only handling as every other provider
  key (ADR-021) — no new plaintext-secret exception was introduced.
- Tool-use is no longer an open question — confirmed both by the live
  reliability probing above and by a real end-to-end production call
  (`scheduler-list` actually invoked, real data returned, correctly
  synthesized into the reply — verified against the audit log).
- Cost telemetry works for the shipped model: `anthropic.claude-3-sonnet-20240229-v1:0`
  carries real, well-documented pricing ($3.00/$15.00 per M input/output
  tokens), unlike the Mistral entries below.

**Harder / accepted trade-offs:**
- **Is pricing for tokens best placed in the code?.** Given the dynamic
  nature of token pricing, it seems that for users to be able to trust 
  costing dashboards it may be better to add a frontend UI for users to 
  enter costing information directly.
- **Mixtral's context window (32K) is a documented spec, not independently
  confirmed against this account/region.** Given that we can now swap out
  models as needed, this is an okay tradeoff for now.
- **No prompt-cache support on Bedrock** (Mistral or Claude-via-Bedrock) —
  cache-related cost savings that exist for direct-API Claude traffic don't
  apply here.
- **`detectUncalledToolIntent()` is best-effort, not exhaustive** — it catches
  the JSON-fenced narration pattern observed with mistral-large-2402, not
  every possible way a model could describe an uncalled action in prose. The
  real regression gate against this failure mode is
  `pnpm run smoke:bedrock-tools`, which knows the expected outcome ahead of
  time and can therefore assert on it precisely; the in-provider detector is
  an observability signal on top, useful in production where the expected
  outcome isn't known in advance.
- **`normalizeMessageSequence()` masks a real upstream bug rather than fixing
  it.** The underlying gaps — failed LLM calls not persisting an assistant
  turn, and the summarization pass writing its synthetic turn inline instead
  of hoisted — still exist in `AgentRuntime`/`WorkingMemory` and could
  resurface in new ways (e.g. a conversation could still read strangely to the
  model even though Bedrock no longer rejects it outright, since dropped/merged
  turns lose information — see the real example where a merged multi-question
  blob caused the coordinator to answer a stale question instead of the latest
  one). Anthropic and OpenRouter are not protected by this fix at all, since it
  lives in the Bedrock adapter only. This may be worth its own fix in 
  `AgentRuntime`/ `WorkingMemory` — persist a turn (even an error marker) 
  after every failed call, and hoist mid-history system turns into the top-level 
  system prompt before they ever reach a provider — rather than every provider 
  adapter needing its own defensive normalization.
