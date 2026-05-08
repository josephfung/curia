# Non-Threaded Channel Context Bridging — Design Spec

**Issue:** [#431](https://github.com/josephfung/curia/issues/431)
**Date:** 2026-05-08

## Problem

Non-threaded channels (Signal, SMS, CLI) have no structural link between outbound
and inbound messages. When Curia sends a proactive notification on Signal and the
CEO replies, the coordinator's new conversation context has no knowledge of what the
CEO is responding to.

Real failure: the scheduler sent a Signal notification about held Google Docs comment
emails but wrote no context into Signal working memory. When the CEO replied, the
coordinator searched the wrong inbox because it had no record of what it had just told him.

## Solution: Three Layers

### Layer 1 — Channel threading declaration

`ChannelPolicyConfig` gains a `threaded: boolean` field:

```typescript
export interface ChannelPolicyConfig {
  trust: TrustLevel;
  unknownSender: UnknownSenderPolicy;
  threaded: boolean;
}
```

`channel-trust.yaml` declares per channel:

```yaml
channels:
  cli:
    trust: high
    unknown_sender: allow
    threaded: false
  web:
    trust: high
    unknown_sender: allow
    threaded: false
  signal:
    trust: high
    unknown_sender: hold_and_notify
    threaded: false
  http:
    trust: medium
    unknown_sender: ignore
    threaded: false
  email:
    trust: low
    unknown_sender: hold_and_notify
    threaded: true
```

The config loader defaults `threaded` to `false` when absent (backwards compat with
legacy flat-string configs).

### Layer 2 — Outbound context memo (dispatch layer writes)

**Trigger:** `handleAgentResponse` in `dispatcher.ts`, after publishing the
`outbound.message` event.

**Condition:** The target channel's policy has `threaded: false`.

**Action:** Write a system-role turn to working memory for the tuple
`(conversationId, 'coordinator')`:

```
[OUTBOUND CONTEXT — 2026-05-08T14:23:00-04:00]
source_conversation: signal:+14155552671
message_preview: You have 3 held Google Docs comment emails from notifications-noreply@google.com. Woul…
task_type: coordinator-response
key_ids: task:evt-abc123
expected_reply: User may reply with instructions about the held messages
```

Fields:
- **Timestamp:** ISO 8601, local timezone.
- **source_conversation:** The `conversationId` from the routing table.
- **message_preview:** First 200 chars of the outbound content, truncated with `…`.
- **task_type:** `coordinator-response` (could be refined later as agent metadata grows).
- **key_ids:** The `taskEventId` from the outbound message, prefixed with `task:`.
- **expected_reply:** Brief hint about what the user might say next. Derived from the
  outbound content — if the message asks a question or presents options, note that.
  For now, a generic "User may reply to this message" is acceptable; the LLM can
  infer intent from `message_preview`.

**Dependencies:** `DispatcherConfig` gains a `workingMemory?: WorkingMemory` field.

**Error handling:** Best-effort. Memo write failure is logged but does not block
outbound delivery. Same pattern as checkpoint scheduling.

### Layer 3 — Inbound context injection (dispatch layer reads)

**Trigger:** `handleInbound` in `dispatcher.ts`, before creating the `agent.task` event.

**Condition:** The inbound channel's policy has `threaded: false`.

**Action:**
1. Call `workingMemory.getHistory(conversationId, 'coordinator')`.
2. Filter system-role turns whose content starts with `[OUTBOUND CONTEXT — `.
3. Filter to those within the 24-hour TTL (parse the ISO timestamp from the prefix).
4. If memos are found, prepend a preamble to the task content:

```
[PRIOR OUTBOUND CONTEXT — this is what you last sent on this channel]
---
[OUTBOUND CONTEXT — 2026-05-08T14:23:00-04:00]
source_conversation: signal:+14155552671
message_preview: You have 3 held Google Docs comment emails…
task_type: coordinator-response
key_ids: task:evt-abc123
expected_reply: User may reply with instructions about the held messages
---

{original inbound content}
```

5. If no memos are found within the TTL, pass the content through unchanged — no
   metadata tag, no preamble.

**TTL:** 24 hours, configurable via `DispatcherConfig.contextMemoTtlMs`
(default `86_400_000`). This is a query-time filter, not a hard delete. Old memos
remain in working memory and are subject to the normal summarization lifecycle.

**Multiple memos:** If several memos exist within the TTL, all are included in the
preamble, most recent last. In practice this will rarely exceed 2-3.

**Error handling:** If the working memory query fails, log the error and proceed
without the preamble. Context injection is best-effort.

### Layer 4 — Coordinator prompt: cold-start clarification gate

The coordinator YAML (`agents/coordinator.yaml`) gains a new directive section,
placed after the existing audience-awareness block:

```
## Non-threaded channel context

When your input includes a [PRIOR OUTBOUND CONTEXT] section, the user is likely
replying to that prior message. Use the context memo (message_preview, key_ids,
expected_reply) to understand what they are referring to and act accordingly.

When your input does NOT include a [PRIOR OUTBOUND CONTEXT] section and you are
on a non-threaded channel (Signal, SMS), apply this two-part test:

1. Is the message **self-contained** — fully actionable on its own?
   Examples: "Move the weekly team meeting to 4:30", "What's on my calendar tomorrow?"
   → Proceed normally. No clarification needed.

2. Is the message **reply-shaped** — only makes sense as a response to something prior?
   Examples: "Yes", "The second one", "Sounds good", "Go ahead", "Which one should I pick?"
   → Ask the user what they are referring to before acting.
   Keep it brief: "I lost the thread — what are you replying to?"
```

This is a soft LLM directive — the coordinator uses judgment. "Yes, cancel it" is
reply-shaped (cancel what?). "Yes, cancel the 3pm meeting" is self-contained.

No changes to threaded channels. Email threading already carries context.

## What is NOT in scope

- Threaded channels (email) — no changes needed.
- Retroactive context reconstruction — if working memory has been checkpointed past
  the relevant outbound message, that is a separate memory decay problem.
- `expected_reply` intelligence — for now, a generic hint is acceptable. LLM-powered
  analysis of outbound content to generate smarter `expected_reply` values is a
  future enhancement.

## Files to modify

| File | Change |
|------|--------|
| `src/contacts/types.ts` | Add `threaded: boolean` to `ChannelPolicyConfig` |
| `config/channel-trust.yaml` | Add `threaded` field to each channel |
| `src/contacts/config-loader.ts` | Parse `threaded` from YAML, default `false` |
| `src/dispatch/dispatcher.ts` | Add `workingMemory` to config; outbound memo write in `handleAgentResponse`; inbound injection in `handleInbound` |
| `agents/coordinator.yaml` | Add non-threaded channel context directive |
| Tests (new) | Integration tests for the three acceptance scenarios |

## Acceptance criteria

- [ ] `ChannelPolicyConfig` has a `threaded: boolean` field; Signal (and any future
      non-threaded adapters) declare `threaded: false`; email declares `threaded: true`.
- [ ] Dispatch layer writes an outbound context memo to channel working memory for
      every message routed to a `threaded: false` channel.
- [ ] Context memos are structured (not freeform text) and include: timestamp, source
      conversation ID, message preview, task type, and key IDs.
- [ ] Dispatch layer reads the most recent outbound context memo(s) (within 24h TTL)
      and injects them when routing an inbound message from a non-threaded channel.
- [ ] If no recent memo exists, the inbound message passes through without a preamble.
- [ ] Coordinator prompt reflects the two-condition clarification gate (no preamble AND
      reply-shaped → ask; no preamble AND self-contained → proceed).
- [ ] Integration test: simulate scheduler-sends-Signal → user-replies flow; verify
      coordinator context contains the outbound memo.
- [ ] Integration test: cold-start self-contained message proceeds without clarification.
- [ ] Integration test: cold-start reply-shaped message triggers clarification.
