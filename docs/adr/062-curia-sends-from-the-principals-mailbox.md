# ADR-062: Curia sends from the principal's mailbox through the outbound gateway

Date: 2026-11-07
Status: Accepted

## Context

ceo-inbox drafts replies and new mail in the principal's own mailbox (the `ceo-inbox` Nylas grant, `ceo_nylas_grant_id`), and until now the principal pressed send. [ADR-047](047-send-skills-address-recipients-by-reference.md) relied on that: "Curia cannot send these drafts", so the principal was the last check on every recipient. #2474 asks Curia to press send, the way an EA with delegate access would, in two modes:

1. **Principal-directed.** On a live turn (voice, Signal, chat) the principal asks Curia to send one or more drafts, including drafts the principal wrote: "fill in the venue on the Acme draft, then send the three I wrote this morning."
2. **Autonomous.** During inbox triage, Curia replies on its own to low-stakes mail ("I'll bring the deck Thursday" → "Got it, thanks").

Principals differ in how much of this they want, and may want different things per mailbox once #2475 adds more than one. The principal's mailbox is also the highest-value injection target Curia touches: a message sent from it carries the principal's name and reputation. The standard is a human EA's. No heavy machinery for risks an EA also carries, but the few limits that must always hold are enforced in code.

Three things had to be settled:

- **Where the send runs.** The obvious option is a high-risk skill that sends through `CeoNylasClient` and relies on the execution-layer gates. That is a second outbound surface. Gate C has no content filter, blocked-contact check, stakes question or grounding question; reaching parity would rebuild the gateway inside a skill, and every later outbound fix would have to land twice. **Rejected.**
- **What happens when a send is not allowed.** Elsewhere a held send becomes an approval. Here the principal's own draft is already the reviewable artifact, in a client where they can edit it, and an approval replay carries `humanApproved`, which would make a queued autonomous send look principal-directed.
- **Identity.** The default identity says "Never impersonate the principal." Sending, from their own mailbox, a message the principal authorized (by request, or through the setting below) is acting as their delegate. ceo-inbox already drafts in the principal's voice on the same basis.

## Decision

**One tool, one gateway entry point.** `ceo-inbox-send-draft` (`action_risk: 80`) sends one existing draft per call through `OutboundGateway.sendPrincipalDraft`. Curia never composes and sends in one step. A batch is several calls; when the principal asks to send two or more drafts, the tool description has Curia read back the count and each draft's recipient and subject in one sentence and ask "send all, or go through them?" first. Triage's own sends under `routine` or `all` are not a batch and need no yes. The read-back is enforced by the description and scenario cases, not code (the maintainer's call). `sendPrincipalDraft` runs the same blocked-contact, identity-gate, personal-data, content-filter and band-review steps as `sendEmailDraft`: both call one private `checkDraftSend` with a profile for the mailbox. Existing callers see no change.

**The principal's mailbox is its own gateway entry.** It is resolved per call by `createPrincipalMailboxResolver` (`src/channels/email/principal-mailbox-resolver.ts`), so a re-sign-in (#2361) takes effect without a restart. It is never a `nylasClients` / `emailAccountAddresses` entry: registered there, the gateway would drop the principal from every audience and `send-draft` could find these drafts. A missing grant or API key refuses (fail closed). The draft read, the pre-send re-read and the send all go through that one client, so the re-read comparison is not fooled by two clients normalizing differently.

**Closing the existing second surface.** `send()` and `sendEmailDraft` now refuse a Curia email account whose address is the principal's, and point at `ceo-inbox-send-draft`. Before this an operator who configured such an account let `email-reply` and `send-draft` send from the principal's mailbox past every rule below. One exception: a system notification on email addressed to the principal alone (the review-cap notice, `emailPrincipal`, an approval email) still goes out through such an account. It reaches no third party, and refusing it would silence Curia's alerts when its primary account is the principal's. A notification with anyone else on it is refused.

**A per-mailbox setting, enforced in the gateway.** Config-store key `ceo_inbox/sending`, value string-encoded JSON `{ "<mailbox>": "<level>" }`:

| Level | Curia may send |
|---|---|
| `off` | nothing |
| `on_request` (default) | only principal-directed sends |
| `routine` | plus autonomous sends rated `routine`, at score 80+ |
| `all` | plus autonomous `commitment` sends, at 90+. `financial_or_legal` never goes out autonomously (#2473) |

Autonomous sends under `routine` and `all` shipped in PR 2 of #2474; PR 1 shipped principal-directed sends, and there `routine` and `all` behaved as `on_request`.

Missing, unreadable or unknown values read as `on_request`: that never widens autonomy, and keeps principal-directed sends working. `sendPrincipalDraft` reads the setting itself through an injected reader, so no caller can skip it. **Amended by [ADR-064](064-multiple-principal-mailboxes.md) (#2475):** the setting is one level per mailbox id, `{ "<mailbox id>": "<level>" }`, and the gateway reads the level of the mailbox that holds the draft it sends (the key is never caller-chosen). A mailbox with no key is `on_request`. The legacy `default` key is no longer written; it applies only while exactly one mailbox is live (or the flat-grant fallback is active), and is renamed to that mailbox's id when the flat-key migration runs. The setting is pinned into ceo-inbox's context and changed like any config-store setting, in conversation. The console has no screen for it.

**Principal-directed means a live principal turn, authenticated.** `isPrincipalDirectedMailboxSend` (`src/skills/principal-send/authority.ts`) requires `isLivePrincipalTurn`, and for an email-originated turn an adapter-verified sender (`TaskOriginator.authenticated`); an unverified email "principal" turn counts as autonomous. An approval replay (`humanApproved`) is never principal-directed and is refused outright. Voice, Signal, Slack, web, CLI and console count as they do elsewhere.

**Review rules for this profile** (spec 15 has the full table):

- A principal-written draft sent on request is not band-reviewed unless third-party personal data remains. The principal's own words are not fact-checked, and the identity gate does not read them.
- A Curia-written draft sent on request gets purpose and grounding. "Go through my inbox and handle the easy ones" is principal-directed, but the content answers outsider mail.
- A draft Curia did not create but edited (`ceo-inbox-draft-edit`), or one last modified before the 30-day provenance lookback (nobody can tell who wrote it), gets purpose only, and the identity gate reads it. An edit can put Curia's words or a new recipient into the principal's draft; the principal's words are still not fact-checked.
- Personal data in the quoted message below a reply is ruled apart (field `quote`), and only when someone on the send was not on the quoted message, by the quote's own header; a header that names nobody is reviewed. A saved draft's quote cannot be cut, so a review that would send without it leaves the draft unsent. On a principal-directed send the principal's own verified identities are dropped. The content filter still reads the whole body.
- The principal's addresses on the draft are the sender's own, not an audience. A draft addressed only to the principal is refused: they can send it themselves.
- Authorship comes from the audit log (`tool.result` rows of `ceo-inbox-draft-reply` / `-draft-compose`, and `ceo-inbox-draft-edit` for the edited class). If it cannot be read, the draft is treated as Curia's, which means more review, not less.
- The brief tells the judge the message goes out under the principal's name (a sender-profile line, added only for this profile so every other brief, Gate C's included, is unchanged).
- Principal-directed sends are not stakes-gated (the principal decided), and are not put in the spot-check sample pool.

**Holds stay drafts. Nothing on this path becomes an approval.** A band hold or ask, a content-filter block, a refusal or a changed draft leaves the draft in the principal's Drafts folder and returns a reason the agent relays. Gates A and B never queue an approval for `ceo-inbox-send-draft`; they return a plain refusal. "Send it anyway" is a new principal-directed send. The pre-send re-read refuses with `draft_changed` when the draft was edited after the checks ran, so only what was checked is sent. On a principal-directed send a review bounce goes back to the drafter once, as for any editable send; on an autonomous send a bounce is final, like a hold.

**Curia's sends are not learning evidence.** Before each send the gateway writes a create-only marker under `/scratch/principal-mailbox-sends/` (draft, thread, recipients, mode, time) and then adds the returned message ID. `ceo-inbox-sent-observe` skips SENT messages that match a marker by ID, or by thread, recipients and a short time window (the send response's ID is not documented to equal the SENT listing's on Gmail), for voice learning, task matching and shadow-draft pairing alike.

**Autonomous sends: shipped in PR 2.** PR 1 of #2474 shipped principal-directed sends only. PR 2 adds the autonomous path under these rules, enforced in `sendPrincipalDraft` before band review, whatever the score:

1. Curia drafted it in the same task (an audit `tool.result` row for `draft-reply` / `draft-compose` with this draft ID, not `already_exists`; never a `draft-edit` result or a voice-learning snapshot).
2. The draft is unchanged since Curia wrote it.
3. Recipients are only people genuinely on the thread: the principal's addresses, recipients of messages sent from the principal's mailbox, and the `From` of inbound messages whose sender was verified. Inbound To/Cc headers never count (a forged Cc of the CFO).
4. At most five recipients, and no mailing lists: a thread message with any list header (List-Id, List-Post, List-Unsubscribe, Precedence list or bulk, a Google Group id) means no reply on its own.
5. No attachments.
6. At most one autonomous send per thread per day, and none for a day after a hold or refusal there (read from the send ledger).
7. At most 10 autonomous sends a day across all threads.
8. The reply answers the latest message on its thread, the one Curia drafted it against; a reply to an older message is left as a draft.
9. Never bank or card details: a reply holding a card number or an IBAN, in its own words or the quoted message, is left as a draft.
10. Only Curia's own inbox check sends on its own: not outsider-originated, and not anything whose origin can't be confirmed.
11. A reply that shares information not on the thread is always held (`off-thread`, judged against the thread messages every recipient received), at every band and under any ceiling: Curia does not pass on new information without the principal. A quoted message must be one every recipient received; an inbound message's Cc doesn't prove that, so a reply going to two or more people outside the principal is held.

Agents can't write the send ledger (`doc-write` refuses the prefix), and a reply whose marker can't be written is not sent. Autonomous review asks every question with speaks-as-principal forced true in code and stakes always asked; a stakes rating above the level's ceiling holds, a judge failure holds, and an autonomous send is refused when band review is not running. Autonomous sends and holds reach the principal as digest items ("Sent for you from your mailbox: …", "Left as a draft in your mailbox: …", and "Tried to send for you from your mailbox: …" when a send did not confirm). Principal-directed sends file no digest item: the principal is on the live turn.

**Why autonomous sends drop the principal-origin gate.** Autonomous triage is system-originated by design, so gating on `isPrincipalOriginated` would rule out the mode entirely. The level, the code limits above and the band score bound it instead; Gate B refuses an autonomous call below score 80.

**Identity.** A send the principal authorized, by request or through the setting, is delegate action, not impersonation. The shared `WRITES_AS_SCOPE_LINES` feed several agents' prompts and are not edited unless a scenario shows the model refusing to send.

## Consequences

- Every send from the principal's mailbox to anyone but the principal passes the same checks as Curia's own sends, and a later outbound fix lands once. (A system notice to the principal alone, above, is the one send from it that does not.)
- The principal chooses per mailbox how far Curia goes, and the default (`on_request`) is what an EA does without standing permission. #2475 adds named mailboxes to the same key without reshaping anything.
- A held or refused send costs nothing: the draft is where the principal expects it, and no approval clutters "Waiting on you".
- An operator who bound a Curia email account to the principal's address loses sending through it; the refusal names the tool to use instead.
- [ADR-047](047-send-skills-address-recipients-by-reference.md)'s "Curia cannot send these drafts" paragraph no longer holds. The principal is no longer always the last check on a principal-mailbox recipient; on a principal-directed send they asked for it, and autonomous sends get the limits above.
- Provider neutrality: the send uses Nylas draft send, thread messages and the send response only. Draft-ID and thread-link stability across a draft update are undocumented for Gmail, so a one-time live check on a real grant is owed before release. Everything fails closed if an ID or thread link changes.

**Accepted risks:**

- SMS spoofing of the principal (an earlier maintainer call): an SMS principal turn counts as principal-directed.
- An agent can write `ceo_inbox/sending` from any turn, including system-originated triage, until #2519 decides a general guard for authority-widening settings writes.
- Standing inbox rules (`/shared/inbox/rules.md`, "never reply for me to the board") are applied by the agent only; the gateway does not read them.
- A forged marker under `/scratch/principal-mailbox-sends/` removes learning evidence or blocks autonomous sends on a thread; it can never allow a send.
- An outsider genuinely on a thread (a verified sender) can receive a routine acknowledgement, as they would from a human EA.
- A false positive from the content filter or identity gate on a principal-written draft stops the send; the principal can send it from their mail client.

**Public API changes:** the `ceo-inbox-send-draft` tool, the `ceo_inbox/sending` setting, and a `modified_since` input on `ceo-inbox-list` and `ceo-inbox-search`, and `date_local` and `created_by_curia` fields on their draft listings.
