# Signal Channel — Design Document

Date: 2026-04-07
Spec: [04-channels.md](../specs/04-channels.md)
ADR: [ADR-010](../adr/010-signal-over-telegram.md) (Signal vs Telegram), ADR-013 (signal-cli daemon — to be written)

---

## Overview

Adds Signal as a second inbound/outbound message channel. Signal carries `high` trust
(already declared in `config/channel-trust.yaml`) — phone number identity + E2E encryption
make it safe to route CEO messages directly without the email channel's SPF/DKIM hedging.

The implementation follows the same structural pattern as the email adapter: a self-contained
class that publishes `inbound.message` events and subscribes to `outbound.message` to send
replies. No core bus, dispatcher, or execution layer changes are needed.

---

## Integration Architecture

### signal-cli daemon mode

Signal does not offer an official bot API. signal-cli is the standard open-source bridge:
a Java CLI tool that implements the Signal protocol and can run as a persistent daemon
exposing a JSON-RPC socket.

**Why daemon mode over subprocess mode:**
- signal-cli is a separate JVM process with its own state and memory pressure; coupling
  it to Node's lifecycle means a Node crash drops the Signal connection and vice versa.
- In production (Docker Compose), signal-cli runs as its own service, sharing a socket
  volume with the Curia container. This is the standard pattern and matches the existing
  `ceo-deploy` architecture.
- Reconnection on adapter side is cheap (re-open socket); reconnect on signal-cli side
  would require re-establishing the Signal session.

**Socket type:** Unix socket (same host/container). TCP socket supported as fallback for
cross-host or unusual Docker networking, but not needed for the standard deployment.

### Component ownership

```
signal-cli (separate service, Java)
  └─ Unix socket /run/signal-cli/socket
       └─ SignalRpcClient (Node.js, owns connection + reconnect)
            └─ SignalAdapter (ChannelAdapter)
                 ├─ inbound: envelope → InboundMessage → bus.publish()
                 ├─ read receipts: direct via SignalRpcClient (bypass gateway — not content)
                 └─ outbound: bus.subscribe('outbound.message') → OutboundGateway.send()
                      └─ OutboundGateway (blocked-contact check + content filter + send)
                           └─ SignalRpcClient.send()
```

### JSON-RPC framing

signal-cli uses newline-delimited JSON over the socket. Each line is a complete JSON object.

**Inbound notifications** (no `id` field — server-initiated):
```json
{
  "jsonrpc": "2.0",
  "method": "receive",
  "params": {
    "envelope": { ... },
    "account": "+1xxx"
  }
}
```

**Outbound requests** (with `id` for response correlation):
```json
{ "jsonrpc": "2.0", "id": "req-1", "method": "send", "params": { ... } }
```

**Responses:**
```json
{ "jsonrpc": "2.0", "id": "req-1", "result": { ... } }
{ "jsonrpc": "2.0", "id": "req-1", "error": { "code": -1, "message": "..." } }
```

---

## New Files

### `src/channels/signal/types.ts`

TypeScript types for the signal-cli JSON-RPC wire format. Key types:
- `SignalEnvelope` — top-level envelope (source, timestamp, dataMessage | syncMessage | ...)
- `SignalDataMessage` — text message payload (message, groupInfo, attachments, reaction)
- `SignalGroupInfo` — groupId + type (DELIVER | UPDATE | QUIT | UNKNOWN)
- `SignalAttachment` — id, contentType, filename, size
- `SignalSendParams` — params for `send` RPC call
- `SignalReadReceiptParams` — params for `sendReceipt` RPC call

### `src/channels/signal/signal-rpc-client.ts`

JSON-RPC 2.0 client over a Unix/TCP socket. Responsibilities:
- Maintain the socket connection (Node `net.Socket`)
- Frame/parse newline-delimited JSON
- Correlate request IDs to Promises for `send()` calls
- Emit `'message'` events for incoming `receive` notifications
- Emit `'connected'` / `'disconnected'` events
- Reconnect with exponential backoff (1s → 2s → 4s → ... → 5min cap)
- Deduplicate re-delivered messages on reconnect (sliding `Set<string>` keyed on
  `${sourceNumber}:${timestamp}`, max 1000 entries)

Key interface:
```typescript
class SignalRpcClient extends EventEmitter {
  async connect(): Promise<void>
  async disconnect(): Promise<void>
  async send(params: SignalSendParams): Promise<void>
  async sendReadReceipt(params: SignalReadReceiptParams): Promise<void>
}
```

### `src/channels/signal/message-converter.ts`

Converts a `SignalEnvelope` → `InboundMessage`. Key logic:
- Ignore envelopes with no `dataMessage`, with a `reaction`, or with `viewOnce: true`
- Ignore `syncMessage` (self-sent from another device)
- Conversation ID: `signal:+1xxx` for 1:1, `signal:group=<base64Id>` for groups
- Sender ID: `sourceNumber` (E.164 format)
- Content: `dataMessage.message` (stripped of any leading/trailing whitespace)
- Metadata: `{ groupId?, sourceName?, timestamp, attachments? }`

### `src/channels/signal/signal-adapter.ts`

Implements `ChannelAdapter`. Responsibilities:
- On `start()`: connect RPC client, subscribe to `outbound.message` on bus
- On `message` event from RPC client:
  1. Convert envelope → InboundMessage via message-converter
  2. Resolve sender contact (for auto-create and read-receipt decision)
  3. Auto-create contact if new (source: `'signal_participant'`, status: `'provisional'`)
  4. If sender is known (non-provisional, non-blocked) and message is 1:1: send read receipt
  5. Sanitize content (same `sanitizeOutput()` call as email adapter)
  6. Publish `inbound.message` to bus
- On `outbound.message` bus event with `channelId: 'signal'`: call `OutboundGateway.send()`
- On `stop()`: disconnect RPC client

---

## Modified Files

### `src/skills/outbound-gateway.ts`

`OutboundSendRequest` becomes a discriminated union:

```typescript
export type OutboundSendRequest =
  | EmailSendRequest
  | SignalSendRequest;

interface EmailSendRequest {
  channel: 'email';
  to: string;
  subject: string;
  body: string;
  replyToMessageId?: string;
}

interface SignalSendRequest {
  channel: 'signal';
  recipient?: string;   // E.164 phone number for 1:1
  groupId?: string;     // base64 group ID for group messages
  message: string;
}
```

The gateway gains an optional `signalClient?: SignalRpcClient` dep. `send()` dispatches
to `dispatchEmail()` or `dispatchSignal()` based on `request.channel`. The blocked-contact
check and content filter run before both dispatch paths.

For Signal, the blocked-contact check uses `channelIdentifier = request.recipient ?? request.groupId`.

### `src/config.ts`

New fields:
```typescript
signalSocketPath: string | undefined;    // e.g. /run/signal-cli/socket
signalPhoneNumber: string | undefined;   // Nathan's Signal number in E.164
```

Env vars: `SIGNAL_SOCKET_PATH`, `SIGNAL_PHONE_NUMBER`.

### `config/default.yaml`

```yaml
channels:
  signal:
    enabled: false   # opt-in; no-op if SIGNAL_SOCKET_PATH is not set
```

### `src/index.ts`

Signal adapter wiring (same pattern as email adapter):
1. Construct `SignalRpcClient` if `config.signalSocketPath` is set
2. Construct `SignalAdapter` with `{ bus, logger, rpcClient, outboundGateway, contactService, phoneNumber }`
3. Start adapter AFTER dispatcher is registered (same ordering rationale as email)
4. Stop adapter in graceful shutdown handler

---

## ADR-013

Documents the choice of signal-cli daemon socket mode over:
- **Child process (stdio)** — tighter coupling, fragile lifecycle
- **Unofficial Node.js Signal libraries** (e.g. `@throneless/libsignal`) — unmaintained, 
  no production track record, would require reimplementing the Signal protocol
- **signal-cli HTTP mode** — adds HTTP server overhead for no benefit; socket is simpler

---

## Testing Strategy

| Test file | Type | Approach |
|---|---|---|
| `signal-rpc-client.test.ts` | Unit | Mock `net.createConnection` with a fake socket; test framing, correlation, backoff |
| `message-converter.test.ts` | Unit | Pure function tests over fixture envelopes (1:1, group, attachment, reaction) |
| `signal-adapter.test.ts` | Unit | Mock RPC client and bus; verify inbound publish, contact auto-create, read receipt logic |

No integration tests requiring a live signal-cli instance — that is deferred until ceo-deploy
wires the service and a real phone number is registered.

---

## Docker / ceo-deploy Notes (not implemented here)

In `ceo-deploy`, signal-cli runs as a separate Compose service:
```yaml
signal-cli:
  image: bbernhard/signal-cli-rest-api:latest  # or custom signal-cli image
  volumes:
    - signal-data:/home/user/.local/share/signal-cli
    - signal-socket:/run/signal-cli
```

The Curia service mounts the same `signal-socket` volume and sets:
```
SIGNAL_SOCKET_PATH=/run/signal-cli/socket
SIGNAL_PHONE_NUMBER=+1XXXXXXXXXX
```

One-time registration (run in the signal-cli container):
```bash
signal-cli -a +1XXXXXXXXXX register
signal-cli -a +1XXXXXXXXXX verify 123456
signal-cli -a +1XXXXXXXXXX daemon --socket /run/signal-cli/socket
```
