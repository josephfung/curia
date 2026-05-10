# Principal Identity & Task Originator — Design

**Issue:** [#457](https://github.com/josephfung/curia/issues/457)
**Date:** 2026-05-10

## Problem

CEO identity is fragmented across the system. Three independent mechanisms
exist, each with its own source of truth:

1. **Config env vars** (`CEO_PRIMARY_EMAIL`, `CEO_SIGNAL_NUMBER`) — flat fields
   loaded at startup, consumed by bootstrap and passed to OutboundGateway.
2. **Database contact record** (`role = 'ceo'`) — created by bootstrap, used by
   dispatcher and contact resolver for `ceoInitiated` stamping.
3. **OutboundGateway config** (`ceoEmail`, `ceoSignalNumber`) — separate flat
   fields on its own config interface, used by `isCeoRecipient()`.

This creates two problems:

**Fragility.** The `role` column is a free-text `TEXT` field used for descriptive
relationships ("Spouse", "CEO, Communitech", "Friend / Executive / Live music
(heavy metal)"). Using `role === 'ceo'` as the deterministic CEO identity signal
is fragile — there's no validation, no uniqueness constraint, and the semantics
of the field are "who is this person" not "what system privilege do they have."

**Context loss.** The dispatcher stamps `ceoInitiated: true` as a bare boolean
on task metadata. This works for direct messages but doesn't survive task
delegation. When the CEO says "tomorrow at 10am email my mother happy birthday,"
the scheduled task fires without originator context — the autonomy gate may
block a message the CEO explicitly authorized.

## Solution

### 1. Separate system designation from descriptive role

Add a `system_role` column to the `contacts` table. This is a constrained enum
that drives authorization and identity — separate from the free-text `role`
field that describes who a person is.

```sql
ALTER TABLE contacts
  ADD COLUMN system_role TEXT
  CHECK (system_role IN ('principal', 'agent'));

CREATE UNIQUE INDEX idx_contacts_system_role_principal
  ON contacts (system_role)
  WHERE system_role = 'principal';

CREATE UNIQUE INDEX idx_contacts_system_role_agent
  ON contacts (system_role)
  WHERE system_role = 'agent';
```

**Values:**

| `system_role` | Meaning | Who |
|---|---|---|
| `'principal'` | The human Curia serves | The CEO's contact record |
| `'agent'` | A system/AI actor | Curia's own contact record |
| `NULL` | Everyone else | All other contacts |

The term "principal" is used instead of "ceo" because it's the correct
agent-principal relationship term (already used in codebase comments like
"agent-to-principal communication"), and it doesn't conflate a job title with
a system designation.

**Uniqueness is enforced at the database level.** Only one contact can be the
principal. Only one contact can be the agent. Application code doesn't need to
check — the DB rejects violations.

### 2. Replace `ceoInitiated` with `TaskOriginator`

Replace the bare `ceoInitiated: boolean` with a richer originator context that
the dispatcher stamps on every task:

```typescript
interface TaskOriginator {
  contactId: string;                          // who started this chain
  systemRole: 'principal' | 'agent' | null;   // system designation
  channel: string;                            // originating channel
  initiatedAt: string;                        // ISO timestamp
}
```

**Key behaviors:**

- The dispatcher stamps `TaskOriginator` on **every** task, not just CEO ones.
  Every task knows its originator.
- A helper `isPrincipalOriginated(metadata)` replaces all
  `ceoInitiated === true` checks. It checks
  `metadata.originator?.systemRole === 'principal'`.
- Security: same pattern as today — the dispatcher is the only code that stamps
  `originator`. Channel metadata is stripped of any `originator` field before
  merging (same as `ceoInitiated` stripping in `mergeTaskMetadata`).
- Self-initiated tasks: when Curia initiates a task itself (scheduler, proactive
  action), the originator is Curia's own contact record with
  `systemRole: 'agent'`.

**Relationship to `CallerContext`:**

| Concept | Type | Meaning | Example |
|---|---|---|---|
| `TaskOriginator` | task metadata | Who started the task chain | CEO sent original message |
| `CallerContext` | skill context | Who is executing this skill call right now | Coordinator calling a skill |

For direct messages these are the same person. For scheduled or delegated tasks
they diverge — the originator is the CEO but the caller is the scheduler.
CEO authorization checks switch to `isPrincipalOriginated(metadata)`.

### 3. Consolidate OutboundGateway to use the database

Remove `ceoEmail` and `ceoSignalNumber` from `OutboundGatewayConfig`. The
gateway resolves principal recipient status by querying the principal contact's
channel identities from the database.

`isCeoRecipient()` becomes `isPrincipalRecipient()`: "is this recipient address
one of the principal contact's verified channel identities?"

**Caching:** The principal's identities are loaded at startup and cached in
memory. Cache invalidation occurs on `contact.updated` bus events for the
principal contact. This avoids per-message DB queries.

### 4. Startup readiness checks

Rather than silently degrading when setup is incomplete, the system runs a list
of named readiness checks after bootstrap. If any fail, the system logs which
checks failed and refuses to accept inbound messages — it will only serve the
setup flow.

```typescript
interface ReadinessCheck {
  name: string;
  check: () => Promise<ReadinessResult>;
}

interface ReadinessResult {
  ready: boolean;
  reason?: string;   // human-readable explanation when not ready
}
```

For this work, one check is added:

- **`principal-contact`** — verifies a contact with
  `system_role = 'principal'` exists.

Future checks (from issues #392 and #486) slot in naturally — just add another
`ReadinessCheck` to the list.

## Layer-by-layer changes

### Dispatcher

- **Originator stamping:** Replace the `ceoMeta` block with `TaskOriginator`
  construction. Read `system_role` from the resolved contact.
- **`mergeTaskMetadata`:** Strip `originator` from channel metadata (same
  security pattern as `ceoInitiated` stripping today).
- **Self-initiated tasks:** When the dispatcher creates tasks without an inbound
  sender (scheduler, proactive action), stamp Curia's own contact as the
  originator with `systemRole: 'agent'`.

### Coordinator (Agent Runtime)

- **Sender context injection:** Include `system_role` when present in the
  injected sender info (e.g. "Current sender: Joseph Fung (principal)
  [verified]").
- **No structural changes** — the coordinator receives originator context via
  task metadata, same as today.

### Skills / Execution Layer

- **`elevated` sensitivity gate:** Switch from `caller.role !== 'ceo'` to
  `isPrincipalOriginated(ctx.taskMetadata)`.
- **CEO-authorized skills** (send-draft, approve-action, etc.): Switch from
  `ctx.taskMetadata?.ceoInitiated === true` to
  `isPrincipalOriginated(ctx.taskMetadata)`.
- **`CallerContext`:** Unchanged. Still carries `contactId`, `role`, `channel`.
  The `role` field remains useful for audit and logging but is no longer used
  for authorization decisions.

### OutboundGateway

- **Config cleanup:** Remove `ceoEmail` and `ceoSignalNumber` from
  `OutboundGatewayConfig`.
- **`isCeoRecipient()` becomes `isPrincipalRecipient()`:** Queries the principal
  contact's channel identities from a cached DB lookup instead of comparing
  against config fields.
- **Autonomy bypass:** Same logic — principal-bound messages skip the autonomy
  gate. Uses the new lookup method.

### Bootstrap

- **`ceo-bootstrap.ts`:** Updated to set `system_role = 'principal'` in
  addition to existing `role = 'ceo'` and `trust_level = 'ceo'`. Additive
  change — bootstrap continues to work as before.
- **Curia's contact:** If a bootstrap exists for Curia's own contact record,
  set `system_role = 'agent'`. If not, add one.
- **Interim:** The env vars (`CEO_PRIMARY_EMAIL`, `CEO_SIGNAL_NUMBER`) and their
  config fields remain, consumed only by bootstrap. They are removed when the
  setup wizard (issues #392, #486) replaces bootstrap-based CEO creation.

## Migration

### Database migration

```sql
-- Add system_role column with check constraint
ALTER TABLE contacts
  ADD COLUMN system_role TEXT
  CHECK (system_role IN ('principal', 'agent'));

-- Enforce uniqueness: only one principal, only one agent
CREATE UNIQUE INDEX idx_contacts_system_role_principal
  ON contacts (system_role)
  WHERE system_role = 'principal';

CREATE UNIQUE INDEX idx_contacts_system_role_agent
  ON contacts (system_role)
  WHERE system_role = 'agent';

-- Backfill from existing data
UPDATE contacts SET system_role = 'principal' WHERE role = 'ceo';
UPDATE contacts SET system_role = 'agent' WHERE role = 'agent';
```

Production has exactly one `role = 'ceo'` and one `role = 'agent'`, so this
backfill is safe.

### Config changes

**Stays (interim):**
- `CEO_PRIMARY_EMAIL` env var — consumed only by `ceo-bootstrap.ts`
- `CEO_SIGNAL_NUMBER` env var — consumed only by `ceo-bootstrap.ts`
- `ceoPrimaryEmail` and `ceoSignalNumber` in the Config interface — read only
  by bootstrap

**Removed:**
- `ceoEmail` from `OutboundGatewayConfig`
- `ceoSignalNumber` from `OutboundGatewayConfig`
- Any direct reads of CEO config fields outside of bootstrap

## Helper module

A small `src/contacts/principal.ts` module encapsulates all principal-related
queries and checks:

- **`isPrincipalOriginated(metadata)`** — checks
  `metadata?.originator?.systemRole === 'principal'`. Used by skills and
  execution layer for authorization.
- **`isAgentOriginated(metadata)`** — checks
  `metadata?.originator?.systemRole === 'agent'`. Used when the coordinator
  needs to know "did I start this myself?"
- **`loadPrincipalIdentities(pool)`** — queries the principal contact's channel
  identities from the DB. Used by OutboundGateway's cached lookup.
- **`getPrincipalContact(pool)`** — returns the contact with
  `system_role = 'principal'`, or `null`. Used by the readiness check and
  anywhere that needs the principal's contact record.

## Future: task-chain originator threading

This design enables but does not implement task-chain threading. When a
scheduled task or bullpen conversation spawns work, the creating code copies
`originator` from the parent task. This is a one-line copy per delegation site.

A separate issue tracks this work — particularly for scheduled jobs where
context loss causes autonomy gate failures on CEO-authorized actions.

## Testing strategy

- **Migration test:** Verify the unique index rejects a second
  `system_role = 'principal'` insert.
- **Dispatcher tests:** Verify `TaskOriginator` is stamped correctly for
  principal senders, regular senders, and self-initiated tasks. Verify
  `originator` is stripped from channel metadata (security).
- **Skill authorization tests:** Verify `isPrincipalOriginated` gates elevated
  skills correctly — principal-originated passes, agent-originated and
  null-originated are rejected.
- **OutboundGateway tests:** Verify `isPrincipalRecipient` resolves against
  channel identities from the DB, not config fields. Verify autonomy bypass
  still works for principal-bound messages.
- **Readiness check test:** Verify system enters setup-required mode when no
  principal contact exists.
- **Bootstrap test:** Verify bootstrap sets `system_role = 'principal'` and
  that existing tests continue to pass.
