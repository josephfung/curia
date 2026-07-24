# ADR-036: Telnyx SMS channel on a dedicated office DID

Date: 2026-07-24
Status: Accepted

## Context

Curia needs two-way SMS so the office can text the principal and third parties on a
dedicated number. Specs treated telephony as future; `contact_channel_identities`
already supports CRM `phone` / E.164, but there was no SMS transport.

Vendor research (Twilio, Telnyx, Plivo, Bandwidth, AWS End User Messaging, Textbelt)
against Curia’s needs — self-serve DID buy, two-way cold inbound, webhooks, Node,
global SMS without an enterprise floor, low volume cost — favored **Telnyx**:
Mission Control self-serve, ~$1/mo DID, global PAYG, thin HTTP API. Steady-state
operator cost is roughly **~$3–5/mo** after one-time 10DLC registration; fixed costs
dominate at Curia volume.

Alternatives rejected as the default:

- **Plivo** — cheap DID, but Professional is US+India only (global needs Enterprise).
- **Twilio** — fine DX; unused ecosystem premium at our scale; onboarding doc name-drop
  is not a reason.
- **Textbelt / shared From** — reply-only after outbound; wrong shape for an office line.
- **Porting a consumer number (TextNow, etc.)** — no suitable server API for cold
  inbound + authenticated send.

Trust: SMS From headers / carrier identity are spoofable and not E2E — must not match
Signal’s `high` (ADR-010). Medium matches Slack (ADR-033).

Voice (#1414) is orthogonal for Phase 1 (self-hosted LiveKit + Deepgram + Cartesia).
Phase 2 PSTN should prefer **Telnyx SIP → self-hosted LiveKit** so the same voice+SMS
DID can be reused without renumbering — SMS must not force Telnyx Voice AI or
LiveKit-on-Telnyx.

## Decision

1. **SMS is a toggleable, medium-trust channel** (`unknown_sender: allow`,
   `threaded: false`) named `sms`, using **Telnyx Messaging** only at v1 behind a
   thin `SmsProvider` / client interface (swap later is cheap; do not multi-provider).
2. **New office DID only** — US local long code with **voice+SMS**, attached to a
   Messaging Profile whose webhook points at Curia. Product and docs never instruct
   operators to port TextNow / consumer numbers as the office DID.
3. **10DLC default:** brand + **Low-Volume Mixed** campaign. Document signup, DID
   purchase, and STOP/opt-out; implement app-level opt-out so outbound respects
   STOP even when the agent would otherwise reply.
4. **Conversation ids:** `sms:<E.164>` (ADR-025); 1:1 only in v1 (no MMS, no groups).
5. **Inbound:** signed Telnyx webhook (`telnyx-signature-ed25519` + timestamp) on the
   HTTP API (`POST /api/webhooks/telnyx/sms`); invalid signatures rejected.
6. **Outbound:** `OutboundGateway` + `sms-send` skill (`action_risk: medium`); channel
   owns `outbound-request.ts` and `principal-rules.ts` (ADR-034 / ADR-035). Principal
   personal mobile is linked as a verified **`sms`** channel identity for Gate C
   (CRM `phone` remains reach-CEO / profile data — never the transport DID).
7. **Trust floor:** `medium` in `config/channel-trust.yaml`. Inbound auto-create uses
   source `sms_participant` but is **not** auto-verified (spoofable From).
8. **Voice:** no changes to #1414 Phase 1. Prefer Telnyx as Phase 2 PSTN SIP trunk
   into the existing VoiceRuntime.

## Consequences

- Operators create a Telnyx account, complete 10DLC, buy a voice+SMS DID, vault
  `channel.sms.api_key` / `from_number` / `webhook_public_key`, enable `sms` in the
  channel registry, and restart. Public HTTPS + signature verify are required for
  self-hosted deploys (unlike Signal’s Unix socket).
- 10DLC approval latency / rejection is an ops risk; Sole Proprietor only when no EIN.
- International send pricing varies; docs should state the US floor and that
  international is extra.
- A thin provider seam keeps a future Twilio swap local to `sms-client.ts` without
  rewriting adapter / gateway wiring.
- Phase 2 voice can reuse the same DID via Telnyx SIP without forcing SMS onto the
  LiveKit media path.
