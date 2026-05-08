# Contact Confidence Scoring Pipeline — Design

**Issue**: #460
**Date**: 2026-05-07

## Problem

`contact_confidence` (0.0–1.0) is a first-class input to the trust score formula in
`src/dispatch/trust-scorer.ts`:

```
messageTrustScore = (channelWeight × 0.4) + (contactConfidence × 0.4) − (injectionRiskScore × 0.2)
```

The schema, type, and formula are all in place, but `contact_confidence` is never updated
after a contact is created — it stays at 0.0. This reduces trust scoring to a two-factor
formula. High-confidence, long-standing contacts are evaluated no differently than unknown
senders.

The outbound-gateway currently papers over this with a `setTrustLevel('high')` band-aid
after every outbound send. This is a blunt workaround: it elevates the channel weight
component but doesn't accumulate real confidence signal. It also conflates "Curia sent a
message to this contact" with "the CEO explicitly trusts this contact" — two different
things.

## Approach

**Formula-over-stored-stats.** Both the incremental and full-recompute paths call the same
pure function over columns stored on the `contacts` table. No event log table — the
existing `audit_log` already captures `contact.resolved` events if historical replay is
ever needed.

Convergence is guaranteed by construction: both paths read the same stored columns and call
the same formula.

## Data Model

### New migration (034)

```sql
ALTER TABLE contacts ADD COLUMN inbound_message_count INT NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN outbound_message_count INT NOT NULL DEFAULT 0;

ALTER TABLE contacts ADD CONSTRAINT contacts_inbound_message_count_check
  CHECK (inbound_message_count >= 0);
ALTER TABLE contacts ADD CONSTRAINT contacts_outbound_message_count_check
  CHECK (outbound_message_count >= 0);
```

### Scoring-owned columns on `contacts`

| Column | Type | Owner |
|---|---|---|
| `contact_confidence` | `NUMERIC(3,2)` | Scoring pipeline (existing, migration 020) |
| `trust_level` | `TEXT` | `setTrustLevel()` — scoring pipeline reads it (existing, migration 020) |
| `last_seen_at` | `TIMESTAMPTZ` | Scoring pipeline (existing, migration 020) |
| `inbound_message_count` | `INT` | Scoring pipeline (new) |
| `outbound_message_count` | `INT` | Scoring pipeline (new) |

The existing `updateContact()` in `PostgresContactBackend` already skips scoring-owned
columns. A new `updateScoringFields()` method writes only these columns using atomic
increments (`SET inbound_message_count = inbound_message_count + $1`).

### Type change

Add `inboundMessageCount: number` and `outboundMessageCount: number` to the `Contact`
interface. Update `rowToContact()` mappers in both backends.

## Scoring Formula

A pure function `computeConfidence()` in `src/contacts/confidence-scorer.ts`. No I/O.

### Inputs

| Input | Source |
|---|---|
| `inboundMessageCount` | `contacts.inbound_message_count` |
| `outboundMessageCount` | `contacts.outbound_message_count` |
| `lastSeenAt` | `contacts.last_seen_at` (recency) |
| `trustLevel` | `contacts.trust_level` (CEO grant signal) |
| `verifiedIdentityCount` | Count of verified rows in `contact_channel_identities` |
| `hasCeoStatedIdentity` | Any identity with `source = 'ceo_stated'` |

Note: `contacts.created_at` was considered for relationship-age scoring but is not used.
The recency signal (`lastSeenAt`) handles the time dimension, and the interaction score
uses count-based saturation. A 2-year-old contact who went silent 6 months ago should score
lower than a 2-week-old contact who messaged yesterday — recency decay handles this
correctly without needing relationship age.

### Formula

```
totalMessages = inboundCount + outboundCount

interactionScore = min(totalMessages / SATURATION, 1.0) × W_INTERACTION
  SATURATION = 20
  W_INTERACTION = 0.35

recencyScore = lastSeenAt ? exp(-daysSinceLastSeen / HALF_LIFE) × W_RECENCY : 0
  HALF_LIFE = 90 days
  W_RECENCY = 0.20

verificationScore =
    (trustLevel != null ? GRANT_BOOST : 0) +
    (hasCeoStatedIdentity ? MANUAL_BOOST : 0) +
    min(verifiedIdentityCount, 3) / 3 × PAIRING_BOOST
  GRANT_BOOST = 0.25
  MANUAL_BOOST = 0.10
  PAIRING_BOOST = 0.10

confidence = clamp(interactionScore + recencyScore + verificationScore, 0.0, 1.0)
```

### Weight rationale

- **Interaction (0.35 max)**: Largest single signal. Saturation at 20 prevents a single
  spam burst from gaming the score.
- **Recency (0.20 max)**: Decays with a 90-day half-life. A contact who emails weekly stays
  near 0.20; someone silent for 6 months drops to ~0.03.
- **CEO grant (0.25)**: Strongest single-event boost. An explicit CEO decision should
  dominate passive signals.
- **Manual entry (0.10)**: A CEO-created contact deserves a base bump, but less than an
  explicit trust grant.
- **Pairing (0.10 max)**: Verified identity pairings are passive trust signals. Caps at 3
  verified identities to prevent gaming.

All constants are exported from the scorer module — tunable without a config file change.

### Score examples

| Contact profile | Confidence | messageTrustScore (email) |
|---|---|---|
| First inbound message, no verification | ~0.22 | 0.3×0.4 + 0.22×0.4 = **0.21** |
| CEO replied once (1 in + 1 out), recent | ~0.24 | 0.3×0.4 + 0.24×0.4 = **0.22** |
| 5 messages over 2 weeks, no verification | ~0.29 | 0.3×0.4 + 0.29×0.4 = **0.24** |
| CEO-created, 10 messages, verified identity | ~0.51 | 0.3×0.4 + 0.51×0.4 = **0.32** |
| 20+ messages, active, CEO trust grant (high) | ~0.80 | 1.0×0.4 + 0.80×0.4 = **0.72** |
| 20+ msgs, active, CEO grant + created + verified | ~0.93 | 1.0×0.4 + 0.93×0.4 = **0.77** |
| 20+ messages, 6 months silent, CEO grant (high) | ~0.63 | 1.0×0.4 + 0.63×0.4 = **0.65** |

Note: rows with "CEO trust grant (high)" use `trustLevel = 'high'`, which overrides the
email channel weight from 0.3 → 1.0 in the trust-scorer formula. This is intentional — the
CEO's per-contact trust override affects both the channel weight AND provides a confidence
boost. These are two different effects of the same CEO decision.

## Signal Types

```typescript
type ConfidenceSignal =
  | { type: 'message_seen'; count?: number }       // inbound message; default count 1
  | { type: 'message_sent'; count?: number }       // outbound message; default count 1
  | { type: 'trust_grant' }                        // CEO called setTrustLevel()
  | { type: 'pairing_confirmed' }                  // verified identity linked
```

The optional `count` supports bulk imports (e.g., CRM import with 47 historical messages):
```typescript
pipeline.incrementalUpdate(contactId, { type: 'message_seen', count: 47 })
```

## New Modules

| File | Purpose |
|---|---|
| `src/contacts/confidence-scorer.ts` | Pure formula: `computeConfidence(inputs) → number`. No I/O, fully unit-testable. |
| `src/contacts/confidence-pipeline.ts` | Orchestrator: `incrementalUpdate(contactId, signal)` and `fullRecompute(contactId)`. Reads contact + identities, calls scorer, persists. |

### `incrementalUpdate(contactId, signal)`

1. Updates the relevant stored stat (increment count, set `last_seen_at`)
2. Reads contact + identities
3. Calls `computeConfidence()`
4. Persists new `contact_confidence` (and updated counts / `last_seen_at`)

Signal-specific behavior:

| Signal | Stats updated |
|---|---|
| `message_seen` | `inbound_message_count += count`, `last_seen_at = now()` |
| `message_sent` | `outbound_message_count += count` (does NOT update `last_seen_at` — "last seen" means last inbound) |
| `trust_grant` | None — `trust_level` is already updated by `setTrustLevel()` before this fires |
| `pairing_confirmed` | None — identity is already created by `linkIdentity()` before this fires |

All signals end with a recompute of `contact_confidence` from stored state.

### `fullRecompute(contactId)`

1. Reads contact + identities
2. Calls `computeConfidence()`
3. Persists new `contact_confidence` only (does not touch counts or `last_seen_at`)

Idempotent — running it twice produces the same result. Convergent with incremental updates
by construction (same inputs, same function).

### `fullRecomputeAll()`

Iterates all contacts, calls `fullRecompute()` on each. Returns count of contacts updated.
Intended for one-off scripts (backfill, formula tuning), not the hot path.

## Integration Points

### 1. Dispatcher (`src/dispatch/dispatcher.ts`)

After resolving a known sender (`senderContext.resolved === true`), fire-and-forget:
```typescript
pipeline.incrementalUpdate(senderContext.contactId, { type: 'message_seen' })
```
Non-blocking — the trust score for this message uses the previously stored
`contactConfidence`. The update benefits the next inbound message.

### 2. Outbound gateway (`src/skills/outbound-gateway.ts`)

**Remove** both `setTrustLevel('high')` band-aid calls (lines ~890 and ~929). Replace with:
```typescript
pipeline.incrementalUpdate(contactId, { type: 'message_sent' })
```
For new contacts: fires after `createContact()` + `linkIdentity()`.
For promoted provisional contacts: fires after `setStatus('confirmed')`.

### 3. `contact-set-trust` skill (`skills/contact-set-trust/handler.ts`)

After `setTrustLevel()` succeeds:
```typescript
pipeline.incrementalUpdate(contactId, { type: 'trust_grant' })
```

### 4. `ContactService.linkIdentity()` (`src/contacts/contact-service.ts`)

When a verified identity is linked (`verified === true`):
```typescript
pipeline.incrementalUpdate(contactId, { type: 'pairing_confirmed' })
```

### 5. Future: `contact-register` skill (#485)

The pipeline exposes `incrementalUpdate()` as the public API. The `contact-register` skill
calls it with `{ type: 'message_seen' }` per sender during ceo-inbox triage. Supports
`count` for bulk imports (CRM, historical data).

### 6. Dependency injection

`ConfidencePipeline` is constructed with `ContactService` (or the backend directly) and
wired in `src/index.ts`. Passed to the dispatcher, outbound-gateway, and skill context via
the existing dependency patterns.

## Edge Cases

- **CEO contact**: `ContactResolver` hardcodes `contactConfidence: 1.0` for CLI/smoke-test/web
  channels. The pipeline skips scoring for CEO contacts (role = 'ceo').
- **Blocked contacts**: Scoring still runs. A blocked contact that gets unblocked retains its
  history. The dispatcher drops blocked sender messages before scoring matters.
- **Contact merge**: The primary contact gets `max(primaryCount, secondaryCount)` for message
  counts (not sum — avoids double-counting when both contacts represent the same person).
  Then `fullRecompute()` on the surviving contact.
- **Negative count guard**: `incrementalUpdate` enforces `count >= 1`. The DB constraint
  prevents negative counts.
- **Concurrent updates**: Use atomic increments (`SET inbound_message_count = inbound_message_count + $1`)
  rather than read-modify-write to avoid races from simultaneous inbound messages.
- **Existing band-aid contacts**: Contacts that already have `trustLevel = 'high'` from the
  outbound-gateway band-aid retain it. This is harmless (they score higher via the CEO grant
  signal) and the CEO can clear it via `contact-set-trust` if desired.

## Backfill on Deploy

The first deployment runs `fullRecomputeAll()` as a post-migration step. Existing contacts
with `inboundMessageCount = 0` will get scores based purely on their verification signals
(`trustLevel`, verified identities, `ceo_stated` source). Contacts with the band-aid
`trustLevel = 'high'` will score ~0.25 from the CEO grant signal alone.

## Testing Strategy

### Unit: `tests/unit/contacts/confidence-scorer.test.ts`

- Zero signals → score = 0
- First inbound message → `confidence > 0` (acceptance criterion)
- CEO-verified contact scores meaningfully higher than auto-resolved with same message
  volume (acceptance criterion)
- Recency decay: `lastSeenAt` at 0 / 90 / 365 days ago
- Saturation: 20 and 200 messages produce the same interaction score
- Clamping: extreme inputs stay within [0.0, 1.0]
- Each signal source tested in isolation
- `count` parameter: `{ type: 'message_seen', count: 20 }` matches 20 individual increments

### Unit: `tests/unit/contacts/confidence-pipeline.test.ts`

- `incrementalUpdate` with each signal type updates the correct stored fields
- `incrementalUpdate` with `count: 5` increments by 5
- `message_seen` updates `lastSeenAt`; `message_sent` does not
- `fullRecompute` produces same score as incremental path for identical history (convergence)
- `fullRecompute` is idempotent (running twice → same result)

### Integration: extend `tests/integration/contacts.test.ts`

- End-to-end: create contact → send signals → verify `contact_confidence` flows through
  `computeTrustScore()` → produces correct `messageTrustScore`

### Existing test updates

- Dispatcher tests checking `messageTrustScore` may need updated expectations
- Outbound-gateway tests asserting `setTrustLevel('high')` → assert `incrementalUpdate` instead
