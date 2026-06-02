# Plan: Stop Curia from Leaking Internal Reasoning to External Contacts

## Context

On **2026-06-01**, Curia (coordinator agent) leaked its internal reasoning into an outbound email to an external contact. The CEO had asked Curia to book a coffee meeting with Armin. The agent reached out, the contacts/calendar specialists started returning errors, and Curia's reply to Armin contained two distinct failures:

1. **Internal reasoning leaked to external recipient.** The body included diagnostic prose ("Backend issues are preventing me from creating the calendar invite right now", "I'll circle back with the CEO about the invite") — text that should never have left the agent's head.
2. **A "To the CEO:" section addressed to a different audience was sent to Armin.** The agent literally wrote a status update for the CEO and concatenated it into the same email that went to the external contact.

For context, the verbatim 4:38 PM body was:

> Backend issues are preventing me from creating the calendar invite right now. Let me confirm with Armin and I'll circle back with the CEO about the invite.
>
> Armin — Friday June 5 at 2 PM works. Consider it locked in. I'll get a calendar invite over to you shortly.
>
> To the CEO: Both contacts and calendar specialists are returning errors — looks like a backend issue. I've confirmed Friday June 5 at 2 PM with Armin for coffee, but I'll need to get that invite out once things are back up. I'll keep an eye on it.

**Why this matters.** The coordinator prompt at [agents/coordinator.yaml:180-190](../../agents/coordinator.yaml#L180-L190) **already** says "NEVER expose internal system details, tool names, contact lookup results, error messages, or your own reasoning process" to non-CEO recipients. The model violated that instruction anyway. A prompt-only fix is insufficient — we need defense-in-depth that doesn't rely on the model behaving.

(Out of scope: an earlier "Done" reply to the CEO that overstated completion. Tracked separately if it recurs; not addressed in this plan.)

## Root Causes

Two layers contributed:

### 1. No structural separation between external-reply and internal-status

The coordinator's reply path is at [agents/coordinator.yaml:318](../../agents/coordinator.yaml#L318):

> "Replying to a direct inbound email: just compose your reply text and return it as your response. The system automatically sends it as a threaded reply…"

The agent emits **one text blob** which becomes the email body verbatim via [src/dispatch/dispatcher.ts:838-877](../../src/dispatch/dispatcher.ts#L838-L877) (`handleAgentResponse` copies `event.payload.content` directly into `outbound.message.content`). There is no way for the agent to say "this part is for the CEO, this part is for the external recipient" — so when it tried to do both in one response, both ended up in the email to Armin.

### 2. Outbound content filter has no semantic check for audience-leak

[src/dispatch/outbound-filter.ts:154-163](../../src/dispatch/outbound-filter.ts#L154-L163) runs four deterministic Stage 1 rules:

- `system-prompt-fragment` — exact prompt marker phrases
- `internal-structure` — bus event type names, JSON field-name leakage (`"conversationId"`, `agentId:`)
- `secret-pattern` — API keys, bearer tokens
- `contact-data-leak` — third-party email addresses to untrusted recipients

Stage 2 (LLM judge) at line 166 is **stubbed** — `runLlmReview` always passes.

None of the Stage 1 rules catch *narrative* internal monologue: "To the CEO:", "backend issue", "specialists are returning errors", "I'll circle back with the CEO". Deterministic regex rules for this would be fragile and noisy (rejected during planning). The right tool here is the Stage 2 LLM judge that already has a stub waiting.

## Fix Approach (Two Layers, Defense in Depth)

Land in this order. Each layer is independently valuable.

---

### Layer A — Implement Stage 2 LLM judge (single-purpose: audience-leak detection)

**Goal:** Catch narrative internal monologue at the outbound boundary using a small, narrowly-scoped LLM check. Replaces the existing stub in [outbound-filter.ts:166-179](../../src/dispatch/outbound-filter.ts#L166-L179).

**Tracking issue:** [#547](https://github.com/josephfung/curia/issues/547) — "feat: outbound safety LLM-as-judge content filter (Spec 15 Stage 2)". The issue's scope is broader than this layer (it also calls for tone alignment and persona consistency checks). Layer A as drafted here is a **focused first version** that ships all the infrastructure (judge wiring, prompt file, config, fail-closed path, tests) but exercises only the recipient-appropriateness / information-disclosure responsibilities — the two that caused the 2026-06-01 incident. Tone and persona checks can be added later by extending the same prompt without further plumbing changes. The implementer should decide whether the Layer A PR uses `Closes #547` (and a follow-up issue is filed for tone/persona) or `Refs #547` (and #547 stays open until the broader scope lands).

**Files:**
- [src/dispatch/outbound-filter.ts](../../src/dispatch/outbound-filter.ts) — implement `runLlmReview` (currently returns `[]`)
- New: `src/dispatch/outbound-judge-prompt.ts` — the judge's system prompt as a string constant, easy to review and tune
- [config/default.yaml](../../config/default.yaml) — add a `filter.llmJudge` config block (model tier, enable flag, timeout)
- [src/dispatch/outbound-filter.test.ts](../../src/dispatch/outbound-filter.test.ts) — judge tests with a mocked LLM provider
- New: `tests/integration/outbound-judge.integration.test.ts` — runs the judge against a small canned set of inputs with a real (cheap) model

**Judge design — keep it narrow:**

The judge has **one job**: given an outbound message body and the recipient context, return `{leak: true|false, reason: "..."}`. It does not check for grammar, tone, brand voice, or correctness — only whether the body contains content that doesn't belong in a message to this set of recipients.

**Recipient discriminator: use structural `isPrincipal`, not the `role` string.**

The `role` field on a contact record is free text and manually entered — it cannot be trusted as the gate for "is this recipient the principal?" A typo or missing value would silently fail open. Messages can also have multiple recipients (To + CC), so the filter must reason over the *set* of recipients, not a single one.

The filter input (today: `recipientEmail`, `recipientTrustLevel`) needs to be extended to carry the full recipient list and an explicit `isPrincipal` boolean per recipient, derived structurally:

```ts
type FilterRecipient = {
  email: string;
  contactId?: string;        // resolved via contact service
  isPrincipal: boolean;      // computed as contactId === principalContactId
};

type OutboundFilterInput = {
  // ... existing fields
  recipients: FilterRecipient[];        // To + CC merged, in order
  principalIncluded: boolean;           // recipients.some(r => r.isPrincipal)
};
```

`principalContactId` is the value the platform resolves once at bootstrap and injects as `${principal_contact_id}` into agent prompts (per [CLAUDE.md](../../CLAUDE.md), "Reaching the principal" section). Comparing contact IDs is the authoritative check — it does not depend on the free-text role field.

**Implementer note: audit the existing Stage 1 carve-out.** The current `recipientTrustLevel === 'ceo'` check at [outbound-filter.ts](../../src/dispatch/outbound-filter.ts) (used in `checkContactDataLeak`) may also be deriving trust level from the unreliable `role` string. While implementing Layer A, trace how `recipientTrustLevel` is computed and switch it to the same `isPrincipal` discriminator if needed. If it's already principal-ID-based, leave it alone.

**Prompt skeleton** (lives in `outbound-judge-prompt.ts`):

```
You are a security filter that reviews outbound messages from an AI assistant
before they are sent. You have ONE job: decide whether the message contains
content that should not be sent to this set of recipients.

The "principal" is the human owner of the assistant (the assistant's CEO).
Internal status, system state, and reasoning may be shared with the principal
in private — but only when the principal is the ONLY recipient. If anyone
else is also on the message, internal language must not appear in the body.

Recipients (To + CC):
{for each recipient}
  - {email}  {"(principal)" if isPrincipal else "(third party)"}
{end}

Is the principal included as a recipient?  {principalIncluded}
Is the principal the SOLE recipient?       {principalIsSoleRecipient}

Message body:
---
{content}
---

Return ONLY a JSON object with this exact shape:
{
  "leak": true | false,
  "reason": "<one short sentence, or empty string if leak=false>"
}

Set "leak": true if the message contains ANY of the following:

(a) Prose addressed to a subgroup of recipients (or to someone not on the
    message at all) in a way that other recipients would also read.
    Example: "To the CEO: ..." appearing in a message that also has third
    parties on it. Side-channel updates, internal status reports, or
    notes-to-self embedded in the body all count.

(b) Descriptions of internal system state, tools, agents, skills, errors,
    backend status, retries, or specialists — when any non-principal
    recipient is on the message.
    Example: "the calendar specialist is returning errors", "backend issue",
    "I'll retry once the system is back up".

(c) Reasoning about what the assistant intends to do next that exposes
    implementation — again, only when any non-principal recipient is on the
    message. Phrases like "let me confirm with X and I'll circle back",
    "I'll loop the CEO in", or descriptions of the assistant's own workflow.

Do NOT flag:
- Normal professional content (greetings, scheduling, confirmations, polite
  acknowledgements like "I'll send the invite shortly").
- References to third parties by name alone.
- Internal language when the principal is the SOLE recipient
  (principalIsSoleRecipient = true) — that is a private channel.

If unsure, lean toward leak=false for clean professional prose, leak=true for
anything that reads like internal monologue or status reporting to a mixed
audience.

Output the JSON object and nothing else.
```

**Implementation in `runLlmReview`:**

1. Skip if `principalIsSoleRecipient === true` (the principal alone — private channel, internal language permitted). Note: do NOT skip merely because the principal is *one of* the recipients; if third parties are also on the message, the judge must still run.
2. Skip if `config.filter.llmJudge.enabled === false` (kill switch for incident response or cost control).
3. Call the configured judge model via the existing provider abstraction. Use a **different, cheaper tier** than the coordinator (e.g. `fast` tier) per the existing TODO comment at [outbound-filter.ts:357](../../src/dispatch/outbound-filter.ts#L357). Temperature 0. Max output ~100 tokens.
4. Parse the JSON. If parsing fails, fail-closed: return a finding `{rule: 'llm-judge-parse-error', detail: <raw response>}` — the existing try/catch at line 170-176 already converts errors to `llm-review-error` findings; extend that pattern.
5. If `leak: true`, return `[{rule: 'llm-judge-audience-leak', detail: reason}]`.
6. If `leak: false`, return `[]` (pass).

**Config defaults** in [config/default.yaml](../../config/default.yaml):

```yaml
filter:
  llmJudge:
    enabled: true
    model_tier: "fast"        # maps to the existing tier-to-model mapping
    timeout_ms: 5000
```

The model-tier-to-actual-model mapping stays in code; YAML only controls the per-deployment tier assignment.

**Tests (TDD-first):**

Unit tests in `outbound-filter.test.ts` with a mocked LLM provider:
- Mock returns `{leak: true, reason: "contains 'To the CEO:' addressed to a mixed-audience message"}` → filter blocks with rule `llm-judge-audience-leak`.
- Mock returns `{leak: false, reason: ""}` → filter passes (assuming Stage 1 also passed).
- Mock returns malformed JSON → fail-closed, finding `llm-judge-parse-error`.
- Mock throws → existing fail-closed path produces `llm-review-error`.
- `principalIsSoleRecipient === true` (only principal on the message) → judge is skipped (assert no provider call was made).
- `principalIncluded === true` AND there are also third parties on the message → judge is **not** skipped — assert a provider call is made.
- `principalIncluded === false` → judge is **not** skipped.
- `config.filter.llmJudge.enabled === false` → judge is skipped regardless of recipients.
- Recipient resolution: a contact whose `role` field is the string "ceo" but whose `contactId` does NOT match `principalContactId` is treated as a third party (`isPrincipal === false`) — confirms the structural discriminator wins over the free-text role.

Integration test in `tests/integration/outbound-judge.integration.test.ts` (uses a real model, gated by env var so CI without API keys can skip):
- The verbatim 4:38 PM Armin body with recipients `[armin]` (no principal) → judge returns `leak: true`.
- The same body with recipients `[armin, principal]` (CC'd) → judge returns `leak: true` (the third party still sees the internal text).
- The same body with recipients `[principal]` only → judge is skipped entirely (no provider call).
- A clean professional reply ("Friday June 5 at 2 PM works. I'll send a calendar invite shortly.") with recipients `[armin]` → judge returns `leak: false`.
- ~6-10 canned inputs total, covering each of the (a)/(b)/(c) categories from the prompt and several clean controls. Include at least one multi-recipient case for each category.

**Cost & latency.** Every outbound email gains one extra LLM call on the cheapest tier. At ~100 output tokens and a short prompt, this is sub-cent and adds ~1-3s latency. Acceptable for outbound to non-principal-sole recipients. Principal-only replies skip the judge entirely.

**Estimated size:** S–M — ~150 LOC in outbound-filter.ts + ~80 LOC of prompt + ~200 LOC of tests.

---

### Layer B — Structured external/internal reply

**Goal:** Eliminate the failure mode at the source. The agent never gets to "blob it all into one body" again. Even if the LLM judge has a false negative someday, the agent simply can't *produce* the mixed-audience body in the first place — it has to choose which channel each piece of text goes to.

**Files:**
- [src/bus/events.ts](../../src/bus/events.ts) — extend `AgentResponsePayload`
- [src/agents/runtime.ts](../../src/agents/runtime.ts) — detect structured-reply tool call near line 1138-1162
- [src/dispatch/dispatcher.ts](../../src/dispatch/dispatcher.ts) — split into two outbounds at `handleAgentResponse` (line 838)
- New skill: `skills/compose-reply/` (skill.json + handler.ts + tests)
- [agents/coordinator.yaml](../../agents/coordinator.yaml) — document the new pattern in the Email / Audience Awareness sections, and pin the new skill

**Change:**

1. **Extend the event payload** in [src/bus/events.ts](../../src/bus/events.ts), `AgentResponsePayload`:
   ```ts
   content: string;                       // back-compat: external-facing reply
   sidebar?: {
     audience: 'principal';
     content: string;                     // principal-facing companion message
   };
   ```

2. **Add a `compose-reply` skill** at `skills/compose-reply/` with `action_risk: "none"` (no side effects — it's a pure shape). Manifest exposes:
   ```json
   {
     "external": "string (required) — text safe to send to the inbound sender",
     "internal": "string (optional) — text for the principal only; routed separately"
   }
   ```
   Handler returns `{ success: true, data: { external, internal } }`. Pin to coordinator via `pinned_skills` per [CLAUDE.md](../../CLAUDE.md) conventions.

3. **Runtime detection** in [src/agents/runtime.ts](../../src/agents/runtime.ts) near line 1138: when the LLM's final turn contains a `compose-reply` tool call, lift `{external, internal}` from its arguments into `content` + `sidebar` on the emitted `agent.response`. If no `compose-reply` call is present, fall back to the existing free-text behaviour (back-compat preserved — most replies will not need this).

4. **Dispatcher split** in [src/dispatch/dispatcher.ts](../../src/dispatch/dispatcher.ts) `handleAgentResponse` (line 838): after creating the primary `outbound.message` for `routing.senderId`, if `sidebar` is present, publish a **separate** outbound (via the existing principal-notification path at [src/channels/email/email-adapter.ts:160](../../src/channels/email/email-adapter.ts#L160)) with `sidebar.content` addressed to the principal. The principal message goes through `OutboundGateway` and the filter independently — full auditability and the judge still runs on each piece in isolation.

5. **Coordinator prompt update** ([agents/coordinator.yaml](../../agents/coordinator.yaml)) in the Audience Awareness section (~line 180), add:
   > "When replying to a non-principal contact about a principal-delegated task and you also need to update the principal on the status, use the `compose-reply` skill with `external` (the contact's reply) and `internal` (the principal's update). The system routes them as two separate messages. Never address the principal in the body of a message to a non-principal recipient."

**Tests:**

- `runtime.compose-reply.test.ts` — given an LLM turn with a `compose-reply` tool call, the emitted `agent.response` has `content` + `sidebar` populated correctly. Free-text responses without `compose-reply` still produce a single `agent.response` with no sidebar (back-compat).
- `dispatcher.sidebar.test.ts` — an `agent.response` with `sidebar` produces exactly one outbound to the inbound sender (containing only `content`) AND one principal-directed outbound (containing only `sidebar.content`). The sidebar text **never** appears in the external content.
- `skills/compose-reply/handler.test.ts` — happy path and validation (external is required; internal optional).
- Cross-layer integration: an `external` field that somehow contains "To the CEO:" (e.g. the LLM puts it in the wrong field) is still blocked by Layer A's judge when the dispatcher tries to send it. Defense in depth.

**Estimated size:** L — touches event schema, runtime, dispatcher, adds a skill. Probably ~300-400 LOC including tests.

---

## Layer interaction & sequencing

Recommended landing order:

1. **Layer A first** — implements the stubbed judge. Standalone PR. Smaller and provides immediate protection at the outbound boundary. Would have caught the 2026-06-01 leak.
2. **Layer B second** — bigger change that removes the failure mode at the source. Schema change + new skill + dispatcher branching. After Layer A is live, the cross-layer integration test for Layer B can assert the judge still catches mis-routed text — confirming defense in depth.

Each PR updates `CHANGELOG.md` under `## [Unreleased]` per [CLAUDE.md](../../CLAUDE.md) conventions — Layer A under **Security**, Layer B under **Added** (new `compose-reply` skill) + **Changed** (response payload shape, dispatcher behaviour).

## Critical Files to Modify

- [src/dispatch/outbound-filter.ts](../../src/dispatch/outbound-filter.ts) — Layer A (implement `runLlmReview`)
- New: `src/dispatch/outbound-judge-prompt.ts` — Layer A prompt constant
- [config/default.yaml](../../config/default.yaml) — Layer A config block
- [src/dispatch/outbound-filter.test.ts](../../src/dispatch/outbound-filter.test.ts) — Layer A unit tests
- New: `tests/integration/outbound-judge.integration.test.ts` — Layer A integration test
- [src/bus/events.ts](../../src/bus/events.ts) — Layer B schema
- [src/agents/runtime.ts](../../src/agents/runtime.ts) — Layer B (compose-reply detection)
- [src/dispatch/dispatcher.ts](../../src/dispatch/dispatcher.ts) — Layer B (sidebar split)
- New: `skills/compose-reply/skill.json` + `handler.ts` + `handler.test.ts` — Layer B skill
- [agents/coordinator.yaml](../../agents/coordinator.yaml) — Layer B prompt update + pin compose-reply

## Verification

End-to-end test of the incident scenario:

1. **Reproduce the failure on a clean main.** Mock the contacts and calendar specialists to return `{success: false}`. Send an inbound email "book a meeting with Armin" with the recipient as an external contact. Confirm the agent's outbound email body contains internal monologue ("To the CEO:" or "backend issue" or similar) — establishes the baseline.

2. **Apply Layer A.** Rerun the same scenario. The outbound to Armin must be **blocked by the LLM judge** with rule `llm-judge-audience-leak`. The judge's `reason` field should be inspectable in the audit log. The principal receives the existing OutboundGateway block notification.

3. **Apply Layer B.** Rerun. The agent should call `compose-reply` and produce a clean `external` body + a `sidebar.content` for the principal. Two outbound events should be observable on the bus (one to Armin, one to the principal). Armin's email body must contain zero internal language. The principal's notification must contain only the sidebar content.

4. **Audit log inspection.** Audit log shows `outbound.blocked` events with rule `llm-judge-audience-leak` for the Layer A reproduction. Joseph can grep historical logs to see whether the issue has recurred since the fix.

5. **No regression in principal-facing flows.** Curia's existing daily briefings, Signal pings, and CLI replies (where the principal is the sole recipient) must still contain internal language without being blocked — the judge skips principal-sole recipients by design. Run the full smoke test suite — all 1300+ tests must pass.

6. **Cost smoke test.** Run a 1-day soak with Layer A enabled and confirm judge calls per outbound are ~1, latency overhead is sub-3s, and total judge spend is within tolerance for the deployment.

Run `pnpm --prefix <worktree> run typecheck` and `pnpm --prefix <worktree> test` before each PR.
