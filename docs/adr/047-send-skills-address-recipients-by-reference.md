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

- **Only verified, active identities on the skill's channel count,** and only in a shape that channel can send to. A Signal ACI UUID or an Enterprise Grid `W…` Slack id is skipped rather than chosen. `sms` matches `sms` identities only, not the CRM `phone` channel, which is the same rule the gateway uses to recognise the principal on SMS.
- **A blocked contact is refused.** The gateway checks the To recipient's tier, not each cc, so the resolver refuses first.
- **The contact's primary is used when it is one of those identities** (`primary_email` for email, `primary_phone` for Signal and SMS). Otherwise the oldest usable identity. A primary that is unverified or inactive is ignored. Sending to another verified address of the right person is a far smaller error than pushing the model back to typing one.
- **A label hint names one of them** (`principal#personal`, or `<contact-id>#work`, including each entry of `cc`). See below.
- **Every failure is closed and says what is missing:** a mistyped alias, a UUID that matches no contact, a contact with no verified identity on the channel. An unverified address is never echoed back, so the model is not handed something to retype.
- **`principal` resolves to the principal's contact ID from the hot-reloaded identity snapshot,** which holds verified, active rows only. A UUID that happens to be the principal's resolves the same way and unlocks nothing more. The prompts name only the alias, and a send by alias does not return the contact ID in its result (only a UUID the agent passed is echoed back as `contact_id`).

The important property is how errors fail. A corrupted reference finds no contact and sends nothing. A corrupted address sends to whoever owns it.

### A label hint selects one address (#2047)

Without a hint there is no way to reach a secondary address except the raw field, which is the transcription path this ADR removes. The hint is the text after the first `#` on a reference. A blank hint is no hint. A separate `to_label` field was rejected: `cc` is a list, and a side field can be applied to the wrong entry or dropped by one of the callers. The hint travels inside the string the skill, the pre-gate check, Gate C and the approval display already pass to the resolver, so they cannot choose different addresses.

The hint is matched against the cleaned label: newlines removed, and a label containing `@` or a run of 7 digits is not a label (`cleanedIdentityLabel`). Matching uses that full note, and also accepts an exact match on the 40-character form the principal block shows, so a label copied from the block still works. A hidden label cannot be selected, and it is not quoted in an error, so the model is not handed an address to retype. A hint that itself looks like an address or a phone number is not a hint: the string is not a reference, so an address whose local part contains `#` stays on the raw path.

Matching is case-insensitive. Exact matches win. If none is exact, a label matches when every token of the hint is a token of the cleaned label, where a token is a run of letters or numbers. `work` matches `work email` and not `homework`.

| Situation | Result |
|---|---|
| No hint | Unchanged: the primary, otherwise the oldest |
| One match | That identity |
| One address, and it has no visible label | The default pick. Not an error |
| A hint, and more than one address has no visible label | Nothing is sent. Each candidate is listed as unlabelled |
| Any visible label, and the hint matches none — including when some addresses are unlabelled | Nothing is sent |
| More than one match | Nothing is sent |

An unlabelled address next to labelled ones is a conflict rather than the default. It might have been the address meant, and the error lists it as unlabelled so the agent can retry with no hint. Several unlabelled addresses are a conflict for the same reason: the hint named one of them and the send would otherwise pick the primary silently. The error lists every candidate by its cleaned label (not the 40-character cut), flags the primary, and says to retry with one listed label or omit the label to use the primary (or the oldest, when none of the candidates is the primary). It contains no address. The success result names the identity used: its cleaned label, or `primary`, or `unlabelled`.

### The raw path is separate and deliberate

Raw addresses move to new fields, for someone with no contact record: `to_address` and `cc_addresses` on `email-send`, `recipient_number` on `signal-send` and `sms-send`, and `recipient_user_id` on `slack-send`. A skill refuses an address in a reference field, and a reference field together with its raw field, and points the model at the right field.

### References are checked before any gate, and Gate C uses the result

For the four send skills, the execution layer checks and resolves recipients before the autonomy gates (`resolveSendSkillReferences` in `src/skills/execution.ts`), with the same resolver the skill uses. It refuses an address or template token in a reference field, a reference in a raw field, a reference that does not resolve, and more than 25 references, each with the skill's own message. So no gate files an approval for a send that cannot run. A contact-store outage is classified `DATABASE_UNAVAILABLE`.

Gate C's carve-out parsers read both fields, and the gate substitutes the resolved addresses before comparing. The principal-sole carve-out and the known-tier reply-to-sender check therefore judge the address the skill will send to. A reference shape cannot collide with an address on any send channel: email has `@`, E.164 starts with `+`, and a Slack user id has no hyphens. A hint containing `@` or a run of 7 digits is not a hint, so an address whose local part contains `#` stays an address.

Approvals show what will be sent: each reference as its address followed by the contact name (sanitized, since names come from inbound headers), every cc recipient, and the raw address on the raw path. The stored payload stays the agent's input, so an approval re-resolves the reference when it runs. A reference that no longer resolves is shown as unresolved, rather than as a contact with no verified address: the cause may be a renamed label, not a missing identity.

### Block errors name unmatched recipients

When a filter blocks a send (identity gate, export block, PII redactor error, content filter, in `send()` and `sendEmailDraft()`), the skill error lists each recipient that matches no contact, or matches only an unverified identity, and tells the agent to check the recipient before rewriting the message. The unverified case covers a typo that was delivered once before and so now has an unverified `outbound_recipient` contact. The principal's FYI marks the same recipients. The lookup runs only on a block, so ordinary sends pay nothing. A lookup error leaves that recipient out rather than claim a mismatch.

### Gateway-created contacts get honest provenance

`promoteOrCreateRecipientContact` records a first-time outbound recipient with source `outbound_recipient`, not `ceo_stated`. That source is not auto-verified: the address came from LLM-generated tool input, the opposite of the mechanical extraction that `agent_called` and `email_participant` rely on. The tier stays `known` for now. At `unknown`, Gate C escalates every external send that a reply from that contact leads to, a relay to the principal included, so every legitimate cold outreach would need approval for each follow-up. That decision is #2040.

### No principal-specific similarity rule

Option A is not added. What send-by-reference does not cover:

- **A typo in a raw-address field still sends.** It now reaches only unknown addresses through a field named for that purpose. If a filter blocks it, the error names the address.
- **Choosing the wrong contact** (#727 picked a real but wrong person) is a different failure. A reference makes it an explicit choice of contact rather than a transcription, but nothing here checks it.

## Consequences

- An address the model already has is never retyped on the reference path, for the principal and every other contact, on every channel.
- **Breaking change to four `tool.json` input surfaces.** `to`, `cc` and `recipient` no longer accept addresses. A pending approval stored before the deploy with an address in `to` fails when approved, and the error points at `to_address`. That window is 48 hours.
- Success payloads are unchanged (`to`, `delivered_to` carry the resolved address, which reply-lock and the activity log read) and gain `contact_id` when the agent passed a contact UUID.
- A contact the gateway created after a cold send has an unverified identity, so a later send to it by reference fails closed. The agent uses the raw field again, or the principal verifies the address. #2040 covers whether an inbound reply should verify it.
- Raw-address paths remain: the four raw fields, and `email-draft-save` with `send-draft`. #2041 decides whether to retire them. A secondary address of a known contact can be reached with a label hint, so retiring the raw fields no longer removes that ability.
- A send by reference costs a contact read before the gates and another in the skill, plus one more if an approval is filed.
- An approval resolves the reference again when it runs, up to 48 hours later. If the contact's primary changed in between, the send goes to the contact's new address, which is another verified address of the same person. A hinted reference is resolved again too. If that label was renamed or removed in the window, the approved send fails closed with a conflict rather than falling through to a different address.
- Contacts the gateway created before this change still carry `ceo_stated` and verified identities. Relabelling them is a data change, left to the operator.
