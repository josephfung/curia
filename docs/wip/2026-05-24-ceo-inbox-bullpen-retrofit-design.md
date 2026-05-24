# CEO-Inbox Bullpen-Through-Coordinator Retrofit

**Issue:** #616
**Depends on:** #615 (context bridging v2 — closed)
**Date:** 2026-05-24

## Summary

Remove direct `signal-send` usage from the `ceo-inbox` specialist agent and
route all Signal alerts through the coordinator via the Bullpen. This aligns
ceo-inbox with the architectural principle from context bridging v2: the
coordinator is the sole voice for all human-facing communication.

## Current State

- `ceo-inbox.yaml` has `signal-send` in `pinned_skills`
- The URGENT classification instructs the agent to both open a bullpen thread
  mentioning the coordinator AND send a Signal message directly
- The CEO's Signal number is hardcoded in the system prompt
- No context bridge entry is created for urgent alerts, so if the CEO replies
  on Signal about an alert, the coordinator has no delegation context

## Design

### 1. Remove `signal-send` from pinned_skills

Delete `signal-send` from the `pinned_skills` list in `agents/ceo-inbox.yaml`.
The `bullpen` skill remains pinned (already present).

### 2. Remove the CEO's Signal number from the system prompt

The coordinator owns outbound channel details. ceo-inbox no longer needs to
know the Signal number.

### 3. Update URGENT classification (step 4e)

Replace the current URGENT instructions:

> Open a bullpen thread mentioning the coordinator. Include: sender name,
> subject, one-sentence summary, key deadline or ask.
> Send a Signal message to the CEO: brief alert with sender and subject.
> Do NOT archive. Do NOT draft a reply.

With:

> Post a Bullpen thread mentioning the coordinator with a structured send
> request. Include: urgency level, channel, composed message, and context
> bridge metadata. Do NOT archive. Do NOT draft a reply.

The structured message format:

```
@coordinator I'd like you to send a message to the CEO.

Urgency: immediate
Channel: Signal
Message: "<brief alert: sender name, subject, one-sentence summary with deadline/ask>"
Context bridge: agent_id=ceo-inbox, expected_reply="Decision or follow-up instruction", delegation_hint="Delegate replies to ceo-inbox", expires_in_hours=24
```

The `Urgency: immediate` field signals the coordinator to send without
batching or delay. This distinguishes urgent escalations from normal proactive
messages (like meeting debriefs) where the coordinator may apply timing
judgment.

### 4. Update step 4h URGENT actions

Replace the dual action (bullpen thread + direct Signal send) with the single
bullpen-through-coordinator action:

- **URGENT**: Open a bullpen thread mentioning the coordinator with a
  structured send request (Urgency: immediate, Channel: Signal, Message,
  Context bridge with delegation_hint=ceo-inbox). Do NOT archive.

### 5. Add delegation-reply handling to delegated mode

Add a note to the delegated mode section: if the coordinator delegates a CEO
reply that originated from an urgent email alert (e.g., "tell me more about
that merger email", "add a rule that merger emails are always URGENT"), handle
it as a standard delegated-mode request using the existing rule management or
inbox query capabilities.

This requires no new code — delegated mode already handles arbitrary requests
from the coordinator. The note makes explicit that alert replies flow back
through this path.

### 6. What stays the same

- ACTIONABLE classification (routes to specialists via bullpen, no outbound
  sending involved)
- NEEDS DRAFT classification (creates drafts for CEO review, no outbound)
- LEAVE FOR CEO / NOISE classifications
- All other pinned skills
- Delegated-mode behavior (config-store rules, inbox queries)
- Scheduled-mode triage protocol structure

## Testing

Integration test covering the full round-trip:

1. Urgent email arrives (simulated inbound)
2. ceo-inbox classifies as URGENT, opens bullpen thread with structured format
3. Coordinator receives via bullpen task
4. Coordinator calls `signal-send` with `context_bridge` params
5. Context bridge entry is created (agent_id=ceo-inbox, delegation_hint present)
6. CEO replies on Signal referencing the alert
7. Coordinator sees active outbound context entry, delegates to ceo-inbox
8. ceo-inbox handles the delegated request

## Scope

This is a prompt-only change to `agents/ceo-inbox.yaml` (remove one pinned
skill, update ~20 lines of system prompt). No TypeScript code changes required.
The integration test is new test code.
