# PII Outbound Channel Redaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable per-channel PII redaction to the outbound gateway, with CEO trust-level bypass and audit events.

**Architecture:** A new `PiiRedactor` pipeline step in `OutboundGateway` uses `openredaction` (via a shared `detectPii()` function extracted from `scrubPii()`) to find PII, then selectively redacts based on channel policy and recipient trust level. A new `'ceo'` trust level with ordinal comparison replaces scattered `=== 'high'` checks.

**Tech Stack:** TypeScript/ESM, Vitest, openredaction, pino, node-pg-migrate

---

### Task 1: Add `'ceo'` trust level and `meetsMinimumTrust()` helper

**Files:**
- Modify: `src/contacts/types.ts:132`
- Test: `src/contacts/types.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `src/contacts/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { meetsMinimumTrust } from './types.js';

describe('meetsMinimumTrust', () => {
  it('returns false for null trust level', () => {
    expect(meetsMinimumTrust(null, 'low')).toBe(false);
  });

  it('ceo meets all trust levels', () => {
    expect(meetsMinimumTrust('ceo', 'ceo')).toBe(true);
    expect(meetsMinimumTrust('ceo', 'high')).toBe(true);
    expect(meetsMinimumTrust('ceo', 'medium')).toBe(true);
    expect(meetsMinimumTrust('ceo', 'low')).toBe(true);
  });

  it('high meets high and below but not ceo', () => {
    expect(meetsMinimumTrust('high', 'ceo')).toBe(false);
    expect(meetsMinimumTrust('high', 'high')).toBe(true);
    expect(meetsMinimumTrust('high', 'medium')).toBe(true);
    expect(meetsMinimumTrust('high', 'low')).toBe(true);
  });

  it('medium meets medium and below', () => {
    expect(meetsMinimumTrust('medium', 'high')).toBe(false);
    expect(meetsMinimumTrust('medium', 'medium')).toBe(true);
    expect(meetsMinimumTrust('medium', 'low')).toBe(true);
  });

  it('low meets only low', () => {
    expect(meetsMinimumTrust('low', 'medium')).toBe(false);
    expect(meetsMinimumTrust('low', 'low')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree test -- src/contacts/types.test.ts`
Expected: FAIL with `meetsMinimumTrust is not a function` or similar

- [ ] **Step 3: Implement the trust level extension**

In `src/contacts/types.ts`, find the existing `TrustLevel` type at line 132:

```typescript
export type TrustLevel = 'high' | 'medium' | 'low';
```

Replace with:

```typescript
export type TrustLevel = 'ceo' | 'high' | 'medium' | 'low';

// Ordinal ranking for trust level comparison. Higher rank = more trusted.
// Used by meetsMinimumTrust() so callers don't need to enumerate every level.
const TRUST_RANK: Record<TrustLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  ceo: 3,
};

/**
 * Check whether an actual trust level meets or exceeds a required minimum.
 * Returns false for null (unknown contacts default to untrusted).
 */
export function meetsMinimumTrust(
  actual: TrustLevel | null,
  required: TrustLevel,
): boolean {
  if (actual === null) return false;
  return TRUST_RANK[actual] >= TRUST_RANK[required];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix /path/to/worktree test -- src/contacts/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/contacts/types.ts src/contacts/types.test.ts
git commit -m "feat: add 'ceo' trust level and meetsMinimumTrust() helper (#249)"
```

---

### Task 2: Migration — update CEO contact to `'ceo'` trust level

**Files:**
- Create: `src/db/migrations/030_ceo_trust_level_ceo.sql`

- [ ] **Step 1: Check how migration 022 identified the CEO contact**

Read `src/db/migrations/022_ceo_contact_trust_high.sql` and use the same WHERE clause pattern to identify the CEO contact.

- [ ] **Step 2: Write the migration**

Create `src/db/migrations/030_ceo_trust_level_ceo.sql`. Follow the same CEO identification pattern from migration 022:

```sql
-- Migration 030: Elevate CEO contact trust level from 'high' to 'ceo'
--
-- The new 'ceo' level sits above 'high' in the ordinal ranking, enabling
-- trust-based policy decisions (e.g. PII redaction bypass) that should
-- only apply to the principal, not all high-trust contacts.
--
-- Uses the same CEO identification as migration 022.
--
-- Reversal: UPDATE contacts SET trust_level = 'high' WHERE trust_level = 'ceo';

-- NOTE: verify the WHERE clause matches how migration 022 identified
-- the CEO contact. Adapt if the pattern differs.
UPDATE contacts
SET trust_level = 'ceo'
WHERE trust_level = 'high'
  AND <same-condition-as-migration-022>;
```

- [ ] **Step 3: Verify migration numbering is unique**

Run: `ls /path/to/worktree/src/db/migrations/ | sort`
Expected: No collision with prefix `030`. If taken, use the next available number.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/030_ceo_trust_level_ceo.sql
git commit -m "feat: migration to elevate CEO contact to 'ceo' trust level (#249)"
```

---

### Task 3: Update `checkContactDataLeak` to use `meetsMinimumTrust()`

**Files:**
- Modify: `src/dispatch/outbound-filter.ts:318-323`
- Modify: `tests/unit/dispatch/outbound-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/dispatch/outbound-filter.test.ts`:

```typescript
it('allows third-party emails when recipient trust level is ceo', async () => {
  const result = await filter.check({
    content: 'Please contact hamilton@other.org for details.',
    recipientEmail: 'recipient@example.com',
    conversationId: 'conv-1',
    channelId: 'email',
    recipientTrustLevel: 'ceo',
  });
  expect(result.passed).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree test -- tests/unit/dispatch/outbound-filter.test.ts`
Expected: FAIL — `'ceo'` not recognized as a trusted level

- [ ] **Step 3: Update the content filter**

In `src/dispatch/outbound-filter.ts`, add the import:

```typescript
import { meetsMinimumTrust } from '../contacts/types.js';
```

Replace lines 318-323 (the `recipientIsTrusted` block):

```typescript
    // Determine if the recipient qualifies as trusted.
    // Uses ordinal trust comparison — any trust level >= 'high' qualifies,
    // which includes 'high' and 'ceo'. The CEO's own email is covered by
    // their 'ceo' trust level in the DB (migration 030), so the explicit
    // ceoEmail comparison is no longer needed here.
    const recipientIsTrusted = meetsMinimumTrust(recipientTrustLevel, 'high');
```

Update the JSDoc comment above `checkContactDataLeak` (around line 284-303) to reflect the ordinal comparison.

- [ ] **Step 4: Run tests**

Run: `npm --prefix /path/to/worktree test -- tests/unit/dispatch/outbound-filter.test.ts`
Expected: ALL tests pass (existing + new)

- [ ] **Step 5: Run full test suite for regressions**

Run: `npm --prefix /path/to/worktree test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/outbound-filter.ts tests/unit/dispatch/outbound-filter.test.ts
git commit -m "refactor: use meetsMinimumTrust() in checkContactDataLeak (#249)"
```

---

### Task 4: Extract `detectPii()` from `scrubPii()`

**Files:**
- Modify: `src/pii/scrubber.ts`
- Modify: `src/pii/scrubber.test.ts`

- [ ] **Step 1: Write the failing tests for `detectPii()`**

Add to `src/pii/scrubber.test.ts`:

```typescript
import { scrubPii, parseExtraPiiPatterns, detectPii } from './scrubber.js';

describe('detectPii', () => {
  it('detects an email address with label and position', () => {
    const text = 'Contact user@example.com for help';
    const matches = detectPii(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].label).toBe('email');
    expect(matches[0].matched).toBe('user@example.com');
    expect(matches[0].start).toBe(8);
    expect(matches[0].end).toBe(24);
  });

  it('detects a credit card number', () => {
    const matches = detectPii('Card: 4111 1111 1111 1111');
    expect(matches.some(m => m.label === 'credit_card')).toBe(true);
  });

  it('detects multiple PII types in one string', () => {
    const text = 'Call +1-555-867-5309 or email test@example.com';
    const matches = detectPii(text);
    const labels = matches.map(m => m.label);
    expect(labels).toContain('email');
    expect(labels).toContain('phone_us');
  });

  it('does not false-positive on UUIDs', () => {
    const text = 'Task 550e8400-e29b-41d4-a716-446655440000 failed';
    const matches = detectPii(text);
    expect(matches).toHaveLength(0);
  });

  it('returns empty array for clean text', () => {
    expect(detectPii('Just a normal message')).toHaveLength(0);
  });

  it('detects extra patterns when provided', () => {
    const extra = parseExtraPiiPatterns(
      [{ regex: 'EMP-\\d{6}', replacement: '[EMPLOYEE_ID]' }],
      'test-config.yaml',
    );
    const matches = detectPii('Employee EMP-123456 reported', extra);
    expect(matches).toHaveLength(1);
    expect(matches[0].label).toBe('extra_0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree test -- src/pii/scrubber.test.ts`
Expected: FAIL — `detectPii` is not exported

- [ ] **Step 3: Implement `detectPii()` and refactor `scrubPii()`**

In `src/pii/scrubber.ts`:

1. Add the `PiiMatch` interface after the existing `PiiPattern` interface:

```typescript
/** A single PII match found by detectPii(). */
export interface PiiMatch {
  /** Pattern name in lowercase (e.g. "email", "credit_card", "extra_0"). */
  label: string;
  /** Start index in the original text. */
  start: number;
  /** End index in the original text (exclusive). */
  end: number;
  /** The matched substring. */
  matched: string;
}
```

2. Add the `detectPii()` function before `scrubPii()`:

```typescript
/**
 * Detect PII in a string, returning matches with labels and positions.
 * Uses the same openredaction patterns and UUID shielding as scrubPii(),
 * but returns structured matches instead of replacing them.
 *
 * Shared detection foundation: both scrubPii() (blanket replacement for
 * logs/LLM context) and PiiRedactor (selective replacement for outbound
 * channels) call this function.
 *
 * @param text          The string to scan.
 * @param extraPatterns Additional patterns from operator config.
 */
export function detectPii(text: string, extraPatterns: PiiPattern[] = []): PiiMatch[] {
  // 1. Shield UUIDs — replace with null bytes of matching length to preserve indices.
  const shielded = text.replace(UUID_RE, (match) => '\x00'.repeat(match.length));

  // 2. Scan all patterns and collect matches.
  const matches: PiiMatch[] = [];
  const allPatterns = [...BUILT_IN_PATTERNS, ...extraPatterns];

  for (const { name, regex } of allPatterns) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(shielded)) !== null) {
      // Skip matches that overlap with shielded UUID regions (null bytes).
      if (m[0].includes('\x00')) continue;
      matches.push({
        label: name,
        start: m.index,
        end: m.index + m[0].length,
        matched: text.slice(m.index, m.index + m[0].length),
      });
    }
  }

  // Sort by position (earliest first) for predictable replacement order.
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
```

3. Refactor `scrubPii()` to delegate to `detectPii()`:

```typescript
export function scrubPii(text: string, extraPatterns: PiiPattern[] = []): string {
  const matches = detectPii(text, extraPatterns);
  if (matches.length === 0) return text;

  // Build result by replacing matches from end to start (preserves indices).
  const allPatterns = [...BUILT_IN_PATTERNS, ...extraPatterns];
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const pattern = allPatterns.find(p => p.name === match.label);
    const replacement = pattern?.replacement ?? `[${match.label.toUpperCase()}]`;
    result = result.slice(0, match.start) + replacement + result.slice(match.end);
  }
  return result;
}
```

- [ ] **Step 4: Run all scrubber tests**

Run: `npm --prefix /path/to/worktree test -- src/pii/scrubber.test.ts`
Expected: ALL tests pass (existing `scrubPii` regression tests + new `detectPii` tests)

- [ ] **Step 5: Run full test suite for regressions**

Run: `npm --prefix /path/to/worktree test`
Expected: PASS — `scrubPii()` refactor is behaviour-preserving

- [ ] **Step 6: Commit**

```bash
git add src/pii/scrubber.ts src/pii/scrubber.test.ts
git commit -m "refactor: extract detectPii() from scrubPii() for shared detection (#249)"
```

---

### Task 5: Register `outbound.pii-redacted` bus event

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/bus/permissions.ts`

- [ ] **Step 1: Add the event payload interface**

In `src/bus/events.ts`, after the `OutboundBlockedPayload` interface (around line 107), add:

```typescript
// OutboundPiiRedactedPayload — emitted by the dispatch layer (via PiiRedactor)
// when PII is redacted from an outbound message before delivery. The message is
// still sent (with redacted content); this event provides an audit trail.
// No subscriber initially — available for future audit UI and alerting rules.
interface OutboundPiiRedactedPayload {
  channelId: string;
  recipientId: string;
  conversationId: string;
  redactions: Array<{
    patternLabel: string;     // e.g. "credit_card"
    replacedWith: string;     // e.g. "[REDACTED: CREDIT_CARD]"
  }>;
}
```

- [ ] **Step 2: Add the event interface to the discriminated union**

After `OutboundNotificationEvent` (around line 481), add:

```typescript
// OutboundPiiRedactedEvent — published by the dispatch layer when PII is redacted
// from an outbound message. The message still sends; this is audit-only.
export interface OutboundPiiRedactedEvent extends BaseEvent {
  type: 'outbound.pii-redacted';
  sourceLayer: 'dispatch';
  payload: OutboundPiiRedactedPayload;
}
```

- [ ] **Step 3: Add to the `BusEvent` union**

In the `BusEvent` type (around line 670), add:

```typescript
  | OutboundPiiRedactedEvent  // PII outbound redaction: audit trail for redacted PII (#249)
```

- [ ] **Step 4: Add the factory function**

After `createOutboundNotification` (around line 797), add:

```typescript
export function createOutboundPiiRedacted(
  payload: OutboundPiiRedactedPayload & { parentEventId?: string },
): OutboundPiiRedactedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'outbound.pii-redacted',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}
```

- [ ] **Step 5: Update permissions**

In `src/bus/permissions.ts`:

1. Add `'outbound.pii-redacted'` to the `dispatch` set in `publishAllowlist`
2. Add `'outbound.pii-redacted'` to the `system` set in both `publishAllowlist` and `subscribeAllowlist`

- [ ] **Step 6: Run full test suite**

Run: `npm --prefix /path/to/worktree test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/bus/events.ts src/bus/permissions.ts
git commit -m "feat: register outbound.pii-redacted bus event (#249)"
```

---

### Task 6: Config schema and YAML

**Files:**
- Modify: `src/config.ts:225-237`
- Modify: `schemas/default-config.schema.json:167-184`
- Modify: `config/default.yaml:206`

- [ ] **Step 1: Extend the TypeScript config interface**

In `src/config.ts`, replace the `pii` block (lines 225-237) with the expanded version that includes `outbound_redaction`:

```typescript
  pii?: {
    /**
     * Extra PII patterns to scrub from LLM-facing error strings, beyond the
     * built-in defaults (email, phone, credit card, SSN).
     *
     * Each entry must have:
     *   regex       - a valid JavaScript regex string (gi flags applied automatically)
     *   replacement - the placeholder to substitute, e.g. "[EMPLOYEE_ID]"
     *
     * Changes take effect on restart.
     */
    extra_patterns?: Array<{ regex: string; replacement: string }>;

    /**
     * Outbound PII redaction policy - controls which PII patterns are redacted
     * in outbound channel messages (email, Signal).
     *
     * Detection uses the same openredaction library as the log/LLM scrubber.
     * This config only controls the policy (block/allow per channel).
     */
    outbound_redaction?: {
      /** Kill switch. Default: true. */
      enabled?: boolean;
      /** Trust levels that bypass all redaction. Default: ['ceo']. */
      trust_override?: string[];
      /** Default action for unlisted pattern/channel combos. Default: 'block'. */
      default?: 'block' | 'allow';
      /** Per-channel allow lists. Patterns listed here pass through unredacted. */
      channel_policies?: Record<string, {
        /** Pattern labels (lowercase) allowed on this channel. */
        allow?: string[];
      }>;
    };
  };
```

- [ ] **Step 2: Extend the JSON schema**

In `schemas/default-config.schema.json`, replace the `pii` object (lines 167-184):

```json
    "pii": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "extra_patterns": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["regex", "replacement"],
            "additionalProperties": false,
            "properties": {
              "regex": { "type": "string", "minLength": 1 },
              "replacement": { "type": "string", "minLength": 1 }
            }
          }
        },
        "outbound_redaction": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "enabled": { "type": "boolean" },
            "trust_override": {
              "type": "array",
              "items": { "type": "string", "enum": ["ceo", "high", "medium", "low"] }
            },
            "default": { "type": "string", "enum": ["block", "allow"] },
            "channel_policies": {
              "type": "object",
              "additionalProperties": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "allow": {
                    "type": "array",
                    "items": { "type": "string", "minLength": 1 }
                  }
                }
              }
            }
          }
        }
      }
    },
```

- [ ] **Step 3: Add defaults to config/default.yaml**

In `config/default.yaml`, after `extra_patterns: []` (line 206), add:

```yaml

  # Outbound PII redaction policy - controls which PII patterns are redacted
  # in outbound channel messages (email, Signal replies).
  #
  # Detection uses the same openredaction library as the log/LLM scrubber.
  # This config controls only the policy: which detected patterns are allowed
  # on which channels. Patterns not in a channel's allow list are redacted.
  #
  # trust_override: trust levels that bypass all redaction (CEO gets unredacted
  # content so they can ask "what phone number do we have for X?" without friction).
  #
  # default: 'block' means any detected PII not explicitly allowed is redacted.
  # You only configure exceptions, not rules.
  outbound_redaction:
    enabled: true
    trust_override: [ceo]
    default: block
    channel_policies:
      email:
        allow: [email]         # email addresses are fine in email replies
      signal:
        allow: []              # everything blocked for Signal (except CEO)
```

- [ ] **Step 4: Run startup validation test**

Run: `npm --prefix /path/to/worktree test -- tests/unit/startup`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts schemas/default-config.schema.json config/default.yaml
git commit -m "feat: add outbound_redaction config schema and defaults (#249)"
```

---

### Task 7: Implement `PiiRedactor` class

**Files:**
- Create: `src/dispatch/pii-redactor.ts`
- Create: `src/dispatch/pii-redactor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/dispatch/pii-redactor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiiRedactor } from './pii-redactor.js';
import { createLogger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';

function createMockBus(): EventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as EventBus;
}

const defaultConfig = {
  enabled: true,
  trust_override: ['ceo'] as string[],
  default: 'block' as const,
  channel_policies: {
    email: { allow: ['email'] },
    signal: { allow: [] },
  },
};

describe('PiiRedactor', () => {
  let bus: EventBus;
  let redactor: PiiRedactor;

  beforeEach(() => {
    bus = createMockBus();
    redactor = new PiiRedactor({
      config: defaultConfig,
      bus,
      logger: createLogger('error'),
      extraPatterns: [],
    });
  });

  it('redacts a credit card number in email channel', async () => {
    const result = await redactor.redact(
      'Your card is 4111 1111 1111 1111.',
      'email',
      'medium',
    );
    expect(result.content).toContain('[REDACTED: CREDIT_CARD]');
    expect(result.content).not.toContain('4111');
    expect(result.redactions).toHaveLength(1);
    expect(result.redactions[0].patternLabel).toBe('credit_card');
  });

  it('allows email addresses in email channel (in allow list)', async () => {
    const result = await redactor.redact(
      'Contact user@example.com for help.',
      'email',
      'medium',
    );
    expect(result.content).toContain('user@example.com');
    expect(result.redactions).toHaveLength(0);
  });

  it('redacts email addresses in signal channel (not in allow list)', async () => {
    const result = await redactor.redact(
      'Contact user@example.com for help.',
      'signal',
      'medium',
    );
    expect(result.content).toContain('[REDACTED: EMAIL]');
    expect(result.content).not.toContain('user@example.com');
  });

  it('bypasses redaction for CEO trust level', async () => {
    const result = await redactor.redact(
      'Your card is 4111 1111 1111 1111.',
      'email',
      'ceo',
    );
    expect(result.content).toContain('4111 1111 1111 1111');
    expect(result.redactions).toHaveLength(0);
  });

  it('bypasses redaction when disabled', async () => {
    const disabled = new PiiRedactor({
      config: { ...defaultConfig, enabled: false },
      bus,
      logger: createLogger('error'),
      extraPatterns: [],
    });
    const result = await disabled.redact(
      'Card: 4111 1111 1111 1111',
      'email',
      'medium',
    );
    expect(result.content).toContain('4111 1111 1111 1111');
  });

  it('blocks all PII on unlisted channels (default: block)', async () => {
    const result = await redactor.redact(
      'Contact user@example.com',
      'sms',
      'medium',
    );
    expect(result.content).toContain('[REDACTED: EMAIL]');
  });

  it('handles multiple PII matches in one message', async () => {
    const result = await redactor.redact(
      'Card 4111 1111 1111 1111 and phone +1-555-867-5309',
      'email',
      'medium',
    );
    expect(result.content).toContain('[REDACTED: CREDIT_CARD]');
    expect(result.content).toContain('[REDACTED: PHONE]');
    expect(result.redactions.length).toBeGreaterThanOrEqual(2);
  });

  it('returns original content when no PII detected', async () => {
    const text = 'Just a normal message with no PII.';
    const result = await redactor.redact(text, 'email', 'medium');
    expect(result.content).toBe(text);
    expect(result.redactions).toHaveLength(0);
  });

  it('does not publish bus event when no redactions', async () => {
    await redactor.redact('Clean message', 'email', 'medium');
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('publishes outbound.pii-redacted event on redaction', async () => {
    await redactor.redact(
      'Card: 4111 1111 1111 1111',
      'email',
      'medium',
      { conversationId: 'conv-1', recipientId: 'recipient@example.com' },
    );
    expect(bus.publish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'outbound.pii-redacted',
        payload: expect.objectContaining({
          channelId: 'email',
          recipientId: 'recipient@example.com',
          conversationId: 'conv-1',
        }),
      }),
    );
  });

  it('does not publish bus event for CEO bypass', async () => {
    await redactor.redact('Card: 4111 1111 1111 1111', 'email', 'ceo');
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('does not include original PII values in redaction entries', async () => {
    const result = await redactor.redact(
      'Card: 4111 1111 1111 1111',
      'email',
      'medium',
    );
    const entry = result.redactions[0];
    expect(JSON.stringify(entry)).not.toContain('4111');
  });

  it('null trust level is treated as untrusted (PII redacted)', async () => {
    const result = await redactor.redact(
      'Card: 4111 1111 1111 1111',
      'email',
      null,
    );
    expect(result.content).toContain('[REDACTED: CREDIT_CARD]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree test -- src/dispatch/pii-redactor.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement `PiiRedactor`**

Create `src/dispatch/pii-redactor.ts`:

```typescript
// pii-redactor.ts -- context-aware PII redaction for outbound channel messages.
//
// Sits as a pipeline step in OutboundGateway between the blocked-contact check
// and the content filter. Detects PII using openredaction (via the shared
// detectPii() function) and selectively redacts based on channel policy and
// recipient trust level.
//
// Design: fail-closed. If detection throws, the caller (OutboundGateway)
// should block the message rather than sending unredacted content.

import { detectPii, type PiiPattern, type PiiMatch } from '../pii/scrubber.js';
import { meetsMinimumTrust, type TrustLevel } from '../contacts/types.js';
import { createOutboundPiiRedacted } from '../bus/events.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RedactionEntry {
  patternLabel: string;     // e.g. "credit_card"
  channelId: string;        // e.g. "email"
  replacedWith: string;     // e.g. "[REDACTED: CREDIT_CARD]"
  // Original value is intentionally NOT stored.
}

export interface RedactionResult {
  /** Modified content (or original if nothing was redacted). */
  content: string;
  /** What was redacted -- for logging and audit. */
  redactions: RedactionEntry[];
}

export interface OutboundRedactionConfig {
  enabled: boolean;
  trust_override: string[];
  default: 'block' | 'allow';
  channel_policies: Record<string, { allow: string[] }>;
}

export interface PiiRedactorConfig {
  config: OutboundRedactionConfig;
  bus: EventBus;
  logger: Logger;
  extraPatterns: PiiPattern[];
}

// ---------------------------------------------------------------------------
// PiiRedactor
// ---------------------------------------------------------------------------

export class PiiRedactor {
  private readonly config: OutboundRedactionConfig;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly extraPatterns: PiiPattern[];

  constructor(opts: PiiRedactorConfig) {
    this.config = opts.config;
    this.bus = opts.bus;
    this.log = opts.logger.child({ component: 'pii-redactor' });
    this.extraPatterns = opts.extraPatterns;
  }

  /**
   * Scan content for PII and redact based on channel policy and trust level.
   *
   * @param content    The outbound message body.
   * @param channelId  Target channel (e.g. 'email', 'signal').
   * @param trustLevel Recipient's trust level (null = unknown/untrusted).
   * @param context    Optional context for the audit event.
   */
  async redact(
    content: string,
    channelId: string,
    trustLevel: TrustLevel | null,
    context?: { conversationId?: string; recipientId?: string },
  ): Promise<RedactionResult> {
    // 1. Kill switch.
    if (!this.config.enabled) {
      return { content, redactions: [] };
    }

    // 2. Trust override -- if recipient meets or exceeds any override level,
    //    skip redaction entirely (CEO gets full PII access).
    for (const overrideLevel of this.config.trust_override) {
      if (meetsMinimumTrust(trustLevel, overrideLevel as TrustLevel)) {
        return { content, redactions: [] };
      }
    }

    // 3. Detect PII using shared openredaction-based detection.
    const matches = detectPii(content, this.extraPatterns);
    if (matches.length === 0) {
      return { content, redactions: [] };
    }

    // 4. Apply channel policy.
    const channelPolicy = this.config.channel_policies[channelId];
    const allowList = new Set(
      (channelPolicy?.allow ?? []).map(l => l.toLowerCase()),
    );

    // Determine which matches to redact (those not in the allow list).
    const toRedact: PiiMatch[] = matches.filter(
      m => !allowList.has(m.label.toLowerCase()),
    );

    if (toRedact.length === 0) {
      return { content, redactions: [] };
    }

    // 5. Redact -- replace from end to start to preserve indices.
    const redactions: RedactionEntry[] = [];
    let result = content;
    for (let i = toRedact.length - 1; i >= 0; i--) {
      const match = toRedact[i];
      const replacement = `[REDACTED: ${match.label.toUpperCase()}]`;
      result = result.slice(0, match.start) + replacement + result.slice(match.end);
      redactions.push({
        patternLabel: match.label,
        channelId,
        replacedWith: replacement,
      });
    }
    // Reverse so redactions are in document order.
    redactions.reverse();

    // 6. Log and publish audit event.
    this.log.info(
      {
        event: 'pii_redacted',
        channelId,
        recipientTrustLevel: trustLevel,
        redactions: redactions.map(r => ({ patternLabel: r.patternLabel })),
        redactionCount: redactions.length,
        conversationId: context?.conversationId,
      },
      'pii-redactor: redacted PII from outbound message',
    );

    // Publish bus event -- fire-and-forget. Failure does not block the send.
    this.bus.publish(
      'dispatch',
      createOutboundPiiRedacted({
        channelId,
        recipientId: context?.recipientId ?? '',
        conversationId: context?.conversationId ?? '',
        redactions: redactions.map(r => ({
          patternLabel: r.patternLabel,
          replacedWith: r.replacedWith,
        })),
      }),
    ).catch((err) => {
      this.log.warn(
        { err, channelId },
        'pii-redactor: failed to publish outbound.pii-redacted event',
      );
    });

    return { content: result, redactions };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix /path/to/worktree test -- src/dispatch/pii-redactor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/pii-redactor.ts src/dispatch/pii-redactor.test.ts
git commit -m "feat: implement PiiRedactor with channel-aware redaction (#249)"
```

---

### Task 8: Wire `PiiRedactor` into `OutboundGateway`

**Files:**
- Modify: `src/skills/outbound-gateway.ts`
- Modify: `tests/unit/skills/outbound-gateway.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Add to `tests/unit/skills/outbound-gateway.test.ts`:

```typescript
import { PiiRedactor } from '../../../src/dispatch/pii-redactor.js';

describe('PII redaction step', () => {
  it('redacts PII for non-CEO recipients before sending', async () => {
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-1',
      displayName: 'Test User',
      role: null,
      status: 'confirmed',
      kgNodeId: null,
      verified: true,
      trustLevel: 'medium',
    });

    const piiRedactor = new PiiRedactor({
      config: {
        enabled: true,
        trust_override: ['ceo'],
        default: 'block',
        channel_policies: { email: { allow: ['email'] } },
      },
      bus: mocks.bus,
      logger: mocks.logger,
      extraPatterns: [],
    });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      piiRedactor,
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'test@example.com',
      subject: 'Booking',
      body: 'Your card 4111 1111 1111 1111 was charged.',
    });

    expect(result.success).toBe(true);
    // Verify the content filter received redacted content
    const filterCall = (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(filterCall.content).toContain('[REDACTED: CREDIT_CARD]');
    expect(filterCall.content).not.toContain('4111');
  });

  it('does NOT redact PII for CEO recipients', async () => {
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-ceo',
      displayName: 'CEO',
      role: null,
      status: 'confirmed',
      kgNodeId: null,
      verified: true,
      trustLevel: 'ceo',
    });

    const piiRedactor = new PiiRedactor({
      config: {
        enabled: true,
        trust_override: ['ceo'],
        default: 'block',
        channel_policies: { email: { allow: ['email'] } },
      },
      bus: mocks.bus,
      logger: mocks.logger,
      extraPatterns: [],
    });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      piiRedactor,
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'ceo@example.com',
      subject: 'Booking',
      body: 'Your card 4111 1111 1111 1111 was charged.',
    });

    expect(result.success).toBe(true);
    const filterCall = (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(filterCall.content).toContain('4111 1111 1111 1111');
  });

  it('works without piiRedactor configured (backwards compatible)', async () => {
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      // no piiRedactor
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'test@example.com',
      subject: 'Test',
      body: 'Card: 4111 1111 1111 1111',
    });

    expect(result.success).toBe(true);
    // Without redactor, content passes through unmodified
    const filterCall = (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(filterCall.content).toContain('4111 1111 1111 1111');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree test -- tests/unit/skills/outbound-gateway.test.ts`
Expected: FAIL — gateway doesn't accept or use `piiRedactor`

- [ ] **Step 3: Add PiiRedactor to the gateway**

In `src/skills/outbound-gateway.ts`:

1. Add imports:

```typescript
import { PiiRedactor } from '../dispatch/pii-redactor.js';
```

2. Add to `OutboundGatewayConfig` interface:

```typescript
  /**
   * PII redactor -- context-aware redaction for outbound messages.
   * Runs as a pipeline step after blocked-contact check, before content filter.
   * Optional -- when absent, no PII redaction is performed.
   */
  piiRedactor?: PiiRedactor;
```

3. Add private field and constructor assignment:

```typescript
  private readonly piiRedactor?: PiiRedactor;
```

In constructor:
```typescript
    this.piiRedactor = config.piiRedactor;
```

4. In `send()`, after the blocked-contact check (after line 309 where `recipientTrustLevel` is captured), insert the redaction step. Then update the content filter call and dispatch calls to use `redactedBody`.

See the design spec for the exact pipeline position and fail-closed error handling pattern.

The key changes:
- Add `let redactedBody = messageBody;` after the blocked-contact check
- If `this.piiRedactor` exists, call `redact()` and update `redactedBody`
- Wrap in try/catch with fail-closed behaviour (block on error)
- Change the content filter's `content:` from `messageBody` to `redactedBody`
- Change the dispatch method calls from `messageBody` to `redactedBody`

- [ ] **Step 4: Run all gateway tests**

Run: `npm --prefix /path/to/worktree test -- tests/unit/skills/outbound-gateway.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm --prefix /path/to/worktree test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git commit -m "feat: wire PiiRedactor into OutboundGateway pipeline (#249)"
```

---

### Task 9: Wire `PiiRedactor` in bootstrap (`index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add PiiRedactor initialization**

In `src/index.ts`, after the existing PII pattern loading block (around line 946), add the `PiiRedactor` construction. Import `PiiRedactor` at the top of the file.

The redactor needs:
- Config from `yamlConfig.pii?.outbound_redaction` (with defaults)
- The `bus` instance (already available)
- The `logger` instance (already available)
- The parsed extra patterns (reuse the variable from the existing PII pattern loading block, or re-parse if the variable is scoped inside the `if` block -- check and adjust)

Then pass `piiRedactor` to the `OutboundGateway` constructor.

- [ ] **Step 2: Run full test suite**

Run: `npm --prefix /path/to/worktree test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire PiiRedactor into bootstrap orchestrator (#249)"
```

---

### Task 10: CHANGELOG and final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entries**

Under `## [Unreleased]`, add:

```markdown
### Added
- **PII outbound redaction** -- configurable per-channel PII redaction for outbound messages. Detected PII (credit cards, phone numbers, SSNs, etc.) is redacted in email and Signal replies based on channel policy. CEO trust level bypasses redaction. Publishes `outbound.pii-redacted` audit event. (#249)

### Changed
- **Trust levels** -- added `'ceo'` trust level above `'high'` with ordinal comparison via `meetsMinimumTrust()` helper. Existing `checkContactDataLeak` rule now uses ordinal comparison instead of `=== 'high'`. (#249)
```

- [ ] **Step 2: Run full test suite one final time**

Run: `npm --prefix /path/to/worktree test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG entries for PII outbound redaction (#249)"
```

- [ ] **Step 4: Push branch and run pre-PR review agents**

Push the branch, then run the review agents (code-reviewer, silent-failure-hunter) before creating the PR, per project rules.
