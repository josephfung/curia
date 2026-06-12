# 04 — Channels

## Overview

Each channel is a self-contained adapter that translates between platform-specific formats and the framework's normalized message types. Channels are the only way messages enter and exit the system.

---

## Channel Interface

Every channel implements the formal `Channel` contract in `src/channels/channel.ts`. This replaces the previous duck-typed `ChannelAdapter { id; start; stop; send }` pattern. Notably, there is **no `send()` method** — outbound delivery now flows through the `OutboundGateway`, not through the channel object itself.

```typescript
interface Channel {
  readonly name: string;          // 'email' | 'signal' | 'http' | 'cli' — matches catalog + registry row
  readonly isToggleable: boolean; // false for http and cli (always-on safeguard channels)
  start(): Promise<void>;         // connect/listen
  stop(): Promise<void>;          // graceful, idempotent teardown (process shutdown)
}
```

Each channel:
- Publishes `inbound.message` (normalized) when a platform message arrives
- Has its outbound responses delivered via the `OutboundGateway` (channels are no longer responsible for `send()`)
- Handles its own connection lifecycle, authentication, and reconnection

### Channel Catalog & Registry

Channels are described by a static catalog (`src/channels/catalog.ts`) and tracked at runtime in a registry table, mirroring the skill/agent registry model (spec 03).

```typescript
interface ChannelDescriptor {
  name: string;
  description: string;
  isToggleable: boolean;
  credentialFields: ChannelCredentialField[];
  requiredSecretKeys: string[];
}

interface ChannelCredentialField {
  key: string;
  label: string;
  secret: boolean;
  envFallback?: string;   // bootstrap env var fallback
}
```

- **Registry table** (`channel_registry`, migration `052_create_channel_registry.sql`): `name` (PK), `enabled`, `is_toggleable`, `installed_at`/`installed_by`, `enabled_at`/`enabled_by`, `updated_at`.
- **Always-on safeguard:** the `http` and `cli` channels have `isToggleable: false` — they always start and cannot be disabled (operator-lockout protection). `email` and `signal` are toggleable.
- **Vault key convention:** channel credentials are stored under structured vault keys of the form `channel.<name>.<field>` — e.g. the email channel's Nylas API key lives at `channel.email.nylas_api_key`. A `ChannelCredentialField` may also declare an `envFallback` env var used at bootstrap.

---

## Message Types

```typescript
interface InboundMessage {
  id: string;                  // UUID
  conversation_id: string;     // deterministic UUID v5 from channel:user_id:thread_id
  channel_id: string;          // e.g., "email"
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

Channels are not started merely by being configured — like skills and agents, they are tracked in the `channel_registry` with an install/enable lifecycle (restart-based). The `http` and `cli` channels are non-toggleable and always start; `email` and `signal` must be enabled in the registry.

### CLI
Interactive terminal for local dev and testing. Reads from stdin, writes to stdout. Simplest adapter — useful for testing agent logic without external services. **Non-toggleable** (`isToggleable: false`): always starts, cannot be disabled.

### Email (via Nylas API)
- **Inbound:** Polls Nylas Messages API at configurable interval (default: 30s)
- **Poll high-water mark (resilience):** the adapter persists its `lastSeenTimestamp` high-water mark via `ConfigStore` (namespace `system:email-poll-state`, key `<accountId>.last_seen_at`) so restarts resume where they left off. This watermark is **code-managed, not LLM-managed**.
- **Poll observability:** a `channel.poll` audit event is emitted once per poll cycle. A watchdog emits a `channel.stalled` audit event (at most once per adapter lifecycle) when no successful poll completes within `5 × pollingIntervalMs`.
- **Outbound:** Sends via Nylas Send API
- **Conversation ID:** derived from Nylas thread ID (`email:<threadId>`)
- **Participant extraction:** From/To/CC addresses are extracted and auto-create contacts
- **Attachments (inbound):** parsed and passed through as `Attachment[]`
- **Attachments (outbound, v0.33):** all five outbound email skills (`email-send`, `email-reply`, `email-draft-save`, `ceo-inbox-draft-compose`, `ceo-inbox-draft-reply`) accept an `attachments` input. Files are read from `file://` URLs backed by `TempFileStore`, validated, and forwarded to Nylas (multipart `FormData` on the CEO-inbox path; `Buffer` content via the Nylas SDK on the Curia-outbound path), capped at 20 MB total / 10 attachments. The `drive-download-file` skill bridges Google Drive → `TempFileStore`, returning a `file://` URL so Drive files can be attached.
- Secrets: `NYLAS_API_KEY`, `NYLAS_GRANT_ID`, `NYLAS_SELF_EMAIL`
- Nylas abstracts away provider differences (Gmail, Outlook, IMAP) and handles OAuth

### Signal (via signal-cli)
- Uses signal-cli in JSON-RPC mode as a subprocess
- **Conversation ID:** derived from Signal group or 1:1 conversation ID
- Handles: text messages, attachments, reactions
- Secrets: `signal_phone_number`

### HTTP API
- REST endpoints for programmatic access
- SSE (Server-Sent Events) for real-time response streaming
- Token-based authentication
- This is the interface a future web dashboard or mobile app would use
- **Conversation ID:** provided by the client or generated server-side
- **Non-toggleable** (`isToggleable: false`): always starts, cannot be disabled — disabling HTTP would lock operators out of the registry API itself.

---

## Adding a New Channel

Adding a channel means creating a directory in `src/channels/<name>/` with:
1. A class implementing the `Channel` interface from `src/channels/channel.ts` (`name`, `isToggleable`, `start()`, `stop()`)
2. A `ChannelDescriptor` entry in `src/channels/catalog.ts` (credential fields + required secret keys)
3. Registration in the channel config (`config/default.yaml`)

The channel registers with the bus as `layer: "channel"` and is automatically restricted to channel-safe event types. A new toggleable channel starts **disabled** in the `channel_registry` and must be installed/enabled (restart-based) before it starts; `http`/`cli` are non-toggleable and always run.

---

## Channel Security

- Adapters run with `layer: "channel"` bus permissions — they **cannot** publish agent/execution events
- A compromised adapter can spam `inbound.message` but cannot invoke skills, access memory, or execute tasks directly
- Each adapter handles its own platform authentication (bot tokens, Nylas API keys) via `ctx.secret()` or environment variables
- Rate limiting is enforced at the dispatch layer, not per-adapter (centralized policy)

### Trust Levels

Each channel is assigned a trust level that the dispatch layer tags on every inbound message:

| Channel | Trust Level | Rationale |
|---|---|---|
| **CLI** | `high` | Requires SSH/physical access to the host |
| **Signal** | `high` | Strong identity via phone number + Signal protocol |
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

---

## Implementation Status

| Item | Status |
|---|---|
| `Channel` interface (`name`, `isToggleable`, `start`, `stop` — no `send`; outbound via `OutboundGateway`) in `src/channels/channel.ts` | Done |
| Channel catalog (`ChannelDescriptor` + `ChannelCredentialField`) in `src/channels/catalog.ts` | Done |
| Channel registry — `channel_registry` table, install/enable lifecycle, restart-based; `http`/`cli` non-toggleable | Done |
| Channel credential vault keys — `channel.<name>.<field>` convention | Done |
| Email poll high-water mark — `lastSeenTimestamp` persisted via `ConfigStore` (`system:email-poll-state`), code-managed | Done |
| Email poll observability — `channel.poll` per cycle; `channel.stalled` watchdog at `5 × pollingIntervalMs` | Done |
| `InboundMessage` type | Done |
| `OutboundMessage` type | Done |
| CLI channel adapter | Done |
| Email channel adapter (Nylas API, polling, participant extraction) | Done |
| Signal channel adapter (signal-cli JSON-RPC subprocess) | Done |
| HTTP API channel adapter (REST + SSE) | Done |
| Trust levels assigned to each channel (`config/channel-trust.yaml`) | Done |
| Sender allowlists per channel | Not Done — superseded by contact resolver (spec 09); no allowlist config present |
| Email validation: SPF/DKIM/DMARC header check | Done |
| Email validation: Reply-To vs From header consistency check | Not Done |
| Reconnection with exponential backoff | Partial — Signal has full backoff; email uses polling (no reconnect path needed); HTTP/CLI not applicable |
| After max retries: publish `channel.disconnected` and stop | Not Done — event type not emitted; Signal adapter stops but does not publish this event |
| Health endpoint reports adapter status (connected/disconnected/disabled) | Not Done — health endpoint only reports DB, agents, and skills |
| Outbound message queue for disconnected channels (max 100, delivered on reconnect) | Not Done |
| Email reply quoting — `email-reply` appends the quoted original message body to drafts and sends | Done |
| Email search — `is:unread` is embedded into the Nylas search string when `unread_only` is set alongside a search query | Done |
