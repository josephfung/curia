# CEO Gate Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exempt CEO-bound outbound messages from the autonomy gate so the agent is never muted to its principal, fixing #454 (phantom pending rows after approval/denial).

**Architecture:** Add a recipient-based CEO check in the outbound gateway's autonomy gate (Step 0), alongside existing `humanApproved` and `isSystemNotification` bypasses. Both `send()` and `sendEmailDraft()` get the check. A new `ceoSignalNumber` config field mirrors the existing `ceoEmail` pattern for Signal. File a cleanup issue for the per-channel config proliferation.

**Tech Stack:** TypeScript/ESM, Vitest, pino

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-gate-bypass` (branch: `fix/ceo-gate-bypass`)

---

### Task 1: Add `ceoSignalNumber` to Config

**Files:**
- Modify: `src/config.ts:112-118` (type + parsing)

- [ ] **Step 1: Add config field and env var parsing**

In `src/config.ts`, add `ceoSignalNumber` to the config interface (after `ceoPrimaryEmail` at line 112):

```typescript
  // CEO's Signal phone number in E.164 format (e.g. "+14155551234").
  // Used by OutboundGateway to exempt CEO-bound Signal messages from the autonomy gate.
  ceoSignalNumber: string | undefined;
```

And in `loadConfig()` (after `ceoPrimaryEmail` parsing at line 834):

```typescript
    ceoSignalNumber: process.env.CEO_SIGNAL_NUMBER?.trim() || undefined,
```

- [ ] **Step 2: Commit**

```
git add src/config.ts
git commit -m "feat: add CEO_SIGNAL_NUMBER env var to config"
```

---

### Task 2: Add `ceoSignalNumber` to OutboundGatewayConfig and Constructor

**Files:**
- Modify: `src/skills/outbound-gateway.ts:108-244` (config interface + private field + constructor)

- [ ] **Step 1: Add config field**

In `OutboundGatewayConfig` (after `ceoEmail` at line 151), add:

```typescript
  /**
   * CEO's Signal phone number in E.164 format — used by the autonomy gate to
   * exempt CEO-bound Signal messages. Same pattern as ceoEmail for email.
   * Optional — when absent, the Signal CEO bypass does not fire.
   */
  ceoSignalNumber?: string;
```

- [ ] **Step 2: Add private field and wire in constructor**

After `private readonly ceoEmail: string;` (line 226), add:

```typescript
  private readonly ceoSignalNumber: string;
```

In the constructor (after `this.ceoEmail = config.ceoEmail ?? '';` at line 240), add:

```typescript
    this.ceoSignalNumber = config.ceoSignalNumber ?? '';
```

- [ ] **Step 3: Commit**

```
git add src/skills/outbound-gateway.ts
git commit -m "feat: add ceoSignalNumber to OutboundGatewayConfig"
```

---

### Task 3: Write Failing Tests for CEO Bypass in `send()`

**Files:**
- Modify: `tests/unit/skills/outbound-gateway.test.ts`

- [ ] **Step 1: Write the test block**

Add a new `describe` block after the `isSystemNotification option on send()` block (after line ~1740). Follow the exact patterns from the `humanApproved` and `isSystemNotification` test blocks:

```typescript
// ---------------------------------------------------------------------------
// CEO recipient bypass on send() — agent-to-principal communication bypasses
// the autonomy gate. All other safety checks (blocked-contact, content filter)
// still run. See design: docs/wip/2026-05-05-ceo-gate-bypass-design.md
// ---------------------------------------------------------------------------

describe('CEO recipient bypass on send()', () => {
  it('bypasses the autonomy gate when recipient is the CEO email and score < 70', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65), // below 70 — would normally block
    });

    const result = await gateway.send(
      { channel: 'email', to: 'ceo@example.com', subject: 'Status update', body: 'All done.' },
    );

    expect(result.success).toBe(true);
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
    // autonomy.send_blocked must NOT fire — we bypassed the gate
    const publishedEvents = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map(([, evt]: [string, BusEvent]) => evt.type);
    expect(publishedEvents).not.toContain('autonomy.send_blocked');
  });

  it('bypasses the autonomy gate for case-insensitive CEO email match', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'CEO@Example.COM',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'ceo@example.com', subject: 'Hello', body: 'Hi!' },
    );

    expect(result.success).toBe(true);
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('bypasses the autonomy gate when Signal recipient is the CEO number', async () => {
    const mocks = createMocks();
    const signalClient = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+10000000000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoSignalNumber: '+14155551234',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'signal', recipient: '+14155551234', message: 'Status update' },
    );

    expect(result.success).toBe(true);
    expect(signalClient.send).toHaveBeenCalledOnce();
  });

  it('does NOT bypass for non-CEO recipients — gate still blocks', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'stranger@example.com', subject: 'Hello', body: 'Hi!' },
    );

    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('still enforces the content filter when recipient is CEO', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'test-rule', detail: 'blocked in test' }],
    });
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'ceo@example.com', subject: 'Hello', body: 'Hi!' },
    );

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Content blocked by filter');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not bypass when ceoEmail is not configured', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      // ceoEmail intentionally omitted
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'anyone@example.com', subject: 'Hello', body: 'Hi!' },
    );

    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /path/to/worktree test tests/unit/skills/outbound-gateway.test.ts`

Expected: 4 of 6 tests fail (the two "still blocks non-CEO" and "not configured" tests should already pass since there's no bypass yet; the 4 bypass tests should fail).

- [ ] **Step 3: Commit failing tests**

```
git add tests/unit/skills/outbound-gateway.test.ts
git commit -m "test: add failing tests for CEO recipient bypass in outbound gateway"
```

---

### Task 4: Implement CEO Bypass in `send()`

**Files:**
- Modify: `src/skills/outbound-gateway.ts:324-332`

- [ ] **Step 1: Add the CEO recipient check**

Add a new `else if` branch after the `isSystemNotification` check (line 331) and before the default autonomy gate (line 332). The new branch goes between lines 331 and 332:

```typescript
    } else if (this.autonomyService && this.isCeoRecipient(request)) {
      // Agent-to-principal communication — the autonomy gate must not silence
      // the agent's ability to communicate with its oversight authority. Gating
      // CEO-bound messages reduces oversight rather than improving it.
      // All other safety checks (blocked-contact, content filter, PII redaction)
      // still run below.
      this.log.info(
        { channel: request.channel },
        'outbound-gateway: autonomy gate skipped — recipient is CEO (agent-to-principal communication)',
      );
    } else if (this.autonomyService) {
```

- [ ] **Step 2: Add the `isCeoRecipient` private helper**

Add after the `sendNotification()` method (around line 756):

```typescript
  /**
   * Check whether the outbound request is addressed to the CEO.
   * Used by the autonomy gate to exempt agent-to-principal communications.
   *
   * Email: case-insensitive comparison against configured ceoEmail.
   * Signal: exact comparison against configured ceoSignalNumber (E.164 format).
   *
   * Returns false when the relevant CEO identifier is not configured — the bypass
   * is inert rather than broken, matching the pattern of other optional config fields.
   */
  private isCeoRecipient(request: OutboundSendRequest): boolean {
    if (request.channel === 'email') {
      return this.ceoEmail !== '' && request.to.toLowerCase() === this.ceoEmail.toLowerCase();
    }
    if (request.channel === 'signal' && 'recipient' in request && request.recipient) {
      return this.ceoSignalNumber !== '' && request.recipient === this.ceoSignalNumber;
    }
    return false;
  }
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree test tests/unit/skills/outbound-gateway.test.ts`

Expected: All tests in the "CEO recipient bypass on send()" block pass.

- [ ] **Step 4: Commit**

```
git add src/skills/outbound-gateway.ts
git commit -m "feat: add CEO recipient bypass to outbound gateway autonomy gate"
```

---

### Task 5: Write Failing Test and Implement CEO Bypass in `sendEmailDraft()`

The `sendEmailDraft()` method (line 991) has its own autonomy gate that also needs the CEO bypass. The draft recipient is in `draftMeta.recipientEmail`.

**Files:**
- Modify: `tests/unit/skills/outbound-gateway.test.ts`
- Modify: `src/skills/outbound-gateway.ts:1000-1005`

- [ ] **Step 1: Write the failing test**

Add inside the existing `sendEmailDraft()` describe block (near the other autonomy gate tests around line 1170):

```typescript
  it('bypasses the autonomy gate when draft recipient is the CEO email and score < 70', async () => {
    const { gateway, nylasClient } = makeGateway({
      autonomyService: makeAutonomyService(65), // below 70 — would normally block
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'curia', {
      recipientEmail: 'ceo@example.com',
      body: 'Hi CEO!',
      subject: 'Update',
    });

    expect(result.success).toBe(true);
    expect(nylasClient.sendDraft).toHaveBeenCalledWith(DRAFT_ID);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree test tests/unit/skills/outbound-gateway.test.ts`

Expected: The new test fails (sendEmailDraft blocks at score 65).

- [ ] **Step 3: Add CEO bypass to `sendEmailDraft()`**

In `sendEmailDraft()`, add a new branch after the `humanApproved` check (line 1004) and before `} else if (this.autonomyService) {` (line 1005):

```typescript
    } else if (this.autonomyService && this.ceoEmail !== '' && draftMeta.recipientEmail.toLowerCase() === this.ceoEmail.toLowerCase()) {
      // Agent-to-principal: CEO-bound draft sends bypass the autonomy gate.
      // Same rationale as the send() CEO bypass — see isCeoRecipient() comment.
      this.log.info(
        { draftId },
        'outbound-gateway: autonomy gate skipped — draft recipient is CEO (agent-to-principal communication)',
      );
    } else if (this.autonomyService) {
```

Note: `sendEmailDraft()` is email-only, so we can directly compare `draftMeta.recipientEmail` against `this.ceoEmail` instead of calling `isCeoRecipient()` (which takes an `OutboundSendRequest`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree test tests/unit/skills/outbound-gateway.test.ts`

Expected: All outbound gateway tests pass.

- [ ] **Step 5: Commit**

```
git add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git commit -m "feat: add CEO recipient bypass to sendEmailDraft() autonomy gate"
```

---

### Task 6: Wire `ceoSignalNumber` Through `src/index.ts`

**Files:**
- Modify: `src/index.ts:715-733`

- [ ] **Step 1: Add `ceoSignalNumber` to the OutboundGateway constructor call**

In `src/index.ts`, where the `OutboundGateway` is instantiated (line 715), add `ceoSignalNumber` to the config object (after the `ceoEmail` line at 726):

```typescript
      ceoSignalNumber: config.ceoSignalNumber,
```

- [ ] **Step 2: Run the full test suite**

Run: `npm --prefix /path/to/worktree test`

Expected: All tests pass. No regressions.

- [ ] **Step 3: Commit**

```
git add src/index.ts
git commit -m "feat: wire ceoSignalNumber from config to OutboundGateway"
```

---

### Task 7: Update CHANGELOG and File Cleanup Issue

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry**

Under `## [Unreleased]`, add to the `### Fixed` section:

```markdown
- **CEO-bound messages bypass autonomy gate** — outbound messages addressed to the CEO (email or Signal) now skip the autonomy gate in `OutboundGateway.send()` and `sendEmailDraft()`. The autonomy gate exists to prevent autonomous communication with external parties; gating agent-to-principal messages caused the agent to go mute at low scores and created phantom `pending_approval` rows when the coordinator tried to confirm approval/denial actions. All other safety checks (content filter, PII redaction, blocked-contact) still apply. Fixes #454.
```

- [ ] **Step 2: File cleanup issue for CeoIdentity refactor**

Create a GitHub issue to track the config proliferation debt. The current approach adds `ceoSignalNumber` alongside `ceoEmail` as separate config fields. Each new channel would require another field. The cleanup issue should propose refactoring to a `CeoIdentity` map (channel → identifier).

Query the repo's labels first and apply all applicable ones. Include acceptance criteria and a size label.

- [ ] **Step 3: Commit**

```
git add CHANGELOG.md
git commit -m "docs: add changelog entry for CEO gate bypass and file cleanup issue"
```

---

### Task 8: Run Full Test Suite and Typecheck

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

Run: `npm --prefix /path/to/worktree run typecheck`

Expected: Clean — no type errors.

- [ ] **Step 2: Run full test suite**

Run: `npm --prefix /path/to/worktree test`

Expected: All tests pass with no regressions.

- [ ] **Step 3: Verify migration check**

Run: `ls /path/to/worktree/src/db/migrations/ | sort | tail -5`

Expected: No new migrations (this change is code-only). Verify no prefix collisions from the rebase.
