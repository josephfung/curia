# Structured secrets: saved credit cards — design

Status: implemented (#1358) · 2026-11-04 · implements #1358 (ADR-027), builds on the Secrets
page redesign (PR #2478, `docs/wip/2026-11-04-secrets-page-redesign-design.md`)

## Why

The principal wants Curia to pay for things with a saved card ("use my personal Visa",
"use the Amex") without the card number ever reaching the model, and to manage those cards
on the same Secrets page as their website logins.

ADR-027 (2026-07-07) settled the core idea: a card is one schema-tagged secret whose fields
are addressed by `secret_ref` with a `#field` suffix, and every rendering a form needs
(`12/25`, `MM` + `YYYY`, `December`) is derived at read time. #1358 carried a file-level
blueprint for it. Since then the codebase has moved under it (tools vocabulary, bundles,
`list-user-secrets`, sign-in details, capture details, the Secrets page redesign), and two
things the ADR never decided now matter: **when Curia may use a card** and **what can be
shown about one without decrypting it**.

## Goals

- Save a card two ways: an agent-minted capture link, and the Secrets page's Create drawer.
- Fill any card field into a text box **or a dropdown**, server-side, with the value never in
  model context, results, logs or screenshots.
- Ask the principal before every checkout, every time.
- Let the agent pick a card by label and brand, and ask when it can't tell.
- Show brand, last four and expiry in the console and to the agent without a decrypt path.
- Renew a card (new expiry, new CVV) without re-entering the number, from the console or by
  the agent.

## Non-goals

- SIN, health card and other sensitive identifiers, including outbound-gateway substitution
  after band review. Decided out of this work (2026-11-04).
- Tokenization or a payment processor (ADR-027: self-hosted, no PCI layer).
- Localized month labels (projections stay pinned to `en-US`, per ADR-027).
- Other structured schemas (address, login pair). The registry supports them; none ship.
- Detecting that a checkout finished, or reading the total off the page. The confirmation
  states what the agent reports.

## Anti-goals (a failure even if it works)

- A card number or CVV in any API response, DOM node, log line, audit payload, tool result,
  screenshot, approval message or LLM call.
- Any console view or `list-user-secrets` call that decrypts a card.
- A card field filled without a principal confirmation for that checkout — including on a
  principal-originated task, an approval replay, or a `humanApproved` path.
- A bare `secret_ref: user.personal_visa_card` typing the card's JSON into a field.
- `#`-addressing working on an arbitrary JSON secret (ADR-027's exfiltration gate).
- Curia choosing between two plausible cards on its own.

## Decided by the principal (2026-11-04)

1. **Confirm every checkout.** The principal is asked before every use of a card.
2. **Brand, last four and expiry may be shown.** The last four are stored *apart from* the
   encrypted value, so there is no decrypt path when viewing.
3. **Pick by label and brand, with disambiguation.** "Use my personal Visa" / "use the Amex".
   Editing a card without re-entering the number is allowed, and the agent can do it too, the
   way it updates a website's sign-in URL today (`secret-capture-request` `details_only`).
4. **SIN is out of scope.**
5. **Payment frames:** a grant is for the top-level site; frames of any origin on that page
   may be filled. A hostile frame on an approved site is an accepted risk.
6. **What ends a grant:** 30 minutes, or two fills each of the number and CVV, whichever
   comes first.

## How the codebase has changed since #1358 was written

| #1358 assumed | Now |
|---|---|
| `resolveSecretRef` ~`execution.ts:1336` | `src/skills/execution.ts:2863`; capability `secretResolver`, allowlist `SECRET_RESOLVER_ALLOWED_TOOLS` (L166) |
| `skills/web-browser/handler.ts`, `skill.json` v1.5.0 | `skills/web/tools/web-browser/` (ADR-031 tools, `web` bundle), `tool.json` v1.11.0 |
| Screenshot suppressed per action | Per call (`injectedSecretThisCall`, handler L387, L605) |
| `select` only needed a `secret_ref` path | `select` also runs the tracked-code destination guard (#2017, L936) |
| New `list_secret_fields` action + `describeStructuredSecret` | `list-user-secrets` (#1497, v0.2.0) already lists keys plus sign-in details (#2201) |
| New `card-capture-request` skill | `secret-capture-request` (v0.4.0) has `value_format`, `login_url`, `username`, `details_only`, `resume_intent` and names keys with `resolveUserSecretName` |
| Capture returns `invalid_shape` | Redeem checks only JSON parse (`invalid_json`); nothing checks shape |
| Capture page form | A single textarea (`SecretCapturePage.tsx:125`) |
| Console capture only | The redesigned Secrets page has Create/View/Edit drawers and a disabled "Card (later)" |
| "Bare ref unchanged" | `secretsService.get()` returns any format's raw text, so a bare ref to a card would type its JSON. Must be refused. |
| `SecretAccessedPayload` ~`events.ts:521` | `events.ts:971`; `secret.changed` now has `action: 'details'` (PR #2478) |
| Migration `NNN_add_secret_capture_template.sql` | Latest is `117` (PR #2478); `user_secret_details` exists (`101`) |
| No payment question | Nothing forces "always ask": principal-originated tasks skip all autonomy gates (`execution.ts:2058`), and an approval replays one tool call without resuming the agent |

## The design

### 1. Storage: split secret and public fields

ADR-027 stored the whole card in one encrypted JSON document. That needs a decrypt to show
the last four or the expiry, which decision 2 rules out. Split it:

- **Vault row** (`secrets`, `value_format: 'json'`): only the truly secret fields.
  `{ "_schema": "credit_card", "number": "4111111111111111", "cvv": "123" }`
- **Public fields** on the key's `user_secret_details` row (migration 118):
  `schema TEXT NULL`, `label TEXT NULL`, `public_fields JSONB NULL`. For a card,
  `public_fields` is `{ brand, last4, expiry_month, expiry_year, cardholder_name,
  billing_zip? }`, validated by the schema registry. `label` is the principal's own word for
  the card ("Personal", "Work"), optional.

Expiry, cardholder name and billing ZIP move out of the encrypted document as well. They are
non-secret (ADR-027 §4), keeping them in one place means there's nothing to keep in sync, a
renewal edits them with no decrypt, and "is this card expired?" is a plain read. `last4` and
`brand` are derived from the number at write time and are never editable on their own.

The vault row and the details row are written in **one transaction** (a new
`SecretsService.setStructured(name, schema, secretDoc, publicFields, label)`); a card must
never exist with one half. Removing the key deletes both, as PR #2478 already does for
details.

`_schema` stays in the encrypted document as the routing tag (ADR-027 §1). `#`-addressing
requires both `details.schema` and the document's `_schema` to name the same registered
schema.

### 2. Schema registry (`src/secrets/structured-secret-schema.ts`, pure)

Keyed by schema tag; `credit_card` is the only entry. Each schema declares:

- `secretFields` (`number`, `cvv`) and `publicFields` (`brand`, `last4`, `expiry_month`,
  `expiry_year`, `cardholder_name`, `billing_zip`).
- `validate(input)`: PAN 12–19 digits with Luhn; CVV 3 digits, or 4 for Amex; month `01`–`12`;
  4-digit year; reject an expiry before the current month (UTC); cardholder name required.
- `derivePublic(secretDoc)`: `brand` from the IIN (visa, mastercard, amex, discover, other)
  and `last4`.
- Projections: the ADR-027 vocabulary unchanged — raw `number`, `cvv`, `cardholder_name`,
  `brand`, `billing_zip`, `expiry_month`, `expiry_year`; derived `expiry_mm`, `expiry_m`,
  `expiry_yy`, `expiry_yyyy`, `expiry_mm_yy`, `expiry_mm_yyyy`, `expiry_month_name`,
  `expiry_month_short` (`Intl.DateTimeFormat('en-US', { timeZone: 'UTC' })`).
- `parseSecretRef(ref) → { name, field | null }` (more than one `#` throws).

### 3. Resolver (`execution.ts` `resolveSecretRef`)

1. `user.*` guard on the whole ref, first (unchanged).
2. Split `#field`.
3. Read the key's details row.
   - **No `#`, and the key has a `schema`** → refuse: "`user.personal_visa_card` is a card;
     address a field, e.g. `#number`. Fields: …".
   - **No `#`, no schema** → exactly today's behavior.
   - **`#` and no recognized schema** → refuse (ADR-027 gate).
4. **Card-use check** (section 4) before any card field resolves, public or secret.
5. Secret fields read the vault with `getJSON` and check `_schema`; public fields read
   `public_fields` (no decrypt). Project, return the string.
6. Emit one `secret.accessed` per resolve with the new optional `secretField` (the projected
   field name, never the value). The audit index keeps `target_id` as the base key name, so
   Last used stays per card.

### 4. Confirm every checkout (new; ADR-059)

The resolver refuses every `credit_card` field unless a **card-use grant** exists for that
card, the registrable domain of the **top-level page** (the site in the address bar), and the
task's conversation, approved within the last 30 minutes. A field inside a frame of any
origin on that page may be filled (payment processors host the number and CVV in their own
frames). Accepted risk, decided by the principal: a hostile frame on an approved site could
receive the card. The resolver therefore takes the page's top-level URL, not the field's
document. Unlike the tracked-code guard, it doesn't judge by the field's own frame.

**Fill limits per grant:** `number` and `cvv` resolve at most **twice** each (one retry
after a form error). Public fields are unlimited within the 30 minutes. A second purchase
needs the number again, so it asks again. The check lives in the resolver, so no autonomy bypass reaches it: not a
principal-originated task, not a `humanApproved` replay.

Getting a grant:

- A new tool **`card-use-request`** (in the `web` bundle, coordinator only). Inputs, in this
  order: `secret_name`, `site_url`, `amount` (as the page shows it, e.g. "CA$412.30"),
  `purpose` (one line, e.g. "Air Canada YYZ–SFO, Dec 12"), `session_id?`.
- It never grants anything itself. It records the request (with the conversation's resume
  routing, as capture links do) and files a `pending_approval` row for an internal tool,
  **`card-use-confirm`**, through the existing approval path. That row is delivered with
  `deliver-approval` and answered the usual ways (reply "approve N", 👍 reaction, console).
  `card-use-confirm` runs only as an approval replay (`humanApproved`), and refuses any
  other call, so the principal's yes is the only way a grant gets written. No manifest schema
  change is needed.
- The message reads: "Curia wants to pay **CA$412.30** at **aircanada.com** with **Visa
  ••1111 (Personal)** for: Air Canada YYZ–SFO, Dec 12. The amount is what Curia read on the
  page." Brand, last four and label come from public fields.
- On approval, the `card-use-confirm` replay writes the grant on the request row (new table
  `card_use_requests`: card name, site domain, conversation id, resume routing, status,
  approved_at, approval ref, `number_fills`, `cvv_fills`; the fill counts go up atomically on
  each resolve)
  and **resumes the originating conversation** with the purpose. That way the agent continues
  the checkout in its warm browser session whichever way the principal answered, the same way
  `secret-capture-resume-subscriber` brings the agent back after a capture. Today only the
  `approve-action` path returns a result to the agent, so the reaction and console paths need
  this resume.
- **Only the principal can approve it.** A card-use row must have been delivered
  (`notification_sent_at` set) before it can be approved, and only by a principal reaction,
  the console, or `approve-action` in a live principal turn that arrives after delivery.
  `approve-action` refuses a card-use row otherwise, so the coordinator can't request and
  approve in the same turn, even when the principal's message said "buy it with my Visa".
- **One continuation.** When the approval came through `approve-action` in the originating
  conversation, its result tells the agent to continue the checkout, and no resume is
  published. Every other path publishes the resume. This way two turns never drive the same
  browser session.
- A card-use approval expires after 30 minutes unanswered, not the usual 24 hours.
- Deny: no grant; the agent is resumed with "declined".
- One grant covers one checkout: one card, one top-level site, one conversation, 30 minutes,
  and at most two fills each of `number` and `cvv`. A new checkout asks again.
- New bus events `card_use.requested` / `card_use.decided` (no card number; brand, last four,
  site, amount, decision). A public-API change, called out in the CHANGELOG.

### 5. Filling (`web-browser`, v1.11.0 → 1.12.0)

- `type` already passes `secret_ref` to the resolver; `#field` refs now work through it.
- `select` accepts `secret_ref`, mutually exclusive with `value`. It resolves, registers the
  value for redaction, marks the call as secret-injected (screenshot suppressed), runs the
  tracked-code guard as today, then calls `selectOption`. Over-redacting short projections
  ("12") is accepted (ADR-027).
- The tool description tells the model to match the projection to the control's options
  (`#expiry_month_name` for "December", `#expiry_mm` for "12").
- A refusal from the card-use check tells the agent to call `card-use-request` first.

### 6. Discovery and choosing a card (`list-user-secrets`, 0.2.0 → 0.3.0)

Each card key gains `{ schema: 'credit_card', label, brand, last4, expiry: 'MM/YYYY',
expired }`, all read from public fields. The addressable field list appears once in the
result summary, not per key. The summary carries the selection rule:
- Match the principal's words against label and brand ("personal Visa", "the Amex").
- Exactly one match: use it. None or more than one: ask the principal, naming the cards by
  label, brand and last four. Never pick between two plausible cards.
- An expired card: tell the principal, and offer a renewal link.

The rule sits in the tool result (ADR-046's "injection with its trigger"), so the coordinator
prompt doesn't grow.

### 7. Capture and agent edits (`secret-capture-request`, 0.4.0 → 0.5.0)

New inputs, appended after the existing ones:
- `template?: 'credit_card' | 'credit_card_renewal'`. `credit_card` mints a link to the full
  card form and forces `value_format: 'json'`. `credit_card_renewal` needs an existing card
  key and asks only for a new expiry and CVV; the number is kept.
- For a card key with `details_only: true`: `card_label?`, `expiry_month?`, `expiry_year?`,
  `cardholder_name?`, `billing_zip?`. These are public fields, so the agent can set them
  directly ("my Visa now expires 03/29") with no link. The new expiry is validated (not past).
  A CVV or number change always needs a link: the agent never takes them in chat.
- Naming: unchanged — resolved at mint from the agent's description ("personal visa card")
  through `resolveUserSecretName`, with `card` added as a type token. The label is stored
  from the agent's description, or the console's Label field.

Redeem: `secret_capture_tokens` gains `capture_template TEXT NULL` (migration 119). The
template's validation runs **before** the atomic claim; a failure returns a new
`invalid_shape` status with a reason ("card number failed its check", "this card has
expired") and leaves the token unspent. The POST body becomes `{ value }` or
`{ card: {...} }` depending on the template; GET metadata adds `capture_template` and, for a
renewal, the card's brand and last four.

Capture page: for a card template, a card form instead of the textarea (number, expiry month
and year `<select>`s, CVV, cardholder name, billing postal code optional;
`autoComplete="cc-*"`; no localStorage; cleared on success). Renewal shows "Visa ••1111" and
asks for expiry and CVV only.

### 8. Secrets page (on PR #2478's page)

One shared card-fields component and pure helpers (`validateCardForm`, `buildCardPayload`,
brand detection for display), used by both the Create drawer and the capture page. Server
validation is the authority.

- **List.** Card rows are Personal. "Used for" shows "Visa ••1111 · exp 12/2027" with the
  label as the sub-line. Status gains **Expired** (a chip in the Status group); expired cards
  sort with Missing at the top. Search also matches label, brand and last four. A duplicate
  hint, like same-site for logins: two cards with the same brand and last four each show
  "⚠ same card as user.x".
- **Create.** "Card (later)" becomes **Card**. Fields: Label (optional), number, expiry,
  CVV, cardholder name, billing postal code. Live brand display; name preview
  (`user.personal_visa_card`) and replace warning through the existing `/preview`.
  `POST /api/vault/user-secrets` accepts `type: 'credit_card'` with a `card` object and writes
  through `setStructured`. Replacing an existing card from Create is allowed (today's
  "JSON-valued key can't be replaced" refusal stays for untagged JSON).
- **View.** Label, brand, last four, expiry (with Expired pill), cardholder name, billing
  postal code — all from public fields. Recent uses shows the field filled ("filled
  `expiry_mm`") and card-use confirmations ("You approved CA$412.30 at aircanada.com").
- **Edit.** Label, expiry, cardholder name and billing postal code save without touching the
  vault (a `details` change). "New CVV" optional; blank keeps the current one. "Replace card"
  opens the full card fields for a new number. Both go through `setStructured` and validate
  server-side.
- **Remove.** Unchanged flow.

### 9. Docs and records

- Amend ADR-027 (storage split, bare-ref refusal, discovery through `list-user-secrets`,
  capture through `secret-capture-request`); write **ADR-059: card use needs a per-checkout
  confirmation** (the approval-only `card-use-confirm` replay and grants). Check the next free ADR number
  at writing time.
- CHANGELOG under Unreleased, with public-API notes for `secret.accessed.secretField`, the
  `card_use.*` events, the `resolveSecretRef` signature change, and the tool versions.
- `docs/specs/03-tools-and-execution.md` and `06-audit-and-security.md` updated at the next
  docs sync.
- No setup-wizard catalog entry: a card is not part of first-run setup.

## Delivery

A stack on PR #2478, each PR shippable. No path can create a card until PR 2, and the
confirmation gate lands in PR 1, so there's never a window where a card can be filled without
a confirmation.

1. **Core.** Registry, migration 118, `setStructured`, resolver `#` and bare-ref refusal,
   `secretField`, card-use grants, `card-use-request` / `card-use-confirm` and the
   resume, ADRs.
2. **Agent surface.** `select` + `secret_ref`, `list-user-secrets` card output and selection
   rule, `secret-capture-request` templates and card `details_only`, migration 119, capture
   page card and renewal forms.
3. **Secrets page.** Card in Create/View/Edit, Expired status, duplicate-card hint, field-level
   Recent uses.

## Acceptance criteria

- Every vocabulary field projects correctly through `resolveSecretRef('user.x#field')`;
  `#expiry_month_name` is "December" under any ambient locale.
- A bare ref to a card is refused, and lists the addressable fields; a bare ref to any
  non-structured key resolves exactly as before.
- `#` on a string secret, or on JSON without a matching registered schema in both the
  document and the details row, is refused. The `user.*` guard rejects `channel.*` refs with
  a `#` suffix.
- Viewing a card in the console and listing it via `list-user-secrets` makes no decrypt call
  (asserted by spying on `SecretsService.get`/`getJSON`).
- A card field resolves only with a matching grant (card, top-level site domain, conversation,
  under 30 minutes old), including inside a cross-origin frame on that page. A third
  `number` or `cvv` fill under one grant is refused. It is refused on a principal-originated task without one, on an approval
  replay without one, on a different site, and after 30 minutes.
- `card-use-request` is held on every call, whatever the score and initiator. Approving it by
  reply, reaction or console writes a grant and resumes the originating conversation; denying
  resumes it with "declined".
- `approve-action` refuses a card-use row that hasn't been delivered, or when called in the
  same turn that requested it. An `approve-action` approval in the originating conversation
  publishes no second resume.
- The approval message names amount, site, brand, last four and label, and never the number
  or CVV.
- `select` with `secret_ref` registers the value for redaction, suppresses that call's
  screenshot and fills the projected value; `secret_ref` with `value` is rejected.
- **Dropdown expiry forms are filled end to end** in browser tests against fixture checkout
  pages (served with `context.route`), not just two-digit text boxes. At minimum:
  - month `<select>` labelled with full names ("January" … "December") whose option values
    are opaque (e.g. `value="m12"`), filled via `#expiry_month_name`;
  - month `<select>` labelled with short names ("Jan" … "Dec"), via `#expiry_month_short`;
  - month `<select>` labelled "01" … "12", via `#expiry_mm`;
  - year `<select>` labelled "2027", "2028" … with two-digit values ("27"), via
    `#expiry_yyyy`;
  - a single `MM/YY` text box, and separate `MM` and `YYYY` boxes, for contrast.

  Each test asserts the right option is selected, the screenshot is suppressed, and no value
  appears in the tool result.
- Each resolve emits exactly one `secret.accessed` with `secretField`, no value.
- `list-user-secrets` returns label, brand, last four, expiry and expired for each card. A
  scenario covers "use my personal Visa" with two Visas (Personal and Work) and one Amex:
  the right card is chosen; "use my Visa" asks.
- Capture: a card link forces JSON; a valid card writes both halves in one transaction; a
  Luhn failure, expired card or short CVV returns `invalid_shape` and leaves the token
  re-redeemable; concurrent redeems stay single-use. A renewal link keeps the number and
  updates expiry and CVV.
- The agent updates a card's label or expiry with `details_only`, with no link and no change
  to `secrets.updated_at`; a past expiry is refused.
- Console: Card create, View, Edit (public fields without re-entering the number; new CVV;
  replace card), Expired status and duplicate-card hint work as described; no number or CVV
  appears in any response body or DOM after save (route and component tests).
- Unit tests plus integration tests on real Postgres; `pnpm run typecheck` clean; migration
  prefixes unique after rebase; CHANGELOG updated.

## Left to the builder

- Where grants live (new table vs. a row kind) and how the resume is published, as long as
  the approval UX is the existing one and every answer path resumes.
- The exact IIN ranges for brand detection.
- Whether `setStructured` takes a client or opens its own transaction.
- Component structure on the Secrets page, following PR #2478's patterns.

## My calls (not decided by the principal)

- Expiry, cardholder name and billing ZIP move to public fields with the last four; only the
  number and CVV are encrypted. This changes ADR-027's stored shape.
- A bare ref to a card is refused (the issue said bare refs are unchanged).
- Discovery extends `list-user-secrets` and capture extends `secret-capture-request`, instead
  of a new browser action and a new tool.
- The last four go to the agent as well as the console, so it can name cards when asking.
- The confirmation reuses the existing approval delivery and answer paths. It's unconditional
  because the grant is written only by `card-use-confirm`, which runs only as an approval
  replay.
- The amount is what the agent reports from the page; the message says so.
- A card-use approval must be delivered and answered by the principal after delivery; the
  coordinator can't self-approve. It expires after 30 minutes.
- An `approve-action` approval in the originating conversation continues in that turn and
  publishes no resume, so only one turn drives the browser.
- Card names are resolved at mint from the agent's description; the true brand comes from
  the number and shows in the list even if the name says otherwise.
- Expired is a new list status; duplicate cards get a hint like duplicate sites.
- No setup-wizard catalog entry.
