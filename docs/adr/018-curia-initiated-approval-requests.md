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

**A. Automatic approval requests at the gate for medium+ action_risk only.**
Gate B fires for medium/high/critical skills → creates a pending record →
notifies CEO. Low-risk blocked actions remain silent.

Problem: at score < 60, low-risk skills are also blocked, and the CEO has
explicitly set a restrictive posture — silent failures there are exactly the
kind of thing that slides through the cracks. The threshold for "worth
notifying" should match the threshold for "worth blocking."

**B. Coordinator invokes a `request-approval` skill after receiving a gate
failure.** Gate behavior unchanged; the coordinator decides case-by-case
whether to escalate.

Problem: relies on LLM consistency for a system-critical flow. A coordinator
that forgets to call the skill, or calls it inconsistently, creates the exact
inconsistency this pattern is meant to prevent.

**C. Extend `action_log` to be the unified state machine for all
autonomy-relevant events — blocking, pending approval, CEO decisions, and
re-execution — and trigger approval requests automatically at the gate for
all non-`none` action_risk levels.**

## Decision

**Option C.** The `action_log` table (issue #148) becomes the single source of
truth for all autonomy-relevant events, including approval requests and their
outcomes. Approval requests are triggered automatically at the gate level for
all blocked non-`none` action_risk skills.

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

3. **Gate-level trigger.** When Gate B (execution layer) blocks a skill with
   action_risk != `none`, and no `pending_approval` row already exists for
   the same skill within the current task:

   a. Write an `action_log` row with `outcome = 'pending_approval'` and the
      serialized skill input in `payload`.
   b. Compute `expires_at` (default: 24 hours from now; configurable per
      action_risk tier if needed later).
   c. Notify the CEO via the most appropriate available channel (Signal
      preferred for immediacy; email as fallback). The notification includes
      the skill name, a human-readable description of what Curia wanted to
      do, and how to approve or dismiss.
   d. Return the existing advisory failure to the coordinator, augmented with
      a note that an approval request has been sent.

   Deduplication: if a `pending_approval` row already exists for the same
   skill name within the same `task_id`, no duplicate request is created. The
   gate returns a failure noting the existing pending request.

4. **CEO approval path.** The CEO approves via natural language in any channel
   ("yes, go ahead with that calendar event"). The coordinator invokes an
   `approve-action` skill (new, action_risk: `none`, sensitivity: `elevated`)
   that:

   a. Looks up the `pending_approval` row by ID or by most-recent for the
      skill name.
   b. Transitions it to `outcome = 'approved'`, sets `resolved_at` and
      `resolved_by = 'ceo'`.
   c. Re-executes the original skill with the stored `payload`, passing
      `humanApproved: true` to the outbound gateway (reusing ADR-017's
      mechanism) where applicable.
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

7. **Expiry.** A background sweep (scheduler job or startup check) transitions
   `pending_approval` rows past their `expires_at` to `outcome = 'expired'`,
   sets `resolved_by = 'system'`. No notification on expiry — the absence of
   CEO response is the signal.

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

**Relationship to ADR-017:**

ADR-017 covers the CEO-initiated direction: CEO says "do X" → gate bypassed.
This ADR covers the Curia-initiated direction: Curia says "may I do X?" →
gate blocks → CEO approves → gate bypassed. Both flows converge on:

- `humanApproved: true` on the outbound gateway (when applicable)
- `human.decision` audit events
- `action_log` rows that feed Phase 3 scoring

The two ADRs are complementary halves of the same trust model.

**Relationship to the email draft mechanism:**

For email specifically, the existing draft creation + `send-draft` (PR #423)
already implements a version of this pattern: the draft is the "pending"
state, and `send-draft` is the approval path. This ADR generalizes it to all
gated actions. Email drafts remain the preferred fallback for email-specific
blocks (they preserve rich formatting, threading, and CC lists better than a
serialized `payload` field would). The `action_log` row is written alongside
the draft creation so that the approval decision is captured for scoring
regardless of whether the CEO uses `send-draft` or sends from Gmail directly.

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
