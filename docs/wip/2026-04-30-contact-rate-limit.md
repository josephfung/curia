# Contact Auto-Creation Rate Limiting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-memory rate limiting (10/message, 100/hour) to email participant contact auto-creation, with CEO notification via `outbound.notification` when limits are hit.

**Architecture:** Two in-memory counters on `EmailAdapter` — a per-message loop counter and a per-hour sliding window. When either cap is reached, remaining participants are skipped and a deduplicated CEO notification email is sent via the existing `outbound.notification` bus event. Configurable via `config/default.yaml`.

**Tech Stack:** TypeScript/ESM, Vitest, pino logging, bus events

**Design doc:** `docs/wip/2026-04-30-contact-rate-limit-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/bus/events.ts` | Modify (line 118) | Add `'contact_rate_limited'` to `notificationType` union |
| `src/channels/email/email-adapter.ts` | Modify | Add rate-limit state, config fields, counter logic, notification |
| `config/default.yaml` | Modify | Add `contact_creation_limits` block |
| `schemas/default-config.schema.json` | Modify | Add `contact_creation_limits` to JSON Schema |
| `src/config.ts` | Modify | Parse `contact_creation_limits` from config, expose on `AppConfig` |
| `src/index.ts` | Modify (line 684) | Pass rate-limit config + `ceoEmail` to `EmailAdapter` constructor |
| `tests/unit/channels/email/email-adapter.test.ts` | Modify | Add 7 rate-limiting test cases |
| `CHANGELOG.md` | Modify | Add entry under `[Unreleased]` |

---

## Task 1: Extend the notification type union

**Files:**
- Modify: `src/bus/events.ts:114-118`

- [ ] **Step 1: Add `'contact_rate_limited'` to the `notificationType` union**

In `src/bus/events.ts`, update the comment and type at lines 114-118:

```typescript
// notificationType discriminates between alert categories:
//   - 'blocked_content': CEO alert that an outbound message was blocked by the content filter
//   - 'group_held':      CEO alert that a Signal group message was held due to unverified members
//   - 'contact_rate_limited': CEO alert that contact auto-creation was throttled due to rate limits
export interface OutboundNotificationPayload {
  notificationType: 'blocked_content' | 'group_held' | 'contact_rate_limited';
```

- [ ] **Step 2: Run typecheck to confirm no type errors**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit run typecheck`

Expected: Clean pass — the new union member is additive; existing callers pass `'blocked_content'` or `'group_held'` which still match.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit add src/bus/events.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit commit -m "feat: add contact_rate_limited to outbound notification type union (#36)"
```

---

## Task 2: Add config schema and parsing

**Files:**
- Modify: `schemas/default-config.schema.json:207` (before closing `}`)
- Modify: `config/default.yaml` (after `channel_accounts` block, around line 48)
- Modify: `src/config.ts:113` (AppConfig interface) and `src/config.ts:774` (loadConfig)

- [ ] **Step 1: Add `contact_creation_limits` to JSON Schema**

In `schemas/default-config.schema.json`, add a new property inside the top-level `properties` object (before the final closing braces):

```json
    "contact_creation_limits": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "max_per_message": { "type": "integer", "minimum": 1 },
        "max_per_hour": { "type": "integer", "minimum": 1 }
      }
    }
```

- [ ] **Step 2: Add config block to `config/default.yaml`**

After the `channel_accounts` comment block (around line 48, after the `# channel_accounts: {}` line), add:

```yaml
# Rate limits for automatic contact creation from email participants.
# Prevents spam campaigns from flooding the contacts table.
# Both limits are anti-flood guardrails — normal business email should never hit them.
contact_creation_limits:
  max_per_message: 10    # max new contacts created from a single email's participant list
  max_per_hour: 100      # max new contacts created per hour, per email account
```

- [ ] **Step 3: Add fields to `AppConfig` and `loadConfig()`**

In `src/config.ts`, add to the `AppConfig` interface (near line 113, after `nylasPollingIntervalMs`):

```typescript
  contactCreationMaxPerMessage: number;
  contactCreationMaxPerHour: number;
```

In the `loadConfig()` return object (near line 774, after `nylasPollingIntervalMs`), add:

```typescript
    contactCreationMaxPerMessage: (rawConfig as Record<string, unknown>)?.contact_creation_limits?.max_per_message ?? 10,
    contactCreationMaxPerHour: (rawConfig as Record<string, unknown>)?.contact_creation_limits?.max_per_hour ?? 100,
```

Note: Check how `rawConfig` is accessed in the existing code — follow the same pattern for accessing nested YAML values. The defaults (10 and 100) ensure backward compatibility when the config block is absent.

- [ ] **Step 4: Run typecheck**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit run typecheck`

Expected: Clean pass.

- [ ] **Step 5: Run startup validator test to confirm schema acceptance**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit test -- tests/unit/startup/validator.test.ts`

Expected: All existing validator tests pass. The new schema property is optional, so existing configs without it still validate.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit add schemas/default-config.schema.json config/default.yaml src/config.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit commit -m "feat: add contact_creation_limits config (#36)"
```

---

## Task 3: Add rate-limit state and config to EmailAdapter

**Files:**
- Modify: `src/channels/email/email-adapter.ts:20-71` (config interface + class fields)
- Modify: `src/index.ts:684` (constructor call)

- [ ] **Step 1: Add config fields to `EmailAdapterConfig`**

In `src/channels/email/email-adapter.ts`, add three new fields to the `EmailAdapterConfig` interface (after `excludedSenderEmails`, around line 60):

```typescript
  /**
   * CEO's email address — used as the recipient for rate-limit notification emails.
   * When absent, rate-limit notifications are logged but not emailed.
   */
  ceoEmail?: string;
  /**
   * Maximum new contacts to auto-create from a single email's participant list.
   * Existing contacts (already in DB) don't count. Default: 10.
   */
  contactCreationMaxPerMessage: number;
  /**
   * Maximum new contacts to auto-create per hour across all emails for this account.
   * Sliding window resets after 1 hour. Default: 100.
   */
  contactCreationMaxPerHour: number;
```

- [ ] **Step 2: Add rate-limit state fields to the `EmailAdapter` class**

In the `EmailAdapter` class body (after `private processing = false;` at line 67), add:

```typescript
  // ── Contact auto-creation rate limiting (#36) ──────────────────────────────
  // In-memory counters — reset on process restart, which is fine for anti-flood.

  /** Sliding-window counter for the per-hour rate limit. */
  private hourlyContactCount = 0;
  private hourlyWindowStart = Date.now();

  /** Timestamps of the last rate-limit notification per limit type, for dedup. */
  private lastNotifiedPerMessage = 0;
  private lastNotifiedPerHour = 0;
```

- [ ] **Step 3: Wire config into `EmailAdapter` constructor in `src/index.ts`**

In `src/index.ts`, at the `emailAdapters.push(new EmailAdapter({...}))` call (around line 684), add the three new fields:

```typescript
        ceoEmail: config.ceoPrimaryEmail,
        contactCreationMaxPerMessage: config.contactCreationMaxPerMessage,
        contactCreationMaxPerHour: config.contactCreationMaxPerHour,
```

- [ ] **Step 4: Run typecheck**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit run typecheck`

Expected: Clean pass. Existing tests will also need their `makeAdapter` updated (next task), but typecheck on the source should pass because the test file uses `as unknown as`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit add src/channels/email/email-adapter.ts src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit commit -m "feat: add rate-limit config and state fields to EmailAdapter (#36)"
```

---

## Task 4: Write failing tests for rate limiting

**Files:**
- Modify: `tests/unit/channels/email/email-adapter.test.ts`

All 7 tests go in a new `describe` block at the end of the file. The tests call `extractParticipants` indirectly by triggering `poll()` via `adapter.start()` + `flushPoll()` (same pattern as the existing inbound poll tests).

- [ ] **Step 1: Update `makeAdapter` helper to include new config fields**

In `tests/unit/channels/email/email-adapter.test.ts`, update the `makeAdapter` function (around line 62) to include the new required config fields:

```typescript
function makeAdapter(mocks: ReturnType<typeof createMocks>, overrides: Partial<{
  contactCreationMaxPerMessage: number;
  contactCreationMaxPerHour: number;
  ceoEmail: string;
}> = {}) {
  return new EmailAdapter({
    accountId: 'curia',
    outboundPolicy: 'direct',
    bus: mocks.bus,
    logger: mocks.logger,
    outboundGateway: mocks.outboundGateway,
    contactService: mocks.contactService,
    pollingIntervalMs: 999999, // never fires in tests
    selfEmail: SELF_EMAIL,
    observationMode: false,
    excludedSenderEmails: [],
    contactCreationMaxPerMessage: overrides.contactCreationMaxPerMessage ?? 10,
    contactCreationMaxPerHour: overrides.contactCreationMaxPerHour ?? 100,
    ceoEmail: overrides.ceoEmail ?? CEO_EMAIL,
  });
}
```

Also update the inline `new EmailAdapter(...)` calls in the existing tests (the `excludedSenderEmails`, `observationMode`, and `outbound.notification` describe blocks) to add the three new fields:

```typescript
    contactCreationMaxPerMessage: 10,
    contactCreationMaxPerHour: 100,
    ceoEmail: CEO_EMAIL,
```

- [ ] **Step 2: Write the 7 rate-limiting test cases**

Add a new `describe` block at the end of the test file:

```typescript
// ---------------------------------------------------------------------------
// Contact auto-creation rate limiting (#36)
// ---------------------------------------------------------------------------

describe('EmailAdapter — contact auto-creation rate limiting', () => {
  /** Build an email with N unique CC participants (+ the from sender). */
  function makeMockMessageWithParticipants(ccCount: number): NylasMessage {
    const ccList = Array.from({ length: ccCount }, (_, i) => ({
      email: `cc${i}@example.com`,
      name: `CC User ${i}`,
    }));
    return makeMockMessage({
      from: [{ email: 'sender@example.com', name: 'Sender' }],
      to: [{ email: SELF_EMAIL }],
      cc: ccList,
    });
  }

  it('enforces per-message cap — only creates max_per_message new contacts', async () => {
    const mocks = createMocks();
    // Set per-message cap to 3 for easy testing
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 3 });

    // resolveByChannelIdentity returns null for all — every participant is new
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // 6 participants (1 from + 5 CC), minus selfEmail in to = 6 non-self participants
    const msg = makeMockMessageWithParticipants(5);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    // Only 3 contacts should be created (per-message cap)
    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(3);

    await adapter.stop();
  });

  it('enforces per-hour cap across multiple emails', async () => {
    const mocks = createMocks();
    // Set per-hour cap to 2 for easy testing, per-message high enough to not interfere
    const adapter = makeAdapter(mocks, { contactCreationMaxPerHour: 2, contactCreationMaxPerMessage: 100 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // First email: 2 new participants (from + 1 CC) — should create 2 (hits hourly cap)
    const msg1 = makeMockMessage({
      id: 'msg-a', date: 1700000001,
      from: [{ email: 'a@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: 'b@example.com' }],
    });
    // Second email: 1 new participant — should be skipped (hourly cap already hit)
    const msg2 = makeMockMessage({
      id: 'msg-b', date: 1700000002,
      from: [{ email: 'c@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg1, msg2]);

    await adapter.start();
    await flushPoll();

    // Only 2 contacts created total (hourly cap), not 3
    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });

  it('resets hourly window after 1 hour', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerHour: 1, contactCreationMaxPerMessage: 100 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // First poll: 1 new participant — hits hourly cap
    const msg1 = makeMockMessage({
      id: 'msg-a', date: 1700000001,
      from: [{ email: 'first@example.com' }],
      to: [{ email: SELF_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg1]);

    await adapter.start();
    await flushPoll();

    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(1);

    // Advance time by 1 hour + 1ms
    vi.advanceTimersByTime(3600001);

    // Second poll: 1 new participant — window reset, should succeed
    const msg2 = makeMockMessage({
      id: 'msg-b', date: 1700003601,
      from: [{ email: 'second@example.com' }],
      to: [{ email: SELF_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg2]);

    // Manually trigger poll (timer is set to huge interval in tests)
    await (adapter as unknown as { poll(): Promise<void> }).poll();
    await flushPoll();

    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });

  it('existing contacts do not count toward the per-message cap', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 2 });

    // First 3 participants already exist, last 2 are new
    let resolveCallCount = 0;
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockImplementation(() => {
      resolveCallCount++;
      // First 3 calls return existing contact, rest return null
      return Promise.resolve(resolveCallCount <= 3 ? { id: 'existing' } : null);
    });
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // 5 non-self participants (1 from + 4 CC)
    const msg = makeMockMessageWithParticipants(4);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    // 3 already existed, 2 are new — both new ones should be created (under cap of 2)
    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });

  it('publishes outbound.notification when per-message cap is hit', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 1 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Add sendNotification mock to outboundGateway
    (mocks.outboundGateway as Record<string, unknown>).sendNotification = vi.fn().mockResolvedValue(undefined);

    // 3 non-self participants (from + 2 CC), cap is 1
    const msg = makeMockMessage({
      from: [{ email: 'a@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: 'b@example.com' }, { email: 'c@example.com' }],
      subject: 'Board meeting notes',
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    // Notification should fire with contact_rate_limited type
    expect((mocks.outboundGateway as Record<string, unknown>).sendNotification).toHaveBeenCalledOnce();
    const notifPayload = ((mocks.outboundGateway as Record<string, unknown>).sendNotification as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(notifPayload.notificationType).toBe('contact_rate_limited');
    expect(notifPayload.ceoEmail).toBe(CEO_EMAIL);
    expect(notifPayload.subject).toContain('rate limit');

    await adapter.stop();
  });

  it('deduplicates notifications — only one per limit type per hour', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 1 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    (mocks.outboundGateway as Record<string, unknown>).sendNotification = vi.fn().mockResolvedValue(undefined);

    // First email — triggers per-message limit + notification
    const msg1 = makeMockMessage({
      id: 'msg-a', date: 1700000001,
      from: [{ email: 'a@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: 'b@example.com' }],
    });
    // Second email — triggers per-message limit again, but notification should be deduped
    const msg2 = makeMockMessage({
      id: 'msg-b', date: 1700000002,
      from: [{ email: 'c@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: 'd@example.com' }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg1, msg2]);

    await adapter.start();
    await flushPoll();

    // Only one notification despite two rate-limit hits
    expect((mocks.outboundGateway as Record<string, unknown>).sendNotification).toHaveBeenCalledOnce();

    await adapter.stop();
  });

  it('respects custom config overrides for limits', async () => {
    const mocks = createMocks();
    // Custom limits: 2 per message, 5 per hour
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 2, contactCreationMaxPerHour: 5 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Email with 4 non-self participants — should only create 2 (per-message cap)
    const msg = makeMockMessageWithParticipants(3); // 1 from + 3 CC = 4 non-self
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit test -- tests/unit/channels/email/email-adapter.test.ts`

Expected: The 7 new tests FAIL (rate-limiting logic doesn't exist yet). Existing tests should still PASS (we only added config fields with defaults).

- [ ] **Step 4: Commit the failing tests**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit add tests/unit/channels/email/email-adapter.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit commit -m "test: add failing tests for contact auto-creation rate limiting (#36)"
```

---

## Task 5: Implement rate-limiting logic in `extractParticipants`

**Files:**
- Modify: `src/channels/email/email-adapter.ts:483-528`

- [ ] **Step 1: Rewrite `extractParticipants` with rate-limit checks**

Replace the existing `extractParticipants` method (lines 483-528) with:

```typescript
  /**
   * Auto-create contacts from email participants (From/To/CC).
   * Uses source 'email_participant' which is auto-verified per spec.
   * Skips participants that already have a contact record, and skips
   * our own email address (selfEmail) to avoid self-contact creation.
   *
   * Rate limits (#36):
   *   - Per-message: at most contactCreationMaxPerMessage new contacts per email
   *   - Per-hour:    at most contactCreationMaxPerHour new contacts per sliding window
   * When a limit is hit, remaining participants are skipped and a CEO
   * notification is sent (deduplicated to one per limit type per hour).
   */
  private async extractParticipants(
    participants: Array<{ email: string; name?: string; role: string }>,
    emailSubject: string,
    emailSender: string,
  ): Promise<void> {
    const { contactService, logger, selfEmail, contactCreationMaxPerMessage, contactCreationMaxPerHour } = this.config;

    // Reset the hourly window if it has expired
    const now = Date.now();
    if (now - this.hourlyWindowStart > 3_600_000) {
      this.hourlyContactCount = 0;
      this.hourlyWindowStart = now;
    }

    let createdThisMessage = 0;
    let skippedThisMessage = 0;
    let hitPerMessageCap = false;
    let hitPerHourCap = false;

    for (const p of participants) {
      // Don't create a contact for ourselves — case-insensitive to guard against
      // inconsistent casing from mail servers (e.g. "User@Example.com" vs "user@example.com").
      if (p.email.toLowerCase() === selfEmail.toLowerCase()) continue;

      try {
        // Check if this email is already linked to a contact
        const existing = await contactService.resolveByChannelIdentity('email', p.email);
        if (existing) continue;

        // Check per-message cap (existing contacts don't count — only new creations)
        if (createdThisMessage >= contactCreationMaxPerMessage) {
          skippedThisMessage++;
          if (!hitPerMessageCap) {
            hitPerMessageCap = true;
            logger.warn(
              { email: p.email, cap: contactCreationMaxPerMessage, emailSubject },
              'Contact auto-creation per-message cap reached — skipping remaining participants',
            );
          }
          continue;
        }

        // Check per-hour cap
        if (this.hourlyContactCount >= contactCreationMaxPerHour) {
          skippedThisMessage++;
          if (!hitPerHourCap) {
            hitPerHourCap = true;
            logger.warn(
              { email: p.email, cap: contactCreationMaxPerHour, hourlyCount: this.hourlyContactCount },
              'Contact auto-creation per-hour cap reached — skipping remaining participants',
            );
          }
          continue;
        }

        // Create a new contact and link the email identity to it.
        // Display name sanitization happens inside createContact() (see issue #39).
        // We pass the email as fallbackDisplayName so that if the participant name
        // sanitizes to empty (e.g., pure injection text), the email is used instead.
        const contact = await contactService.createContact({
          displayName: p.name || p.email,
          fallbackDisplayName: p.email,
          source: 'email_participant',
          status: 'provisional',
        });
        await contactService.linkIdentity({
          contactId: contact.id,
          channel: 'email',
          channelIdentifier: p.email,
          source: 'email_participant',
        });

        createdThisMessage++;
        this.hourlyContactCount++;
        logger.info({ email: p.email, name: p.name }, 'Auto-created contact from email participant');
      } catch (err) {
        // Warn rather than error — participant auto-creation is best-effort.
        // The inbound message will still be published even if contact creation fails.
        logger.warn({ err, email: p.email }, 'Failed to auto-create contact from email participant');
      }
    }

    // Send a deduplicated CEO notification if any rate limit was hit
    if (skippedThisMessage > 0) {
      await this.notifyRateLimitHit(
        hitPerMessageCap ? 'per_message' : 'per_hour',
        skippedThisMessage,
        emailSubject,
        emailSender,
      );
    }
  }
```

- [ ] **Step 2: Add the `notifyRateLimitHit` helper method**

Add this method to the `EmailAdapter` class, after `extractParticipants`:

```typescript
  /**
   * Send a deduplicated CEO notification when contact auto-creation rate limits
   * are hit. At most one notification per limit type per hour to avoid notification
   * spam during a sustained flood.
   */
  private async notifyRateLimitHit(
    limitType: 'per_message' | 'per_hour',
    skippedCount: number,
    emailSubject: string,
    emailSender: string,
  ): Promise<void> {
    const { outboundGateway, logger, ceoEmail } = this.config;
    const now = Date.now();

    // Dedup: skip if we already notified for this limit type within the last hour
    const lastNotified = limitType === 'per_message' ? this.lastNotifiedPerMessage : this.lastNotifiedPerHour;
    if (now - lastNotified < 3_600_000) {
      logger.debug({ limitType, skippedCount }, 'Rate-limit notification suppressed (already sent within the hour)');
      return;
    }

    if (!ceoEmail) {
      logger.warn({ limitType, skippedCount }, 'Contact rate-limit hit but ceoEmail not configured — cannot notify');
      return;
    }

    // Update dedup timestamp
    if (limitType === 'per_message') {
      this.lastNotifiedPerMessage = now;
    } else {
      this.lastNotifiedPerHour = now;
    }

    const limitLabel = limitType === 'per_message'
      ? `per-message limit (${this.config.contactCreationMaxPerMessage})`
      : `per-hour limit (${this.config.contactCreationMaxPerHour})`;

    try {
      await outboundGateway.sendNotification({
        notificationType: 'contact_rate_limited',
        ceoEmail,
        subject: `Contact auto-creation rate limit reached (${limitLabel})`,
        body: [
          `Contact auto-creation was throttled on the ${this.config.accountId} email account.`,
          '',
          `Limit hit: ${limitLabel}`,
          `Participants skipped: ${skippedCount}`,
          `Triggering email subject: ${emailSubject}`,
          `Triggering email sender: ${emailSender}`,
          '',
          'Skipped participants will be auto-created if they send an email directly.',
          'If this is unexpected, check for spam activity on this account.',
        ].join('\n'),
      });
    } catch (err) {
      // Non-fatal — the rate limit is already enforced, this is just a notification
      logger.warn({ err, limitType, skippedCount }, 'Failed to send contact rate-limit notification');
    }
  }
```

- [ ] **Step 3: Update the `extractParticipants` call site to pass subject and sender**

In `src/channels/email/email-adapter.ts`, update the call to `extractParticipants` in `poll()` (around line 237) to pass the email subject and sender:

Change:
```typescript
            await this.extractParticipants(converted.metadata.participants);
```

To:
```typescript
            await this.extractParticipants(
              converted.metadata.participants,
              converted.metadata.subject,
              converted.senderId,
            );
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit test -- tests/unit/channels/email/email-adapter.test.ts`

Expected: All tests pass — both existing tests and the 7 new rate-limiting tests.

- [ ] **Step 5: Run the full test suite**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit test`

Expected: All tests pass (including any bus event tests that reference the notification type).

- [ ] **Step 6: Run typecheck**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit run typecheck`

Expected: Clean pass.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit add src/channels/email/email-adapter.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit commit -m "feat: implement contact auto-creation rate limiting in email adapter (#36)"
```

---

## Task 6: Update CHANGELOG and final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry**

Add under `## [Unreleased]` in the appropriate section (create `### Security` if it doesn't exist, otherwise use `### Added`):

```markdown
### Security

- **Contact auto-creation rate limiting** — email participant contact auto-creation is now capped at 10 per message and 100 per hour (configurable in `default.yaml`). CEO is notified via email when limits are hit. Prevents spam-campaign flooding of the contacts table (#36).
```

- [ ] **Step 2: Run the full test suite one final time**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit test`

Expected: All tests pass.

- [ ] **Step 3: Run typecheck one final time**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit run typecheck`

Expected: Clean pass.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-rate-limit commit -m "docs: add changelog entry for contact rate limiting (#36)"
```

---

## Notes for the implementing agent

- **`vi.useFakeTimers()`**: The "resets hourly window after 1 hour" test uses `vi.advanceTimersByTime()`. If the test file doesn't already use fake timers, you'll need to add `vi.useFakeTimers()` in a `beforeEach` for that describe block and `vi.useRealTimers()` in `afterEach`. Check whether `Date.now()` in the adapter uses the vitest-faked clock — it does when `vi.useFakeTimers({ shouldAdvanceTime: true })` is used.
- **`poll()` is private**: The window-reset test needs to trigger a second poll manually. Access via `(adapter as unknown as { poll(): Promise<void> }).poll()` — same escape hatch pattern used elsewhere in the test suite. If this doesn't work, an alternative is to make the poll timer interval small and use `vi.advanceTimersByTime()` to trigger it.
- **Accessing `metadata.subject`**: The `convertNylasMessage` return type puts `subject` inside `metadata`. Verify the field name matches at runtime — the call site already destructures `converted.metadata.subject`.
- **`sendNotification` mock**: The existing test mocks don't include `sendNotification` on `outboundGateway`. The notification tests add it inline via `(mocks.outboundGateway as Record<string, unknown>).sendNotification = vi.fn()`. If this causes type issues, add it to the `createMocks` factory instead.
