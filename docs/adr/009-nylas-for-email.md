# ADR-009: Nylas as email integration layer

Date: 2026-03-10
Status: Accepted

## Context

The email channel needs to send and receive email on behalf of the executive. Options considered:

1. **Direct SMTP/IMAP** — implement the raw email protocols; maximum control, but significant implementation complexity (auth, TLS, bounces, MIME parsing, attachment handling, threading)
2. **SendGrid / Postmark** — outbound-only transactional email APIs; no inbound support
3. **Nylas** — unified email API supporting both inbound webhooks and outbound sending across Gmail, Outlook, and others

## Decision

Use Nylas as the email integration layer.

Nylas was chosen because:
- **Unified API** — inbound and outbound in a single integration. Direct SMTP/IMAP would require maintaining two separate integrations (IMAP for receive, SMTP for send) with all the reconnection, TLS, and authentication complexity that entails.
- **Multi-provider** — Nylas abstracts over Gmail, Outlook, and other providers. The executive's email provider can change without touching Curia's channel adapter.
- **MIME and threading** — Nylas handles MIME parsing, attachment decoding, thread reconstruction, and reply-chain management. These are non-trivial to implement correctly and are not Curia's core competency.
- **Webhooks** — inbound email arrives via webhook push, not polling. This is more reliable and lower-latency than IMAP IDLE.
- **HTML formatting** — Nylas supports sending HTML bodies natively, which the outbound formatter uses to produce readable formatted emails.

## Consequences

- Nylas is a paid third-party service; the integration depends on Nylas's API availability and pricing.
- All email content (subject, body, sender metadata) is processed by Nylas before reaching Curia. This is an accepted privacy trade-off for the integration simplicity it provides.
- Switching email providers (e.g., from Nylas to direct IMAP) would require rewriting the channel adapter but would not affect the bus events or agent layer.
- Nylas API credentials are required in addition to Anthropic and OpenAI credentials.
