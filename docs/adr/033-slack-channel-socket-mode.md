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
2. **v1 surface:** DMs and `@mentions` only; replies go in-thread for channel mentions.
3. **One Slack workspace per Curia instance.** Bot display name / @handle is chosen by the principal in Slack app settings (typically from office identity); Curia never hardcodes `@curia` and ignores its own messages by bot user id from `auth.test`.
4. **Ship an importable Slack app manifest** for workspace-owned apps. Do not ship a Curia-Inc distributed app in v1.
5. **Outbound** goes through `OutboundGateway` (same as email/Signal). Conversation ids are reversible (`slack:D…`, `slack:C…:<thread_ts>`) per ADR-025.
6. **Identities** use Slack user id (`U…`) with source `slack_participant` (auto-verified like `email_participant` / `signal_participant`).

## Consequences

- Operators must create a Slack app (or import the manifest), install it, and vault `channel.slack.bot_token` + `channel.slack.app_token`, then install/enable Slack in the channel registry and restart.
- Any workspace member can DM the bot and get a low-trust coordinator turn until contacts are elevated — documented and mitigated with an optional channel allowlist for @mentions.
- Events API remains a later alternative if a deployment prefers webhooks.
- Meeting-debrief and other proactive flows can target `channel_id: "slack"` once the gateway path exists, without agent changes.
