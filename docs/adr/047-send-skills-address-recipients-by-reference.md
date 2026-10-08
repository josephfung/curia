# ADR-047: Send skills address recipients by contact reference, not by typed address

Date: 2026-10-07
Status: Accepted
Amended: 2026-10-07 — no raw-address path; agent-entered contacts (#2041)

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
- **No raw path at all; cold outreach creates a contact first** (#727's design). Deferred from #2033 as a product decision, then adopted in #2041: see "No raw path" below.

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

The hint is matched against the cleaned label: newlines removed, and a label containing `@` or a run of 7 digits is not a label (`cleanedIdentityLabel`). Matching uses that full note, and also accepts an exact match on the 40-character form the principal block shows, so a label copied from the block still works. A hidden label cannot be selected, and it is not quoted in an error, so the model is not handed an address to retype. A hint that itself looks like an address or a phone number is not a hint: the string is not a reference, so an address whose local part contains `#` is refused as an address in a reference field.

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

### No raw path: cold outreach creates a contact first (#2041)

The send skills take references only. `to_address`, `cc_addresses`, `recipient_number` and `recipient_user_id` are retired, and so is `email-draft-save`'s typed `to`, which is now a reference too. Someone who is not a contact yet is added with `contact-create`, which returns the contact ID to send to. The coordinator pins `contact-create`, so a cold outreach is two calls in one turn.

A call that still passes a retired input is refused, not ignored. A dropped `cc_addresses` would send to fewer people than asked and report success. The pre-gate check refuses it, the handler refuses it, and the Gate C parsers treat it as an unparsed recipient key and fail closed. The message names the input, the reference input that replaced it, and `contact-create`. A blank value (`""`, `[]`, null) is not present: models fill unused optional inputs with one.

`send-draft` is unchanged. It sends a draft's envelope as stored, behind its principal-origin gate (ADR-017). Once `email-draft-save` addresses drafts by reference, every draft it sends was addressed by reference or by a person in their own mail client. `ceo-inbox-draft-compose` and `ceo-inbox-draft-edit` still take typed addresses. Their drafts sit in the principal's Gmail and Curia cannot send them. #2053 covers them.

### Agent-entered addresses: `agent_stated`, verified after a duplicate check (#2041)

`contact-create` and `contact-link-identity` used to record `ceo_stated`, so an address an agent typed looked like the principal's own statement. They now record `agent_stated`. `ceo_stated` stays where the principal entered the data: the console and the setup wizard.

`agent_stated` is auto-verified, because otherwise "create, then send by ID" could not work: the resolver sends only to verified identities. The verification is earned by a duplicate check that runs before anything is written (`ContactService.findLikelyDuplicates`):

| Finding | Result |
|---|---|
| The identifier is already on another contact, same channel (email ignoring case, numbers by digits) | Refused, naming that contact. No override |
| The same number on a sibling phone channel (`phone`, `signal`, `sms`) | Candidate |
| A near-miss email: optimal-string-alignment distance 1–2, or 1 when the shorter address has fewer than 12 characters | Candidate |
| A near-miss number: distance 1 on the digits | Candidate |
| The same display name, ignoring case and spacing (`contact-create` only) | Candidate |

A candidate blocks the write until the agent passes `distinct_from` listing every candidate's ID. The list is a statement, "I checked these and they are different people". A boolean override was rejected because a model learns to set a flag before it has seen anything. Refusals name contacts and reasons, never an address. The principal is listed as `the principal`, with `principal` as its `distinct_from` token, so their contact ID stays out of the model's context. Because `sanitizeDisplayName` strips `@`, a contact the gateway named after its address is stored without it (`sam.rivera@vendor.example` is stored as `sam.riveravendor.example`), so a refusal names a candidate by its contact ID alone when its name looks like an address, a number or a Slack id, which includes a single dotted token with no spaces (`isAddressLikeName`). The send resolver's errors follow the same rule. A check that cannot run refuses the write.

Nothing on the server enforces the order: `agent_stated` is auto-verified on the premise that `contact-create` and `contact-link-identity` are its only writers and both run `findLikelyDuplicates` first, so any future writer of `agent_stated` must run it before writing too. They are not the only agent writers of an auto-verified source: `contact-register` (ceo-inbox only) records `agent_called`, which is auto-verified without the duplicate check. That is an open question, tracked in #2061.

Identifiers are normalized first:
- email is lowercased;
- numbers are converted to E.164, and a valid E.164 value the phone library does not recognise is kept as typed;
- Slack ids must be `U…` or `W…`.

This makes the comparison meaningful, and stores the identifier in the shape the send skills address.

Rejected verification rules:
- **Unverified, with principal approval on the first send.** A person sees every new address once, but every cold outreach waits on the principal, and #2040 already weighed that friction as a product change.
- **Unverified but sendable.** The resolver would special-case a source, breaking the rule that only verified addresses are sendable.

This is not the near-miss rule rejected below (Option A). It covers every contact, not only the principal. It runs once, when an address is first stored, not on every send. A hit asks the agent rather than blocks the send.

Re-stating an address already on the same contact:
- a verified identity: unchanged;
- an unverified `outbound_recipient` identity: the same duplicate check runs first, because the gateway records the address as the agent typed it, typos included (the 2026-10-07 incident address was one). If it passes, the identity is verified in place, keeping its source. If not, the call is refused and nothing is verified;
- anything else unverified (`self_claimed`, `sms_participant`): refused, because only the principal can verify those.

Structural contacts are off limits to agents. No agent skill changes the addresses of a structural contact (the principal, an agent or a system contact: `isStructuralContact`). `contact-link-identity` refuses adding an identity, re-stating one, and verifying an `outbound_recipient` one. `contact-merge` refuses a structural contact on either side, since the primary gains the secondary's identities. `contact-unlink-identity` and `contact-set-identity-status` refuse a structural contact's identities. The principal's verified identities form the principal identity snapshot, which Gate C's carve-outs and the `principal` send alias trust, so an address an agent added there would be a way to impersonate the principal. The principal manages their own addresses in the console. The `ceo_stated` path that `contact-link-identity` used before this change had the same hole, and a security review flagged it.

Apart from structural contacts, an agent may vouch only for what an agent typed. This is how agents reach contacts that a raw send created before this change.

### References are checked before any gate, and Gate C uses the result

For the four send skills and `email-draft-save`, the execution layer checks and resolves recipients before the autonomy gates (`resolveSendSkillReferences` in `src/skills/execution.ts`), with the same resolver the skill uses. It refuses a retired raw-address input, an address or template token in a reference field, a reference that does not resolve, and more than 25 references, each with the skill's own message (#2041). So no gate files an approval for a send that cannot run. A contact-store outage is classified `DATABASE_UNAVAILABLE`.

Gate C's carve-out parsers read the reference inputs only, and the gate substitutes the resolved addresses before comparing. The principal-sole carve-out and the known-tier reply-to-sender check therefore judge the address the skill will send to. A reference shape cannot collide with an address on any send channel: email has `@`, E.164 starts with `+`, and a Slack user id has no hyphens. A hint containing `@` or a run of 7 digits is not a hint, so an address whose local part contains `#` stays an address.

Approvals show what will be sent: each reference as its address followed by the contact name (sanitized, since names come from inbound headers), and every cc recipient. The stored payload stays the agent's input, so an approval re-resolves the reference when it runs. A reference that no longer resolves is shown as unresolved, rather than as a contact with no verified address: the cause may be a renamed label, not a missing identity.

### Block errors name unmatched recipients

When a filter blocks a send (identity gate, export block, PII redactor error, content filter, in `send()` and `sendEmailDraft()`), the skill error lists each recipient that matches no contact, or matches only an unverified identity, and tells the agent to check the recipient before rewriting the message. The unverified case covers a typo that was delivered once before and so now has an unverified `outbound_recipient` contact. The principal's FYI marks the same recipients. The lookup runs only on a block, so ordinary sends pay nothing. A lookup error leaves that recipient out rather than claim a mismatch.

### Gateway-created contacts get honest provenance

`promoteOrCreateRecipientContact` records a first-time outbound recipient with source `outbound_recipient`, not `ceo_stated`. That source is not auto-verified: on a raw send the address came from LLM-generated tool input, the opposite of the mechanical extraction that `email_participant` relies on. `agent_called` is not such an extraction either: `contact-register`, callable by ceo-inbox only, records it from tool input, auto-verified without the duplicate check. That is an open question, tracked in #2061. The tier stays `known` for now. At `unknown`, Gate C escalates every external send that a reply from that contact leads to, a relay to the principal included, so every legitimate cold outreach would need approval for each follow-up. That decision is #2040. With the raw inputs retired (#2041), the gateway creates such a contact after any successful gateway send to an address with no contact record (send-draft, email-reply). An agent re-stating the address with contact-link-identity verifies it.

### No principal-specific similarity rule

Option A is not added. What send-by-reference does not cover:

- **A typo in a brand-new address is stored and verified** when it resembles nothing on file (#2041). The principal's message is the only check on that transcription. It now happens once, in a checked and recorded place, instead of on every send.
- **Choosing the wrong contact** (#727 picked a real but wrong person) is a different failure. A reference makes it an explicit choice of contact rather than a transcription, but nothing here checks it.

## Consequences

- An address the model already has is never retyped on the reference path, for the principal and every other contact, on every channel.
- **Breaking change to four `tool.json` input surfaces.** `to`, `cc` and `recipient` no longer accept addresses. A pending approval stored before the deploy with an address in `to` fails when approved, and the error names `contact-create`. That window is 48 hours.
- Success payloads are unchanged (`to`, `delivered_to` carry the resolved address, which reply-lock and the activity log read) and gain `contact_id` when the agent passed a contact UUID.
- A contact the gateway created has an unverified identity, so a later send to it by reference fails closed. Its address came from a raw send before #2041, or from a gateway send (send-draft, email-reply) to an address with no contact. An agent re-states the address with contact-link-identity, or the principal verifies it. #2040 covers whether an inbound reply should verify it.
- **Breaking change (#2041):** the four send skills' raw-address inputs and email-draft-save's typed to are gone. An approval stored before the deploy with a raw input fails when approved, with a message naming contact-create. That window is 48 hours.
- A send by reference costs a contact read before the gates and another in the skill, plus one more if an approval is filed.
- An approval resolves the reference again when it runs, up to 48 hours later. If the contact's primary changed in between, an unhinted send goes to the contact's new address, which is another verified address of the same person. A hinted approval records the identity row and the name that was resolved (`send_resolution`, not skill input). Replay sends only when both still match. A renamed or removed label, or a fallback onto a different unlabelled address, fails closed before the skill runs. A hint that originally selected the single unlabelled address still sends while that same row is the one resolved.
- Contacts the gateway created before this change still carry `ceo_stated` and verified identities. Relabelling them is a data change, left to the operator.
