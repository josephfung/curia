# Signal Channel — Implementation Plan

> **Design doc:** [2026-04-07-signal-channel-design.md](2026-04-07-signal-channel-design.md)

**Goal:** Implement the Signal channel adapter (spec 04) — signal-cli daemon socket integration,
inbound message handling, outbound replies via OutboundGateway, 1:1 read receipts for known
senders, and contact auto-creation.

**Architecture summary:** `SignalRpcClient` owns the socket + reconnect. `SignalAdapter` owns
the bus integration. `OutboundGateway` gets a Signal send path alongside the existing email path.
No core bus/dispatcher/execution layer changes needed.

---

### Task 1: ADR-013 — signal-cli daemon mode

**Files:**
- Create: `docs/adr/013-signal-cli-daemon-mode.md`
- Modify: `docs/adr/README.md`

- [ ] **Step 1: Write ADR-013**

Document the decision to use signal-cli in daemon socket mode. Cover:
- Context: Signal has no official bot API; three integration options evaluated
- Options rejected: child process stdio (lifecycle coupling), unofficial Node.js Signal
  libraries (`@throneless/libsignal` — unmaintained, reimplements the protocol),
  signal-cli HTTP mode (extra server overhead for no benefit)
- Decision: signal-cli daemon + Unix socket (battle-tested, maintained, production standard)
- Consequences: Java runtime dependency in ceo-deploy; one-time phone number registration
  required; socket volume shared between signal-cli container and Curia container

- [ ] **Step 2: Add row to `docs/adr/README.md`**

---

### Task 2: Wire types for signal-cli JSON-RPC

**Files:**
- Create: `src/channels/signal/types.ts`

- [ ] **Step 1: Write `SignalEnvelope` and related types**

```typescript
// signal-cli envelope — top-level wrapper for all incoming signal-cli notifications.
export interface SignalEnvelope {
  source: string;         // E.164 phone number, e.g. "+14155552671"
  sourceNumber: string;   // same as source (signal-cli uses both)
  sourceUuid: string;
  sourceName: string;
  sourceDevice: number;
  timestamp: number;      // Signal-level timestamp (ms) — needed for read receipts
  dataMessage?: SignalDataMessage;
  syncMessage?: SignalSyncMessage;
  // callMessage, typingMessage, receiptMessage — ignored
}

export interface SignalDataMessage {
  timestamp: number;
  message: string | null;  // null for reactions, attachments-only, etc.
  expiresInSeconds: number;
  viewOnce: boolean;
  groupInfo?: SignalGroupInfo;
  attachments?: SignalAttachment[];
  reaction?: SignalReaction;
}

export interface SignalGroupInfo {
  groupId: string;   // base64-encoded group V2 ID
  type: 'DELIVER' | 'UPDATE' | 'QUIT' | 'UNKNOWN';
}

export interface SignalAttachment {
  contentType: string;
  filename?: string;
  id: string;
  size: number;
}

export interface SignalReaction {
  emoji: string;
  targetAuthor: string;
  targetTimestamp: number;
  isRemove: boolean;
}

// syncMessage — messages sent by Nathan from another device.
// We don't process these as inbound; they're filtered out in the converter.
export interface SignalSyncMessage {
  sentMessage?: { message: string };
}

// Params for the signal-cli `send` JSON-RPC method
export interface SignalSendParams {
  account: string;       // Nathan's phone number
  recipient?: string[];  // E.164 array for 1:1
  groupId?: string;      // base64 group ID for group messages
  message: string;
}

// Params for the signal-cli `sendReceipt` JSON-RPC method
export interface SignalReadReceiptParams {
  account: string;
  recipient: string;           // sender's E.164 number
  targetTimestamp: number[];   // array of Signal timestamps to mark read
  receiptType: 'read' | 'viewed';
}

// Receive notification payload (the `params` field of a receive notification)
export interface SignalReceiveParams {
  envelope: SignalEnvelope;
  account: string;
}
```

---

### Task 3: SignalRpcClient

**Files:**
- Create: `src/channels/signal/signal-rpc-client.ts`
- Create: `src/channels/signal/signal-rpc-client.test.ts`

- [ ] **Step 1: Write `SignalRpcClient`**

Key design points:
- Extends `EventEmitter` — emits `'message'` (with `SignalEnvelope`) and
  `'connected'` / `'disconnected'`
- Socket: `net.createConnection({ path: socketPath })` for Unix,
  `net.createConnection({ host, port })` for TCP
- Framing: buffer partial reads, split on `\n`, parse each line as JSON
- Request correlation: `Map<string, { resolve, reject }>` keyed on `id`
- Request IDs: monotonic counter (`req-1`, `req-2`, ...)
- Reconnect: exponential backoff starting at 1000ms, doubling, capped at 300_000ms (5 min);
  use `setTimeout` not `setInterval` so backoff can grow; reset to 1000ms on successful
  connect
- `send()` and `sendReadReceipt()`: build JSON-RPC request, write to socket, return Promise
  that resolves/rejects from the correlation map; reject after 10s timeout
- On `disconnect` / `error`: reject all pending requests with connection error, schedule reconnect
- Dedup: `Set<string>` keyed on `${sourceNumber}:${timestamp}`; evict oldest when size > 1000
  (use an insertion-order array as a queue alongside the set)

```typescript
export interface SignalRpcClientConfig {
  socketPath: string;  // Unix socket path (TCP support deferred)
  accountNumber: string;
  logger: Logger;
}

export class SignalRpcClient extends EventEmitter {
  constructor(config: SignalRpcClientConfig)
  async connect(): Promise<void>
  async disconnect(): Promise<void>
  async send(params: SignalSendParams): Promise<void>
  async sendReadReceipt(params: SignalReadReceiptParams): Promise<void>
}
```

- [ ] **Step 2: Write tests for `SignalRpcClient`**

Use Node's `net.createServer()` to create a real Unix socket server in a temp path.
Test cases:
- Parses a valid `receive` notification and emits `'message'`
- Correlates a `send` request to its response
- Rejects pending requests on socket close
- Deduplicates a re-delivered envelope (same `sourceNumber:timestamp`)
- Evicts oldest dedup entry when Set exceeds 1000

---

### Task 4: Message converter

**Files:**
- Create: `src/channels/signal/message-converter.ts`
- Create: `src/channels/signal/message-converter.test.ts`

- [ ] **Step 1: Write `convertSignalEnvelope()`**

```typescript
export interface ConvertedSignalMessage {
  conversationId: string;
  channelId: 'signal';
  senderId: string;            // E.164 phone number
  content: string;
  metadata: {
    sourceName: string;
    signalTimestamp: number;   // needed for read receipt
    groupId?: string;
    isGroup: boolean;
    attachments?: SignalAttachment[];
  };
}

// Returns null for envelopes that should be ignored (reactions, sync messages,
// view-once, no text content, group management events)
export function convertSignalEnvelope(
  envelope: SignalEnvelope,
): ConvertedSignalMessage | null
```

Conversation ID logic:
```typescript
const isGroup = !!envelope.dataMessage?.groupInfo;
const conversationId = isGroup
  ? `signal:group=${envelope.dataMessage.groupInfo.groupId}`
  : `signal:${envelope.sourceNumber}`;
```

Ignore conditions (return `null`):
- No `dataMessage`
- Has `syncMessage` (self-sent from another device)
- `dataMessage.reaction` is set (emoji reaction — ignore per spec)
- `dataMessage.viewOnce` is true
- `dataMessage.message` is null or empty after trim
- `dataMessage.groupInfo?.type !== 'DELIVER'` (group management events like UPDATE, QUIT)

- [ ] **Step 2: Write tests**

Cover: 1:1 message, group message, reaction (null), sync message (null), empty message (null),
group UPDATE event (null), attachment-only message (null), message with leading/trailing whitespace.

---

### Task 5: SignalAdapter

**Files:**
- Create: `src/channels/signal/signal-adapter.ts`
- Create: `src/channels/signal/signal-adapter.test.ts`

- [ ] **Step 1: Write `SignalAdapter`**

```typescript
export interface SignalAdapterConfig {
  bus: EventBus;
  logger: Logger;
  rpcClient: SignalRpcClient;
  outboundGateway: OutboundGateway | undefined;
  contactService: ContactService;
  phoneNumber: string;  // Nathan's number — used as `account` in all RPC calls
}

export class SignalAdapter {
  async start(): Promise<void>
  async stop(): Promise<void>
}
```

`start()` sequence:
1. Subscribe to `outbound.message` bus event (filter `channelId === 'signal'`)
2. Register `rpcClient.on('message', handleInbound)`
3. Call `rpcClient.connect()`

`handleInbound(envelope)` sequence:
1. `convertSignalEnvelope(envelope)` — return early if null
2. Try to resolve sender contact via `contactService.resolveByChannelIdentity('signal', senderId)`
3. If no contact: auto-create with `source: 'signal_participant'`, `status: 'provisional'`,
   link identity channel='signal', channelIdentifier=senderId
4. Determine `isKnown`: contact exists AND status is not `'provisional'` AND not `'blocked'`
5. If `isKnown` AND message is 1:1 (not group): fire read receipt (fire-and-forget, log on error)
6. Sanitize content with `sanitizeOutput(content, { maxLength: 10_000 })`
7. Publish `createInboundMessage({ conversationId, channelId: 'signal', senderId, content, metadata })`

`handleOutbound(event)`:
- Parse `conversationId` to extract recipient or groupId
- Call `outboundGateway.send({ channel: 'signal', ... })`
- If no gateway: log warn and return (same degraded-mode pattern as email)

Read receipt:
```typescript
await this.config.rpcClient.sendReadReceipt({
  account: this.config.phoneNumber,
  recipient: senderId,
  targetTimestamp: [metadata.signalTimestamp],
  receiptType: 'read',
});
```

- [ ] **Step 2: Write tests**

Mock `SignalRpcClient` (EventEmitter stub) and bus. Test:
- Inbound 1:1 from known contact → publishes inbound.message, sends read receipt
- Inbound 1:1 from unknown → publishes inbound.message, no read receipt, auto-creates contact
- Inbound group message from known contact → publishes inbound.message, no read receipt
- Reaction envelope → ignored (no publish)
- Outbound message event (signal channelId) → calls gateway.send()
- Outbound message event (email channelId) → ignored

---

### Task 6: OutboundGateway — Signal send path

**Files:**
- Modify: `src/skills/outbound-gateway.ts`

- [ ] **Step 1: Extend `OutboundSendRequest` to a discriminated union**

```typescript
export type OutboundSendRequest = EmailSendRequest | SignalSendRequest;

export interface EmailSendRequest {
  channel: 'email';
  to: string;
  subject: string;
  body: string;
  replyToMessageId?: string;
}

export interface SignalSendRequest {
  channel: 'signal';
  recipient?: string;   // E.164 for 1:1; mutually exclusive with groupId
  groupId?: string;     // base64 group ID; mutually exclusive with recipient
  message: string;
}
```

- [ ] **Step 2: Add `signalClient?: SignalRpcClient` to `OutboundGatewayConfig`**

- [ ] **Step 3: Add `dispatchSignal()` private method**

```typescript
private async dispatchSignal(request: SignalSendRequest): Promise<OutboundSendResult>
```

Logic:
- If `!this.config.signalClient`: return `{ success: false, blockedReason: 'Signal client not configured' }`
- Build `SignalSendParams`: `{ account: this.config.signalPhoneNumber, ... }`
- Call `this.config.signalClient.send(params)`
- Return `{ success: true }`

- [ ] **Step 4: Update `send()` to dispatch on channel**

Replace the existing unconditional Nylas path with:
```typescript
if (request.channel === 'email') {
  return this.dispatchEmail(request);
} else {
  return this.dispatchSignal(request);
}
```

The blocked-contact check and content filter already run before this branch — they are
channel-agnostic.

For Signal's blocked-contact check, the `to` identifier is `request.recipient ?? request.groupId ?? ''`.

- [ ] **Step 5: Add `signalPhoneNumber?: string` to `OutboundGatewayConfig`** (needed for `account` param)

---

### Task 7: Config

**Files:**
- Modify: `src/config.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Add Signal fields to `Config` interface and `loadConfig()`**

```typescript
// In Config interface:
signalSocketPath: string | undefined;
signalPhoneNumber: string | undefined;
```

```typescript
// In loadConfig():
signalSocketPath: process.env.SIGNAL_SOCKET_PATH || undefined,
signalPhoneNumber: process.env.SIGNAL_PHONE_NUMBER || undefined,
```

- [ ] **Step 2: Update `config/default.yaml`**

The `channels.signal` key already exists in `channel-trust.yaml` (trust + policy). Add
an opt-in `enabled` flag to `default.yaml` for consistency with the CLI channel entry:

```yaml
channels:
  cli:
    enabled: true
  signal:
    enabled: false   # enable by setting SIGNAL_SOCKET_PATH + SIGNAL_PHONE_NUMBER
```

---

### Task 8: Bootstrap wiring

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Construct SignalRpcClient and SignalAdapter**

After the email adapter construction block, add:

```typescript
// Signal channel — optional; requires SIGNAL_SOCKET_PATH and SIGNAL_PHONE_NUMBER.
// SignalRpcClient is constructed here; SignalAdapter is started after the dispatcher
// (same ordering rule as EmailAdapter: no adapter polls before inbound.message has a subscriber).
let signalAdapter: SignalAdapter | undefined;
if (config.signalSocketPath && config.signalPhoneNumber) {
  const signalRpcClient = new SignalRpcClient({
    socketPath: config.signalSocketPath,
    accountNumber: config.signalPhoneNumber,
    logger,
  });
  // Inject signalRpcClient and signalPhoneNumber into outboundGateway if it exists.
  // If outboundGateway is not available (no Nylas), construct a Signal-only gateway.
  // ...see step 2
  signalAdapter = new SignalAdapter({
    bus,
    logger,
    rpcClient: signalRpcClient,
    outboundGateway,   // may be undefined — adapter handles graceful degradation
    contactService,
    phoneNumber: config.signalPhoneNumber,
  });
} else {
  logger.warn('SIGNAL_SOCKET_PATH/SIGNAL_PHONE_NUMBER not set — Signal channel disabled');
}
```

- [ ] **Step 2: Pass signalRpcClient + signalPhoneNumber to OutboundGateway**

`OutboundGateway` currently requires `nylasClient`. For Signal-only mode (no Nylas),
`outboundGateway` would be undefined, and the adapter falls back to no outbound.

The cleaner approach: if `signalRpcClient` is available, pass it into `OutboundGateway`
regardless of Nylas. Update the gateway construction block:

```typescript
outboundGateway = new OutboundGateway({
  nylasClient,
  signalClient: signalRpcClient,    // may be undefined
  signalPhoneNumber: config.signalPhoneNumber,
  contactService,
  contentFilter: outboundFilter,
  bus,
  ceoEmail: config.nylasSelfEmail,
  logger,
});
```

Update the gateway initialization guard: currently requires `nylasClient && outboundFilter && ceoEmail`.
Change to: initialize gateway if `(nylasClient || signalRpcClient) && outboundFilter`.
`ceoEmail` becomes optional (only needed for email content filter).

- [ ] **Step 3: Start SignalAdapter after dispatcher registration**

After `emailAdapter?.start()`:
```typescript
if (signalAdapter) {
  await signalAdapter.start();
  logger.info('Signal channel adapter started');
}
```

- [ ] **Step 4: Stop SignalAdapter in shutdown handler**

```typescript
if (signalAdapter) {
  try {
    await signalAdapter.stop();
  } catch (err) {
    logger.error({ err }, 'Error stopping Signal adapter during shutdown');
  }
}
```

---

### Task 9: CHANGELOG and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add `## [Unreleased]` entry to CHANGELOG.md**

```markdown
### Added
- **Signal channel** (spec 04): inbound/outbound messaging via signal-cli daemon socket,
  1:1 read receipts for known senders, contact auto-creation, unknown sender hold policy.
```

- [ ] **Step 2: Bump version to `0.10.0`** in `package.json`

New channel = minor bump per versioning table.

---

### Task 10: Run test suite

- [ ] **Step 1: Run full test suite and fix any failures**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-channel test
```

- [ ] **Step 2: Run typecheck**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-channel run typecheck
```
