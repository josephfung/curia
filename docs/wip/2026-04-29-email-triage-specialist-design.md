# Email Triage Specialist — Design

**Issue:** josephfung/curia#386
**Date:** 2026-04-29
**Status:** Approved

## Goal

Extract the observation-mode email triage protocol from `agents/coordinator.yaml` into a
dedicated `email-triage` specialist agent. The coordinator retains oversight via a thin
delegation rule; all triage logic, classification, and email-domain action live in the
specialist.

## Background

Phase 1 inbox triage (see `docs/wip/2026-04-11-inbox-triage-design.md`) shipped a 4-way
triage protocol (later expanded to 5 categories) directly in the coordinator system prompt.
This works, but creates three problems as the protocol grows: auditability (triage decisions
are buried alongside unrelated coordinator events), context pressure (triage rules compete
with other coordinator responsibilities for context budget), and separation of concerns
(triage is a self-contained domain that doesn't need the full coordinator capability set).

## Routing Architecture

**Approach A — coordinator as hub.** The dispatcher continues routing observation-mode
messages to the coordinator unchanged. The coordinator recognizes the observation-mode flag
and delegates to `email-triage` via the `delegate` skill. After the specialist responds, the
coordinator echoes the classification keyword in its own response so the dispatcher's
existing regex extraction (line 779–782 in `src/dispatch/dispatcher.ts`) continues to work
without modification. Zero dispatcher changes required.

Considered and rejected: direct dispatcher routing to the specialist (Approach B). Cleaner
separation, but requires dispatcher changes and breaks the coordinator-as-single-entry-point
pattern. Natural evolution if observation-mode volume grows to a point where the round-trip
matters.

## Agent Definition

**New file: `agents/email-triage.yaml`**

```yaml
name: email-triage
role: specialist
description: >
  Triages the CEO's inbound email in observation mode. Classifies each message into five
  categories and takes appropriate action: archives noise, saves draft replies, escalates
  urgent items via bullpen, and handles or routes actionable items.
model:
  provider: anthropic
  model: claude-sonnet-4-6
inject_specialists: true
pinned_skills:
  - email-list
  - email-get
  - email-archive
  - email-draft-save
  - entity-context
  - bullpen
allow_discovery: false
memory:
  scopes: [email-triage]
system_prompt: |
  <system prompt — see Section below>
```

**Model:** Sonnet 4.6. Triage is structured classification, not open-ended reasoning. Sonnet
is fast and appropriately sized for high-volume inbox traffic.

**Pinned skills:**
- `email-archive`, `email-draft-save` — direct email-domain actions
- `email-list`, `email-get` — thread context lookup before classifying
- `entity-context` — sender standing-instruction and global instruction lookup
- `bullpen` — URGENT escalation and out-of-domain ACTIONABLE routing

**No `signal-send`.** URGENT escalation uses bullpen → coordinator, which selects the
notification channel. This keeps cross-channel concerns in the coordinator and lets the
coordinator make the "most urgent available channel" decision using common sense (Signal is
real-time, email is async — no formal metadata needed).

**`allow_discovery: false`** — specialist stays focused; no runtime-discovered extras.

**`memory.scopes: [email-triage]`** — isolated from coordinator and other specialist memory.

## inject_specialists Flag

`${available_specialists}` is currently injected only for `role: coordinator` agents
(`src/index.ts:817`). The email-triage specialist needs this list to:

1. **Classify ACTIONABLE correctly** — "Is there a deployed specialist that can handle this
   task?" Without the list, the specialist cannot know whether a health expense agent, a
   calendar specialist, or another capability exists in this deployment.
2. **Route bullpen threads precisely** — instead of posting to the coordinator blindly, the
   specialist can mention the right specialist by name for out-of-domain ACTIONABLE items.

**New YAML field:** `inject_specialists: true`

The agent loader in `src/index.ts` is updated to also call `interpolateRuntimeContext` for
any agent that has `inject_specialists: true`, in addition to the existing coordinator path.
No changes to `interpolateRuntimeContext` itself — it already accepts optional context and
leaves other placeholders untouched.

URGENT escalations always go to the coordinator via bullpen (not a named specialist), because
channel selection is the coordinator's responsibility.

## System Prompt

The specialist system prompt absorbs and adapts content currently in `coordinator.yaml`.

### Identity and Role Framing

```
You are the email triage specialist for an executive assistant team. You monitor the CEO's
inbound email in observation mode and act on each message according to a triage protocol.

You are NOT the sender's recipient and you are NOT the coordinator. Your response is logged
for audit; it is not sent to anyone. The coordinator will read your response and echo your
classification in its own reply.
```

### Context Block

The coordinator passes observation-mode context in the delegation task string:

```
[OBSERVATION MODE — email-triage delegation]
Message ID: <nylasMessageId>
Account: <accountId>
Timezone: <IANA timezone>

--- Original message ---
<full email content>
```

The specialist uses `Account` for all email skill `account` params and `Message ID` for
`reply_to_message_id` / archive calls. The dispatcher-injected account override rules
(coordinator.yaml lines 357–373) simplify to a single rule here: always use the Account
from the delegation context.

### ACTIONABLE Scope

ACTIONABLE is defined by capability, not enumeration. Do not hardcode a list of action
types. Instead:

1. Check `${available_specialists}` to understand what Curia can currently do.
2. If a deployed specialist can handle the task, classify as ACTIONABLE and route via
   bullpen (mentioning that specialist).
3. If no deployed specialist can handle the task and it's not in the specialist's own
   skill set, prefer LEAVE FOR CEO unless the CEO has given a standing instruction to act.

This means the scope of ACTIONABLE grows automatically as new specialists are deployed,
and shrinks automatically when a specialist is not running.

### Standing Instructions (per-sender and global)

Call `entity-context` on the sender before classifying. Check for:
- **Per-sender instructions**: "always archive receipts from Stripe"
- **Global/topic instructions**: "track all business expenses", "file health claims
  automatically"

If a matching standing instruction exists, follow it verbatim. The triage protocol below
is the fallback when no standing instruction applies.

### Triage Protocol

```
TRIAGE — evaluate in order:

1. STANDING INSTRUCTIONS
   Call entity-context on the sender. If the CEO has given a standing instruction for this
   sender, email type, or topic, follow it. Global instructions (e.g. "track business
   expenses") take precedence over the default categories below.

2. CLASSIFY — five mutually exclusive categories, evaluated in priority order:

   URGENT — time-sensitive, CEO decision required, from a known contact:
     Open a bullpen thread mentioning the coordinator. Frame it as "this email needs urgent
     notification" — do NOT specify the notification channel; the coordinator decides.
     Include: sender name, subject, one-sentence summary, key ask or deadline.
     Do NOT reply to the sender.

   ACTIONABLE — a task Curia can handle autonomously:
     Check ${available_specialists}. If a specialist can handle this task, open a bullpen
     thread mentioning that specialist with a clear handoff summary. If the task is within
     this specialist's skill set (email archive, draft), execute directly.
     No CEO notification needed — it will appear in the activity log.

   NEEDS DRAFT — a reply is warranted and the CEO should review before sending:
     Call email-draft-save with:
       account: <Account from context>
       reply_to_message_id: <Message ID from context>
       triage_classification: "NEEDS DRAFT"
     Write the draft in the CEO's voice, not the assistant's. Do not sign with a name or
     title. Check whether the CEO has already replied before drafting.

   LEAVE FOR CEO — personal, sensitive, relationship-dependent, or uncertain:
     Do nothing. No archive, no draft, no notification.

   NOISE — receipt, newsletter, automated notification, no human sender action needed:
     Call email-archive with the Message ID and Account from context. No notification.

3. WHEN IN DOUBT
   Prefer LEAVE FOR CEO. URGENT only for genuinely time-sensitive items with a clear
   deadline or decision required. Do not over-notify.
```

### Response Format

Every response must include the classification keyword in a structured line:

```
Classification: <URGENT|ACTIONABLE|NEEDS DRAFT|LEAVE FOR CEO|NOISE>
Rationale: <one or two sentences explaining the decision>
Actions taken: <brief list of skill calls made, or "none">
```

The coordinator reads this response and echoes the classification keyword in its own reply,
preserving the dispatcher's regex extraction at `src/dispatch/dispatcher.ts:779–782`.

## Coordinator Changes

**Remove from `coordinator.yaml`:**
- Lines 272–283: Inbox disambiguation rules (simplified into email-triage context block)
- Lines 299–335: Full observation-mode triage protocol
- Lines 337–338: CEO voice rule for observed emails (moved to specialist)
- Lines 357–373: Email-skill account override exception for observation mode

Estimated reduction: ~65 lines from the coordinator system prompt.

**Add to `coordinator.yaml`** (~10 lines in the delegation section):

```
## Observation Mode — Email Triage Delegation

When you receive a message marked [OBSERVATION MODE — monitored inbox], delegate immediately
to the email-triage specialist via the delegate skill. Do not triage the email yourself.

Task string to pass:
  [OBSERVATION MODE — email-triage delegation]
  Message ID: <nylasMessageId from the preamble>
  Account: <Account identifier from the preamble>
  Timezone: <${timezone}>

  --- Original message ---
  <full email content>

After the specialist responds, echo the classification keyword in your own response
(e.g. "Classification: NOISE") so the dispatcher can extract it.

If the email-triage specialist is unavailable (delegate skill returns an error), classify
all observation-mode emails as LEAVE FOR CEO and include a note in your response indicating
the specialist was unavailable. The audit log will capture this. Do not attempt to triage
without the specialist.
```

## Classification Propagation

No dispatcher changes. The existing regex at `src/dispatch/dispatcher.ts:779–782` extracts
the classification keyword from the coordinator's `agent.response` event. The coordinator
echoes the keyword it receives from the specialist, so propagation is transparent.

## Testing

**Adapt existing tests:**

`tests/unit/dispatch/dispatcher-observation-triage.test.ts` currently simulates the
coordinator emitting classification keywords. These tests continue to work unchanged — the
coordinator still emits the keyword; only the source of truth shifts (specialist → coordinator
echo rather than coordinator's own triage).

**New unit tests:**

- `tests/unit/agents/email-triage.test.ts` (or `agents/email-triage.handler.test.ts`)
  - All five classification outcomes with mock entity-context responses
  - Standing instruction overrides per-sender and global
  - URGENT → bullpen thread opened mentioning coordinator
  - ACTIONABLE in-domain → correct skill call
  - ACTIONABLE out-of-domain → bullpen thread mentioning correct specialist
  - NEEDS DRAFT → email-draft-save called with correct params
  - NOISE → email-archive called
  - LEAVE FOR CEO → zero skill calls

**New unit tests for coordinator delegation:**

- Coordinator receives observation-mode message → delegate skill called with correct task string
- email-triage unavailable → coordinator classifies as LEAVE FOR CEO, logs warning

**New integration test:**

- Observation-mode message flows from dispatcher → coordinator → email-triage → coordinator
  echoes classification → dispatcher extracts and emits triage event
- Add to `tests/integration/multi-agent-delegation.test.ts` or as a new
  `tests/integration/email-triage-delegation.test.ts`

**Smoke test update:**

Update `tests/smoke/cases/email-triage-urgent.yaml` and `email-triage-batch.yaml` to
reflect that classification now originates in the email-triage specialist rather than the
coordinator.

## Files to Create / Modify

| File | Change |
|------|--------|
| `agents/email-triage.yaml` | **Create** — new specialist agent definition |
| `agents/coordinator.yaml` | **Modify** — remove ~65 lines of triage protocol, add ~10 lines of delegation rule |
| `src/agents/loader.ts` | **Modify** — add `inject_specialists` field to `AgentYamlConfig` type |
| `src/index.ts` | **Modify** — inject `${available_specialists}` for agents with `inject_specialists: true` |
| `tests/unit/agents/email-triage.test.ts` | **Create** — unit tests for all 5 classifications + edge cases |
| `tests/integration/email-triage-delegation.test.ts` | **Create** — end-to-end delegation flow |
| `tests/smoke/cases/email-triage-urgent.yaml` | **Modify** — update expected response shape |
| `tests/smoke/cases/email-triage-batch.yaml` | **Modify** — update expected response shape |
| `CHANGELOG.md` | **Modify** — add entry under `## [Unreleased]` |

No changes to: dispatcher, email adapter, bullpen service, skill manifests, outbound gateway,
or the bus event schema.

## Out of Scope

Per issue #386, the following are tracked as separate issues:

- **Scheduled observation job** — decoupling triage from the email adapter's primary polling
  loop into a separate scheduled job with independent cadence
- **Label management** — future triage complexity (email labels, more categories) lands in
  the specialist once it exists; label management infrastructure is a separate concern
- **Interactive-mode email** — stays with coordinator; using Curia's email as a communication
  channel is architecturally distinct from monitoring the CEO's inbox
