# ADR-047: Send skills address recipients by contact reference, not by typed address

Date: 2026-10-07
Status: Accepted

## Context

Three incidents share one failure. A model has the right recipient in context and types a different one into a send skill's free-text address field:

| Date | Skill | What it typed | Issue |
|---|---|---|---|
| 2026-05-26 | `signal-send` | another existing contact's number | #727 |
| 2026-09-30 | `email-send` | the principal's address with `.com` for `.ca` (a live third-party domain) | #1950 |
| 2026-10-07 | `email-send` | the principal's address with a dot inserted into the domain | #2033 |

The #1950 prompt fix (closed-set wording, a `[primary]` marker, "principal" vocabulary) was live for the third incident. A correct send from a byte-identical prompt followed 15 minutes later, and 2 of 10 bullpen-triggered emails to the principal in that week had a corrupted address. The address was in context every time. Prompting has nowhere left to go, and ADR-046 ranks code enforcement above prompt rules.

The third incident also showed a second weakness. The judge blocked the send three times for `audience_leak`, correctly, but no block reason named the recipient. The agent rewrote the body each time until attempt five passed and went to the invented domain. The gateway then recorded that address as a `known` contact with source `ceo_stated` and a verified identity, as if the principal had stated it.

Alternatives considered:

- **A near-miss check at the gateway.** Block a send whose address is close to a principal identity (edit distance, Jaro-Winkler) but not equal to one. Rejected:
  - It protects only the principal. Every other contact's address can still be mistyped into anyone's.
  - It catches only typo-shaped errors. #727 was a different real contact's number, with no similarity at all.
  - Similarity is not meaningful for phone numbers or Slack ids.
  - The principal's own addresses resemble each other and family members share a surname, so false positives are built in and the threshold needs ongoing tuning.
  - A corruption just outside the threshold sends silently, so passing proves nothing.
- **More prompt wording.** Already tried (#1950). The error is stochastic transcription, not missing context.
- **The principal's contact ID as its handle.** Spec 09 keeps `${principal_contact_id}` opt-in because it unlocks calendar and attribute reads, and the coordinator does not opt in. A reserved alias stays within what every agent already sees.
- **One overloaded recipient field** that accepts a reference or an address, told apart by shape. Rejected: the raw path would not be deliberate, and the model would keep typing addresses into the field it already uses.
- **No raw path at all; cold outreach creates a contact first** (#727's design). Deferred to #2041. It changes how agents reach new people, which is a product decision.

## Decision

### Send skills take a reference

`email-send` (`to`, `cc`), `signal-send`, `sms-send` and `slack-send` (`recipient`) take a contact reference: a contact UUID, or the reserved alias `principal`. The model chooses the person, and the gateway reads the address from that contact's identities. The resolver is `src/skills/_shared/recipient-reference.ts`, exposed as `OutboundGateway.resolveRecipientReference`.

- **Only verified, active identities on the skill's channel count.** `sms` matches `sms` identities only, not the CRM `phone` channel, which is the same rule the gateway uses to recognise the principal on SMS.
- **The contact's primary is used when it is one of those identities** (`primary_email` for email, `primary_phone` for Signal and SMS). Otherwise the oldest usable identity. A primary that is unverified or inactive is ignored. Sending to another verified address of the right person is a far smaller error than pushing the model back to typing one.
- **Every failure is closed and says what is missing:** a mistyped alias, a UUID that matches no contact, a contact with no verified identity on the channel. An unverified address is never echoed back, so the model is not handed something to retype.
- **`principal` resolves to the principal's contact ID from the hot-reloaded identity snapshot,** which holds verified, active rows only. A UUID that happens to be the principal's resolves the same way and unlocks nothing more. The prompts name only the alias.

The important property is how errors fail. A corrupted reference finds no contact and sends nothing. A corrupted address sends to whoever owns it.

### The raw path is separate and deliberate

Raw addresses move to new fields, for someone with no contact record: `to_address` and `cc_addresses` on `email-send`, `recipient_number` on `signal-send` and `sms-send`, and `recipient_user_id` on `slack-send`. A skill refuses an address in a reference field, and a reference field together with its raw field, and points the model at the right field.

### Gate C resolves references the same way

Gate C's carve-out parsers read both fields, and the gate resolves references with the same resolver before comparing (`resolveGateCRecipientReferences` in `src/skills/execution.ts`). The principal-sole carve-out and the known-tier reply-to-sender check therefore judge the address the skill will send to. A reference that matches no contact returns the resolver's error instead of creating an escalation. A reference shape cannot collide with an address on any send channel: email has `@`, E.164 starts with `+`, and a Slack user id has no hyphens.

### Block errors name unmatched recipients

When a filter blocks a send (identity gate, export block, PII redactor error, content filter, in `send()` and `sendEmailDraft()`), the skill error lists each recipient that matches no contact and tells the agent to check the recipient before rewriting the message. The principal's FYI marks the same recipients. The lookup runs only on a block, so ordinary sends pay nothing. A lookup error leaves that recipient out rather than claim a mismatch.

### Gateway-created contacts get honest provenance

`promoteOrCreateRecipientContact` records a first-time outbound recipient with source `outbound_recipient`, not `ceo_stated`. That source is not auto-verified: the address came from LLM-generated tool input, the opposite of the mechanical extraction that `agent_called` and `email_participant` rely on. The tier stays `known` for now. At `unknown`, Gate C escalates every external send that a reply from that contact leads to, a relay to the principal included, so every legitimate cold outreach would need approval for each follow-up. That decision is #2040.

### No principal-specific similarity rule

Option A is not added. What send-by-reference does not cover:

- **A typo in a raw-address field still sends.** It now reaches only unknown addresses through a field named for that purpose. If a filter blocks it, the error names the address.
- **Choosing the wrong contact** (#727 picked a real but wrong person) is a different failure. A reference makes it an explicit choice of contact rather than a transcription, but nothing here checks it.

## Consequences

- An address the model already has is never retyped on the reference path, for the principal and every other contact, on every channel.
- **Breaking change to four `tool.json` input surfaces.** `to`, `cc` and `recipient` no longer accept addresses. A pending approval stored before the deploy with an address in `to` fails when approved, and the error points at `to_address`. That window is 48 hours.
- Success payloads are unchanged (`to`, `delivered_to` carry the resolved address, which reply-lock and the activity log read) and gain `contact_id` on the reference path.
- A contact the gateway created after a cold send has an unverified identity, so a later send to it by reference fails closed. The agent uses the raw field again, or the principal verifies the address. #2040 covers whether an inbound reply should verify it.
- Raw-address paths remain: the four raw fields, and `email-draft-save` with `send-draft`. #2041 decides whether to retire them.
- A send by reference costs one contact read in the skill, and one more in Gate C for externally initiated tasks.
