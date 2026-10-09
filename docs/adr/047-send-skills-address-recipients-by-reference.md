# ADR-047: Send skills address recipients by contact reference, not by typed address

Date: 2026-10-07
Status: Accepted
Amended: 2026-10-07 — no raw-address path; agent-entered contacts (#2041)
Amended: 2026-10-08 — agent-entered identifiers are verified by provenance (#2061)
Amended: 2026-10-08 — the principal's mailbox drafts address recipients by reference; a raw address needs a source (#2053)

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

`send-draft` is unchanged. It sends a draft's envelope as stored, behind its principal-origin gate (ADR-017). Once `email-draft-save` addresses drafts by reference, every draft it sends was addressed by reference or by a person in their own mail client. The principal's mailbox drafts follow their own rule, below.

### Drafts in the principal's mailbox (#2053)

`ceo-inbox-draft-compose` and `ceo-inbox-draft-edit` write drafts into the principal's personal Gmail, which the principal reviews and sends. Each recipient used to pass through two model copies: the coordinator copied the address from `<resolved_entities>` into its brief, and ceo-inbox copied it into the tool call. An edit replaced a whole recipient list, so changing one cc meant retyping every other one.

**Recipient rule.**
- `to` and `cc` take contact references, resolved by the same resolver as the send skills (`ToolContext.resolveRecipientReference`, which the execution layer sets for every skill when a contact service is wired, so the draft tools need no `outboundGateway` capability). A reference that matches no contact, a blocked contact, or a contact with no verified email refuses the call, and nothing is saved. A resolved recipient is saved with the contact's display name, unless the name looks like an address (`isAddressLikeName`).
- `to_addresses` and `cc_addresses` take an address for someone who is not a contact: a sender found in the principal's mail, a mailing list, an address the principal wrote. One is accepted only when it has a source under the #2061 rule: a message a person sent in the conversation, or a source tool's result (`ceo-inbox-search`, `ceo-inbox-list` and `ceo-inbox-read` are sources; reads of drafts are not). Anything else fails closed and nothing is saved. An address that belongs to a blocked contact is refused, as its reference would be, and so is any address when that lookup fails. A raw entry is saved with no display name, so a typo cannot appear under a familiar one.
- `ceo-inbox-draft-edit` changes recipients one at a time. `remove` takes an entry off both lines: a contact reference matches any of that contact's email addresses, and an address must be on the draft as shown (ignoring case), so a typo matches nothing. `add_to` / `add_cc` (references) and `add_to_addresses` / `add_cc_addresses` (raw) put one on. A raw address already on the draft needs no source, but is still refused if it belongs to a blocked contact. Adding someone who is on the other line, under any of their addresses, moves their stored entry; adding someone already on the line changes nothing. Everyone not named keeps their stored entry, display name included. An edit that empties a To line is refused; a draft the principal started with no To can still have its Cc changed. The whole-list `to` and `cc` inputs are retired and refused, not ignored, a blank `cc: []` included (it used to mean "clear the CC line").
- The coordinator briefs ceo-inbox with contact IDs from `<resolved_entities>`, not addresses. Smoke case `cold-compose-existing-contact` covers it.

**Why not contact-first, as for the send skills.** Most cold-compose recipients are not contacts and never will be: people found once in mail history, mailing lists. Making each a contact first adds a record per draft for someone the principal may never write to again, and ceo-inbox does not hold `contact-create`. The provenance check gives the raw path the property that matters: a mistyped address fails closed.

**Why the #2061 source rule, not a mailbox search.** #2053 proposed accepting a raw address only when it appears in a header of a message in the principal's mailbox, and named two ways to check: a Nylas `from:`/`to:`/`cc:` search, or the headers of messages already read in the task. The second is what #2061 built. A per-call Nylas search was rejected for `contact-register` and is rejected here for the same reasons: an API call per address, and the smoke and scenario stubs replace the mailbox tools by name, so a search would always miss in tests. The sources are slightly wider than mail headers: a message the principal wrote counts, so "draft to jordan@quillfeather.example" works without a lookup, and so does a page a tool read. Neither can carry a typo the model introduced, which is the failure this closes.

**Curia cannot send these drafts.** `send-draft` looks a draft up only in the gateway's email accounts, the `email_accounts` rows configured under Settings → Channels → Email, each with its own Nylas grant. The principal's grant (`ceo_nylas_grant_id`) is not one of them. An operator who adds an email account bound to the principal's grant would let `send-draft` find and send these drafts on a principal-originated task (ADR-017). Until then the principal is the last check on every recipient. A mistyped recipient here costs a wrong address in a draft the principal reads before sending, not a delivered message.

### Agent-entered addresses: `agent_stated`, verified after a duplicate check and a provenance check (#2041, #2061)

`contact-create` and `contact-link-identity` used to record `ceo_stated`, so an address an agent typed looked like the principal's own statement. They now record `agent_stated`. `ceo_stated` stays where the principal entered the data: the console and the setup wizard.

An `agent_stated` identity is written verified, because otherwise "create, then send by ID" could not work: the resolver sends only to verified identities. The verification is earned by two checks that run before anything is written. The first is a duplicate check (`ContactService.findLikelyDuplicates`); the second is the provenance check below.

| Finding | Result |
|---|---|
| The identifier is already on another contact, same channel (email ignoring case, numbers by digits) | Refused, naming that contact. No override |
| The same number on a sibling phone channel (`phone`, `signal`, `sms`) | Candidate |
| A near-miss email: optimal-string-alignment distance 1–2, or 1 when the shorter address has fewer than 12 characters | Candidate |
| A near-miss number: distance 1 on the digits | Candidate |
| The same display name, ignoring case and spacing (`contact-create` only) | Candidate |
| A near-miss display name (Jaro-Winkler ≥ 0.95 on the normalized names; `contact-create` only) | Candidate |

The name threshold sits in the gap between typos of one name ("Priya Natarajan" / "Priya Natrajan", 0.958) and different people who share part of a name ("David Kim" / "David King", 0.938; "Sarah Johnson" / "Sarah Jones", 0.936). It catches a one-letter typo after the first letter in a name of about eight or more characters. Shorter names and first-letter typos can fall below it. A few different people with one-letter-apart names of 8+ characters land above it ("Wei Chen" / "Wei Chan", 0.95; "Michael Brown" / "Michelle Brown", 0.956), and `distinct_from` clears those.

A candidate blocks the write until the agent passes `distinct_from` listing every candidate's ID. The list is a statement, "I checked these and they are different people". A boolean override was rejected because a model learns to set a flag before it has seen anything. Refusals name contacts and reasons, never an address. The principal is listed as `the principal`, with `principal` as its `distinct_from` token, so their contact ID stays out of the model's context. Because `sanitizeDisplayName` strips `@`, a contact the gateway named after its address is stored without it (`sam.rivera@vendor.example` is stored as `sam.riveravendor.example`), so a refusal names a candidate by its contact ID alone when its name looks like an address, a number or a Slack id, which includes a single dotted token with no spaces (`isAddressLikeName`). The send resolver's errors follow the same rule. A check that cannot run refuses the write.

Neither `agent_stated` nor `agent_called` is in `AUTO_VERIFIED_SOURCES`. Their writers pass `verified` explicitly, so a future writer of either source stores unverified unless it runs the checks.

### Provenance: an agent-entered identifier is verified only when a source has it (#2061)

The duplicate check compares an identifier with what is on file, so it cannot catch a typo in a new person's address. Triage registers new senders all day, and the 2026-09-30 typo reached a live domain. Provenance asks a different question: did this string come from text the model did not write? A typo occurs in no such text, whoever it resembles.

**Sources.** An identifier is found when it occurs in either of these:
- a message a person sent in the task's conversation: the active `user` turns in working memory that are not `synthetic` and not on a channel only agents write to (`internal`, `bullpen`, `scheduler`) (`WorkingMemory.getPersonTurns`). Text in a stored turn that quotes Curia is cut before matching (`personTurnSourceText`): the `[ACTIVE OUTBOUND CONTEXT]` block wherever the dispatcher put it, and quoted reply history (`On … wrote:`, `-----Original Message-----`, `>` lines);
- the successful result of a source tool read in the conversation. A tool is a source when its manifest sets `provenance_source`: `web-fetch`, `web-search`, `email-get`, `email-get-thread`, `email-list`, `file-parse`, `ceo-inbox-list`, `ceo-inbox-search` and `ceo-inbox-read`. The field defaults to false. Within a result, messages from Curia's own addresses and drafts are left out, and a call that reads drafts records nothing (`ExecutionLayer.provenanceSourceText`): both hold addresses a model typed. Not sources: `delegate` and `bullpen` (model-written text), `doc-read` and `doc-search` (the document workspace agents write with `doc-write`), and `web-browser` (its page state echoes what the agent typed).

**Scope.** Sources are scoped to the root conversation, for text and voice turns alike. A delegated specialist counts toward the conversation it came from: it reads the coordinator's person turns there, and the source-tool results it records are visible to the coordinator, and the reverse. So "research the venue, then add its booking address" works whichever agent read the page. The runtime keeps source-tool results in a process-wide index (`IdentifierSourceIndex`, 24-hour TTL, capped per conversation). Losing it on a restart only means a later write is refused and the agent asks again.

**Matching** is on normalized identifiers: email lowercased; phone numbers read from text in local or international form and compared in E.164; other ids (Slack, Telegram) as exact tokens.

**What each writer does on a miss.**
- `contact-create` and `contact-link-identity` (`agent_stated`) refuse and store nothing. The refusal names the channel, not the address, and tells the agent to copy it from where it came or ask the principal, whose answer is then a source. The duplicate check runs first, so "that address is already on …" still wins. Re-stating an unverified `outbound_recipient` identity needs a source too.
- `contact-register` (`agent_called`, ceo-inbox triage) cannot stop, so it registers the sender with the identity **unverified** and reports `verified: false`. The mailbox listing the agent copied the address from is a source, so a correct copy is verified. A later registration that finds a source verifies an unverified `agent_called` identity in place.

**An approval replay counts as a source.** When a contact write was held for approval, the principal saw the identifier in the approval, and the replay runs outside the task that had the sources.

Rejected alternatives:
- **Duplicate check in `contact-register`.** It knows only what is on file, so it misses a typo of a first-time sender. The first write wins: if the typo is registered first, the sender's correct address is the near miss. It also flags real lookalike addresses, and resolving a near miss to the existing contact would match a sender at a lookalike domain to the principal.
- **Stop auto-verifying `agent_called` with no check.** Every correct registration would become unsendable by reference, score lower and show `[unverified]` when that person writes to Curia. The way out, an agent re-stating the address, is another transcription.
- **Re-read the named message's headers from Nylas** (`contact-register` takes a `message_id`). Precise to From/To/Cc, but it costs an API call per new sender, needs mailbox secrets in the skill, and cannot be answered by the smoke and scenario stubs, which replace the mailbox tools by name. The fetched results are already in the conversation.
- **Source-tool results count only within the task that read them.** A coordinator that delegated research sees only the specialist's model-written reply, so the address would be refused.

Identifiers are normalized first:
- email is lowercased;
- numbers are converted to E.164, and a valid E.164 value the phone library does not recognise is kept as typed;
- Slack ids must be `U…` or `W…`.

This makes the comparison meaningful, and stores the identifier in the shape the send skills address.

Rejected verification rules:
- **Unverified, with principal approval on the first send.** A person sees every new address once, but every cold outreach waits on the principal, and #2040 already weighed that friction as a product change.
- **Unverified but sendable.** The resolver would special-case a source, breaking the rule that only verified addresses are sendable.

This is not the near-miss rule rejected below (Option A). It covers every contact, not only the principal. It runs when an address is first stored, and again when an `outbound_recipient` address is re-stated before it is verified, not on every send. A hit asks the agent rather than blocks the send.

Re-stating an address already on the same contact:
- a verified identity: unchanged;
- an unverified `outbound_recipient` identity: the same duplicate check and provenance check run first, because the gateway records the address as the agent typed it, typos included (the 2026-10-07 incident address was one). If both pass, the identity is verified in place, keeping its source. If not, the call is refused and nothing is verified;
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

`promoteOrCreateRecipientContact` records a first-time outbound recipient with source `outbound_recipient`, not `ceo_stated`. That source is not auto-verified: on a raw send the address came from LLM-generated tool input, the opposite of the mechanical extraction that `email_participant` relies on. `agent_called` is not such an extraction either: `contact-register`, callable by ceo-inbox only, records it from tool input, verified only when the provenance check finds it (#2061). With the raw inputs retired (#2041), the gateway creates such a contact after any successful gateway send to an address with no contact record (send-draft, email-reply). An agent re-stating the address with contact-link-identity verifies it, after the duplicate check.

The tier of such a contact is `known` (#2040). No agent typed the address on either remaining path:
- `send-draft` runs only on a principal-originated task (ADR-017). `email-draft-save` addresses by contact ID, so a draft whose To has no contact was written outside Curia, in practice by the principal;
- `email-reply` sends to the From of the message being answered, an address that has written to us.

The same function already promotes an existing `unknown` contact to `known` when a send reaches it (correspondence elevation), so a contact it creates gets the same tier. At `unknown`, a reply would be held or dropped by the `unknown_sender` policy, and Gate C would escalate every external send it led to, a relay to the principal included.

Rejected tiers:
- **`unknown`, with the principal-sole carve-out extended to `unknown` originators.** That changes Gate C for every unknown sender, inbound strangers included, to settle this narrow case, and a reply is still dropped on a channel whose `unknown_sender` policy is `ignore`.
- **`unknown` until the address proves live (its first inbound reply).** Liveness is not correctness. The 2026-09-30 typo reached a live third-party domain, so its owner's first reply would have promoted them. Correspondence elevation also lifts an `email-send` or `email-reply` recipient to `known` before any reply arrives, in the gateway and again in the dispatcher.
- **`known` only when the send was principal-approved (`humanApproved`).** After #2041 that means `known` for `send-draft` and `unknown` for `email-reply`, and correspondence elevation lifts the second straight away. The outcome is the same as `known`, with one more branch.

An inbound reply does not verify an `outbound_recipient` identity (#2040), for the same reason: a reply shows the address is live, not that it is the intended one, and an inbound sender can be spoofed (SMS, ADR-036). The identity is verified by the principal, or by an agent re-stating it after the duplicate check.

### No principal-specific similarity rule

Option A is not added. What send-by-reference does not cover:

- **A correct copy from the wrong source.** Provenance proves an identifier was copied, not that it belongs to the person meant. A sender at a lookalike domain is verified, as `email_participant` verifies them on Curia's own inbox; that is a question for triage and Gate C. A typo in a brand-new address, accepted here until #2061, is now refused or stored unverified.
- **`file-parse` extraction.** For PDFs, images and HTML, `file-parse` extracts text with an LLM. The check then proves the agent copied the extracted text exactly, not that the extraction read the document correctly.
- **Unmarked quotes.** Quoted history is cut only where a client marks it. A reply that quotes Curia's message without a marker, or a forwarded Curia message, still counts as the person's text.
- **Choosing the wrong contact** (#727 picked a real but wrong person) is a different failure. A reference makes it an explicit choice of contact rather than a transcription, but nothing here checks it.

## Consequences

- An address the model already has is never retyped on the reference path, for the principal and every other contact, on every channel.
- **Breaking change to four `tool.json` input surfaces.** `to`, `cc` and `recipient` no longer accept addresses. A pending approval stored before the deploy with an address in `to` fails when approved, and the error names `contact-create`. That window is 48 hours.
- Success payloads are unchanged (`to`, `delivered_to` carry the resolved address, which reply-lock and the activity log read) and gain `contact_id` when the agent passed a contact UUID.
- A contact the gateway created has an unverified identity, so a later send to it by reference fails closed. Its address came from a raw send before #2041, or from a gateway send (send-draft, email-reply) to an address with no contact. An agent re-states the address with contact-link-identity (after the duplicate check), or the principal verifies it. An inbound reply does not verify it (#2040).
- **Breaking change (#2041):** the four send skills' raw-address inputs and email-draft-save's typed to are gone. An approval stored before the deploy with a raw input fails when approved, with a message naming contact-create. That window is 48 hours.
- A send by reference costs a contact read before the gates and another in the skill, plus one more if an approval is filed.
- An approval resolves the reference again when it runs, up to 48 hours later. If the contact's primary changed in between, an unhinted send goes to the contact's new address, which is another verified address of the same person. A hinted approval records the identity row and the name that was resolved (`send_resolution`, not skill input). Replay sends only when both still match. A renamed or removed label, or a fallback onto a different unlabelled address, fails closed before the skill runs. A hint that originally selected the single unlabelled address still sends while that same row is the one resolved.
- Contacts the gateway created before this change still carry `ceo_stated` and verified identities. Relabelling them is a data change, left to the operator.
- **#2061:** a cold outreach to an address with no source (no person stated it, no source tool read it, and the principal did not approve the write) is refused until the principal states it. That covers a pattern guess, an address from memory, and one found only in a delegate's reply. `agent_called` and `agent_stated` identities written before #2061 stay verified.
- **`tool.json` gains `provenance_source` (public API).** Marking a tool is a security decision: its output must be data it read, never model text. `tests/unit/skills/provenance-source-manifests.test.ts` pins the list.
