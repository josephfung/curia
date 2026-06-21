# Design: Resume a delegated specialist after secret capture

**Issue:** [#995](https://github.com/josephfung/curia/issues/995)
**Follow-up to:** #972 (secret.captured event + agent resume), PR #984 (forward guard)
**Date:** 2026-06-21
**Status:** Approved (design), pending implementation

## Problem

Secret capture resume (#972) re-enters the agent that minted a capture link by publishing
a synthetic `agent.task` back into that agent's conversation. This works for the
**coordinator**, which the dispatcher runs directly in the user's conversation on a
user-facing channel.

It does **not** work for a **delegated specialist**. The `delegate` skill runs every
specialist on `channelId: 'internal'` with a throwaway `conversationId: 'delegate-<uuid>'`
(`skills/delegate/handler.ts`). A resume into that context would publish an
`outbound.message` on `internal` that no channel adapter delivers and no user SSE stream
is watching, and it would bypass the coordinator's `delegate`-await that normally relays a
specialist's output (that await already returned when the specialist first asked for the
secret).

PR #984 added a **forward guard**: the resume subscriber skips (with a `warn` log) when
`secret.captured` carries a non-user-facing `channelId` (`internal`/`bullpen`/`scheduler`).
This design is the proper fix.

### Not currently triggered (latent capability gap)

Today only the **coordinator** pins `secret-capture-request`. The **setup-wizard**
(a `role: specialist` agent, delegated via the normal `delegate` path — confirmed: no
special dispatch references in `src/`) pins `system-secret-capture-request`, but that skill
passes **no origin at all**, so wizard captures dead-end silently rather than resuming.

So no specialist resume happens today. This is a latent gap that becomes live the moment a
specialist is given a capture skill (a future "travel"/"accounts" specialist needing a user
credential), and it already affects the setup-wizard's system-secret captures.

## Approach

Resuming a delegated specialist cannot be a routing tweak — the specialist's reply has to
reach the user, and the coordinator is the only thing positioned to relay it. So on a
specialist-minted capture, re-entry is routed **through the coordinator**, which
**re-delegates** to the specialist via the `delegate` skill's existing `resume_token`
mechanism.

The setup-wizard is just another `specialist`, so a single unified mechanism covers both
the (future) user-secret specialist case and the (live) wizard system-secret case.

### 1. Thread the coordinator's relay context at mint time

A delegated specialist's `SkillContext` only knows `channelId: 'internal'` and
`delegate-<uuid>` — no path back to the user. The coordinator's routing must be threaded
down through delegation.

`skills/delegate/handler.ts` — when building the specialist's `agent.task`, add a new
metadata field alongside the existing `originator`:

```ts
delegationOrigin: {
  conversationId: ctx.conversationId,  // coordinator's user-facing conversation
  channelId:      ctx.channelId,       // coordinator's user-facing channel
  agentId:        ctx.agentId,         // the coordinator
  originalTask:   effectiveTask,       // the specialist's brief (for the resume_token)
}
```

This is the structural signal that "this task is running as a delegated specialist." Only
`delegate` sets it.

### 2. Build the resume_token + retarget the capture origin (both capture skills)

`secret-capture-request` and `system-secret-capture-request` read
`ctx.taskMetadata?.delegationOrigin`. When present (delegated specialist):

- Build a `resume_token` reusing `delegate`'s exact format:
  ```ts
  base64(JSON.stringify({
    v: 1,
    agent: ctx.agentId,            // the specialist
    original_task: delegationOrigin.originalTask,
    context: resumeIntent,         // NL "what I was doing / why I need the secret"
  }))
  ```
  (Apply the same `MAX_RESUME_TASK_LENGTH`/`MAX_RESUME_CONTEXT_LENGTH` caps the runtime uses
  in `runtime.ts`, factored into a shared helper so the format stays in one place.)
- Set the capture `origin` so re-entry targets the **coordinator** on a deliverable channel:
  - `conversationId/channelId/agentId` = `delegationOrigin` (the coordinator)
  - `originator` = forwarded `originator` (unchanged)
  - `resumeIntent` = the ask (unchanged; `system-secret-capture-request` derives it from the
    label, since it has no `resume_intent` input)
  - **new** `delegateAgent` = `ctx.agentId` (the specialist to re-delegate to)
  - **new** `resumeToken` = the token above

When `delegationOrigin` is absent (coordinator minting directly — today's only live path),
behavior is **unchanged**: origin = the coordinator's own ctx, no `delegateAgent`/`resumeToken`.

`system-secret-capture-request` currently passes no origin; this design adds the same origin
threading to it (it always runs as the setup-wizard specialist).

### 3. Persist + propagate the new fields

- **Migration:** add nullable `delegate_agent TEXT` and `resume_token TEXT` columns to
  `secret_capture_tokens`. (Verify migration prefix uniqueness before merge — see project
  CLAUDE.md migration-numbering hazard.)
- `CaptureOrigin` and `CapturedContext` (`secret-capture-service.ts`): add optional
  `delegateAgent` + `resumeToken`; round-trip them through `mint()`/`redeem()`.
- `SecretCapturedPayload` (`src/bus/events.ts`): add optional `delegateAgent` + `resumeToken`.
  The capture endpoint (`routes/secret-capture.ts`) forwards them from `CapturedContext`.

### 4. Re-enter the coordinator (resume subscriber)

`secret-capture-resume-subscriber.ts` `handle()`:

- When the payload carries `delegateAgent` + `resumeToken`, build the synthetic `agent.task`
  targeting the **coordinator** (origin routing already points at it, so the existing
  `NON_DELIVERABLE_CHANNELS` guard passes), with content along the lines of:

  > The secret `'<label>'` a specialist asked for was just captured and saved to the vault.
  > Specialist `<delegateAgent>` paused waiting for it. Re-delegate to `<delegateAgent>` to
  > continue, passing this resume_token **exactly** as given:
  >
  > `<resumeToken>`
  >
  > Then relay its reply to the user. (Original goal: `<resumeIntent>`.)

  The coordinator then calls `delegate(agent: <delegateAgent>, task: "…the secret is now
  available, continue…", resume_token: <token>)`. The existing `delegate` decode path
  validates the token (incl. its cross-agent guard, since `resume_token.agent ===
  delegateAgent`), constructs the brief, runs the specialist, and the coordinator relays the
  result on its user-facing conversation.

- When `delegateAgent`/`resumeToken` are absent, behavior is **unchanged** (coordinator
  self-resume / direct agent resume from #972).

- The PR #984 forward guard **stays** as a safety net for genuinely unroutable mints (an
  internal-channel mint with no `delegationOrigin`, which shouldn't occur but must not
  dead-end loudly into a non-deliverable channel). Update its comment: specialist-minted
  captures are now handled via coordinator re-delegation; the guard now only catches the
  no-delegation-context edge case.

Note the resume_token rides in the synthetic task **content** for the coordinator to copy
into the `delegate` call. This is the same pattern the live clarification path already uses
(the coordinator copies the resume_token out of the `[ACTIVE OUTBOUND CONTEXT]` block), so
the LLM-copies-an-opaque-token concern is no worse than the accepted status quo.

### 5. Setup-wizard / system-secret restart messaging (messaging-only)

System bootstrap credentials (channel creds, API keys in config) are read **once** at
startup by `applyVaultSecrets` — capturing one does not make it live until a process restart.
But skill-declared secrets resolved dynamically (`ctx.secret` / `resolveSecretRef`, #973) do
**not** need a restart. The resume subscriber must not try to classify which is which.

Following #972's "the LLM has the context" philosophy, the subscriber stays dumb. Instead,
add a line to `agents/setup-wizard.yaml`'s prompt: after a captured credential, tell the
user a restart is needed for it to take effect. The wizard reasons restart-vs-not from its
own context (it already distinguishes secrets from raw env vars). Bump the agent version.

**Out of scope:** auto-triggering a process restart from a redeem event (chosen explicitly —
larger, intersects onboarding internals, and a redeem causing a process exit is riskier).
That remains the onboarding restart/poll flow's job; this design at least ensures the wizard
*informs* the user instead of the capture dead-ending.

## Invariants preserved

- **No-value privacy invariant.** `resume_token` is `base64(JSON{v, agent, original_task,
  context})` — names and NL only. `delegateAgent` is an agent name. `resumeIntent` is NL.
  No secret value appears in any token column, event, task, or log on the re-delegation path.
  A test asserts this explicitly.
- **`originator` preserved.** Forwarded: mint origin → `secret.captured` → synthetic
  coordinator task metadata → coordinator's `delegate` call → specialist. Principal-identity
  / authorization gates resolve identically on the resumed work. A test asserts this.

## Components touched

| Area | File | Change |
|---|---|---|
| Delegate | `skills/delegate/handler.ts` | Forward `delegationOrigin` metadata |
| Capture skill (user) | `skills/secret-capture-request/handler.ts` | Build resume_token + retarget origin when delegated |
| Capture skill (system) | `skills/system-secret-capture-request/handler.ts` | Add origin threading + resume_token when delegated |
| Resume token format | new `src/agents/resume-token.ts` (or shared helper) | Extract the `{v,agent,original_task,context}` + caps logic used by runtime and the capture skills |
| Service | `src/secrets/secret-capture-service.ts` | `delegateAgent`/`resumeToken` on `CaptureOrigin`/`CapturedContext` + SQL |
| Migration | `src/db/migrations/NNN_*.sql` | Nullable `delegate_agent`, `resume_token` columns |
| Event | `src/bus/events.ts` | Optional `delegateAgent`/`resumeToken` on `SecretCapturedPayload` |
| Endpoint | `src/channels/http/routes/secret-capture.ts` | Forward new fields onto the event |
| Subscriber | `src/secrets/secret-capture-resume-subscriber.ts` | Coordinator re-delegate branch + guard comment |
| Wizard prompt | `agents/setup-wizard.yaml` | Restart-messaging line + version bump |

## Testing

- **Delegate** forwards `delegationOrigin` (and still forwards `originator`).
- **secret-capture-request**: builds resume_token + `delegateAgent` and retargets origin to
  the coordinator when `delegationOrigin` is present; unchanged when absent.
- **system-secret-capture-request**: same, and now passes origin at all.
- **Service**: `delegateAgent`/`resumeToken` round-trip through mint → redeem.
- **Resume subscriber**: a specialist-minted capture (delegateAgent + resumeToken present,
  origin = coordinator routing) → publishes a coordinator-targeted task containing the
  re-delegate instruction + resume_token, with routing registered; the no-delegation
  internal-channel mint still skips (updated #984-guard test).
- **Privacy**: no secret value in token columns, event, synthetic task, or logs.
- **Originator**: preserved through the re-delegation path.
- **Integration** (real Postgres): specialist-minted capture → redeem → coordinator
  re-delegation → specialist resumes with the brief → user-visible reply. Reuse the shape of
  `tests/integration/research-analyst-multi-turn.test.ts`.

## Acceptance criteria (from #995)

- [ ] A specialist-minted capture link, on redeem, resumes the specialist and its reply
      reaches the user (via coordinator re-delegation), not dropped.
- [ ] Re-delegation reuses `delegate`'s `resume_token` mechanism, not direct internal-channel
      re-entry.
- [ ] No-value privacy invariant holds across the re-delegation path.
- [ ] `originator` preserved so authorization gates resolve identically.
- [ ] PR #984 forward guard updated (retained as a no-delegation-context safety net).
- [ ] Tests cover the end-to-end resume plus the privacy + originator invariants.
- [ ] Setup-wizard / system-secret stance documented: resumed via the same path, with
      restart messaging (messaging-only), auto-restart explicitly out of scope.
```
