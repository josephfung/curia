# 04 — Channels

## Overview

Each channel is a self-contained adapter that translates between platform-specific formats and the framework's normalized message types. Channels are the only way messages enter and exit the system.

---

## Adapter Interface

```typescript
interface ChannelAdapter {
  id: string;                      // e.g., "signal", "telegram", "email"
  start(): Promise<void>;         // connect/listen
  stop(): Promise<void>;          // graceful shutdown
  send(message: OutboundMessage): Promise<void>;
}
```

Each adapter:
- Publishes `inbound.message` (normalized) when a platform message arrives
- Subscribes to `outbound.message` and calls `send()` to deliver responses
- Handles its own connection lifecycle, authentication, and reconnection

---

## Message Types

```typescript
interface InboundMessage {
  id: string;                  // UUID
  conversation_id: string;     // deterministic UUID v5 from channel:user_id:thread_id
  channel_id: string;          // e.g., "telegram"
  sender_id: string;           // platform-specific user ID
  content: string;             // normalized text content
  attachments?: Attachment[];  // files, images, etc.
  metadata: Record<string, unknown>;  // platform-specific extras
  timestamp: Date;
}

interface OutboundMessage {
  conversation_id: string;
  channel_id: string;
  content: string;
  attachments?: Attachment[];
  metadata: Record<string, unknown>;
}
```

---

## Launch Channels

### CLI
Interactive terminal for local dev and testing. Reads from stdin, writes to stdout. Simplest adapter — useful for testing agent logic without external services.

### Email (IMAP + SMTP)
- **Inbound:** Polls IMAP mailbox at configurable interval (default: 60s)
- **Outbound:** Sends via SMTP
- **Conversation ID:** derived from email thread (In-Reply-To / References headers)
- **Attachments:** parsed and passed through as `Attachment[]`
- Secrets: `email_imap_host`, `email_imap_password`, `email_smtp_host`, `email_smtp_password`

### Signal (via signal-cli)
- Uses signal-cli in JSON-RPC mode as a subprocess
- **Conversation ID:** derived from Signal group or 1:1 conversation ID
- Handles: text messages, attachments, reactions
- Secrets: `signal_phone_number`

### Telegram (Bot API)
- Long-polling or webhook mode (configurable)
- **Conversation ID:** derived from chat_id + message_thread_id
- Handles: text, photos, documents, inline queries
- Secrets: `telegram_bot_token`

### HTTP API
- REST endpoints for programmatic access
- SSE (Server-Sent Events) for real-time response streaming
- Token-based authentication
- This is the interface a future web dashboard or mobile app would use
- **Conversation ID:** provided by the client or generated server-side

---

## Adding a New Channel

Adding a channel means creating a directory in `src/channels/<name>/` with:
1. A class implementing `ChannelAdapter`
2. Registration in the channel config (`config/default.yaml`)

No core code changes needed. The adapter registers with the bus as `layer: "channel"` and is automatically restricted to channel-safe event types.

---

## Channel Security

- Adapters run with `layer: "channel"` bus permissions — they **cannot** publish agent/execution events
- A compromised adapter can spam `inbound.message` but cannot invoke skills, access memory, or execute tasks directly
- Each adapter handles its own platform authentication (bot tokens, IMAP credentials) via `ctx.secret()`
- Rate limiting is enforced at the dispatch layer, not per-adapter (centralized policy)

### Trust Levels

Each channel is assigned a trust level that the dispatch layer tags on every inbound message:

| Channel | Trust Level | Rationale |
|---|---|---|
| **CLI** | `high` | Requires SSH/physical access to the host |
| **Signal** | `high` | Strong identity via phone number + Signal protocol |
| **Telegram** | `medium` | Platform-verified `chat_id`, but account compromise is possible |
| **HTTP API** | `medium` | Token-authenticated, but tokens can be leaked |
| **Email** | `low` | From headers are trivially spoofable; relies on SPF/DKIM/DMARC |

Trust levels gate which actions the Coordinator can take based on the originating channel. See [06-audit-and-security.md](06-audit-and-security.md#trust-gated-actions) for policy configuration.

### Sender Allowlists

Each channel maintains an allowlist of authorized senders. Messages from unknown senders are rejected silently (default) or held for pairing approval (configurable). This is configured per-channel in `config/default.yaml`.

### Email Validation

The email adapter performs additional validation before publishing `inbound.message`:
- SPF, DKIM, and DMARC header validation
- Reply-To vs From header consistency check
- Messages failing validation are tagged `sender_verified: false` in metadata (not blocked — the Coordinator decides how to handle unverified messages)

---

## Reconnection & Resilience

Each adapter implements reconnection with exponential backoff:
- On disconnect: retry at 1s, 2s, 4s, 8s, ... up to 5 minutes
- After max retries: publish `channel.disconnected` and stop
- On restart: all configured adapters attempt to connect
- Health endpoint reports adapter status (connected/disconnected/disabled)

**Future note:** Voice/telephony adapters will need a `streaming: true` flag on `OutboundMessage` for real-time TTS. Not included at launch — trivial to add when needed.
