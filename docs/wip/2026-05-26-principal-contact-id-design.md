# Design: Inject `${principal_contact_id}` as a runtime template variable

**Issue:** [#716](https://github.com/josephfung/curia/issues/716)
**Date:** 2026-05-26
**Size:** S

## Problem

Scheduled agents that need the CEO's contact ID currently resolve it at runtime
via `contact-lookup` by role. This is fragile: every cron tick spends an extra
skill call (and tokens) on a value that does not change within a deployment, and
the lookup can fail or be misinterpreted by the LLM.

Two agents currently work around this:

- **`meeting-debrief`** ([agents/meeting-debrief.yaml](../../agents/meeting-debrief.yaml),
  Entity Resolution section, lines 89–92) — calls `contact-lookup` by role on
  every 15-minute cron tick to discover the CEO's known email addresses for the
  solo-event filter (Step 3).
- **`calendar`** ([agents/calendar.yaml](../../agents/calendar.yaml), line 44) —
  calls `contact-lookup` by role to identify the CEO's calendar.

The runtime already injects `${agent_contact_id}` (the agent's own identity)
via `interpolateRuntimeContext()` in [src/agents/loader.ts](../../src/agents/loader.ts).
The same mechanism should inject `${principal_contact_id}`. The data is
already loaded at bootstrap — `principalContact` is materialized at
[src/index.ts:873](../../src/index.ts).

## Scope

**In scope (this PR, curia repo):**

- Inject the principal's contact UUID as `${principal_contact_id}` via
  `interpolateRuntimeContext()`. Mirrors the existing `${agent_contact_id}`
  pattern (opt-in placeholder, not auto-injected).
- Update `meeting-debrief.yaml` and `calendar.yaml` to use the placeholder.
- Add a CLAUDE.md convention documenting that agents needing to reach the
  principal MUST use `${principal_contact_id}` rather than hardcoding addresses
  or calling `contact-lookup`-by-role.

**Cross-repo follow-up (separate PR, curia-deploy repo):**

- Update `T2125-expense-tracker.yaml` to reference `${principal_contact_id}` in
  a new entity-resolution paragraph. T2125 already has `entity-context` pinned;
  the change is prose-only. This lands *after* the curia release that ships the
  platform support, so the placeholder resolves rather than appearing as a
  literal string.

**Out of scope (explicit non-goals):**

- **Auto-injecting** the principal contact ID into every agent prompt. Rejected
  because (a) it expands the attack surface — unrelated agents like
  research-analyst would be invited to contact the CEO directly when they have
  no business doing so; (b) it diverges from the established `${agent_contact_id}`
  opt-in pattern; (c) the real fix for poorly-written agents is the documented
  convention plus review, not silent injection.
- Pre-resolving the principal's email identities, calendar IDs, timezone, or any
  other enrichment data. Agents continue to call `entity-context` with the
  injected ID when they need that information.
- Per-turn refresh. The principal contact ID is immutable for a deployment, so
  bootstrap-time injection is correct. (Identities and calendars *can* change,
  which is why they are excluded — bootstrap-time injection of those would go
  stale.)
- Refactoring `digest.yaml` (curia-deploy) to replace its hardcoded Signal
  number with the placeholder + entity-context. The existing
  `@TODO(signal-config)` flags this work; it stays a separate ticket because
  it changes runtime cost (adds a per-fire entity-context call) and pinned
  skills, not just prose.

## Design

### 1. `interpolateRuntimeContext()` — add the placeholder

[src/agents/loader.ts](../../src/agents/loader.ts):

- Add `principalContactId?: string` to the context parameter object.
- Add a `.replace(/\$\{principal_contact_id\}/g, …)` clause to the existing
  chain.
- Gate it with the same `UUID_FORMAT` defense-in-depth check used for
  `agent_contact_id`. Anything that doesn't match the UUID v4 regex resolves to
  an empty string. This protects against future changes to the ID source from
  accidentally injecting arbitrary text into the system prompt.
- Update the JSDoc comment to list `${principal_contact_id}` alongside
  `${agent_contact_id}`.

### 2. Bootstrap wiring

[src/index.ts](../../src/index.ts):

- `principalContact` is already loaded at line 873. Pass `principalContact?.id`
  (which is `string | undefined`) into both `interpolateRuntimeContext()` call
  sites — the coordinator branch (line 1240) and the `inject_specialists` branch
  (line 1248).
- If `principalContact` is null (fresh deployment, before bootstrap), the value
  passed is `undefined`, the UUID check fails, and the placeholder resolves to
  an empty string — matching the behavior of `agent_contact_id` when its source
  is missing.
- Log a one-time `logger.warn` at boot when `principalContact` is null,
  unconditionally (mirroring the existing line-507 warning for agent
  self-identity). The message names the affected placeholder so the
  misconfiguration is searchable in logs.

### 3. Agent YAML updates

**[agents/meeting-debrief.yaml](../../agents/meeting-debrief.yaml):**

- Replace the prose at lines 89–92 ("At the start of the detection pipeline,
  resolve the CEO's contact via `contact-lookup`…") with explicit reference to
  `${principal_contact_id}`. The new prose tells the agent to use that ID
  directly and to call `entity-context` on it to discover known email addresses.
- Keep `contact-lookup` in `pinned_skills` (line 19) — it is still used for
  non-CEO name resolution at line 86.

**[agents/calendar.yaml](../../agents/calendar.yaml):**

- Replace the prose at line 44 ("To find the CEO's calendar: resolve the CEO
  via `contact-lookup` (by role)…") to use `${principal_contact_id}` directly,
  then call `entity-context` to get the CEO's registered calendar IDs.
- Keep `contact-lookup` in `pinned_skills` (line 173) — still used for other
  name resolution.

### 4. CLAUDE.md convention

Add a short section to [repos/curia/CLAUDE.md](../../CLAUDE.md), near the
existing "Adding Things" / "New Agent" guidance. Suggested wording:

> **Reaching the principal.** Agents that need to send messages to, look up
> calendars for, or otherwise act on behalf of the principal MUST reference
> `${principal_contact_id}` in their system prompt. Pass that ID to
> `entity-context` to discover the principal's verified email addresses,
> Signal number, calendar IDs, and timezone. Do not hardcode addresses or
> phone numbers in agent prompts, and do not use `contact-lookup`-by-role
> for the principal — the platform resolves the ID at bootstrap.

This is the durable countermeasure to "poorly written agents" — it documents
the convention so reviewers and future agent authors can apply it consistently.

### 5. Tests

New `describe('interpolateRuntimeContext')` block in
[tests/unit/agents/loader.test.ts](../../tests/unit/agents/loader.test.ts).

Cases for the new variable:

1. Replaces `${principal_contact_id}` with a valid UUID when provided.
2. Resolves to empty string when `principalContactId` is `undefined`.
3. Resolves to empty string when `principalContactId` is a non-UUID string
   (defense-in-depth check).
4. Leaves other placeholders (`${agent_contact_id}`, `${office_identity_block}`)
   untouched while interpolating `${principal_contact_id}`.

## Acceptance Criteria

(Reproduced from issue #716 with the warn-on-null clarification.)

- [ ] `interpolateRuntimeContext()` resolves and injects `${principal_contact_id}`.
- [ ] If no principal contact exists, the variable resolves to an empty string
      and a warning is logged at boot (unconditional warn-on-null).
- [ ] `meeting-debrief.yaml` and `calendar.yaml` use `${principal_contact_id}`
      instead of runtime `contact-lookup`-by-role for the CEO. Both agents
      retain `contact-lookup` in `pinned_skills` for non-CEO name resolution.
- [ ] Unit test for `interpolateRuntimeContext()` covers the new variable
      (UUID-present, undefined, non-UUID, and isolation from other placeholders).
- [ ] CHANGELOG.md updated under `## [Unreleased]` (per CLAUDE.md).
- [ ] CLAUDE.md "Reaching the principal" convention added near the
      "Adding Things" / "New Agent" section.

## Cross-Repo Follow-Up (curia-deploy)

After this PR ships and a curia release is cut that includes the new
placeholder, open a follow-up PR against `curia-deploy`:

- **`custom/agents/T2125-expense-tracker.yaml`** — add a small "Entity
  Resolution" paragraph (mirroring `calendar.yaml`) instructing the agent
  to use `${principal_contact_id}` and `entity-context` to discover the
  CEO's email/Signal address before any `email-send` or `signal-send`
  call. No skill manifest changes; `entity-context` is already pinned.

Tracked separately so the curia release is the gate — the placeholder must
exist in the platform before the curia-deploy YAML references it.

## Risks & Mitigations

- **Prompt injection via the ID source.** Mitigated by reusing the existing
  `UUID_FORMAT` regex check — any non-UUID string becomes empty.
- **Silent failure on fresh deployments.** The boot warning makes the
  misconfiguration visible in logs. Empty-string fallback matches the
  established behavior for `agent_contact_id`.
- **Agents drifting back to `contact-lookup`-by-role.** Not blocked structurally
  — the prose update relies on the LLM following the new instructions. This is
  acceptable because (a) the same risk applies to `${agent_contact_id}` today,
  (b) a regression would still produce correct behavior (just one wasted skill
  call), and (c) the change reduces, not removes, reliance on `contact-lookup`.
