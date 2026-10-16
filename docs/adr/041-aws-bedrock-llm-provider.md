# ADR-041: AWS Bedrock as an LLM provider

Date: 2026-07-06 (revised 2026-10-16)
Status: Proposed

> **Provenance.** Authored by [@AnshulaChowdhury](https://github.com/AnshulaChowdhury)
> in [#1349](https://github.com/josephfung/curia/pull/1349) and preserved in #1768.
> Revised alongside the implementation (#1766) to read for every operator rather than
> one deployment: the model-search narrative is now general findings, and tier choices
> for a specific installation are left to that installation's `local.yaml`.

## Context

ADR-007 put Anthropic behind a provider-agnostic `LLMProvider` interface so that adding
a provider is an adapter plus configuration, not an architecture change.
`OpenRouterProvider` already showed a second adapter plugs in cleanly. This ADR adds a
third: AWS Bedrock.

Why an operator wants it: consolidating LLM billing, IAM and data-residency controls under
an existing AWS account, and swapping between hosted model families without changing
vendors.

Two questions were settled up front:

1. **Access path.** Calls go directly to Bedrock via `@aws-sdk/client-bedrock-runtime`.
2. **Credentials.** ADR-021 requires every provider credential except the vault-bootstrap
   values to live in the encrypted vault. The AWS access key and secret follow that path
   (`aws_access_key_id` / `aws_secret_access_key`, resolved by `applyVaultSecrets()`).
   Region and request timeout are non-secret and stay in `.env`, like `TIMEZONE`.

## Decision

Add `BedrockProvider` (`src/agents/llm/bedrock.ts`), an `LLMProvider` over Bedrock's
**Converse API**, registered in `providerRegistry` next to Anthropic and OpenRouter.

**Opt-in; defaults unchanged.** The provider registers only when both vault secrets and
`AWS_REGION` are present. A deployment with no AWS credentials behaves exactly as before,
and `config/default.yaml` keeps its Anthropic tier mapping, because the install wizard
collects Anthropic credentials only. An operator who wants Bedrock maps tiers in their own
uncommitted `config/local.yaml`.

**Why Converse, not raw `InvokeModel`.** Converse normalizes tool use, message roles and
response shape across every model family Bedrock hosts. That maps directly onto Curia's
provider-neutral `ToolCall` / `ToolResult` / `ContentBlock` types, whereas `InvokeModel`
would need each family's native schema and tool-calling semantics reimplemented. The class
is therefore model-agnostic, not tied to one vendor.

**Models are registered by inference-profile id.** The `bedrock-runtime` endpoint rejects a
bare model id for current Claude models and requires a geo or global profile id:
`global.` may route anywhere AWS has capacity; `us.` / `eu.` stay within that geography
(data residency). Each profile id is its own `ModelRegistry` key with provider `bedrock`,
so it cannot collide with the direct-API `claude-*` keys. Registered at introduction:
Claude Sonnet 4.6 and Haiku 4.5 for `global`, `us` and `eu`.

**No provider is mandatory at boot.** Boot previously hard-failed without an Anthropic key
even if no tier used a Claude model. Anthropic, OpenRouter and Bedrock now register
symmetrically, each conditional on its own credentials, and the "every tier-mapped model has
a registered provider" check enforces what a deployment's own configuration needs, naming the
tier, model and provider when one is missing. A partial AWS configuration logs a warning.
`anthropic_api_key` is no longer in the installer's required-secrets list for the same
reason.

**Two defensive measures at the provider boundary:**

- `detectUncalledToolIntent()` — a model can return a valid, successful response that is
  still a silent failure by *describing* a tool call in text instead of emitting a
  `toolUse` block. When tools were offered, text containing a fenced JSON block naming an
  offered tool is logged at `error`. It is deliberately conservative and is an
  observability signal, not a fix or a complete detector.
- `normalizeMessageSequence()` — Converse requires the conversation to start with a `user`
  message and strictly alternate roles; Anthropic and OpenAI tolerate violations. It drops
  leading non-`user` turns and merges consecutive same-role turns. Two upstream causes
  produce such sequences: failed LLM calls leaving an unpaired user turn (fixed in
  `AgentRuntime`, #1767 / #1774) and the summarization pass writing a synthetic
  `role: 'system'` row inline in history. The normalizer remains as a guard.

### Findings that apply to any operator choosing a Bedrock model

These came from a live model search and are the reason a tier should be validated, not
assumed:

1. **Tool-calling can degrade under load.** A model that calls tools correctly in an
   isolated test can narrate calls as prose or JSON instead once a large system prompt
   (~12K tokens) and a full tool set (~48 tools) are both present. Observed with
   `mistral.mistral-large-2402-v1:0`: 5 of 5 loaded runs failed, while the same model with
   one tool and a short prompt succeeded. Validate a candidate model under production-shaped
   load before routing the coordinator's tiers to it.
2. **Not every model supports tool use.** Bedrock rejects tool configuration outright for
   some (e.g. the original Llama 3 instruct models: "This model doesn't support tool use").
3. **Access can require more than `bedrock:InvokeModel`.** Anthropic models are billed
   through AWS Marketplace; an account may also need Marketplace subscription permissions
   before the first call succeeds.
4. **Model ids are strict.** An id that does not match Bedrock's catalog is rejected with
   `ValidationException`, and a bare id fails where a profile id is required.

### Consequences of the Anthropic-optional boot for judges

If LLM-as-judge components (outbound filter, escalation judge) are intended to run on a
different model family from the agents they review, an operator who moves every tier to
Bedrock should still map those judges deliberately. The provider does not decide this.

## Consequences

**Easier:**
- ADR-007 held: a third provider took one adapter, conditional registration mirroring
  OpenRouter, and no changes to `AgentRuntime`, `ModelRouter`, or any agent or skill.
- A deployment can run entirely on Bedrock, Anthropic or OpenRouter, or any mix per
  capability tier, with no provider treated as load-bearing by bootstrap.
- AWS credentials use the same vault-only handling as every other provider key; no
  plaintext-secret exception was introduced.
- Cost telemetry works: each registered profile id carries pricing (and cache rates, since
  Bedrock reports cache tokens when a model caches implicitly).

**Harder / accepted trade-offs:**
- **No `stream()`.** The voice channel requires true streaming (ADR-037), so no Bedrock
  model may back it. The registry does not advertise `streaming` for these entries, and
  voice boot refuses a model without it.
- **No prompt-cache checkpoints are emitted**, so cache savings available on the direct
  Anthropic API are not realized through this provider.
- **Pricing is static data.** Entries mirror the direct-API rates and were not verified
  against Bedrock's own price list; geo profiles may be priced differently from `global`.
  Static registry pricing is a standing weakness for any provider, and a way to let
  operators maintain it outside code would address it for all of them.
- **Context window is the conservative 200K** mirrored from the direct-API entries, though
  AWS lists a larger window for Sonnet 4.6; raise it only after confirming the Converse path
  accepts it without extra flags.
- **Not exercised against a live endpoint in CI.** Unit tests mock the SDK client (keeping
  the real `ConverseCommand`). `pnpm run smoke:bedrock-tools` runs the load scenario from
  finding 1 against live Bedrock and fails loudly on a narrated call, a provider error,
  or missing credentials. It needs AWS credentials, so it is not part of `pnpm test`; run it
  whenever a tier's model changes.
- **The shipped model list has not been re-searched live.** The registered Claude profile ids
  come from AWS's model cards, not from running the smoke gate, so the gate should be run on
  a chosen tier model before this ADR moves to Accepted.
- **The two defensive measures are partial.** The tool-narration detector misses phrasings
  with no JSON block, and the normalizer loses information when it merges turns. An
  LLM-as-judge pass over responses that should have invoked a tool is a possible future
  improvement.
