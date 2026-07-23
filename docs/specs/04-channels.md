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
- **Always-on safeguard:** the `http` and `cli` channels have `isToggleable: false` — they always start and cannot be disabled (operator-lockout protection). `email`, `signal`, and `slack` are toggleable.
- **Vault key convention:** channel credentials are stored under structured vault keys of the form `channel.<name>.<field>` — e.g. the email channel's Nylas API key lives at `channel.email.nylas_api_key`. A `ChannelCredentialField` may also declare an `envFallback` env var used at bootstrap.

---

## Message Types

```typescript
interface InboundMessage {
  id: string;                  // UUID
  conversation_id: string;     // deterministic, reversible channel-scoped key, e.g. "email:<threadId>",
                               // "signal:+1555...", "signal:group=<id>", "cli:local:default". NOT a UUID —
                               // outbound adapters parse it back to recover the reply target. See ADR-025.
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

Channels are not started merely by being configured — like skills and agents, they are tracked in the `channel_registry` with an install/enable lifecycle (restart-based). The `http` and `cli` channels are non-toggleable and always start; `email`, `signal`, and `slack` must be installed and enabled in the registry (via **Settings → Channels**). Seeding channel credentials alone does not enroll a toggleable channel. Inbound adapters and outbound egress both derive from the same registry gate.

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
- **CEO inbox drafts (v0.35):** the CEO inbox can now find, read, and edit unsent drafts. `ceo-inbox-list` / `ceo-inbox-search` query Nylas's `/drafts` resource (the DRAFTS folder) when scoped with `folder: 'DRAFTS'`; `ceo-inbox-read` accepts a `draft_id` to return a draft's full body; and the new `ceo-inbox-draft-edit` skill updates a draft's recipients/subject/body. Draft results key on `drafts` (not `messages`) so a genuine "none" is distinguishable from a silent zero, and the inbox poll watermark is not applied to drafts.
- **Email accounts (v0.37):** multiple agent-owned mailboxes are managed from the console under **Settings → Channels → Email → Email accounts**. Each account is a row in the `email_accounts` table (migration `064_create_email_accounts.sql`) with its Nylas grant stored in the vault at a per-account key (`channel.email.<name>.nylas_grant_id`). The shared app-level `NYLAS_API_KEY` remains an env-bootstrapped vault secret. The legacy `channel_accounts.email` YAML path and `CEO_PRIMARY_EMAIL` env var are retired.
- **Vault credential wiring (v0.37):** at startup `applyChannelVaultSecrets()` overlays channel vault credentials (`channel.<name>.<field>`) onto the runtime config before adapters are constructed, so credentials saved via the Channels console take effect on the next restart without any env-var or YAML change.
- **Sent-mail observation (v0.42, ADR-029):** a scheduled `ceo-inbox-sent-observe` skill polls the CEO's **Sent** folder through the existing `ceo-inbox` Nylas grant (no new credential). Scope is **all sent mail**. Each run is watermarked (`config-store` under the `ceo_inbox` namespace, same high-water pattern as the inbound email poll) and is idempotent on re-run. For each new sent message it (1) correlates to Curia-authored draft snapshots (below) by `thread_id` + recipients + send time and appends `(draft, sent)` pairs to a rolling OKF evidence doc, and (2) correlates to open `owner='ceo'` tasks for completion candidates, queued in `config-store` (`ceo_inbox`, `sent_observe.completion_candidates`) rather than an OKF doc ([spec 19](19-tasks-and-backlog.md)). It emits a `ceo.sent_observed` audit event and advances the watermark. Observe runs as a **separate daily cron** on `agents/ceo-inbox.yaml` with its own Operating Modes task text — never folded into the 15-min triage loop.
- **Draft capture for voice learning (v0.42):** the three CEO-inbox draft skills (`ceo-inbox-draft-reply`, `ceo-inbox-draft-compose`, `ceo-inbox-draft-edit`) snapshot what Curia proposed into an OKF scratch doc at `/scratch/voice-learning/<draft_id>.md` (frontmatter: `draft_id`, `thread_id`, recipients, subject, `created_at`, `linked_task_ids[]`, `agent_version`; body = drafted markdown). Capture failure logs and **must not** block draft creation. Matched `(draft, sent)` diffs accumulate in `/scratch/voice-learning/pending-diffs.md` for the weekly `voice-learn` job ([spec 13](13-office-identity.md)). That job makes a single batched LLM extraction pass over the accumulated diffs to produce an updated `WritingVoice.guide`, proposed in the digest for CEO approval.
- **OKF evidence retention:** raw draft snapshots and pending-diff evidence are scratch-path docs. Once a pair has been folded into the writing-voice profile (or dismissed), the learning job deletes or TTL-expires the consumed evidence — default scratch TTL applies to unmatched snapshots; consumed evidence must not be retained indefinitely. Shadow drafts for punted mail follow the same scratch path conventions and never surface or send ([spec 14](14-autonomy-engine.md)).
- Nylas abstracts away provider differences (Gmail, Outlook, IMAP) and handles OAuth

### Signal (via signal-cli)
- Uses signal-cli in JSON-RPC mode as a subprocess
- **Conversation ID:** derived from Signal group or 1:1 conversation ID
- Handles: text messages, attachments, reactions
- Secrets: `channel.signal.phone_number` — the canonical namespaced vault key (wired via `applyChannelVaultSecrets`, as above). The legacy flat `signal_phone_number` key was consolidated onto it and backfilled by migration; entering the phone number in the console alone now activates Signal (#1140).

### Slack (via Socket Mode)
- Toggleable channel: principal creates a **workspace-owned** Slack app (import Curia's app manifest), installs it, and vaults `channel.slack.bot_token` + `channel.slack.app_token`. See ADR-033.
- **Inbound:** Socket Mode — DMs (`message.im`), `@mentions` (`app_mention`), and **in-thread replies** in channels/groups Curia is already active in (`message.channels` / `message.groups`). Reactions normalize to `inbound.reaction` (approval correlation is a follow-up). Ignores edits, bot messages, and channel traffic outside active threads. Own messages ignored by bot user id from `auth.test` (never by a hardcoded `@curia` string). Bot display name / @handle is set in Slack to match office identity. Inbound text has Slack entities decoded; outbound agent Markdown is converted to mrkdwn.
- **Outbound:** `OutboundGateway` → `chat.postMessage` (mrkdwn). Channel mentions and active-thread replies stay in-thread. Principal checks use Slack user id `U…` (`isPrincipalSlack`), not conversation ids.
- **Conversation ID:** DM `slack:D<conversationId>` or `slack:D…:<thread_ts>` when threaded; channel thread `slack:C<channelId>:<thread_ts>` (reversible per ADR-025).
- **Trust:** `medium`, `unknown_sender: allow`, `threaded: true` (`config/channel-trust.yaml`). Sender `U…` resolves through the unified contact ledger — principal-linked Slack identities get principal-tier override. Optional `channels.slack.allowed_channel_ids` allowlist for @mentions / thread replies.
- **Identity:** Slack user id (`U…`) as `channel_identifier`, source `slack_participant` (same `contact_channel_identities` table as email/Signal).

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
| **Slack** | `medium` | Workspace OAuth / bot token — weaker than Signal (ADR-033) |
| **Email** | `low` | From headers are trivially spoofable; relies on SPF/DKIM/DMARC |

Trust levels gate which actions the Coordinator can take based on the originating channel. See [06-audit-and-security.md](06-audit-and-security.md#trust-gated-actions) for policy configuration.

### Sender Allowlists

Superseded by the contact resolver (see [09-contacts-and-identity.md](09-contacts-and-identity.md#unknown-sender-policy)). Unknown senders are no longer gated by a per-channel allowlist; they are handled by the `unknown_sender` policy in `config/channel-trust.yaml`, which is either `allow` (auto-create a `tier='unknown'` contact and route to the coordinator in low-trust mode) or `ignore` (silently drop). The former hold-for-pairing-approval path was removed with the held-messages machinery in #947.

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

## Known Deficiencies

- **Reply-To vs From header consistency check** — not yet implemented.
- **Reconnection with exponential backoff** — partial; Signal has full backoff, email uses polling (no reconnect path needed), HTTP/CLI not applicable.
- **`channel.disconnected` event emission** — not yet implemented; event type not emitted, Signal adapter stops but does not publish this event.
- **Health endpoint adapter status** — not yet implemented; health endpoint only reports DB, agents, and skills.
- **Outbound message queue for disconnected channels** — not yet implemented (max 100, delivered on reconnect). (#1380)
