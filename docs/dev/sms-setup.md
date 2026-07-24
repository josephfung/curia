# SMS channel setup (Telnyx)

Two-way office SMS on a **dedicated Telnyx DID**. This is Curia's SMS transport —
not a port of a personal/TextNow number. See ADR-036 and issue #1478.

## Prerequisites

- Public HTTPS URL for your Curia host (Telnyx must reach the webhook)
- Telnyx Mission Control account with funded balance
- US A2P: brand + **Low-Volume Mixed** 10DLC campaign (Sole Proprietor only if no EIN)

## Steps

1. In Telnyx Mission Control, complete 10DLC brand + Low-Volume Mixed campaign.
2. Buy a **voice+SMS** US local long code (prefer voice+SMS so Phase 2 PSTN can reuse it).
3. Create/attach a Messaging Profile. Set webhook URL to:
   `https://<your-host>/api/webhooks/telnyx/sms` (API v2).
4. Copy: API key, office DID (E.164), and account **Public Key** (Keys & Credentials).
5. In Curia **Settings → Channels → SMS**, enter those three values (vault keys
   `channel.sms.api_key`, `channel.sms.from_number`, `channel.sms.webhook_public_key`).
6. Install + enable `sms` in the channel registry; **restart** Curia.
7. On Contacts → principal, add your **personal mobile** as an `sms` channel identity
   (verified) so Gate C / principal detection work. Optionally also store CRM `phone`
   for profile. Never use the office DID as the principal's personal identity.

## Compliance (STOP / START / HELP)

Inbound keyword messages are handled before the agent:

| Keyword | Behavior |
|---|---|
| STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT | Persist opt-out; auto-reply confirmation; block further outbound |
| START, YES, UNSTOP | Clear opt-out; auto-reply confirmation |
| HELP, INFO | Auto-reply help text |

Outbound `sms-send` and SMS replies refuse opted-out numbers.

## Cost floor

US steady-state is roughly **~$3–5/mo** after ~$20 one-time 10DLC registration
(number rent + Low-Volume Mixed + usage). International send is extra.

## Non-goals (v1)

- Porting consumer numbers as the office DID
- MMS / group SMS
- In-app Telnyx OAuth / automated number purchase
