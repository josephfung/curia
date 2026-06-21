# Design: reliable multi-meeting debrief clear (#975)

Status: approved
Date: 2026-06-20
Issue: [#975](https://github.com/josephfung/curia/issues/975)

## Problem

When the CEO asks the coordinator to clear several debrief items by name, the
coordinator releases only the `outbound_context` entries that happen to be in
its per-turn `[ACTIVE OUTBOUND CONTEXT]` injection, then confirms **all named
meetings cleared** — even when entries for some of those meetings fell outside
the injected window and were never released. The result is a partial clear
reported as complete: stale debrief nudges keep surfacing while the CEO is told
everything is done.

Two compounding defects:

1. **Incomplete release** — "clear meeting X" releases the `entry_id`s the
   coordinator can see, not *all* active entries belonging to meeting X.
2. **Over-reported success** — the confirmation is keyed to the meeting *names
   the CEO listed*, not to the set of entries actually released.

### Root cause

`OutboundContextService.getActive()` returns the 10 most-recent active entries
globally (`ORDER BY created_at DESC LIMIT 10`), with no per-meeting filter. A
single meeting's debrief produces **multiple** `outbound_context` rows — the
prompt (Step 6) and the reminder (Step 7), both `agent_id = meeting-debrief` —
and they share only a `conversation_id`, which for Signal is the *same* CEO
conversation across every meeting. So `conversation_id` cannot group by meeting,
and the meeting title exists only as free text inside `expected_reply`
("...for [meeting title]"). There is no stable, queryable meeting key, and no
release path that targets "every entry for meeting X" independent of the
injection window. The coordinator then maps the entry_ids it *did* release onto
the names the CEO requested and reports blanket success.

## Approach

Give debrief entries a **structured, queryable meeting key**, add a
**conversation-agnostic bulk-clear** that releases every active entry for a
named meeting, and **ground the coordinator's confirmation** in what the clear
actually released.

### 1. Producer — stamp a stable meeting key (`agents/meeting-debrief.yaml`)

The Bullpen request format for both the prompt (Step 6) and the reminder
(Step 7) gains a structured `metadata` block in its `context_bridge`:

```json
"metadata": { "subject": "[meeting title]", "eventId": "<eventId>" }
```

`subject` is the human-facing meeting title the CEO will name when clearing;
`eventId` is carried for traceability/audit. This stamps a queryable key on
every debrief `outbound_context` row. Bump the agent `version`.

### 2. Store — conversation-agnostic bulk clear (`src/dispatch/outbound-context.ts`)

Add to `OutboundContextService`:

```ts
clearBySubjects(subjects: string[]): Promise<SubjectClearResult>
```

where

```ts
interface SubjectClearResult {
  totalReleased: number;
  perSubject: { subject: string; released: number }[];
  unmatched: string[]; // subjects that matched zero active entries
}
```

Per requested subject, one parameterized statement:

```sql
UPDATE outbound_context SET released = true
WHERE released = false
  AND expires_at > now()
  AND lower(metadata->>'subject') = lower($1)
RETURNING id
```

Matching is **exact, case-insensitive** on `metadata->>'subject'` only (no
free-text/`expected_reply` fallback — decided in brainstorming). Because the
statement scans the whole active table, entries outside the injection window are
released too — the core fix. A subject whose statement returns zero rows lands
in `unmatched`. Input is trimmed; empty/blank subjects are dropped before
querying. The method is **conversation-agnostic** — the subject is the scope,
not the conversation (debrief prompts and replies can span Signal and email).

Surface the method on the narrow capability:

- Add `clearBySubjects` to the `OutboundContextCapability` interface.
- `ScopedOutboundContext.clearBySubjects` delegates **straight to the service**,
  intentionally ignoring its `conversationId` scope (documented in code) — the
  per-conversation guard that `release()` applies does not apply here because the
  subject key is globally unique enough and debrief entries legitimately span
  conversations.

Rollout note: entries already in flight when this deploys have no
`metadata.subject`; they surface as `unmatched` (the coordinator says so rather
than over-reporting) and age out within the 48h TTL.

### 3. New skill — `skills/context-bridge-clear/`

`handler.ts` + `skill.json`:

- Input: `{ subjects: string[] }`. Also accept a single `subject: string` for
  convenience (normalized to a one-element array).
- Calls `ctx.outboundContext.clearBySubjects(...)`.
- Output: `{ released: number, cleared: { subject: string; count: number }[], unmatched: string[] }`.
- `action_risk: "low"`, `capabilities: ["outboundContext"]`, coordinator-only
  via `allowed_callers`. Pinned to the coordinator.
- Errors (no silent swallow): missing `outboundContext` capability → `{ success:
  false, error }`; empty/all-blank `subjects` → `{ success: false, error }`;
  store failure → logged and returned as `{ success: false, error }`.

The existing single-entry `context-bridge-release` skill is unchanged and still
used for the sweep-on-close path.

### 4. Coordinator prompt (`agents/coordinator.yaml`)

Add a rule to the "Active outbound context" section: when the CEO asks to
clear / dismiss / "clear out" one or more named debrief items, call
`context-bridge-clear` with the list of meeting names and **report strictly from
its result** — state the released count and the meetings cleared, and for any
name in `unmatched` tell the CEO it could not be found among active debrief
items rather than claiming it was cleared. Never report a blanket "all cleared"
keyed to the names the CEO listed. Pin the new skill; bump the agent `version`.

### 5. Tests

- `src/dispatch/outbound-context.test.ts` — `clearBySubjects`:
  - releases **all** matching active entries, including entries that would fall
    outside a `LIMIT 10` window (insert 12+ rows across meetings, clear by
    subject, assert every matching row released);
  - leaves non-matching, expired, and already-released rows untouched;
  - case-insensitive match;
  - correct `unmatched` for a subject with no active entries;
  - trims input and drops blank subjects.
- `skills/context-bridge-clear/handler.test.ts` — grounded result shape; single
  vs array input; missing-capability error; empty-input error.
- `tests/integration/*` (real Postgres) — headline scenario: N meetings, some
  entries outside the injected window, clear a subset, assert the exact released
  set and the `unmatched` reporting.

## Data flow

```
CEO: "clear out Sean Brownlee, Khanjan Desai, Walk and Ice cream"
  → coordinator inbound
  → coordinator calls context-bridge-clear(subjects: [3 names])
    → ScopedOutboundContext.clearBySubjects (delegates, conversation-agnostic)
      → OutboundContextService.clearBySubjects
        → per-subject UPDATE ... WHERE lower(metadata->>'subject') = lower($1) RETURNING id
      ← { totalReleased: 9, perSubject: [...], unmatched: [] }
  ← { released: 9, cleared: [{Sean Brownlee,4},{Khanjan Desai,2},{Walk and Ice cream,3}], unmatched: [] }
  → coordinator: "Cleared 9 entries across Sean Brownlee, Khanjan Desai, and Walk and Ice cream."
```

## Out of scope

- Debrief reminder cadence / dedup (#956).
- Transfer-ownership reply fix (#957, already merged).
- Completing/cancelling the underlying debrief **tasks** — this change is the
  `outbound_context` release path only, matching the issue scope.

## Acceptance criteria (from #975)

- [ ] Clearing one or more named debrief items releases **all** matching active
  `outbound_context` entries for those items, regardless of injection window.
- [ ] The coordinator's confirmation reflects what was actually released; it
  never reports a complete clear while matching entries remain `released = false`.
- [ ] If a requested item cannot be resolved/released, the coordinator surfaces
  that explicitly instead of claiming success.
- [ ] Test coverage for the "clear N named meetings where some entries fall
  outside the injected active-context window" scenario.
