# Coordinator prompt reassessment — the decision-spine restructure

**Issue:** #957
**Date:** 2026-06-13
**Status:** Design — approved verbally, pending written review

## Problem

`agents/coordinator.yaml` (v0.6.0) has grown to ~665 lines across ~30 sections. Its
dominant, repeated framing is "you are the doer and the unified voice — compose
replies, do the work," while delegation guidance is scattered and self-contradictory.
The result is **systemic under-delegation of *transfer-ownership* replies**: the
coordinator answers them itself, so specialist lifecycles never complete (dropped
follow-ups, spurious reminders — see #956).

Concrete evidence (from #957): every delegation example in the prompt is "borrow info,
then I answer." The prompt never distinguishes that from "hand off the whole
interaction." So when a hand-off-the-whole-interaction reply arrives (e.g. a CEO reply
to a `delegation_hint`ed debrief outbound), the model defaults to answering. The Active
Outbound Context section also contains contradictory clauses ("Always delegate" at L224
beside "handle directly" L231 / "handle normally" L232), and a "just compose your reply"
default at L343–344.

## Goal

Re-derive the prompt around a single explicit model — the three-way routing decision —
and reorganize accordingly, **porting all current behavior 1:1 except the one known
delegation defect.**

## The keystone model

The coordinator's core function: for each inbound, choose **one of three** and stay the
single voice.

- **Handle directly** — within my own capabilities (memory, config, simple Q&A).
- **Borrow-then-answer** — pull info/work from a specialist (the "brief me" pattern),
  then *I* reply in my own voice.
- **Transfer-ownership** — hand the *entire interaction* to a specialist that owns its
  lifecycle (completion, confirmations, releasing the context entry). I route it and do
  **not** reply.

**The rule that fixes the bug class:** a reply to anything I sent on a specialist's
behalf (a `delegation_hint`ed outbound) is **always** transfer-ownership — I route it to
that specialist and never answer it myself, even for a trivial "no."

## Intended behavior changes (the only deviations from 1:1 porting)

Everything else ports 1:1. There are exactly **two** intended changes:

1. **The transfer-ownership reply rule** (above) — the keystone fix for the delegation
   defect.
2. **Remove the vestigial `${executive_voice_block}`** from the coordinator. It was a
   bare placeholder with no surrounding prose; the coordinator composes as Curia (the
   office) in its own `office_identity` voice and never drafts in the CEO's *personal*
   voice. The ceo-inbox specialist — which owns CEO-voice drafting — already fetches the
   voice profile at runtime via the `executive-profile-get` skill (ceo-inbox.yaml Step 1),
   not via an injected block, so nothing depends on the coordinator carrying it. The
   `executive-profile-get` / `executive-profile-update` skills stay pinned to the
   coordinator (it remains the profile's custodian); only the injected block is removed.
   Because no other agent receives `executiveProfileService`, the runtime/loader
   voice-injection path becomes dead and is removed in full.

## Target structure — the 5-part taxonomy

The body of `system_prompt` is reorganized so every section maps onto exactly one slot,
and the operating policy (slots 1–4) sits in the top portion with mechanics pushed to a
bottom Reference region (slot 5).

**Governing principle (sharpened during design):** slot 3 contains only *genuinely
self-served* capabilities. Anything whose instruction is "delegate to a specialist" is
an instance of a hand-off pattern (slot 2), even when I then speak in my own voice.

### 1. Who I am
Persona, voice, audience adaptation, and how I refer to my own identity.

### 2. The routing decision (the spine)
The three-way choice as the explicit spine, placed near the top. Names the two hand-off
patterns and states the transfer-ownership reply rule.
- *Borrow-then-answer* named examples: Contact Intelligence "brief me" (the archetype),
  CEO Inbox requests.
- *Transfer-ownership* named examples: replies to delegation-hinted outbounds (debrief,
  calendar-reschedule, specialist-clarification resumes).

### 3. What I do directly
Only self-served capabilities: memory, configuration, scheduling/tasks, email on my own
account, Google Workspace, reaching the principal, data protection, pending-approval
handling, capability discovery, general guidelines.

### 4. What I proactively surface
**One** unified discipline replacing the four near-duplicate copies: "surface the oldest
item, one per turn, at a natural pause, don't interrupt urgent topics" — covering held
messages, decay warnings, pending approvals, and backlog. The *handling mechanics* for
each (held-messages-process actions, memory-confirm, approve/deny) live in slot 3; only
the surfacing discipline unifies here.

### 5. Reference
Clearly-marked region at the bottom for tool-specific mechanics: config-store namespace
syntax, Drive-upload steps, email account-selection rules, email threading mechanics,
`context_bridge` JSON shape, decay-warning phrasings. Tool-mechanics stay *in the prompt*
— relocating them into skill manifests is the separate #958 follow-up.

## Porting checklist — every current section → new home

| # | Current section (coordinator.yaml v0.6.0) | New slot |
|---|---|---|
| 1 | `${office_identity_block}` (injected) | Preamble (runtime-injected, see below) |
| 2 | `${security_context_block}` (injected) | Preamble (runtime-injected) |
| 3 | Date & Time | 1 — Who I am |
| 4 | Your Identity (agent_contact_id usage) | 1 — Who I am (value injected, see below) |
| 5 | Pronoun Resolution for Delegation | 2 — Routing decision (delegation prep) |
| 6 | Memory (storing facts, proactive recall) | 3 — Direct; namespace/decay mechanics → 5 |
| 7 | Contact Intelligence ("brief me") | 2 — Routing decision (borrow-then-answer archetype) |
| 8 | Configuration (config-store) | 3 — Direct (when to use); namespace syntax → 5 |
| 9 | Audience Awareness | 1 — Who I am |
| 10 | Active Outbound Context & Delegation | 2 — Routing decision (resolves the contradiction) |
| 10a | Enriching outbound context (context_bridge) | 5 — Reference (JSON shape) |
| 10b | self-contained vs reply-shaped test | 2 — Routing decision |
| 11 | Held Messages | surfacing → 4; process actions → 3 |
| 12 | Decay Warnings | surfacing → 4; memory-confirm + phrasings → 3 / 5 |
| 13 | Scheduling and Task Management | 3 — Direct; backlog-surfacing → 4 |
| 14 | Email (send/reply, inbox, To/CC, before composing) | 3 — Direct; threading + account rules → 5 |
| 15 | CEO Inbox Requests | 2 — Routing decision (borrow-then-answer); cold-compose addr resolution → 5 |
| 16 | `${executive_voice_block}` (injected) | **Removed** (vestigial — see Intended behavior changes #2) |
| 17 | Account Identity for Tool Calls | 5 — Reference |
| 18 | Reaching the Principal | 3 — Direct |
| 19 | Your Team (`${available_specialists}`) | 2 — Routing decision; roster injected → Appendix |
| 20 | Google Workspace (read, drive, uploads) | 3 — Direct; upload steps → 5 |
| 20a | Delegation acknowledgment on sync channels | 2 — Routing decision |
| 20b | Handling specialist clarification requests | 2 — Routing decision (transfer-ownership resume) |
| 21 | Persona & Communication Style | 1 — Who I am |
| 22 | Data Protection | 3 — Direct |
| 23 | Pending Approval Requests | handling → 3; surfacing → 4 |
| 24 | Capability Discovery | 3 — Direct |
| 25 | Guidelines | 3 — Direct (or fold into 1/2) |

Before finalizing the rewrite, every row above will be confirmed represented in the new
prompt (acceptance criterion: porting checklist complete).

## The injection / runtime change

Currently these are `${...}` placeholders substituted in-place (identity/security/voice
per-turn in `runtime.ts`; specialists/contact-IDs at bootstrap in
`loader.interpolateRuntimeContext`). The in-place model has a latent failure: if the
placeholder is missing, the identity/voice block is silently dropped, and security falls
back to an end-of-prompt append — hence the failsafe warning at `index.ts:~941`.

**New model:** the runtime always-injects these blocks at fixed canonical positions, so
the YAML no longer carries placeholders. This matches the existing always-injected
`## Principal Contact Details` / `## Your Contact Details` pattern.

### Assembly order (coordinator-only — scoping preserved)

```
[office_identity_block]        <- PREAMBLE (prepended, constraints first)
[security_context_block]       <- PREAMBLE (prepended)

<coordinator.yaml system_prompt body — placeholder-free>

[## Available Specialists]     <- APPENDIX (roster from agentRegistry.specialistSummary())
[## Your Contact Details]      <- APPENDIX (now includes a `Contact ID: <uuid>` line)
[## Principal Contact Details] <- APPENDIX (unchanged)
[autonomy] [date/time] [turn budget] [intent anchor] [scheduler fence]  <- unchanged
```

The agent's own contact ID (formerly `${agent_contact_id}` inline) is injected as a
`- Contact ID: <uuid>` line appended to the already-present `## Your Contact Details`
block — **coordinator-only** (the value is passed into `AgentRuntime` only for the
coordinator). The body's identity guidance references that block.

### Scope (decision: preserve current scoping)

- `office_identity_block`, `security_context_block`: coordinator only (as today —
  services are passed to `AgentRuntime` only for the coordinator).
- `executive_voice_block`: **removed entirely** (see Intended behavior changes #2).
- `available_specialists`: coordinator gets it via the new runtime appendix. Specialists
  that opt in with `inject_specialists: true` (e.g. ceo-inbox.yaml) keep their existing
  `${available_specialists}` placeholder resolved at bootstrap — **untouched.**
- `agent_contact_id` / `principal_contact_id`: specialist YAMLs (e.g. calendar.yaml) keep
  their inline placeholders resolved by `interpolateRuntimeContext` — **untouched.** Only
  the coordinator stops using the inline placeholder.

### File changes

- **`agents/coordinator.yaml`** — full `system_prompt` restructure; remove all `${...}`
  placeholders (including `${executive_voice_block}`); bump `version` 0.6.0 → 0.7.0.
- **`src/agents/runtime.ts`** — replace the in-place `.replace('${...}', block)` logic
  for identity/security with prepend (identity, security). Add `## Available Specialists`
  and the `Contact ID:` line to the appendix. Thread `availableSpecialists` and
  `agentContactId` through `AgentRuntimeConfig`. **Remove** the `${executive_voice_block}`
  injection block (L259-276), the `executiveProfileService` / `executiveDisplayName`
  config fields, and the now-unused `compileWritingVoiceBlock` import.
- **`src/index.ts`** — pass `availableSpecialists` and `agentContactId` into the
  coordinator's `AgentRuntime`; **delete** the missing-`${security_context_block}`
  failsafe warning at ~L941; **stop passing** `executiveProfileService` /
  `executiveDisplayName` to the coordinator's `AgentRuntime`. (`executiveProfileService`
  itself stays alive — the `executive-profile-*` skills consume it.)
- **`src/agents/loader.ts`** — `interpolateRuntimeContext` keeps the
  `${available_specialists}` / `${agent_contact_id}` / `${principal_contact_id}` branches
  for specialists. **Remove** the `${executive_voice_block}` branch (no remaining
  consumer) and drop `executiveVoiceBlock` from its context param. The coordinator branch
  in `index.ts` stops feeding it the now-absent placeholders; the coordinator's
  `availableSpecialists` moves to the runtime appendix path.

## Validation

- **Baseline metric (run now):** query the audit log for the current `delegate`→specialist
  rate on transfer-ownership replies (debrief / calendar-reschedule / specialist-
  clarification replies). Expected near-zero. Requires prod audit-log access — to be
  confirmed at that step. The exact query is documented in the PR so the post-deploy
  "after" can be re-run. The "after" number is inherently post-deploy; that acceptance
  checkbox stays open at PR time with the method documented.
- **Tests (TDD on the code change):**
  - `runtime` — coordinator effective prompt **starts with** identity→security preamble
    and **includes** `## Available Specialists` + a `Contact ID:` line in the appendix;
    a non-coordinator agent gets none of those. Assert the coordinator prompt **no longer
    contains** the executive voice block.
  - `loader` — `interpolateRuntimeContext` still resolves specialist placeholders
    (`${agent_contact_id}`, `${available_specialists}`, `${principal_contact_id}`)
    unchanged; the `${executive_voice_block}` branch is gone.
  - Remove the index.ts failsafe and any test asserting that warning. Remove/adjust any
    test asserting executive-voice injection into the coordinator.
- **Manual smoke pass:** email reply, contacts "brief me", memory store/recall,
  scheduling, held-message surfacing, approval handling.

## Versioning & changelog

- `coordinator.yaml` `version`: 0.6.0 → **0.7.0** (minor — behavior-affecting restructure;
  Agent YAML is a public API surface so the change is called out explicitly).
- CHANGELOG `[Unreleased]` → **Changed**: coordinator prompt re-derived around the
  three-way routing decision; transfer-ownership replies now always delegate.
- CHANGELOG `[Unreleased]` → **Removed**: vestigial executive-voice block injection from
  the coordinator (CEO-voice drafting lives in the ceo-inbox specialist).

## Out of scope (per #957)

- Relocating tool-mechanics into skill descriptions/manifests — #958.
- Execution-layer *enforcement* of delegation (a "force" backstop) — gated on the metric.
- Debrief reminder defense-in-depth — #956 (complementary).

## Risks

- The prompt is large and drives untested production behavior; the porting checklist plus
  the explicit "one intended behavior change" framing is the regression guard.
- Prepending identity/security changes the prompt's leading bytes, which affects prompt
  caching warmth on first deploy — acceptable, one-time.
