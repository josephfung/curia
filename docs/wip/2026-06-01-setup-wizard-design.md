# Setup Wizard v1 — Design Spec

**Issue:** [#486](https://github.com/josephfung/curia/issues/486)
**Date:** 2026-06-01
**Status:** Approved

---

## Overview

A `setup-wizard` specialist agent that owns the conversational first-experience after the form wizard exits, and can be re-invoked for "help me set up X" requests. This is v1, scoped to capabilities Curia already has today.

---

## Architecture

### Delegation model

`setup-wizard` is a delegated specialist — not a user-facing agent. The coordinator remains the only voice. The specialist's output is paraphrased and relayed by the coordinator, following the same pattern as `research-analyst`. No new routing logic; the coordinator's `${available_specialists}` injection picks it up automatically.

### No persistent state

The agent has no per-conversation state. It is invoked freshly each time the coordinator delegates. "First conversation" is signalled by the kickoff message text arriving in the task brief, not by any stored flag.

---

## Components

### 1. Infrastructure: `officeIdentityService` capability

`behavioral-preferences-update` needs to write to `OfficeIdentity.behavioralPreferences` via `OfficeIdentityService`. This capability does not currently exist in the skill execution system. Four additive changes are required:

| File | Change |
|---|---|
| `src/skills/types.ts` | Add `officeIdentityService?: OfficeIdentityService` to `SkillContext` |
| `src/skills/loader.ts` | Add `'officeIdentityService'` to `VALID_CAPABILITIES` |
| `src/skills/execution.ts` | Add private field, constructor option, and entry in `capabilityServices` map |
| `src/index.ts` | Pass `officeIdentityService` to the single shared `ExecutionLayer` constructor call |

Pattern mirrors `executiveProfileService` exactly. ~10 lines total.

---

### 2. `skills/behavioral-preferences-update/`

Mirrors `executive-profile-update`. Writes `OfficeIdentity.behavioralPreferences` via `OfficeIdentityService`.

#### `skill.json`

```json
{
  "name": "behavioral-preferences-update",
  "description": "Append or replace entries in the assistant's behavioral-preferences list. Use 'append' to add new preferences without discarding existing ones; use 'replace' to overwrite the full list. Requires CEO authorization.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "capabilities": ["officeIdentityService"],
  "inputs": {
    "operation": "string",
    "entries": "array"
  },
  "outputs": { "preferences": "array", "summary": "string", "changes": "string" },
  "permissions": [],
  "secrets": [],
  "timeout": 15000,
  "action_risk": "low"
}
```

#### `handler.ts` — logic

- Guard: `ctx.officeIdentityService` must be present.
- Validate `operation` is `'append'` or `'replace'`.
- Validate `entries` is a non-empty string array.
- Read current identity: `ctx.officeIdentityService.get()`.
- **append**: union current + new entries (deduplicate by exact string match — idempotent).
- **replace**: overwrite with `entries` directly.
- Build change summary string.
- Persist: `await ctx.officeIdentityService.update({ ...current, behavioralPreferences: merged }, 'skill', note)`.
- Return `{ success: true, data: { preferences, summary, changes } }`.

#### `handler.test.ts` — cases

- `append` adds new entries to existing list.
- `append` is idempotent: duplicate entries are not doubled.
- `replace` overwrites entire list.
- Missing `officeIdentityService` returns `{ success: false }`.
- Invalid `operation` returns `{ success: false }`.
- Empty `entries` array returns `{ success: false }`.

---

### 3. `agents/setup-wizard.yaml`

```yaml
name: setup-wizard
role: specialist
description: >
  First-conversation specialist and setup guide. Invoke when the principal
  just completed initial setup (kickoff message "Just finished setup — say hi!"),
  asks "help me set up X" for any integration or feature, or requests a
  capability tour ("what can you do?"). Returns structured output the
  coordinator relays: greeting, interview questions, setup instructions,
  or a capability summary.
model:
  tier: standard
system_prompt: |
  You are a setup and onboarding specialist working as part of an executive
  assistant team. Your output will be presented by the coordinator — do not
  address the principal directly. Write the response the coordinator should relay.

  ## First-conversation flow

  Triggered when the task brief contains a kickoff message
  ("Just finished setup" or similar). Run this sequence across turns:

  **Turn 1 — Greeting + priorities question:**
  Warm greeting. Acknowledge this is a first conversation. Ask: "What takes
  up most of your time right now — email, scheduling, research, staying on
  top of news?" (one question only; the coordinator will personalize with
  the principal's name when relaying).

  **Turn 2 — Feature suggestions:**
  Map their answer to concrete next steps:
  - Email-heavy → suggest setting up Nylas (env var: NYLAS_API_KEY, NYLAS_GRANT_ID)
  - Calendar-heavy → suggest connecting Google Calendar via Nylas
  - Research / news → "You're already covered — I have web search built in"
  - Scheduling → "Calendar tools are ready once Nylas is connected"
  Persist a preference note via behavioral-preferences-update (append).
  Then ask: "What are your usual working hours and timezone?"

  **Turn 3 — Debrief cadence:**
  Acknowledge the hours. Ask: "Would a regular debrief be useful — say,
  a quick daily summary at end of day, or a weekly digest on Fridays?"

  **Turn 4 — Wrap-up:**
  If they want a debrief: offer to schedule it via scheduler-create.
  Close with a brief summary of what was set up and what's next.

  ## Capability tour

  When asked "what can you do?" or similar: call skill-registry and return
  a plain-language summary grouped by category (email, calendar, research,
  scheduling, memory). Keep it to ~5 bullets.

  ## Integration setup (v1)

  When asked about setting up Nylas, Twilio, Signal, OpenAI key, or similar:
  - Return the specific env var names needed and a one-line description of each.
  - Add: "After setting these, restart Curia and I'll be ready to use them."
  - Add: "An in-app setup flow for this is coming in v2."

  ## Rules

  - You have no persistent state. Each invocation is fresh.
  - Never address the principal directly — always write what the coordinator should say.
  - Keep each turn concise. One question per turn maximum.
  - After each meaningful preference captured, call behavioral-preferences-update (append).

pinned_skills:
  - behavioral-preferences-update
  - scheduler-create
  - scheduler-list
  - scheduler-cancel
  - skill-registry
  - memory-store
  - executive-profile-update
allow_discovery: false
inject_specialists: false
```

---

### 4. Frontend: chat auto-kickoff (`useChatSession.ts`)

Two additions to the hook:

**New constants (top of file):**
```typescript
const ONBOARDING_KICKOFF_KEY = 'curia:onboarding:welcome-banner-pending';
const KICKOFF_TEXT = 'Just finished setup — say hi!';
```

**New `pendingKickoff` ref** (initialized alongside `conversationId`):
```typescript
const pendingKickoff = useRef(
  (() => {
    if (typeof window === 'undefined') return false;
    try {
      const flag = localStorage.getItem(ONBOARDING_KICKOFF_KEY);
      if (flag !== null && !conversationId.current) {
        // Clear immediately — one-shot. Clearing here (not in the effect)
        // prevents a second fire if the component mounts twice in strict mode.
        localStorage.removeItem(ONBOARDING_KICKOFF_KEY);
        return true;
      }
      return false;
    } catch { return false; }
  })(),
);
```

**New `useEffect` (after all other effects):**
```typescript
useEffect(() => {
  if (!pendingKickoff.current) return;
  void send(KICKOFF_TEXT);
  // send is defined in the same render scope; deps omitted intentionally (one-shot).
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

**Why clear the flag in the IIFE:** React strict mode double-mounts components in development. Clearing the flag synchronously in the ref initializer (which runs once, not twice) prevents a second auto-send. The effect sees `pendingKickoff.current` as `false` on the second mount.

---

### 5. Integration test: `tests/integration/setup-wizard-delegate.test.ts`

Two test cases:
1. **Kickoff turn delegates to setup-wizard** — POST with `"Just finished setup — say hi!"` → assert coordinator's `delegate` tool call targets `setup-wizard`.
2. **Normal turn does not delegate to setup-wizard** — POST with `"Hello"` → assert no delegation to `setup-wizard`.

---

### 6. CHANGELOG entries (under `## [Unreleased]`)

```
### Added
- **`setup-wizard` specialist** — first-conversation agent that interviews the principal, captures behavioral preferences, and guides feature setup.
- **`behavioral-preferences-update` skill** — appends or replaces entries in `OfficeIdentity.behavioralPreferences` via `OfficeIdentityService` (`action_risk: low`).
- **Chat auto-kickoff** — chat page auto-sends a visible kickoff message on first mount when the onboarding flag is set, gated on `curia:onboarding:welcome-banner-pending`.
```

---

## Out of scope (v2, tracked in #808)

- In-app Nylas OAuth flow and grant capture
- Phone number provisioning (Twilio) walkthrough
- Signal channel verification
- OpenAI key collection and secure storage
- Persistent step-state tracking across sessions

---

## Acceptance criteria (from issue)

- [ ] `agents/setup-wizard.yaml` exists with `role: specialist`, `inject_specialists: false`, pinned-skills list, system prompt framed as coordinator-relay.
- [ ] `skills/behavioral-preferences-update/` exists with manifest (`action_risk: low`) and handler writing `OfficeIdentity.behavioralPreferences`. Unit tests cover append/replace/idempotency.
- [ ] Setup-wizard `description` makes coordinator routing decision obvious without coordinator-prompt changes.
- [ ] Chat page auto-sends kickoff on mount when `curia:onboarding:welcome-banner-pending` is set and no conversation exists; clears flag after send (one-shot).
- [ ] After walking the form wizard end-to-end, user lands on `/chat` and within ~1s sees kickoff bubble + Curia's personalized greeting + first interview question.
- [ ] Replying with a preference results in a new row in `office_identity_versions`.
- [ ] Asking "help me set up Nylas" delegates to setup-wizard and returns env-var path + restart note + "v2 coming" caveat.
- [ ] Fresh conversation with "Hello" does NOT trigger setup-wizard delegation.
- [ ] Integration test `tests/integration/setup-wizard-delegate.test.ts` covers kickoff-shaped turn and asserts delegate target.
- [ ] `CHANGELOG.md` has three **Added** entries (10–15 words each).
