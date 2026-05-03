# ADR-018: Curia-initiated approval requests via unified action log

Date: 2026-05-03
Status: Accepted

## Context

ADR-017 established the CEO-authorized action pattern: the CEO explicitly
directs Curia to take an action, and the autonomy gate is bypassed via
`humanApproved: true`. That pattern covers the case where the CEO is already
in the loop at invocation time.

The inverse case is unaddressed: Curia autonomously decides to take an action,
the autonomy gate blocks it, and Curia has no systematic way to request CEO
permission. Today, a blocked skill returns an advisory `{ success: false }`
result and the coordinator either tells the user it couldn't act or silently
drops the intent. There is no notification to the CEO, no pending queue, no
approval path, and no record that feeds the autonomy scoring system.

This gap shows up concretely at the default autonomy score (75):

- **Calendar writes** (action_risk: `high`, requires 80): blocked with no
  fallback. If the coordinator wants to schedule a meeting, it simply can't.
- **Email/Signal sends below 70**: email has a passive draft fallback (CEO
  discovers it via end-of-day digest), but Signal sends just fail. Neither
  path generates an immediate CEO notification or records the decision as an
  autonomy signal.
- **Low-risk writes below 60**: contacts, memory, and other internal state
  writes are silently blocked. At restricted mode, every non-read action
  should be surfaced for CEO decision.

The planned `action_log` table (issue #148) records skill invocation outcomes
for Phase 3 automatic score adjustment, but its current schema only covers
post-execution states (`success`, `failure`, `rejected`). Approval decisions
— which are high-signal indicators of trust — are not captured.

Three approaches were considered:

**A. Automatic approval requests at the gate.**
Gate B fires → creates a pending record → notifies CEO. Originally scoped to
medium+ action_risk only, but that leaves low-risk skills silently blocked at
score < 60, which is exactly the inconsistency this pattern aims to prevent.
The threshold for "worth notifying" should match the threshold for "worth
blocking." A separate `action_requests` table stores the pending state.

**B. Coordinator invokes a `request-approval` skill after receiving a gate
failure.** Gate behavior unchanged; the coordinator decides case-by-case
whether to escalate.

Problem: relies on LLM consistency for a system-critical flow. A coordinator
that forgets to call the skill, or calls it inconsistently, creates the exact
inconsistency this pattern is meant to prevent.

**C. Unified `action_log` state machine.**
Extend `action_log` (issue #148) to record all autonomy-relevant events —
blocking, pending approval, CEO decisions, and re-execution — instead of
using a separate table. All approval lifecycle state lives in `action_log`
rows, giving Phase 3 scoring a single source of truth.

The chosen approach combines **A's gate-level trigger** (automatic, not
coordinator-dependent) with **C's unified data model** (no separate table,
everything in `action_log`), and extends A's scope to all non-`none`
action_risk levels — not just medium+.

## Decision

**A + C combined.** The `action_log` table (issue #148) becomes the single
source of truth for all autonomy-relevant events, including approval requests
and their outcomes (from C). Approval requests are triggered automatically at
the gate level for all blocked non-`none` action_risk skills (from A,
expanded to all tiers).

**Pattern components:**

1. **Unified `action_log` schema.** The `outcome` column expands from
   (`success`, `failure`, `rejected`) to include approval lifecycle states:

   - `pending_approval` — gate fired, CEO notified, awaiting decision
   - `approved` — CEO approved; a separate `action_log` row records the
     subsequent re-execution with outcome `success` or `failure`
   - `denied` — CEO explicitly declined
   - `expired` — no CEO response within the expiry window
   - `resolved_externally` — CEO handled it outside Curia (e.g., created the
     calendar event directly) and dismissed the pending request

   All existing outcomes (`success`, `failure`, `rejected`) remain unchanged.
   A `rejected` row is still written for gate blocks that are purely
   informational (e.g., a re-invocation attempt while an approval request for
   the same action is already pending).

2. **Schema additions to `action_log`.** Beyond the fields in issue #148:

   - `payload JSONB` — serialized skill input for re-execution on approval.
     Null for non-approval rows.
   - `notification_sent_at TIMESTAMPTZ` — when the CEO was notified. Null for
     non-approval rows.
   - `resolved_at TIMESTAMPTZ` — when the approval request reached a terminal
     state. Null for non-approval rows and for pending rows.
   - `resolved_by TEXT` — `'ceo'`, `'system'` (expiry), or null.
   - `expires_at TIMESTAMPTZ` — when the pending request auto-expires. Null
     for non-approval rows.
   - `parent_action_id BIGINT REFERENCES action_log(id)` — links the
     re-execution row back to the `approved` row that authorized it.
   - `short_ref TEXT` — human-friendly reference for the pending request
     (e.g. `"cal-1"`, `"email-3"`). Generated at insert time from a
     prefix (abbreviated skill name) and a per-session counter. Included
     in CEO notifications and used by the coordinator to match natural
     language ("the second one", "the Tuesday meeting") to a specific
     pending row. Null for non-approval rows.
   - `description TEXT` — human-readable summary of what the action would
     do (e.g. "Create calendar event: Lunch with Dana, Tue May 6 at
     12:00"). Generated by the gate from the skill name and input payload.
     Used in notifications, digests, and by the coordinator for
     description-based matching. Null for non-approval rows.

3. **Gate-level trigger.** When Gate B (execution layer) blocks a skill with
   action_risk != `none`, and no `pending_approval` row already exists for
   the same skill and input combination within the current task:

   a. Write an `action_log` row with `outcome = 'pending_approval'`, the
      serialized skill input in `payload`, a generated `short_ref`, and a
      human-readable `description`.
   b. Compute `expires_at` (default: 24 hours from now; configurable per
      action_risk tier if needed later).
   c. Notify the CEO via the most appropriate available channel (Signal
      preferred for immediacy; email as fallback). The notification includes
      the skill name, a human-readable description of what Curia wanted to
      do, and how to approve or dismiss. If the notification fails (channel
      unavailable, API error), set `notification_sent_at` to null and log a
      warning. The `pending_approval` row still exists — it will appear in
      the pending-actions digest (see step 7) and in `list-pending-actions`
      results, so the CEO can still discover and act on it. The coordinator's
      response should reflect whether notification succeeded ("approval
      requested — CEO notified") or failed ("approval requested — but
      notification could not be delivered; CEO will see it in the next
      digest").
   d. Return the existing advisory failure to the coordinator, augmented with
      a note that an approval request has been sent (or that notification
      failed — see 3c).

   Deduplication: if a `pending_approval` row already exists for the same
   skill name *and* input payload within the same `task_id`, no duplicate
   request is created. The gate returns a failure noting the existing
   pending request. Multiple pending requests for the same skill with
   *different* payloads are allowed — e.g., three `calendar-create-event`
   requests for three different meetings each get their own `short_ref`
   and the CEO can approve, deny, or dismiss them independently.

4. **CEO approval path.** The CEO approves via natural language in any channel
   ("yes, go ahead with that calendar event"). The coordinator invokes an
   `approve-action` skill (new, action_risk: `none`, sensitivity: `elevated`)
   that:

   a. Looks up the `pending_approval` row by `short_ref`. The coordinator
      maps the CEO's natural language to the correct `short_ref` using the
      `description` field and conversation context (e.g., "approve the
      second one" → the coordinator knows from the notification which
      `short_ref` that corresponds to). When only one pending request
      exists, the `short_ref` can be omitted and the skill resolves to
      the sole pending row. When multiple exist and the reference is
      ambiguous, the skill returns an error listing the pending requests
      so the coordinator can ask the CEO to clarify.
   b. Transitions it to `outcome = 'approved'`, sets `resolved_at` and
      `resolved_by = 'ceo'`.
   c. Re-executes the original skill with the stored `payload`, passing
      `humanApproved: true` to bypass the autonomy gates. See "Where
      `humanApproved` is enforced" below for details.
   d. Writes a new `action_log` row for the re-execution, with
      `parent_action_id` pointing to the approved row.
   e. Publishes a `human.decision` event (same shape as ADR-017) for the
      audit trail.

5. **CEO denial path.** The CEO says "no" or "don't do that". The coordinator
   invokes a `deny-action` skill (or the same `approve-action` skill with a
   deny flag) that transitions the row to `outcome = 'denied'`, sets
   `resolved_at` and `resolved_by = 'ceo'`.

6. **CEO dismiss path.** The CEO handled the action outside Curia (e.g.,
   created the calendar event directly in Google Calendar). The coordinator
   invokes a `dismiss-action` skill that transitions to
   `outcome = 'resolved_externally'`. This prevents orphaned pending requests
   without requiring the CEO to lie about approving or denying.

7. **Expiry and digest.** A background sweep (scheduler job or startup check)
   transitions `pending_approval` rows past their `expires_at` to
   `outcome = 'expired'`, sets `resolved_by = 'system'`.

   For `high` and `critical` action_risk tiers, an expiry notification is
   sent to the CEO ("Curia wanted to create a calendar event but the request
   expired without a response"). For lower tiers, expiry is silent — the
   volume at low scores would be noisy.

   Separately, a daily digest (scheduler job) surfaces any `pending_approval`
   rows that are still open, regardless of tier. This is the safety net for
   notification failures (step 3c): even if the original notification didn't
   reach the CEO, the digest will. The digest also reminds the CEO of
   requests they may have seen but not yet acted on.

8. **Autonomy scoring signals.** Phase 3 (issue #148) consumes approval
   outcomes as first-class signals:

   - `approved` → positive Competence signal (Curia correctly identified a
     useful action; CEO confirmed it) and positive Commitment signal
     (proactive follow-through)
   - `denied` → negative Compatibility signal (Curia's judgment about what to
     do was wrong for this context)
   - `expired` → weak negative signal (lower weight than `denied` — CEO
     inaction is ambiguous, not necessarily disapproval)
   - `resolved_externally` → neutral (CEO agreed the action was needed but
     handled it differently — no signal about Curia's judgment)

**Where `humanApproved` is enforced:**

When `approve-action` re-executes a blocked skill, the re-execution hits the
same gates that blocked it originally. `humanApproved` must bypass gates at
every layer, not just the outbound gateway:

- **Execution layer (Gates A and B).** `InvokeOptions` gains a
  `humanApproved?: boolean` field. When set, the autonomy score check in
  `invoke()` is skipped — the skill runs as if the score were sufficient.
  Only the `approve-action` skill (elevated, CEO-only) sets this flag. This
  is the primary bypass: it covers all skill types, including calendar
  writes, contact mutations, memory stores, and anything else that never
  touches the outbound gateway.

- **Outbound gateway (Gate C).** Already supports `humanApproved` on
  `send()` and `sendEmailDraft()` (ADR-017). When a re-executed skill calls
  the gateway, `humanApproved` is threaded through so Gate C is also
  bypassed. All other safety checks (blocked-contact, content filter) run
  normally.

Individual skill handlers do not need to implement `humanApproved` support.
The flag is handled entirely at the infrastructure level — execution layer
and outbound gateway. A new skill with any `action_risk` value automatically
inherits the approval request flow when blocked, and the re-execution bypass
when approved, with zero handler changes.

**Relationship to ADR-017:**

ADR-017 covers the CEO-initiated direction: CEO says "do X" → gate bypassed.
This ADR covers the Curia-initiated direction: Curia says "may I do X?" →
gate blocks → CEO approves → gate bypassed. Both flows converge on:

- `humanApproved: true` on the execution layer and outbound gateway
- `human.decision` audit events
- `action_log` rows that feed Phase 3 scoring

The two ADRs are complementary halves of the same trust model.

**Relationship to the email draft mechanism:**

For email specifically, the existing draft creation + `send-draft` (PR #423)
already implements a version of this pattern: the draft is the "pending"
state, and `send-draft` is the approval path. This ADR generalizes that
pattern to all gated actions.

`send-draft` itself does not need handler changes — its core mechanic
(look up draft, verify CEO origin, send via gateway with `humanApproved`)
is unchanged. What changes is the plumbing around it:

- When the email adapter falls back to draft creation because the autonomy
  gate blocked a direct send, it now also writes an `action_log` row with
  `outcome = 'pending_approval'` alongside the Nylas draft.
- When the CEO uses `send-draft` to approve that draft, the skill transitions
  the corresponding `action_log` row to `approved` — capturing the decision
  for Phase 3 scoring.
- If the CEO sends the draft from Gmail directly (bypassing Curia), the
  `action_log` row expires or is dismissed, same as any other pending action.

Email drafts remain the preferred fallback for email-specific blocks (they
preserve rich formatting, threading, and CC lists better than a serialized
`payload` field would). The `action_log` row written alongside ensures the
approval decision is captured for scoring regardless of the CEO's chosen
send mechanism.

## Consequences

**Easier:**

- Every future skill with action_risk != `none` automatically gets the
  approval request flow when blocked. No per-skill opt-in, no manifest
  changes, no handler modifications.
- Phase 3 scoring gets high-signal data (CEO approval decisions) without any
  additional instrumentation — it's already in `action_log`.
- Orphaned pending requests self-resolve via expiry. The `resolved_externally`
  status handles the "CEO did it outside Curia" case explicitly.
- Single table to query for "what has Curia tried to do, what was blocked,
  what did the CEO think about it." Traceability is complete.
- The pattern is consistent across all channels and all action types —
  calendar, email, Signal, and any future channel all follow the same flow.

**Harder / accepted trade-offs:**

- `action_log` is no longer a pure append-only log — rows transition through
  states (`pending_approval` → `approved`/`denied`/`expired`). This adds
  update operations to a table originally designed as insert-only. Mitigation:
  only approval-related rows are mutable; `success`/`failure`/`rejected` rows
  remain immutable after insert.
- Serializing skill input to `payload JSONB` means the re-execution must
  reconstruct the same execution context. If the world state has changed
  between the original attempt and the approval (e.g., the meeting time
  Curia wanted to book is now taken), the re-execution may fail. This is
  acceptable — the failure is logged as a normal `action_log` row with
  `outcome = 'failure'` and `parent_action_id` linking it to the approval.
- CEO notification volume scales with how much Curia attempts at low scores.
  At restricted mode (< 60), every non-read skill triggers a notification.
  Deduplication per task prevents bursts, but persistent low scores may
  generate steady notification volume. This is the correct behavior — the CEO
  set a low score because they want visibility.
- The `approve-action`, `deny-action`, and `dismiss-action` skills must be
  `sensitivity: 'elevated'` (CEO-only) to prevent non-CEO contacts from
  approving actions. Same security model as `set-autonomy`.
