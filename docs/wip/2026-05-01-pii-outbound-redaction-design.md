# PII Outbound Channel Redaction Policy

**Issue:** #249
**Date:** 2026-05-01
**Status:** Design

## Summary

Configurable per-channel PII redaction for outbound messages. When the agent sends a reply via email or Signal, detected PII patterns are redacted based on channel policy — unless the recipient is the CEO, who bypasses all redaction.

This is distinct from issue #197's `scrubPii()` which blanket-strips PII from logs and LLM context. This feature controls what PII flows to *external recipients* through *channel replies*.

## Architecture Decision

**Approach: Separate pipeline step in OutboundGateway** (not a content filter rule, not a channel adapter hook).

Rationale:
- Redaction is a *transformation* (modify content and send), not a *gate* (block or allow). The existing content filter is a gate — changing its contract would mix responsibilities.
- Placing redaction before the content filter ensures the filter validates what the recipient will actually see.
- A single pipeline step means one audit point, one failure mode, one place to emit events.

## Outbound Pipeline (Updated)

```
1. Autonomy gate (score check)
2. Blocked contact check + capture recipientTrustLevel
3. PiiRedactor.redact(content, channelId, trustLevel)     ← NEW
4. Content filter (validates post-redaction content)
5. Channel dispatch (email or signal adapter)
```

## Pattern Detection

Detection is delegated entirely to `openredaction` (the library `scrubPii()` already uses). No regex is maintained in Curia config.

The existing `scrubPii()` function is refactored into two layers:

```
detectPii(text, extraPatterns?) → PiiMatch[]      // detection only (new, shared)
scrubPii(text, extraPatterns?) → string           // calls detectPii(), replaces all (same API)
```

`detectPii()` becomes the shared foundation used by both `scrubPii()` (blanket replacement for logs/LLM) and `PiiRedactor` (selective replacement for outbound channels).

### PiiMatch Interface

```typescript
interface PiiMatch {
  label: string;      // e.g. "CREDIT_CARD", "PHONE_US", "EMAIL"
  start: number;      // position in text
  end: number;
  matched: string;    // the actual value found
}
```

### UUID Shielding

The existing UUID shielding logic (prevents false positives on RFC 4122 UUIDs in application text) is preserved in `detectPii()` and benefits both consumers.

### Extra Patterns

`pii.extra_patterns` in config (which already exists for the scrubber) feeds into `detectPii()` for any patterns openredaction doesn't cover natively. Both the scrubber and the redactor benefit from additions there.

## PiiRedactor Class

New file: `src/dispatch/pii-redactor.ts`

### Interface

```typescript
interface RedactionResult {
  content: string;                  // modified content (or original if nothing redacted)
  redactions: RedactionEntry[];     // what was redacted (for logging/audit)
}

interface RedactionEntry {
  patternLabel: string;             // e.g. "CREDIT_CARD"
  channelId: string;                // e.g. "email"
  replacedWith: string;             // e.g. "[REDACTED: CREDIT_CARD]"
  // Original value is NOT stored — that would defeat the purpose
}
```

### Redaction Format

Detected PII is replaced with: `[REDACTED: <LABEL>]`

Examples:
- `4111 1111 1111 1111` → `[REDACTED: CREDIT_CARD]`
- `+1 555-867-5309` → `[REDACTED: PHONE_US]`
- `AB1234567` → `[REDACTED: PASSPORT]`

This format:
- Tells the reader something was redacted
- Identifies what type of data was removed (aids debugging and testing)
- Is inert to all existing content filter rules (no false positives — verified against `system-prompt-fragment`, `internal-structure`, `secret-pattern`, and `contact-data-leak`)

### Logic

```
redact(content, channelId, trustLevel):
  1. If enabled is false → return content unchanged (no-op)
  2. If meetsMinimumTrust(trustLevel, <lowest trust_override value>) → return content unchanged
  3. Call detectPii(content, extraPatterns) → matches
  4. For each match:
     - Normalize match.label to lowercase for comparison
     - Look up channel_policies[channelId].allow (if channel not listed, allow = [])
     - If match.label is in the allow list → skip
     - Otherwise → replace with [REDACTED: <match.label>]
  5. If any redactions performed:
     - Emit pino structured log
     - Publish 'outbound.pii-redacted' bus event
  6. Return { content: modifiedContent, redactions }
```

**Label casing:** Config uses lowercase labels (`email`, `credit_card`). Labels from openredaction are normalized to lowercase before comparison. The replacement string uses the original label casing from openredaction (e.g., `[REDACTED: CREDIT_CARD]`) for readability.

**Unlisted channels:** If a channel has no entry in `channel_policies`, its allow list is treated as empty — meaning all detected PII is blocked on that channel (consistent with `default: block`).

### Failure Behaviour

If `PiiRedactor` throws (openredaction crash, unexpected error):
- **Fail closed** — block the message, do not send unredacted content
- Publish `outbound.blocked` with reason `pii_redactor_error`
- CEO notified via existing blocked-message notification flow

Consistent with the content filter's failure mode.

## Configuration

### config/default.yaml

```yaml
pii:
  # Existing — extra patterns for the scrubber (openredaction extensions)
  extra_patterns: []

  # New — outbound redaction policy
  outbound_redaction:
    enabled: true
    trust_override: [ceo]           # trust levels that bypass all redaction
    default: block                   # unlisted pattern/channel combos are blocked
    channel_policies:
      email:
        allow: [email]              # email addresses are fine in email replies
      signal:
        allow: []                   # everything blocked for signal (except CEO)
```

### Design Notes

- **`enabled`** — kill switch. If false, PiiRedactor is a no-op pass-through.
- **`trust_override`** — trust levels that skip redaction entirely. Only `ceo` for now; supports adding `high` later without code changes.
- **`default: block`** — any detected pattern not in a channel's allow list gets redacted. Configure exceptions, not rules.
- **`channel_policies`** — per-channel allow lists. Unlisted channels inherit the default (block everything).
- No regex anywhere in this config — detection is delegated to openredaction.

### TypeScript Schema (src/config.ts)

```typescript
pii?: {
  extra_patterns?: Array<{ regex: string; replacement: string }>;

  outbound_redaction?: {
    enabled?: boolean;                // default: true
    trust_override?: TrustLevel[];    // default: ['ceo']
    default?: 'block' | 'allow';     // default: 'block'
    channel_policies?: Record<string, {
      allow?: string[];              // pattern labels allowed on this channel
    }>;
  };
};
```

Validated at startup in `src/startup/validator.ts`. Invalid trust levels, unknown structure, or malformed values = fail-closed startup error.

## Logging and Audit

### Pino Structured Log

Emitted only by the outbound `PiiRedactor` (not by the log/LLM scrubber):

```typescript
logger.info({
  event: 'pii_redacted',
  channelId: 'email',
  recipientTrustLevel: 'confirmed',
  redactions: [
    { patternLabel: 'CREDIT_CARD' },
    { patternLabel: 'PHONE_US' }
  ],
  redactionCount: 2,
  conversationId: '...'
});
```

No original values logged.

### Bus Event

New event type: `outbound.pii-redacted`

```typescript
{
  type: 'outbound.pii-redacted',
  channelId: 'email',
  recipientId: '...',
  conversationId: '...',
  redactions: [
    { patternLabel: 'CREDIT_CARD', replacedWith: '[REDACTED: CREDIT_CARD]' },
    { patternLabel: 'PHONE_US', replacedWith: '[REDACTED: PHONE_US]' }
  ],
  timestamp: '...'
}
```

Published for future audit UI or alerting rules. Nothing subscribes to it initially.

Registered in `src/bus/events.ts` (discriminated union) and authorized for the dispatch layer in `src/bus/permissions.ts`.

### When Events Are NOT Emitted

- CEO recipient (trust override) — silent pass-through
- No PII detected — silent pass-through
- `enabled: false` — silent pass-through
- Log/LLM scrubbing via `scrubPii()` — never emits redaction events (different concern)

## Trust Level Ordinal Comparison

The existing `TrustLevel` type (`'high' | 'medium' | 'low'`) is extended with a `'ceo'` level and ordinal comparison support. This avoids brittle `=== 'high'` checks that break when new levels are added.

### Changes to `src/contacts/types.ts`

```typescript
export type TrustLevel = 'ceo' | 'high' | 'medium' | 'low';

const TRUST_RANK: Record<TrustLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  ceo: 3,
};

export function meetsMinimumTrust(
  actual: TrustLevel | null,
  required: TrustLevel,
): boolean {
  if (actual === null) return false;
  return TRUST_RANK[actual] >= TRUST_RANK[required];
}
```

### Migration

One migration to update the CEO contact from `trustLevel: 'high'` to `trustLevel: 'ceo'`.

### Existing Code Updates

Replace existing `trustLevel === 'high'` checks with `meetsMinimumTrust(trustLevel, 'high')` — semantically identical but now correctly includes `ceo` and any future levels above `high`.

This also removes the special CEO email comparison from the content filter's `checkContactDataLeak` rule — the CEO's `ceo` trust level already implies trust, so the email comparison is redundant.

## Files Changed

| File | Change |
|------|--------|
| `src/contacts/types.ts` | Add `'ceo'` to `TrustLevel`, add `meetsMinimumTrust()` helper |
| `src/pii/scrubber.ts` | Extract `detectPii()`, make `scrubPii()` a thin wrapper |
| `src/dispatch/pii-redactor.ts` | New `PiiRedactor` class |
| `src/dispatch/outbound-filter.ts` | Replace `=== 'high'` + CEO email check with `meetsMinimumTrust()` |
| `src/skills/outbound-gateway.ts` | Add redaction as step 3 in pipeline |
| `src/bus/events.ts` | Add `outbound.pii-redacted` event type |
| `src/bus/permissions.ts` | Authorize dispatch layer for new event |
| `src/config.ts` | Extend `pii` interface with `outbound_redaction` |
| `src/startup/validator.ts` | Validate new config block at startup |
| `schemas/default-config.schema.json` | Add `outbound_redaction` to JSON schema |
| `config/default.yaml` | Add `outbound_redaction` section |
| `src/db/migrations/NNN_ceo_trust_level.sql` | Update CEO contact trust level to `'ceo'` |

## Testing

### Unit Tests (src/pii/)

- `detectPii()` returns correct matches with labels/positions for each openredaction pattern type
- `detectPii()` UUID shielding prevents false positives (regression)
- `scrubPii()` works identically after refactor (regression)

### Unit Tests (src/dispatch/pii-redactor.ts)

- Redacts blocked patterns, output contains `[REDACTED: <LABEL>]`
- Allows patterns in channel's allow list (email addresses in email channel)
- CEO trust level bypasses all redaction — content unchanged
- Default-block applies to unlisted channels
- Multiple matches in one message — all redacted correctly
- No redactions needed — original content returned, no events emitted
- Throws on malformed config at construction (fail-closed startup)

### Integration Tests (src/skills/outbound-gateway)

- Redacted content passes content filter without false positives
- Full pipeline: non-CEO gets redacted content, CEO gets original
- PiiRedactor crash → message blocked, `outbound.blocked` event published
- `enabled: false` → no redaction, message passes through
- Bus event `outbound.pii-redacted` published with correct payload

## Out of Scope

- "Hold for review" mode (message blocked pending CEO approval) — future enhancement
- Per-recipient policies beyond trust level (e.g., per-contact allow lists) — future
- Redaction in skill-to-API calls (these bypass the gateway entirely) — by design
- Changes to the log/LLM scrubber's behaviour — unchanged, separate concern
