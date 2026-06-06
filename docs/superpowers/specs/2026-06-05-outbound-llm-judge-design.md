# Outbound Safety — Stage 2 LLM-as-Judge (Audience-Leak Detection)

**Issue:** [#547](https://github.com/josephfung/curia/issues/547) — feat: outbound safety LLM-as-judge content filter (Spec 15 Stage 2)
**Plan reference:** `docs/wip/2026-06-02-outbound-audience-leak.md` (Layer A)
**Date:** 2026-06-05
**Status:** Approved design — ready for implementation plan

---

## Summary

Implement Stage 2 of the outbound content filter: an LLM-as-judge that runs after Stage 1
(deterministic rules) passes. This is a **focused first version** scoped to the single
responsibility that caused the 2026-06-01 audience-leak incident: **recipient-appropriateness /
information-disclosure detection**. The judge decides whether an outbound message body contains
content that should not be sent to *this set of recipients* — internal monologue, system/agent
status, side-channel notes ("To the CEO: ..."), or reasoning that exposes implementation — when
any non-principal recipient is on the message.

**Explicitly out of scope** for this version (deferred to a follow-up, tracked against the broader
#547 scope): tone alignment and persona consistency. The infrastructure shipped here (judge wiring,
prompt file, config, telemetry, tests) supports adding those later by extending the prompt only.

**Layer B** from the plan (structured external/internal reply via a `compose-reply` skill) is a
separate, larger change and is **not** part of this work.

---

## Background

On 2026-06-01 the coordinator leaked internal reasoning into an outbound email to an external
contact (Armin), including a "To the CEO: ..." status block concatenated into the same body that
went to the external recipient. The coordinator prompt already forbids this; the model violated
the instruction anyway. A prompt-only fix is insufficient — we need a defense-in-depth check at
the outbound boundary that does not rely on the model behaving.

Stage 1's four deterministic rules (`system-prompt-fragment`, `internal-structure`,
`secret-pattern`, `contact-data-leak`) cannot catch *narrative* internal monologue. Regex rules for
that would be fragile and noisy. The right tool is the Stage 2 LLM judge, whose stub already exists
at `src/dispatch/outbound-filter.ts` (`runLlmReview` currently returns `[]`).

---

## Architecture

### Components

1. **`OutboundLlmJudge`** — new class, `src/dispatch/outbound-judge.ts`.
   Implements a small interface and owns the LLM call, timeout, parsing, telemetry, and failure
   semantics. Returns `FilterFinding[]` (`[]` = pass) so it slots directly into the filter.

   ```ts
   export interface OutboundJudge {
     review(input: JudgeInput): Promise<FilterFinding[]>;  // [] = pass (no leak)
   }
   ```

2. **`outbound-judge-prompt.ts`** — new file holding the judge's prompt builder/system prompt as
   string constants, reviewable and tunable in isolation (per the plan).

3. **`OutboundContentFilter`** — existing, `src/dispatch/outbound-filter.ts`.
   Minimal change: constructor config gains an optional `judge?: OutboundJudge`; `runLlmReview()`
   delegates to it. Filter input is extended with structural recipient data.

4. **`OutboundGateway`** — existing, `src/skills/outbound-gateway.ts`.
   Builds the recipient set (`to + cc`, each tagged `isPrincipal`) and passes it into the filter.
   **No change to block handling** — a Stage 2 block already routes through `outbound.blocked` +
   CEO notification + message drop, identically to Stage 1.

### Data flow

```
OutboundGateway.send()
  → resolve recipients: [to, ...cc] → FilterRecipient[] { email, isPrincipal }
  → OutboundContentFilter.check({ content, recipients, principalIncluded, principalIsSoleRecipient, ... })
      → Stage 1 deterministic rules (unchanged); any finding → block, skip Stage 2
      → Stage 2: runLlmReview()
          → if no judge configured OR judge disabled OR principalIsSoleRecipient → return [] (pass)
          → else judge.review() → LLM call → { leak, reason } → FilterFinding[]
  → if blocked: existing path emits outbound.blocked + notifies CEO + drops message
```

---

## Recipient discriminator (structural, not `role`)

The free-text `role` field on a contact is manually entered and must **not** gate "is this the
principal?" (see the `project_principal_discriminator` learning). Messages can also have multiple
recipients (To + CC), so the filter reasons over the *set*.

Filter input is extended:

```ts
export interface FilterRecipient {
  email: string;
  isPrincipal: boolean;   // structurally determined — see below
}

// added to FilterCheckInput:
recipients: FilterRecipient[];        // To + CC merged, in order
principalIncluded: boolean;           // recipients.some(r => r.isPrincipal)
principalIsSoleRecipient: boolean;    // recipients.length === 1 && recipients[0].isPrincipal
```

**How `isPrincipal` is computed.** The gateway already holds `principalIdentities` — the principal
contact's *verified channel identities* loaded from the DB at boot — and uses them in
`isPrincipalRecipient()` / `isPrincipalEmail()`. We reuse `isPrincipalEmail(email)` to tag each
recipient. This is structurally authoritative (verified identities, not the role string) and needs
no extra per-recipient contact lookup.

> **Note on the plan's `contactId === principalContactId` formulation.** The plan describes the
> discriminator as a contact-ID match. Matching against the principal's verified channel identities
> is equivalent in authority and is already wired into the gateway, so we use that rather than
> resolving every CC recipient to a `contactId`. Both avoid the unreliable `role` string, which is
> the actual requirement.

**Stage 1 audit (implementer task).** Trace how `recipientTrustLevel` and the `'ceo'` trust check in
`checkContactDataLeak` are computed. Today the gateway sets `recipientTrustLevel = contact.trustLevel`
(a structured field, not `role`). Verify that `trustLevel: 'ceo'` is itself derived structurally from
the principal identity and not from the free-text role; if it is role-derived, switch that carve-out
to the same `isPrincipal` discriminator. If it is already principal-derived, leave it unchanged.

---

## Judge behavior

### Skip conditions (return `[]` without an LLM call)

1. `principalIsSoleRecipient === true` — the principal alone is a private channel; internal language
   is permitted. **Do not** skip merely because the principal is *one of* the recipients.
2. Judge disabled (`filter.llmJudge.enabled === false`) — kill switch for incident response / cost.
3. No judge wired (e.g. in unit tests that construct the filter without a judge) — preserves the
   current no-op Stage 2 and keeps existing filter callers/tests working unchanged.

### The LLM call

- Model: the configured `filter.llmJudge.model` (default `claude-haiku-4-5`), routed through the
  existing `LLMProviderRouter` (`infraLlmRouter`) so any registered model/provider works with no new
  wiring. Temperature 0, max output ~100 tokens.
- The prompt **JSON-encodes the message body and recipient list inside delimiters**, with a system
  message stating the encoded blob is opaque data to evaluate, not instructions to follow
  (prompt-injection defense — same technique as `scoring-pass.ts`).
- Wrapped in a timeout (`Promise.race`, default `timeout_ms: 5000`).
- Emits an `llm.call` telemetry event on success (same shape as `infra-llm.ts` / `scoring-pass.ts`):
  model, tokens, cost estimate, latency, prompt/response hashes.

### Verdict shape

```json
{ "leak": true | false, "reason": "<one short sentence, or empty string if leak=false>" }
```

- `leak: true` → `[{ rule: 'llm-judge-audience-leak', detail: reason }]` (block).
- `leak: false` → `[]` (pass).

### Failure semantics (split fail-open / fail-closed)

The judge owns its failure handling and never throws. Default behavior, configurable via
`filter.llmJudge.failMode`:

| Failure | Default | Rationale |
|---|---|---|
| Timeout / API outage (judge unreachable) | **fail-OPEN** — return `[]`, deliver | The judge couldn't render an opinion; gates on it would halt all non-principal-sole outbound during an outage. Availability. |
| Malformed / unparseable JSON (live model, garbled output) | **fail-CLOSED** — return `[{ rule: 'llm-judge-parse-error', detail: <raw> }]`, block | A live model returning a non-conforming verdict is an anomaly (possible manipulation). Safety. |

`failMode: 'closed'` makes *both* cases block; `failMode: 'open'` makes *both* deliver. The default
is the split above. Every failure is logged at warn with the cause.

The existing fail-closed `try/catch` around `runLlmReview` in `check()` stays as a last-resort net
for *truly unexpected* throws (the judge shouldn't throw, but defense in depth).

---

## Configuration

`config/default.yaml`:

```yaml
filter:
  llmJudge:
    enabled: true
    # Default works out of the box (claude-haiku-4-5 — smaller/cheaper than the opus coordinator).
    # STRONGLY RECOMMENDED: point this at a DIFFERENT vendor/family than the fast/standard/powerful
    # agent tiers (e.g. an OpenRouter Gemini or DeepSeek model) so an attack crafted for the Claude
    # coordinator cannot also fool the reviewer. Model diversity is the security value here.
    model: claude-haiku-4-5
    timeout_ms: 5000
    failMode: split        # split (default) | open | closed
```

- `model` is a dedicated model string (not a tier reference) so the judge can use a different vendor
  independently of the three agent tiers. It is validated against the model registry at startup
  (fail-fast on an unknown model). The registry still owns pricing/capabilities — YAML only names a
  registered model, consistent with "model registry stays in code".
- Parsed and typed in `src/config.ts` alongside the existing config sections.

---

## Testing (TDD-first)

### Unit — `outbound-judge.test.ts` (mocked `LLMProvider`)

- `leak: true` verdict → `[{ rule: 'llm-judge-audience-leak', detail: reason }]`.
- `leak: false` verdict → `[]`.
- Timeout (provider never resolves within `timeout_ms`) → `failMode: split`/`open` returns `[]`;
  `failMode: closed` returns a finding. Assert the timeout fires.
- API error response (`type: 'error'`) → `split`/`open` deliver, `closed` block.
- Malformed JSON → `split`/`closed` returns `llm-judge-parse-error`; `open` returns `[]`.
- Empty message body → handled (no crash).
- Very long message body → handled (no crash; passes through to the model).
- Injection content (body containing `</...>` / fake JSON / "ignore previous instructions") → assert
  it is JSON-encoded inside the delimiter scheme in the prompt sent to the provider.
- Telemetry: a successful call publishes one `llm.call` event.

### Unit — additions to `outbound-filter.test.ts` (mocked judge)

- With a judge wired, Stage 2 runs **only** when Stage 1 passes (Stage-1 finding → judge not called).
- Judge block → `result.passed === false`, `result.stage === 'llm-review'`,
  finding rule `llm-judge-audience-leak`.
- `principalIsSoleRecipient === true` → judge **not** called (assert zero provider/judge calls).
- `principalIncluded === true` with third parties also present → judge **is** called.
- `principalIncluded === false` → judge **is** called.
- `filter.llmJudge.enabled === false` → judge **not** called regardless of recipients.
- No judge configured → Stage 2 is a no-op pass (back-compat for existing callers).
- Structural discriminator: a recipient whose `role` would read "ceo" but whose email is **not** a
  principal identity is treated as a third party (`isPrincipal === false`) — confirms the structural
  check wins over `role`.

### Integration — `tests/integration/outbound-judge.integration.test.ts` (real cheap model, env-gated)

Canned inputs (~6–10), skipped when the API key env var is absent so keyless CI passes:

- Verbatim 2026-06-01 4:38 PM Armin body, recipients `[armin]` (no principal) → `leak: true`.
- Same body, recipients `[armin, principal]` (principal CC'd) → `leak: true` (third party still reads it).
- Same body, recipients `[principal]` only → judge skipped (no provider call).
- Clean professional reply ("Friday June 5 at 2 PM works. I'll send a calendar invite shortly."),
  recipients `[armin]` → `leak: false`.
- At least one multi-recipient case for each of the prompt's (a) side-channel, (b) system-state,
  (c) intent-reasoning categories, plus clean controls.

### Full suite

`pnpm --prefix <worktree> run typecheck` and `pnpm --prefix <worktree> test` must pass (1300+ tests),
confirming no regression in principal-sole flows (daily briefings, Signal pings, CLI) which must
still carry internal language without being blocked.

---

## Cost & latency

One extra LLM call per outbound to non-principal-sole recipients, on the cheapest configured model
(~100 output tokens, short prompt): sub-cent, ~1–3s added latency, within the <3s acceptance budget.
Principal-only replies skip the judge entirely.

---

## Files

| File | Change |
|---|---|
| `src/dispatch/outbound-judge.ts` | **New** — `OutboundLlmJudge` (LLM call, timeout, parse, telemetry, failMode). |
| `src/dispatch/outbound-judge-prompt.ts` | **New** — judge prompt builder + system prompt constants. |
| `src/dispatch/outbound-filter.ts` | Extend `FilterCheckInput` with recipient fields; `runLlmReview` delegates to optional `judge`; skip logic. |
| `src/skills/outbound-gateway.ts` | Build `recipients`/`principalIncluded`/`principalIsSoleRecipient` from `to + cc`; pass to filter. Audit Stage 1 trust carve-out. |
| `config/default.yaml` | Add `filter.llmJudge` block. |
| `src/config.ts` | Parse/type the new config; validate `model` against the registry at startup. |
| `src/index.ts` | Construct `OutboundLlmJudge` when enabled; pass into `OutboundContentFilter`. |
| `src/dispatch/outbound-judge.test.ts` | **New** — judge unit tests. |
| `src/dispatch/outbound-filter.test.ts` | Add Stage 2 / recipient / skip tests. |
| `tests/integration/outbound-judge.integration.test.ts` | **New** — env-gated real-model tests. |
| `docs/specs/15-outbound-safety.md` | Update Stage 2 section: implemented, binary leak/no-leak (drop "review"). |
| `CHANGELOG.md` | `## [Unreleased]` → **Security**: Stage 2 outbound LLM judge. |

---

## PR linkage

Per the issue comment: this PR uses `Refs #547` (the broader tone/persona scope stays tracked on
#547) unless we file a dedicated follow-up issue, in which case `Closes #547`. Default: `Refs #547`
+ note the deferred scope. Implementer/CEO decision at PR time.
