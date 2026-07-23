# ADR-033: Slack as a medium-trust channel via Socket Mode

Date: 2026-07-20
Status: Accepted

## Context

Curia needs a workspace messaging channel so the principal and colleagues can interact with the agent in Slack — DMs and @mentions in channels they invite the bot into. Slack does not allow software to join as an ordinary human user; automation must be a Slack App (bot user).

Transport alternatives:

1. **Events API (HTTP webhooks)** — Slack POSTs to a public HTTPS URL on the Curia host. Requires inbound reachability, TLS, and request signature verification.
2. **Socket Mode** — Curia opens an outbound WebSocket with an app-level token. No public webhook URL. Mirrors Signal’s push-over-socket operational model for self-hosted deployments.

Trust / surface alternatives:

- Match Signal’s `high` trust — rejected; Slack workspace OAuth is weaker than Signal’s phone + E2E identity (see ADR-010).
- Respond to every message in a channel — rejected for v1; open channels are a leak risk for a CEO assistant.
- Reuse Signal’s all-members group-trust check — rejected for v1; Slack channels are often large, and membership checks on every mention are impractical. Per-sender contact tier + optional channel allowlist is the safety model.

App distribution alternatives:

- **Importable per-workspace manifest** (principal creates their own Slack app) — fits single-tenant self-host.
- **Curia-Inc distributed Slack App** — easier install, but central credentials and multi-workspace OAuth fight self-host/single-tenant design.

## Decision

1. **Slack is a toggleable, medium-trust channel** (`unknown_sender: allow`, `threaded: true`) using **Socket Mode** (`@slack/socket-mode` + `@slack/web-api`).
2. **v1 surface:** DMs, `@mentions`, and **in-thread continuation** once Curia is active in a thread (subscribe to `message.channels` / `message.groups`; track active `thread_ts`). Replies go in-thread. DM threads are keyed when `thread_ts` is present (`slack:D…:<thread_ts>`).
3. **Trust the sender, not the conversation.** Every trust decision resolves Slack user id `U…` → `contact_channel_identities` → contact tier (same ledger as email/Signal). Channel floor is `medium`; a principal whose Slack identity is linked gets principal-tier override via `trust-scorer`. Outbound principal carve-outs use `isPrincipalIdentity('slack', U…)` — never `D…`/`C…`.
4. **Unknown DMers** auto-create as `tier: unknown` (parity with unknown emailers). Cross-channel identity unifies when the same person’s Slack `U…` is linked onto an existing contact.
5. **Reactions** normalize to bus event `inbound.reaction` (channel-agnostic). Emoji→intent (e.g. 👍 → approve) lives in dispatch/approval, not the Slack adapter. Manifest includes `reaction_added` + `reactions:read` now; approval correlation is a tracked follow-up.
6. **Markdown ↔ mrkdwn** both ways: outbound Markdown→mrkdwn before `chat.postMessage`; inbound Slack entities decoded before the agent sees text.
7. **One Slack workspace per Curia instance.** Bot display name / @handle is chosen by the principal in Slack app settings (typically from office identity); Curia never hardcodes `@curia` and ignores its own messages by bot user id from `auth.test`.
8. **Ship an importable Slack app manifest** for workspace-owned apps. Do not ship a Curia-Inc distributed app in v1.
9. **Outbound** goes through `OutboundGateway` (same as email/Signal). Conversation ids are reversible (`slack:D…`, `slack:D…:<thread_ts>`, `slack:C…:<thread_ts>`) per ADR-025.
10. **Identities** use Slack user id (`U…`) with source `slack_participant` (auto-verified like `email_participant` / `signal_participant`).

## Consequences

- Operators must create a Slack app (or import the manifest), install it, and vault `channel.slack.bot_token` + `channel.slack.app_token`, then install/enable Slack in the channel registry and restart. Re-install after manifest event/scope updates.
- Any workspace member can DM the bot and get a low-trust coordinator turn until contacts are elevated — documented and mitigated with an optional channel allowlist for @mentions / thread replies.
- **Channel message surface area:** `message.channels` / `message.groups` mean the process receives *every* message in every channel the bot is in, then discards non-active-thread traffic before bus publish. Slack has no per-thread subscription API — this is the only way to get in-thread continuation. In large/busy workspaces that increases Socket Mode event volume (CPU/ack cost) even when almost all events are dropped; keep the bot out of high-noise channels or use `allowed_channel_ids`.
- Active-thread state, DM-peer map, and inbound dedupe are **process-local** (TTL + size-capped; cleared on stop; lost on restart/reconnect). After restart, a fresh `@mention` re-activates a channel thread. Dedupe absorbs Slack redelivery-on-missed-ack, not overlapping `message.im` + `app_mention` (those events are disjoint).
- **Outbound principal asymmetry:** reply-path `recipientId` is the inbound Slack `U…` (dispatcher stamps `routing.senderId`), so principal carve-outs work across restarts for replies. The DM-peer map is only a fallback (e.g. proactive DM without a stamped `U…`) and is lost on restart — until the peer messages again, outbound treats the target as non-principal (fail-closed; carve-outs simply do not apply). Inbound principal recognition remains durable via contact linkage.
- `inbound.reaction.conversationId` is best-effort (may key on a thread-reply ts rather than the thread root). Approval correlation must use `targetMessageId` ↔ `outbound.delivered.messageId`, not `conversationId`. Until that wiring lands, `inbound.reaction` is published and unconsumed (bus delivers to zero handlers — no unhandled-event warning).
- Events API remains a later alternative if a deployment prefers webhooks.
- Meeting-debrief and other proactive flows can target `channel_id: "slack"` once the gateway path exists, without agent changes.
- Reaction→approval wiring is intentionally a follow-up (#1479) so the bus primitive ships with Slack.
- Contact auto-create (create → link → orphan cleanup) is duplicated with Signal’s adapter; extract into `ContactService` when a fourth channel lands.
