# Slack setup

Connect Slack so your team can DM and @mention your Curia agent in your workspace.

Slack does not allow software to join as a normal human user. You create a **workspace-owned Slack App** (bot user), install it, and vault the tokens. Day-to-day use is the same invite UX as a colleague: invite the bot to channels, DM it, or @mention it. After an @mention, you can keep talking in that thread without re-mentioning. See [ADR-033](../adr/033-slack-channel-socket-mode.md).

> Public mirror: this page is the source for [docs.meetcuria.com/channels/slack-setup](https://docs.meetcuria.com/channels/slack-setup). Keep them in sync when editing.

## Prerequisites

- A Slack workspace where you (or an admin) can create apps
- Your Curia **office identity** name (e.g. "Nathan Curia") — use this as the Slack bot display name / @handle

## Step 1 — Create the Slack app from Curia's manifest

1. Open [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**.
2. Paste [`slack-app-manifest.yaml`](./slack-app-manifest.yaml).
3. Replace `YOUR_OFFICE_IDENTITY_NAME` with your office identity (e.g. `Nathan Curia`). Pick a bot username such as `nathancuria` or `nathan` in Slack's app settings if prompted — Curia never assumes `@curia`.
4. Create the app.

## Step 2 — Socket Mode tokens

1. In the app settings, open **Socket Mode** and enable it.
2. Create an **App-Level Token** with scope `connections:write`. Copy the `xapp-…` token.
3. Open **OAuth & Permissions** → **Install to Workspace** (or reinstall after any manifest scope/event change). Copy the **Bot User OAuth Token** (`xoxb-…`).

## Step 3 — Vault credentials in Curia

In the Curia console: **Settings → Channels → Slack**

| Field | Vault key |
|---|---|
| Bot User OAuth Token | `channel.slack.bot_token` |
| App-Level Token | `channel.slack.app_token` |

Install and enable the Slack channel in the registry, then restart Curia (or `docker compose up -d --force-recreate curia`) so the adapter starts.

## Step 4 — First message

1. Invite the bot to a channel (or open a DM with it).
2. Send a DM, or @mention the bot in a channel — Curia replies in-thread for channel mentions.
3. Continue in that thread without re-@mentioning (Curia stays active in the thread until restart).
4. Link your Slack user id to the principal contact (`contact.link-identity`) so Principal Contact Details include Slack and principal-tier trust applies on Slack turns.

Unknown workspace members who message the bot are auto-created as `tier=unknown` contacts (same low-trust constraints as unknown emailers) until you elevate them or link their Slack identity onto an existing contact.

### Optional channel allowlist

To restrict @mentions and in-thread channel replies to specific Slack channels, set in `config/local.yaml`:

```yaml
channels:
  slack:
    allowed_channel_ids:
      - C0123456789
```

DMs are never filtered by this list. Empty/absent = all channels the bot is in.

## Trust

Slack is **medium** trust (`config/channel-trust.yaml`) — weaker than Signal as a *channel floor*. Trust still rides the **sender**: once your Slack `U…` is linked to the principal contact, principal-tier override applies (same contact ledger as email/Signal). Prefer Signal/CLI for high-autonomy approvals when the Slack identity is not linked yet.

## Troubleshooting

| Symptom | Check |
|---|---|
| Adapter not starting | Vault has both tokens; Slack is installed+enabled in Settings → Channels; process was restarted |
| No replies in a channel | Bot is invited; first turn is an @mention (or continue in an already-active thread); channel is on the allowlist if configured |
| Thread replies ignored after restart | Active-thread state is process-local — @mention once to re-activate |
| Socket Mode disconnects | App-level token has `connections:write`; bot token is from the same app; check `curia.log` |
| Bot ignored as unknown | Link the principal's Slack `U…` id via contacts; elevate colleague tiers as needed |
| Missing reactions / channel messages | Re-install the app after updating the manifest (needs `reaction_added`, `message.channels`, `message.groups`, `reactions:read`) |
