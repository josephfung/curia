# Contact Merge & Deduplication Design

**Date:** 2026-04-05
**Status:** Approved

---

## Problem

The contacts system has no `contact.merge` skill, and no mechanism for detecting or resolving
duplicate contacts. Duplicates can accumulate through many vectors. here are four examples:

1. **Email extraction then CEO statement** — an inbound email creates a sparse contact;
   the CEO later introduces the same person by name, creating a second record.
2. **Name variation across emails** — `Jenna Torres` vs `J. Torres` in To/CC headers
   creates two `email_participant` contacts for the same person.
3. **CEO bulk-create over existing sparse contacts** — CEO asks Curia to record a set of
   contacts (e.g., board members, family) that partially overlap with existing records.
4. **CRM sync** — a CRM sync skill imports contacts that already exist in Curia, and the CRM
   itself may carry its own internal duplicates.

---

## Approach

**Approach 2 (chosen):** Skills + deterministic dedup service.

`contact.merge` and `contact.find-duplicates` skills, backed by a deterministic scoring service
(normalize for "first, last", "last first", initials, Jaro-Winkler + channel overlap). Dedup detection runs in two modes:

- **On-creation:** After every new contact write, a non-blocking side-effect scores the new
  contact against existing contacts and publishes a bus event for `certain` matches.
- **Scheduled batch:** A weekly cron triggers the Coordinator to run a full scan and work
  through probable duplicate pairs with the CEO.

The Coordinator handles all CEO-facing workflow (presenting proposals, confirming merges).
No new agent is needed.

---

## New Components

| Component | Type | Purpose |
|---|---|---|
| `skills/contact-merge/` | Skill | Execute a merge between two contacts; `dry_run` mode returns the golden record proposal without writing |
| `skills/contact-find-duplicates/` | Skill | Batch scan all contacts for probable duplicate pairs; returns ranked list |
| `src/contacts/dedup-service.ts` | Service | Deterministic scoring: Jaro-Winkler name similarity + exact channel identifier overlap + shared KG facts |
| `contact.duplicate_detected` | Bus event | Published when on-creation check finds a `certain` match |
| On-creation hook in `ContactService` | Hook | After every successful `createContact()`, calls `DedupService.checkForDuplicates()` non-blocking |
| Weekly cron entry | Config | Triggers the Coordinator to run a batch dedup scan |
| Coordinator system prompt additions | Config | Instructions for the dedup confirmation workflow and merge execution pattern |

---

## contact.merge Skill

**Manifest:** `skills/contact-merge/skill.json`
- `action_risk: "low"` (internal state write, min autonomy score 60)
- Requires `caller_context` (elevated skill — same pattern as `contact-grant-permission`)

**@TODO (autonomy):** As the agent's autonomy level advances, the Coordinator should skip
the CEO confirmation step for high-confidence merges. At "full" autonomy, the Coordinator
should execute merges from the batch scan without interrupting the CEO. The `dry_run` flag
is the natural gate point — see `2026-04-03-autonomy-engine-design.md`.

### Inputs

```typescript
{
  primary_contact_id: string;   // contact that survives
  secondary_contact_id: string; // contact absorbed and deleted
  dry_run?: boolean;            // default: false
}
```

### Golden Record Survivorship Rules

| Field | Rule |
|---|---|
| `display_name`, `role` | Most recent non-null wins — compare both contacts' `updated_at`; take the value from the more recently updated contact if non-null, else fall back to the other |
| `notes` | Concatenate both with `\n---\n` separator |
| `status` | Most restrictive wins: `blocked > provisional > confirmed` |
| Channel identities | Union of all rows — UNIQUE constraint already prevents same `(channel, channel_identifier)` on different contacts |
| Auth overrides | Union; primary's override wins on same `(contact_id, permission)` conflict |
| KG node | Merge nodes: scalar properties use most-recent-wins; relationship edges are unioned |

### Execution Flow

1. Load both contacts with identities, overrides, and KG node data.
2. Compute golden record.
3. If `dry_run: true` → return proposal, stop.
4. If `dry_run: false`:
   - Merge KG nodes via memory engine (keep primary's node, absorb secondary's facts)
   - Re-point secondary's channel identities to primary's `id`
   - Re-point secondary's auth overrides to primary's `id` (skip conflicts — primary wins)
   - Apply golden record field values to primary contact row
   - Delete secondary contact (CASCADE cleans up remaining `contact_channel_identities` and `contact_auth_overrides` rows)
   - Publish `contact.merged` bus event
   - Audit log the merge

### New Bus Event: contact.merged

```typescript
type ContactMergedEvent = {
  type: 'contact.merged';
  primaryContactId: string;
  secondaryContactId: string;
  mergedAt: string; // ISO timestamp
};
```

### How the Coordinator Uses This Skill

1. Receive a duplicate signal (from `contact.duplicate_detected` event or batch scan result).
2. Select primary using heuristic: most verified channel identities → has KG node → has role
   → older `created_at` (tiebreaker).
3. Call `contact.merge` with `dry_run: true` to get golden record proposal.
4. Present both contacts and the proposal to CEO: what's kept, what changes, what's dropped.
5. On CEO confirmation → call `contact.merge` with `dry_run: false`.

---

## Dedup Scoring Service

**File:** `src/contacts/dedup-service.ts`

### Scoring Signals

| Signal | Weight | Notes |
|---|---|---|
| Exact channel identifier overlap | 1.0 (auto-ceiling) | Same email or phone on two contacts → certain duplicate regardless of name |
| Jaro-Winkler name similarity | 0.6× | Applied to normalized `display_name` (lowercase, stripped punctuation) |
| Shared KG facts (same org, same title) | 0.2× | Booster only — never sufficient alone. Requires a KG query per contact; only applied when both contacts have a `kg_node_id` |

Final score is clamped to [0, 1].

### Thresholds

| Score | Confidence | Action |
|---|---|---|
| ≥ 0.9 | `certain` | Publish `contact.duplicate_detected`; include in batch review |
| 0.7–0.9 | `probable` | Include in batch review only |
| < 0.7 | — | Ignored |

### Blocking

Before scoring, contacts are grouped by the first 3 characters of normalized `display_name`.
Only contacts within the same block are compared — avoids O(n²) comparisons across large
contact lists.

---

## contact.find-duplicates Skill

**Manifest:** `skills/contact-find-duplicates/skill.json`
- `action_risk: "none"` (read-only scan)

### Inputs

```typescript
{
  min_confidence?: 'certain' | 'probable'; // default: 'probable'
}
```

### Output

```typescript
{
  pairs: Array<{
    contact_a: ContactSummary;
    contact_b: ContactSummary;
    score: number;
    confidence: 'certain' | 'probable';
    reason: string; // human-readable: "Same email address" | "Similar name (0.91)"
  }>;
}
```

---

## On-Creation Hook

After every successful `ContactService.createContact()`, call
`DedupService.checkForDuplicates(newContactId)` as a non-blocking side-effect.

**Key constraint:** A failure in the dedup check must never fail the contact create.
The hook is fire-and-forget — errors are logged and discarded.

If any `certain` matches are found, publish `contact.duplicate_detected`:

```typescript
type ContactDuplicateDetectedEvent = {
  type: 'contact.duplicate_detected';
  newContactId: string;
  probableMatchId: string;
  confidence: 'certain' | 'probable';
  reason: string;
};
```

The Coordinator picks this up during normal message routing and surfaces it to the CEO
at the next opportunity — not as an interrupt.

---

## Scheduled Batch

A weekly cron entry in the scheduler config triggers the Coordinator with a system message:

```
"Run your weekly contacts dedup scan."
```

The Coordinator calls `contact.find-duplicates`, then works through the returned pairs with
the CEO one at a time — presenting the golden record preview (via `contact.merge dry_run`)
for each pair and executing confirmed merges.

**@TODO (autonomy):** At higher autonomy levels, the Coordinator should auto-merge `certain`
pairs from the batch without CEO review, and present only `probable` pairs for confirmation.
See `2026-04-03-autonomy-engine-design.md`.

---

## Coordinator System Prompt Additions

Three new instruction blocks to add to `agents/coordinator.yaml`:

1. **On receiving `contact.duplicate_detected`:** Present both contacts side-by-side,
   recommend a primary using the heuristic (most verified identities → has KG node →
   has role → older `created_at`), show the golden record preview, ask CEO to confirm
   before merging.

2. **On running weekly dedup scan:** Call `contact.find-duplicates`, work through pairs
   sequentially (one at a time), skip any pair the CEO defers.

3. **On creating any new contact:** The dedup check runs automatically in the background —
   no manual check needed from the Coordinator.

---

## Testing

### Unit Tests

**`tests/unit/contacts/dedup-service.test.ts`**
- Exact channel overlap scores 1.0 regardless of name difference
- Jaro-Winkler similarity above/below thresholds produces correct confidence levels
- Blocking groups contacts correctly; contacts in different blocks are never compared
- Score < 0.7 returns no matches
- Dedup service failure does not propagate (non-blocking contract)

**`tests/unit/contacts/contact-merge.test.ts`**
- Golden record survivorship for each field type (scalar, concatenated, most-restrictive)
- `dry_run: true` returns proposal without any DB write
- Status most-restrictive logic: `blocked` beats `confirmed`
- Same ID for both primary and secondary is rejected
- Unknown contact IDs are rejected

### Integration Tests (`tests/integration/contacts.test.ts`)

- On-creation hook fires after `createContact()` and publishes `contact.duplicate_detected`
  for a `certain` match
- On-creation hook failure does not fail the `createContact()` call
- Full merge flow: `dry_run` returns correct proposal → confirm → secondary deleted →
  primary has union of identities and overrides → `contact.merged` event published
- KG node merge: facts consolidated correctly per survivorship rules
- `contact.find-duplicates` returns ranked pairs above threshold, respects `min_confidence`

### Skill Handler Tests

**`skills/contact-merge/handler.test.ts`**
- Rejects unknown contact IDs
- Rejects same ID for primary and secondary
- `dry_run` mode returns proposal and makes no writes

**`skills/contact-find-duplicates/handler.test.ts`**
- Returns empty list when no contacts exist
- Respects `min_confidence` filter

---

## Implementation Checklist

- [ ] `src/contacts/dedup-service.ts` — scoring, blocking, `checkForDuplicates()`, `findAllDuplicates()`
- [ ] On-creation hook in `ContactService.createContact()` (non-blocking)
- [ ] `contact.duplicate_detected` event type in `src/bus/events.ts`
- [ ] `contact.merged` event type in `src/bus/events.ts`
- [ ] KG node merge method in memory engine
- [ ] `skills/contact-merge/` — manifest + handler
- [ ] `skills/contact-find-duplicates/` — manifest + handler
- [ ] Weekly cron entry in scheduler config
- [ ] Coordinator system prompt additions (`agents/coordinator.yaml`)
- [ ] Unit tests: `dedup-service.test.ts`, `contact-merge.test.ts`
- [ ] Integration tests: on-creation hook, full merge flow, KG node merge
- [ ] Skill handler tests: contact-merge, contact-find-duplicates
