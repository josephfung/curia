# signal-send Skill + Signal Group Trust Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `signal-send` skill so the coordinator can proactively send Signal messages (1:1 and group), with a group trust model that verifies all group members are known contacts before engaging.

**Architecture:** Thin skill layer over the existing `OutboundGateway` Signal path, with a shared `checkGroupMemberTrust()` helper used by both the skill (outbound) and `SignalAdapter` (inbound). Group trust check calls `listGroups()` on `SignalRpcClient` to enumerate members, then resolves each phone against `ContactService`. Unknown-member groups are held with a CEO email notification.

**Tech Stack:** TypeScript/ESM, Vitest, signal-cli JSON-RPC, existing `OutboundGateway` + `ContactService` + `SignalRpcClient`.

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send`

---

### Task 1: Add group types to `types.ts`

**Files:**
- Modify: `src/channels/signal/types.ts`

No test needed — types-only change.

- [ ] **Step 1: Add `SignalGroupMember` and `SignalGroupDetails` types**

Open `src/channels/signal/types.ts`. At the end of the outbound param types section (after the `JsonRpcMessage` union, around line 204), add:

```typescript
// ---------------------------------------------------------------------------
// Group types — for listGroups RPC call
// ---------------------------------------------------------------------------

/**
 * A single member entry from signal-cli's listGroups response.
 * Identity anchor is `number` (E.164 phone) — `uuid` is present but not used
 * for trust decisions since UUIDs can rotate if an account re-registers.
 */
export interface SignalGroupMember {
  /** E.164 phone number, e.g. "+14155552671" */
  number: string;
  uuid?: string;
}

/**
 * Group details as returned by signal-cli's `listGroups` JSON-RPC method.
 * `name` is user-defined and NOT trusted for identity — only `members[].number`
 * values are meaningful for trust checks.
 */
export interface SignalGroupDetails {
  /** Base64-encoded Signal group V2 ID — stable identifier for the group */
  id: string;
  /** User-defined group display name — do not use for identity */
  name: string;
  /** Current group members (joined) */
  members: SignalGroupMember[];
  /** Invited but not yet joined */
  pendingMembers: SignalGroupMember[];
  isMember: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send add src/channels/signal/types.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send commit -m "feat: add SignalGroupMember and SignalGroupDetails types"
```

---

### Task 2: Add `listGroups()` to `SignalRpcClient`

**Files:**
- Modify: `src/channels/signal/signal-rpc-client.ts`
- Modify: `tests/unit/channels/signal/signal-rpc-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `tests/unit/channels/signal/signal-rpc-client.test.ts`. Add these two tests inside the existing `describe('SignalRpcClient', ...)` block, after the last existing test:

```typescript
it('resolves with an array of group details on listGroups success', async () => {
  const groups = [
    {
      id: 'grpABC==',
      name: 'Test Group',
      members: [{ number: '+14155551234' }],
      pendingMembers: [],
      isMember: true,
    },
  ];

  const listPromise = client.listGroups();

  await new Promise((r) => setTimeout(r, 20));
  const req = mock.popRequest();
  expect(req).toBeDefined();
  expect(req!.method).toBe('listGroups');
  expect(req!.params).toMatchObject({ account: '+15555550000' });
  mock.respondSuccess(req!.id, groups);

  await expect(listPromise).resolves.toEqual(groups);
});

it('rejects if signal-cli returns an error for listGroups', async () => {
  const listPromise = client.listGroups();

  await new Promise((r) => setTimeout(r, 20));
  const req = mock.popRequest();
  expect(req).toBeDefined();
  mock.respondError(req!.id, -1, 'Not registered');

  await expect(listPromise).rejects.toThrow('Not registered');
});
```

- [ ] **Step 2: Run and confirm the tests fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- tests/unit/channels/signal/signal-rpc-client.test.ts
```

Expected: two new tests fail with `client.listGroups is not a function`.

- [ ] **Step 3: Add `listGroups()` to `SignalRpcClient`**

Open `src/channels/signal/signal-rpc-client.ts`.

Add `SignalGroupDetails` to the import from `./types.js`:

```typescript
import type {
  SignalSendParams,
  SignalReadReceiptParams,
  SignalGroupDetails,
  JsonRpcRequest,
  JsonRpcMessage,
  SignalReceiveParams,
} from './types.js';
```

After the `sendReadReceipt()` method (around line 161), add:

```typescript
/**
 * List all Signal groups the account is currently a member of.
 * Returns the full membership list including phone numbers for each member.
 * Used by the group trust check to verify all members before engaging.
 */
async listGroups(): Promise<SignalGroupDetails[]> {
  const result = await this.call('listGroups', { account: this.config.accountNumber });
  // signal-cli returns an array; guard against null in case of an empty result
  return (result as SignalGroupDetails[]) ?? [];
}
```

- [ ] **Step 4: Run and confirm the tests pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- tests/unit/channels/signal/signal-rpc-client.test.ts
```

Expected: all tests pass including the two new ones.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send add src/channels/signal/signal-rpc-client.ts tests/unit/channels/signal/signal-rpc-client.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send commit -m "feat: add listGroups() to SignalRpcClient"
```

---

### Task 3: Create `group-trust.ts` helper

**Files:**
- Create: `src/channels/signal/group-trust.ts`
- Create: `tests/unit/channels/signal/group-trust.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/channels/signal/group-trust.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { checkGroupMemberTrust } from '../../../../src/channels/signal/group-trust.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';

/**
 * Build a ContactService mock that returns the provided contact record
 * for the given phone numbers, and null for any other identifier.
 */
function makeContactService(
  responses: Record<string, { contactId: string; status: string } | null>,
): ContactService {
  return {
    resolveByChannelIdentity: vi.fn().mockImplementation(
      (_channel: string, identifier: string) =>
        Promise.resolve(responses[identifier] ?? null),
    ),
  } as unknown as ContactService;
}

describe('checkGroupMemberTrust', () => {
  it('returns trusted:true when all members are verified contacts', async () => {
    const svc = makeContactService({
      '+14155551234': { contactId: 'c1', status: 'active' },
      '+14165559999': { contactId: 'c2', status: 'confirmed' },
    });

    const result = await checkGroupMemberTrust(['+14155551234', '+14165559999'], svc);

    expect(result).toEqual({ trusted: true, unknownMembers: [], blockedMembers: [] });
  });

  it('surfaces a provisional contact as unknownMember', async () => {
    const svc = makeContactService({
      '+14155551234': { contactId: 'c1', status: 'provisional' },
    });

    const result = await checkGroupMemberTrust(['+14155551234'], svc);

    expect(result.trusted).toBe(false);
    expect(result.unknownMembers).toEqual(['+14155551234']);
    expect(result.blockedMembers).toEqual([]);
  });

  it('surfaces a null contact (no record) as unknownMember', async () => {
    const svc = makeContactService({}); // all lookups return null

    const result = await checkGroupMemberTrust(['+14155551234'], svc);

    expect(result.trusted).toBe(false);
    expect(result.unknownMembers).toEqual(['+14155551234']);
    expect(result.blockedMembers).toEqual([]);
  });

  it('surfaces a blocked contact as blockedMember', async () => {
    const svc = makeContactService({
      '+14155551234': { contactId: 'c1', status: 'blocked' },
    });

    const result = await checkGroupMemberTrust(['+14155551234'], svc);

    expect(result.trusted).toBe(false);
    expect(result.unknownMembers).toEqual([]);
    expect(result.blockedMembers).toEqual(['+14155551234']);
  });

  it('surfaces both unknown and blocked members in a mixed group', async () => {
    const svc = makeContactService({
      '+14155551234': { contactId: 'c1', status: 'provisional' },
      '+14165559999': { contactId: 'c2', status: 'blocked' },
    });

    const result = await checkGroupMemberTrust(['+14155551234', '+14165559999'], svc);

    expect(result.trusted).toBe(false);
    expect(result.unknownMembers).toEqual(['+14155551234']);
    expect(result.blockedMembers).toEqual(['+14165559999']);
  });

  it('returns trusted:true for an empty member list (edge case: empty group)', async () => {
    const svc = makeContactService({});

    const result = await checkGroupMemberTrust([], svc);

    expect(result).toEqual({ trusted: true, unknownMembers: [], blockedMembers: [] });
  });
});
```

- [ ] **Step 2: Run and confirm the tests fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- tests/unit/channels/signal/group-trust.test.ts
```

Expected: all tests fail with module not found.

- [ ] **Step 3: Implement `group-trust.ts`**

Create `src/channels/signal/group-trust.ts`:

```typescript
// src/channels/signal/group-trust.ts
//
// Shared trust-checking logic for Signal group conversations.
//
// Signal's identity anchor is the phone number — cryptographically bound via SIM
// + E2E encryption. Display names are entirely user-defined and carry no trust weight.
//
// A group is trusted iff every member's phone number resolves to a verified
// (non-provisional, non-blocked) contact. A single unknown or blocked member renders
// the entire group untrusted. This is intentionally conservative: a CEO assistant
// participating in a group with unknown parties risks leaking context or being
// manipulated by social engineering.
//
// Callers are responsible for excluding Nathan's own phone number from the list
// before calling — the gateway does this (getSignalGroupMembers) and the adapter
// does it inline.
//
// Used by:
//   - SignalAdapter (inbound): gates whether a group message is published to the bus
//   - signal-send handler (outbound): gates whether a proactive group send proceeds

import type { ContactService } from '../../contacts/contact-service.js';

export interface GroupTrustResult {
  /** True iff all members are verified (non-provisional, non-blocked) contacts. */
  trusted: boolean;
  /** E.164 numbers with no contact record or with provisional status. */
  unknownMembers: string[];
  /** E.164 numbers of explicitly blocked contacts. */
  blockedMembers: string[];
}

/**
 * Check the trust level of a set of Signal group member phone numbers.
 *
 * Each phone is resolved against the contact system:
 *   - null contact or status 'provisional' → unknownMember
 *   - status 'blocked'                     → blockedMember
 *   - any other status (active, confirmed)  → trusted
 *
 * @param memberPhones - E.164 numbers of group members (own account already excluded)
 * @param contactService - ContactService for resolving phone numbers to contacts
 */
export async function checkGroupMemberTrust(
  memberPhones: string[],
  contactService: ContactService,
): Promise<GroupTrustResult> {
  const unknownMembers: string[] = [];
  const blockedMembers: string[] = [];

  for (const phone of memberPhones) {
    const contact = await contactService.resolveByChannelIdentity('signal', phone);
    if (!contact || contact.status === 'provisional') {
      unknownMembers.push(phone);
    } else if (contact.status === 'blocked') {
      blockedMembers.push(phone);
    }
    // active / confirmed / any other non-provisional, non-blocked status → trusted
  }

  return {
    trusted: unknownMembers.length === 0 && blockedMembers.length === 0,
    unknownMembers,
    blockedMembers,
  };
}
```

- [ ] **Step 4: Run and confirm the tests pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- tests/unit/channels/signal/group-trust.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send add src/channels/signal/group-trust.ts tests/unit/channels/signal/group-trust.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send commit -m "feat: add checkGroupMemberTrust() helper"
```

---

### Task 4: Add `getSignalGroupMembers()` to `OutboundGateway`

**Files:**
- Modify: `src/skills/outbound-gateway.ts`
- Modify: `tests/unit/skills/outbound-gateway.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `tests/unit/skills/outbound-gateway.test.ts`. Add a `signalClient` mock factory and three new tests in a new `describe` block after the existing tests:

```typescript
// Add at top of file alongside the other mock factories
function makeSignalClient(groups: import('../../../src/channels/signal/types.js').SignalGroupDetails[] = []) {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendReadReceipt: vi.fn().mockResolvedValue(undefined),
    listGroups: vi.fn().mockResolvedValue(groups),
  };
}

// Add this describe block at the end of the file
describe('OutboundGateway.getSignalGroupMembers', () => {
  it('returns member phones excluding own number', async () => {
    const signalClient = makeSignalClient([
      {
        id: 'grpABC==',
        name: 'Test Group',
        members: [
          { number: '+14155551234' },
          { number: '+15555550000' }, // Nathan's own number — must be excluded
          { number: '+14165559999' },
        ],
        pendingMembers: [],
        isMember: true,
      },
    ]);

    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      logger: mocks.logger,
    });

    const members = await gateway.getSignalGroupMembers('grpABC==');
    expect(members).toEqual(['+14155551234', '+14165559999']);
    expect(members).not.toContain('+15555550000');
  });

  it('throws if the group is not found', async () => {
    const signalClient = makeSignalClient([]); // empty group list

    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      logger: mocks.logger,
    });

    await expect(gateway.getSignalGroupMembers('nonexistent==')).rejects.toThrow('group not found');
  });

  it('throws if Signal client is not configured', async () => {
    const gateway = new OutboundGateway({
      nylasClient: mocks.nylasClient,
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    await expect(gateway.getSignalGroupMembers('grpABC==')).rejects.toThrow('Signal client not configured');
  });
});
```

- [ ] **Step 2: Run and confirm the tests fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- tests/unit/skills/outbound-gateway.test.ts
```

Expected: three new tests fail with `gateway.getSignalGroupMembers is not a function`.

- [ ] **Step 3: Implement `getSignalGroupMembers()` in `OutboundGateway`**

Open `src/skills/outbound-gateway.ts`. Add this method after `listEmailMessages()` (around line 310, before the private helpers section):

```typescript
/**
 * Retrieve the E.164 phone numbers of all current (non-pending) members of a
 * Signal group. Nathan's own phone number is excluded so callers can pass the
 * result directly to `checkGroupMemberTrust()` without filtering.
 *
 * Throws if:
 *   - Signal client is not configured
 *   - The group is not found in the account's group list
 *   - The signal-cli RPC call fails
 */
async getSignalGroupMembers(groupId: string): Promise<string[]> {
  if (!this.signalClient) {
    throw new Error('outbound-gateway: Signal client not configured');
  }

  const groups = await this.signalClient.listGroups();
  const group = groups.find((g) => g.id === groupId);

  if (!group) {
    // Log only the group ID presence — not the ID value itself (may be sensitive).
    this.log.warn({ hasGroupId: !!groupId }, 'outbound-gateway: getSignalGroupMembers — group not found');
    throw new Error(`outbound-gateway: group not found: ${groupId}`);
  }

  // Exclude Nathan's own number — it would otherwise resolve to Curia's own contact
  // record and could skew trust checks (Curia trusts itself, but it shouldn't count
  // as a "verified member" of the group for trust-check purposes).
  return group.members
    .map((m) => m.number)
    .filter((phone) => phone !== this.signalPhoneNumber);
}
```

- [ ] **Step 4: Run and confirm the tests pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- tests/unit/skills/outbound-gateway.test.ts
```

Expected: all tests pass including the three new ones.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send commit -m "feat: add getSignalGroupMembers() to OutboundGateway"
```

---

### Task 5: Add group trust check to `SignalAdapter`

**Files:**
- Modify: `src/channels/signal/signal-adapter.ts`
- Modify: `src/index.ts`
- Modify: `tests/unit/channels/signal/signal-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `tests/unit/channels/signal/signal-adapter.test.ts`.

First, update `makeMockRpcClient()` to add `listGroups` (default returns empty array so existing tests are unaffected):

```typescript
function makeMockRpcClient() {
  const emitter = new EventEmitter() as EventEmitter & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    sendReadReceipt: ReturnType<typeof vi.fn>;
    listGroups: ReturnType<typeof vi.fn>;
    simulateMessage: (envelope: SignalEnvelope) => void;
  };

  emitter.connect = vi.fn().mockReturnValue(undefined);
  emitter.disconnect = vi.fn().mockResolvedValue(undefined);
  emitter.send = vi.fn().mockResolvedValue(undefined);
  emitter.sendReadReceipt = vi.fn().mockResolvedValue(undefined);
  emitter.listGroups = vi.fn().mockResolvedValue([]);
  emitter.simulateMessage = (envelope) => emitter.emit('message', envelope);

  return emitter as unknown as SignalRpcClient & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    sendReadReceipt: ReturnType<typeof vi.fn>;
    listGroups: ReturnType<typeof vi.fn>;
    simulateMessage: (envelope: SignalEnvelope) => void;
  };
}
```

Next, update `makeMockGateway()` to add `getSignalGroupMembers` (default throws "not configured"):

```typescript
function makeMockGateway() {
  return {
    send: vi.fn().mockResolvedValue({ success: true }),
    getSignalGroupMembers: vi.fn().mockRejectedValue(new Error('Signal client not configured')),
  } as unknown as OutboundGateway;
}
```

Next, add `ceoEmail: 'ceo@example.com'` to all four `new SignalAdapter({...})` calls in the existing `beforeEach` and inline test adapters. The `beforeEach` adapter becomes:

```typescript
adapter = new SignalAdapter({
  bus,
  logger,
  rpcClient,
  outboundGateway: gateway,
  contactService,
  phoneNumber: PHONE,
  ceoEmail: 'ceo@example.com',
});
```

Do the same for the inline adapters in the `'sends a read receipt'`, `'does NOT send a read receipt for a provisional sender'`, `'does NOT send a read receipt for a blocked sender'`, `'does NOT send a read receipt for a group message'`, and `'auto-creates a contact for an unknown sender'` tests — each creates its own `SignalAdapter` and needs `ceoEmail: 'ceo@example.com'` added.

Then add a helper for building group envelopes and the four new tests at the end of the describe block:

```typescript
function makeGroupEnvelope(groupId: string, overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return makeEnvelope({
    dataMessage: {
      timestamp: 1700000000000,
      message: 'Group message',
      expiresInSeconds: 0,
      viewOnce: false,
      groupInfo: { groupId, type: 'DELIVER' },
    },
    ...overrides,
  });
}

describe('Group trust check', () => {
  const GROUP_ID = 'grpABC==';

  it('publishes an inbound.message for a group with all verified members', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    // rpcClient.listGroups returns this group with one member
    (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: GROUP_ID, name: 'G', members: [{ number: '+14155551234' }], pendingMembers: [], isMember: true },
    ]);
    // contactService resolves the member as active
    (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(
      { contactId: 'c1', status: 'active' },
    );

    rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
    await new Promise((r) => setTimeout(r, 30));

    expect(published).toHaveLength(1);
  });

  it('holds a group message and emails the CEO when a member is unknown', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: GROUP_ID, name: 'G', members: [{ number: '+14155551234' }], pendingMembers: [], isMember: true },
    ]);
    // Member has no contact record
    (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
    await new Promise((r) => setTimeout(r, 30));

    expect(published).toHaveLength(0);
    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: 'ceo@example.com',
        subject: 'Signal group message held — member verification needed',
      }),
    );
  });

  it('drops a group message silently when a member is blocked (no email, no publish)', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: GROUP_ID, name: 'G', members: [{ number: '+14155551234' }], pendingMembers: [], isMember: true },
    ]);
    (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(
      { contactId: 'c1', status: 'blocked' },
    );

    rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
    await new Promise((r) => setTimeout(r, 30));

    expect(published).toHaveLength(0);
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('treats a group as untrusted when listGroups throws', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('socket error'));

    rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
    await new Promise((r) => setTimeout(r, 30));

    expect(published).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and confirm the new tests fail (existing tests should still pass)**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- tests/unit/channels/signal/signal-adapter.test.ts
```

Expected: the four new group trust tests fail; all existing tests still pass (they use `makeMockRpcClient()` which now returns `listGroups: [] → no group found → trusted path never reached for 1:1 messages`).

- [ ] **Step 3: Update `SignalAdapterConfig` and add group trust logic to the adapter**

Open `src/channels/signal/signal-adapter.ts`.

Add the `group-trust` import at the top:

```typescript
import { checkGroupMemberTrust } from './group-trust.js';
```

Add `ceoEmail` to `SignalAdapterConfig`:

```typescript
export interface SignalAdapterConfig {
  bus: EventBus;
  logger: Logger;
  rpcClient: SignalRpcClient;
  outboundGateway: OutboundGateway | undefined;
  contactService: ContactService;
  phoneNumber: string;
  /**
   * CEO's email address for group hold notifications.
   * When a group message is held because of unverified members, Nathan sends the
   * CEO an email listing the unknown phone numbers.
   * If absent or empty, holds are logged at error but no email is sent.
   */
  ceoEmail?: string;
}
```

In `handleInbound()`, insert the group trust check immediately after the `convertSignalEnvelope` null-return guard and before the existing `// Step 1: Contact resolution` comment. The insertion point is after line:

```typescript
const { conversationId, senderId, content, metadata } = converted;
```

Insert:

```typescript
// ------------------------------------------------------------------
// Step 0: Group trust check
// ------------------------------------------------------------------
// Before engaging with any group conversation, verify every member's
// phone number is a known, verified contact. A single unknown or blocked
// member causes the message to be held or dropped.
// This runs before contact resolution so we don't create a contact for the
// sender of an untrusted group message.
if (metadata.isGroup && metadata.groupId) {
  const shouldProceed = await this.handleGroupTrustCheck(metadata.groupId);
  if (!shouldProceed) return;
}
```

Add the two private helper methods at the end of the class, before the closing `}`:

```typescript
// ---------------------------------------------------------------------------
// Private: group trust
// ---------------------------------------------------------------------------

/**
 * Runs the group trust check for an inbound group message.
 * Returns true if the group is trusted and processing should continue.
 * Returns false if the message was held or dropped — caller must return early.
 */
private async handleGroupTrustCheck(groupId: string): Promise<boolean> {
  // Fetch group membership from signal-cli. Fail-closed: if listGroups throws
  // (e.g. socket error, signal-cli restart), treat the group as untrusted so
  // we never accidentally engage with an unverified group.
  let memberPhones: string[];
  try {
    const groups = await this.config.rpcClient.listGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) {
      this.log.warn({ groupId }, 'Signal adapter: group not found in listGroups — treating as untrusted (fail-closed)');
      return false;
    }
    // Exclude Nathan's own number — it would resolve to Curia's own contact and
    // skew the trust check. Only external member phones are meaningful here.
    memberPhones = group.members
      .map((m) => m.number)
      .filter((phone) => phone !== this.config.phoneNumber);
  } catch (err) {
    this.log.warn({ err, groupId }, 'Signal adapter: listGroups failed — treating group as untrusted (fail-closed)');
    return false;
  }

  const trust = await checkGroupMemberTrust(memberPhones, this.config.contactService);

  if (trust.blockedMembers.length > 0) {
    // Silent drop — never acknowledge to blocked contacts that Curia is active
    // or monitoring the group. No email notification.
    this.log.debug(
      { groupId, blockedCount: trust.blockedMembers.length },
      'Signal adapter: group message dropped — blocked member in group',
    );
    return false;
  }

  if (trust.unknownMembers.length > 0) {
    // Auto-create provisional contacts for unknown members so the CEO can
    // identify them using the contact skills. Same pattern as unknown 1:1 senders.
    for (const phone of trust.unknownMembers) {
      try {
        const contact = await this.config.contactService.createContact({
          displayName: phone,
          fallbackDisplayName: phone,
          source: 'signal_participant',
          status: 'provisional',
        });
        await this.config.contactService.linkIdentity({
          contactId: contact.id,
          channel: 'signal',
          channelIdentifier: phone,
          source: 'signal_participant',
        });
      } catch (err) {
        // Best-effort — continue with remaining members even if one fails
        this.log.warn({ err, phone }, 'Signal adapter: failed to auto-create contact for unknown group member');
      }
    }

    await this.notifyCeoGroupHeld(groupId, trust.unknownMembers);

    this.log.info(
      { groupId, unknownCount: trust.unknownMembers.length },
      'Signal adapter: group message held — unknown members, CEO notified via email',
    );
    return false;
  }

  return true; // all members verified — proceed
}

/**
 * Send the CEO an email notification when a group message is held due to
 * unverified members. Uses the outbound gateway so the email goes through
 * the normal content filter pipeline.
 *
 * The CLI is not assumed to be monitored, so email is the reliable async
 * channel for this notification.
 */
private async notifyCeoGroupHeld(groupId: string, unknownPhones: string[]): Promise<void> {
  const { outboundGateway, ceoEmail } = this.config;

  if (!outboundGateway || !ceoEmail) {
    this.log.error(
      { groupId, hasGateway: !!outboundGateway, hasCeoEmail: !!ceoEmail },
      'Signal adapter: cannot notify CEO of held group message — outbound gateway or ceoEmail not configured',
    );
    return;
  }

  const memberList = unknownPhones.map((p) => `• ${p} — no verified contact`).join('\n');
  const body = [
    'A Signal group message was received but held because the following group members have not yet been verified:',
    '',
    memberList,
    '',
    'Once you have verified these contacts, you can ask me to send a message to the group and I will re-check membership before engaging.',
    '',
    `Group ID (for reference): ${groupId}`,
  ].join('\n');

  try {
    await outboundGateway.send({
      channel: 'email',
      to: ceoEmail,
      subject: 'Signal group message held — member verification needed',
      body,
    });
  } catch (err) {
    // Non-fatal — the message is still held. Log at error so it's visible in alerting.
    this.log.error({ err, groupId }, 'Signal adapter: failed to send CEO group-held notification via email');
  }
}
```

- [ ] **Step 4: Update `src/index.ts` to pass `ceoEmail` to `SignalAdapter`**

Open `src/index.ts`. Find the `SignalAdapter` construction block (around line 516):

```typescript
signalAdapter = new SignalAdapter({
  bus,
  logger,
  rpcClient: signalRpcClient,
  outboundGateway,
  contactService,
  phoneNumber: config.signalPhoneNumber,
});
```

Add `ceoEmail`:

```typescript
signalAdapter = new SignalAdapter({
  bus,
  logger,
  rpcClient: signalRpcClient,
  outboundGateway,
  contactService,
  phoneNumber: config.signalPhoneNumber,
  ceoEmail: config.nylasSelfEmail || undefined,
});
```

- [ ] **Step 5: Run and confirm all adapter tests pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- tests/unit/channels/signal/signal-adapter.test.ts
```

Expected: all tests pass including the four new group trust tests.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send add src/channels/signal/signal-adapter.ts src/index.ts tests/unit/channels/signal/signal-adapter.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send commit -m "feat: add group trust check to SignalAdapter with CEO email notification"
```

---

### Task 6: Create `signal-send` skill

**Files:**
- Create: `skills/signal-send/skill.json`
- Create: `skills/signal-send/handler.ts`
- Create: `skills/signal-send/handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `skills/signal-send/handler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalSendHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

/**
 * Build a minimal SkillContext for signal-send tests.
 * `gateway` and `contactService` are vi.fn()-based mocks you can override per-test.
 */
function makeCtx(overrides: {
  input?: Record<string, unknown>;
  gateway?: Partial<OutboundGateway>;
  contactService?: Partial<ContactService>;
}): SkillContext {
  const gateway = {
    send: vi.fn().mockResolvedValue({ success: true }),
    getSignalGroupMembers: vi.fn().mockResolvedValue([]),
    ...overrides.gateway,
  } as unknown as OutboundGateway;

  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue({ contactId: 'c1', status: 'active' }),
    ...overrides.contactService,
  } as unknown as ContactService;

  return {
    input: overrides.input ?? {},
    secret: () => '',
    log: makeLogger(),
    outboundGateway: gateway,
    contactService,
  } as unknown as SkillContext;
}

describe('SignalSendHandler', () => {
  let handler: SignalSendHandler;

  beforeEach(() => {
    handler = new SignalSendHandler();
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  it('returns error when message is missing', async () => {
    const ctx = makeCtx({ input: { recipient: '+14155551234' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/message/);
  });

  it('returns error when neither recipient nor group_id is provided', async () => {
    const ctx = makeCtx({ input: { message: 'hello' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/recipient|group_id/);
  });

  it('returns error when both recipient and group_id are provided', async () => {
    const ctx = makeCtx({ input: { recipient: '+14155551234', group_id: 'grpABC==', message: 'hi' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/either.*not both|not both/i);
  });

  it('returns error when recipient is not a valid E.164 number', async () => {
    const ctx = makeCtx({ input: { recipient: 'not-a-phone', message: 'hi' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/E\.164/);
  });

  it('returns error when message exceeds max length', async () => {
    const ctx = makeCtx({ input: { recipient: '+14155551234', message: 'x'.repeat(10_001) } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/10.000|10,000/);
  });

  it('returns error when outboundGateway is not available', async () => {
    const ctx = makeCtx({ input: { recipient: '+14155551234', message: 'hi' } });
    (ctx as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  // ---------------------------------------------------------------------------
  // 1:1 send
  // ---------------------------------------------------------------------------

  it('sends a 1:1 Signal message and returns delivered_to', async () => {
    const gateway = { send: vi.fn().mockResolvedValue({ success: true }) };
    const ctx = makeCtx({ input: { recipient: '+14155551234', message: 'hello' }, gateway });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).delivered_to).toBe('+14155551234');
      expect((result.data as Record<string, unknown>).channel).toBe('signal');
    }
    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'signal', recipient: '+14155551234', message: 'hello' }),
    );
  });

  it('returns error when gateway blocks the 1:1 send', async () => {
    const gateway = { send: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient is blocked' }) };
    const ctx = makeCtx({ input: { recipient: '+14155551234', message: 'hi' }, gateway });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
  });

  // ---------------------------------------------------------------------------
  // Group send
  // ---------------------------------------------------------------------------

  it('sends a group Signal message when all members are trusted', async () => {
    const gateway = {
      send: vi.fn().mockResolvedValue({ success: true }),
      getSignalGroupMembers: vi.fn().mockResolvedValue(['+14155551234']),
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({ contactId: 'c1', status: 'active' }),
    };
    const ctx = makeCtx({ input: { group_id: 'grpABC==', message: 'team update' }, gateway, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).delivered_to).toBe('grpABC==');
    }
    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'signal', groupId: 'grpABC==', message: 'team update' }),
    );
  });

  it('returns error listing unknown phones when a group member is unverified', async () => {
    const gateway = {
      send: vi.fn(),
      getSignalGroupMembers: vi.fn().mockResolvedValue(['+14155551234']),
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null), // unknown
    };
    const ctx = makeCtx({ input: { group_id: 'grpABC==', message: 'hi' }, gateway, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/\+14155551234/);
      expect(result.error).toMatch(/verified|verify/i);
    }
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('returns error (no phone list) when a group member is blocked', async () => {
    const gateway = {
      send: vi.fn(),
      getSignalGroupMembers: vi.fn().mockResolvedValue(['+14155551234']),
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({ contactId: 'c1', status: 'blocked' }),
    };
    const ctx = makeCtx({ input: { group_id: 'grpABC==', message: 'hi' }, gateway, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
    // Phone number must NOT appear in error for blocked contacts
    expect(result.success === false && result.error).not.toMatch(/\+14155551234/);
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('returns error when getSignalGroupMembers throws', async () => {
    const gateway = {
      send: vi.fn(),
      getSignalGroupMembers: vi.fn().mockRejectedValue(new Error('group not found: grpXYZ==')),
    };
    const ctx = makeCtx({ input: { group_id: 'grpXYZ==', message: 'hi' }, gateway });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/group/i);
    expect(gateway.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and confirm the tests fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- skills/signal-send/handler.test.ts
```

Expected: all tests fail with module not found.

- [ ] **Step 3: Create the skill manifest**

Create `skills/signal-send/skill.json`:

```json
{
  "name": "signal-send",
  "description": "Send a Signal message to a person (by their E.164 phone number) or a group (by group ID). For 1:1 sends, use the contact's verified Signal phone number from contact-lookup — display names are not trusted for Signal identity. For group sends, all group members must be verified contacts; unverified groups are refused with a list of which members need verification.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "medium",
  "infrastructure": true,
  "inputs": {
    "recipient": "string?",
    "group_id": "string?",
    "message": "string"
  },
  "outputs": {
    "delivered_to": "string",
    "channel": "string"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

- [ ] **Step 4: Create the skill handler**

Create `skills/signal-send/handler.ts`:

```typescript
// handler.ts — signal-send skill implementation.
//
// Sends a Signal message to a 1:1 contact (by E.164 phone number) or a group
// (by base64 group ID) via the OutboundGateway.
//
// Signal's identity anchor is the phone number, not the display name.
// Display names are user-defined and not trusted. The coordinator must use
// contact-lookup (by channel: "signal:<phone>") to find the correct E.164 number
// before calling this skill.
//
// For group sends, every group member's phone number is checked against the
// contact system before sending:
//   - Any blocked member  → error (no member list disclosed)
//   - Any unknown member  → error listing the unknown phones
//   - All verified        → send proceeds
//
// action_risk: "medium" — outbound Signal communication.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { checkGroupMemberTrust } from '../../src/channels/signal/group-trust.js';

const MAX_MESSAGE_LENGTH = 10_000;
// E.164: + followed by country code (1 digit, non-zero) and up to 14 digits
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export class SignalSendHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { recipient, group_id, message } = ctx.input as {
      recipient?: string;
      group_id?: string;
      message?: string;
    };

    // ------------------------------------------------------------------
    // Input validation
    // ------------------------------------------------------------------

    if (!message || typeof message !== 'string') {
      return { success: false, error: 'Missing required input: message (string)' };
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return { success: false, error: `message must be ${MAX_MESSAGE_LENGTH.toLocaleString()} characters or fewer` };
    }

    if (!recipient && !group_id) {
      return { success: false, error: 'Either recipient (E.164 phone number) or group_id (Signal group ID) must be provided' };
    }
    if (recipient && group_id) {
      return { success: false, error: 'Provide either recipient or group_id, not both' };
    }
    if (recipient && !E164_REGEX.test(recipient)) {
      return {
        success: false,
        error: `recipient must be a valid E.164 phone number (e.g. "+15195551234"), got: "${recipient}"`,
      };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'signal-send requires outboundGateway access. Is infrastructure: true set in the manifest and outboundGateway passed to ExecutionLayer?',
      };
    }
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'signal-send requires contactService access. Is infrastructure: true set in the manifest?',
      };
    }

    // ------------------------------------------------------------------
    // Group trust check (group sends only)
    // ------------------------------------------------------------------
    // Before sending to a group, verify every member is a known, verified
    // contact. One blocked or unknown member prevents the send entirely.
    // This is intentionally conservative — the CEO can ask to resend once
    // unknown members are verified.

    if (group_id) {
      let memberPhones: string[];
      try {
        memberPhones = await ctx.outboundGateway.getSignalGroupMembers(group_id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Could not retrieve group members: ${msg}` };
      }

      const trust = await checkGroupMemberTrust(memberPhones, ctx.contactService);

      if (trust.blockedMembers.length > 0) {
        // Don't disclose blocked member phone numbers — just refuse.
        return { success: false, error: 'Cannot send to this group — it contains a blocked contact.' };
      }
      if (trust.unknownMembers.length > 0) {
        // List unknown phones so the coordinator can tell the CEO who needs verifying.
        return {
          success: false,
          error: `Cannot send to this group — the following members are not yet verified: ${trust.unknownMembers.join(', ')}. Please verify them first.`,
        };
      }
    }

    // ------------------------------------------------------------------
    // Send via gateway
    // ------------------------------------------------------------------
    // The gateway applies the blocked-contact check and content filter
    // before dispatching to signal-cli.

    ctx.log.info({ hasRecipient: !!recipient, hasGroupId: !!group_id }, 'Sending Signal message via gateway');

    try {
      const result = await ctx.outboundGateway.send({
        channel: 'signal',
        recipient: recipient,
        groupId: group_id,
        message,
      });

      if (!result.success) {
        return { success: false, error: result.blockedReason ?? 'Signal send failed' };
      }

      return {
        success: true,
        data: {
          delivered_to: recipient ?? group_id,
          channel: 'signal',
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, hasRecipient: !!recipient, hasGroupId: !!group_id }, 'Failed to send Signal message');
      return { success: false, error: `Failed to send Signal message: ${msg}` };
    }
  }
}
```

- [ ] **Step 5: Run and confirm all skill tests pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test -- skills/signal-send/handler.test.ts
```

Expected: all 11 tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send add skills/signal-send/skill.json skills/signal-send/handler.ts skills/signal-send/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send commit -m "feat: add signal-send skill with group trust check"
```

---

### Task 7: Full test suite + typecheck

- [ ] **Step 1: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send test
```

Expected: all tests pass. Fix any failures before proceeding.

- [ ] **Step 2: Run typecheck**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send run typecheck
```

Expected: no type errors. Fix any before proceeding.

---

### Task 8: Changelog and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add changelog entry**

Open `CHANGELOG.md`. Under `## [Unreleased]` (create this heading if it doesn't exist), add:

```markdown
## [Unreleased]

### Added
- **`signal-send` skill**: proactively send Signal messages (1:1 by E.164 phone number, group by group ID) via the OutboundGateway.
- **Signal group trust model**: before engaging with any Signal group (inbound or outbound), all member phone numbers are verified against the contact system. Unknown members cause the group message to be held and the CEO notified via email; blocked members cause silent drop. Shared `checkGroupMemberTrust()` helper used by both `SignalAdapter` (inbound) and `signal-send` (outbound).
- **`SignalRpcClient.listGroups()`**: typed wrapper for signal-cli's `listGroups` JSON-RPC method.
- **`OutboundGateway.getSignalGroupMembers()`**: resolves a group ID to member phone numbers, excluding Nathan's own number.
```

- [ ] **Step 2: Bump version to `0.11.0`**

Open `package.json`. Change the `"version"` field from its current value to `"0.11.0"`. New skill = minor bump per the versioning table in CLAUDE.md.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-send commit -m "chore: bump version to 0.11.0 and update CHANGELOG for signal-send skill"
```
