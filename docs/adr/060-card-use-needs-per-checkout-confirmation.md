# ADR-060: Card use needs a per-checkout confirmation

Date: 2026-11-04
Status: Accepted

## Context

[ADR-027](027-structured-secret-subfield-addressing.md) lets the web browser fill a saved card's fields by reference, so the card number never reaches the model. It did not decide *when* Curia may use a card. The principal decided (2026-11-04, #1358) that every checkout is confirmed, every time.

Nothing in the codebase could express "always ask". The autonomy gates score an action against the live autonomy level, and a task that the principal originated skips all of them. An approval replays one tool call and does not resume the agent that asked. A gate placed in a manifest or in the gates would therefore be skipped on exactly the paths where the principal is talking to Curia, and a card could be filled with no confirmation.

## Decision

The card-use check lives in the resolver (`resolveSecretRef` in `src/skills/execution.ts`), below every gate. Every `credit_card` field, public or secret, is refused unless a **card-use grant** exists for that card, the registrable domain of the page's top-level URL, and the task's conversation. No autonomy path, `humanApproved` replay or principal-originated task bypasses it.

**Grants are written only by the `card-use-confirm` approval replay.**

- `card-use-request` (coordinator, `web` bundle) takes the card name, the site, the amount as the page shows it, and a one-line purpose. It writes nothing but a request row (`card_use_requests`, with the conversation's resume routing) and files a `pending_approval` row for `card-use-confirm`. The row is delivered and answered through the existing approval paths: reply, reaction, console or `approve-action`.
- `card-use-confirm` is `allowed_callers: ["system"]`, hidden from pin resolution, and refuses any call that is not `humanApproved`. The principal's yes is the only thing that can write a grant.
- Only the principal can answer. Console approve and `approve-action` both refuse a card-use row that was never delivered. `approve-action` also refuses an approval in the turn that requested it, so the coordinator cannot request and approve in one turn, even when the principal's message said "buy it with my Visa". It also refuses unless the approval was delivered before the principal's confirming message arrived (the turn's `originator.initiatedAt`), so delivering and approving within one later turn does not count either.
- Every answer settles the request and resumes the originating conversation: approve, deny, dismiss, expiry, and a failed replay. An `approve-action` approval inside the originating conversation continues in that turn and publishes no second resume, so only one turn drives the browser.
- A card-use approval expires after 30 minutes, not the usual 24 hours.

**Grant scope.** One card, one top-level site (registrable domain), one conversation, 30 minutes, and at most two fills each of `number` and `cvv` (one retry after a form error). Public fields (brand, expiry, name, ZIP) are unlimited inside the window. The fill counters go up atomically on each resolve. A second purchase asks again. The site comes from the page's top-level URL, passed to the resolver as the `siteUrl` option. A field in a frame of any origin on that page may be filled, because payment processors host the number and CVV in their own frames.

**Bare refs.** A bare `user.x` ref to a card is refused, including when the details tag is missing and the decrypted value is card JSON, so a missing tag row cannot make the resolver type the whole card.

**Audit.** `card_use.requested` and `card_use.decided` carry brand, last four, site, amount and the decision, never the number.

### Alternatives rejected

- **A manifest `approval: always` field.** It would change the manifest schema, and the gates that read it are skipped on principal-originated tasks and approval replays. The unconditional guarantee has to live where the value is produced.
- **Per-field approval.** Asking for the number, the CVV and the expiry separately makes one checkout three prompts and gives the principal no more information than one.
- **Frame-origin matching.** Judging by the field's own frame fails for processor-hosted iframes, the common case, and would make most checkouts unfillable.

## Consequences

- No path fills a card without a principal answer for that checkout. The check cannot be skipped by a prompt, a score or a task's origin.
- **Accepted risk (decided by the principal):** a hostile frame on an approved site could receive the card, since any frame on the approved top-level page may be filled.
- **The amount is what the agent reports from the page.** The approval message says so. Curia does not detect that a checkout finished or read the total itself.
- Every answer path resumes the conversation, so the checkout continues in the agent's warm browser session however the principal answered.
- **Public API changes:** `secret.accessed.secretField`, the `card_use.requested` and `card_use.decided` events, the `resolveSecretRef` `siteUrl` option, and the `ToolContext.approvalVia` and `cardUse` fields.
