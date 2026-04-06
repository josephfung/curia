# ADR-010: Signal as high-trust messaging channel, rejecting Telegram

Date: 2026-05-05
Status: Accepted

## Context

The system needed a high-trust, low-friction messaging channel for the executive to communicate with the agent — one where messages can trigger high-autonomy actions (setting autonomy scores, managing contacts, initiating outbound communication on their behalf).

Two candidates were considered for this channel: Signal and Telegram.

Both are mobile-first messaging apps with bot/API support. The question was which to adopt as the high-trust channel, given that messages on this channel bypass the provisional sender queue and can invoke skills with elevated `action_risk` levels.

## Decision

Signal is adopted as the high-trust messaging channel. Telegram support was removed from the planned channel list.

Signal was chosen because:
- **End-to-end encryption by default** — Signal's protocol (the Signal Protocol) encrypts all messages end-to-end with no server-side access. Telegram uses client-server encryption by default; end-to-end is only available in "Secret Chats" and is not available in group chats or bots.
- **Trust alignment** — the high-trust channel carries messages that can authorize high-autonomy actions. The security properties of that channel must match the trust level it implies.
- **No cloud storage of messages** — Telegram stores message history on Telegram's servers by default. Signal does not. For an executive assistant with access to sensitive business context, server-side message retention is a meaningful risk.
- **Operational simplicity** — maintaining two messaging channels with similar trust levels adds complexity without proportional value.

Telegram remains a technically viable channel for lower-trust, higher-volume use cases (e.g., public-facing bots) — it is not globally rejected, only rejected as the high-trust executive channel.

## Consequences

- Signal is the only high-trust messaging channel at launch.
- The Signal channel adapter requires the `signal-cli` integration or an equivalent Signal API bridge (Signal does not offer an official bot API).
- Telegram-based workflows planned in early design documents are deprecated.
- If Telegram support is added in the future, it should be as a lower-trust channel, not a peer to Signal.
