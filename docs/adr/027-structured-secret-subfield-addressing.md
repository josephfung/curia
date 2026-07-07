# ADR-027: Structured secrets with schema-tagged sub-field addressing

Date: 2026-07-07
Status: Accepted

## Context

The secrets vault ([ADR-020](020-secrets-vault.md)) stores each secret as a single
AES-256-GCM blob under one `name` key, with `value_format` recording only whether the
plaintext is a raw `string` or a JSON document. There is no *semantic* type — the
consumer owns all meaning. The form-fill path built on top of it
([ADR-021](021-vault-only-secret-resolution.md) and the `secretResolver` capability,
#973) is deliberately narrow: the web-browser skill's `type` action takes a
`secret_ref`, calls `ctx.resolveSecretRef(ref)`, and gets back **exactly one string**,
which it fills into **exactly one field**. `resolveSecretRef` reads the vault with
`secretsService.get()` (raw string, never `getJSON`), hard-guards the `user.*`
namespace, and audits the access by name. The `select` action, by contrast, accepts a
literal `value` only — it has no `secret_ref` path at all.

That model fits an opaque credential (a site password, an API token) perfectly. It does
not fit a **structured** credential — most concretely, a **credit card**, whose fields:

1. **need individual addressing at fill time** — number, expiry, CVV, and cardholder
   name each go into a *different* form field;
2. **render differently per form** — the same stored expiry must appear as `12/25` on
   one site, as separate `MM` and `YYYY` text boxes on another, and as `December` +
   `2025` dropdowns on a third; and
3. **mix truly-secret and non-secret parts** — the PAN and CVV are sensitive; the
   expiry month/year and cardholder name are not.

Today the only workable representation is *N separate `user.card_*` string secrets*,
one per form field. That approach fails in two structural ways. First, the `select`
action cannot consume a secret, so any card field rendered as a `<select>` (expiry
month and year, very commonly) cannot be filled server-side at all — the value would
have to pass through the model, defeating the entire point of `secret_ref` (the model
never sees the value). Second, a stored string is **format-frozen at capture**: a
secret holding `"12/25"` cannot satisfy a form that wants `MM` and `YYYY` in two boxes,
so the same expiry has to be re-captured per format — and there is no single source of
truth for the card.

**Alternatives considered.**

- **Keep N flat `user.card_*` string secrets (status quo).** Rejected. It leaves the
  `<select>` gap unsolved, has no grouping (four unrelated keys the agent must know by
  name), and freezes each value in one format — the multi-representation problem is
  unsolvable without storing the same datum several ways.

- **Store the card as a `json` secret and expose arbitrary JSONPath sub-field
  reads** (`user.anything#some.deep.path`). Rejected as a general capability. It would
  turn `resolveSecretRef` into a generic exfiltration primitive over *every* JSON
  secret — including wholesale-secret documents like OAuth token sets
  (`user.oauth#refresh_token`) that were never meant to be individually addressable.
  Projections such as "month name" also only make sense for a card, not for arbitrary
  JSON. Sub-field addressing must be *gated*, not universal.

- **Per-field encryption / a payment-processor tokenization layer (Stripe et al).**
  Rejected as out of scope. Curia is self-hosted; the operator who runs it chooses to
  store their own PAN on their own infrastructure. There is no multi-tenant service and
  therefore no PCI-DSS obligation to design around. The vault's existing AES-256-GCM at
  rest is the accepted protection; adding an external processor dependency solves a
  compliance problem this deployment model does not have.

## Decision

Introduce **structured secrets**: a JSON secret carrying a `_schema` tag, addressable
by sub-field through the existing `secret_ref` mechanism, with a fixed vocabulary of
**derived projections** so one canonical value renders any way a form needs. Ship
**`credit_card`** as the first (and, for now, only) schema, but build the machinery as
a small **schema registry** so future structured types (postal address, login pair)
plug in without touching the resolver.

**1. Schema-tagged storage.** A structured secret is a `value_format: 'json'` row whose
document includes a routing tag, e.g.:

```jsonc
{
  "_schema": "credit_card",
  "number": "4111111111111111",   // PAN, digits only
  "expiry_month": "12",           // canonical "01".."12"
  "expiry_year": "2025",          // canonical 4-digit
  "cvv": "123",
  "cardholder_name": "Joseph Fung",
  "brand": "visa",                // optional
  "billing_zip": "M5V 2T6"        // optional
}
```

Month and year are **always stored canonical**; every rendering is derived at read
time. There is exactly one source of truth per field — a differently-formatted form
never requires re-entry.

**2. Sub-field addressing, gated to a registered schema.** A `secret_ref` may carry a
`#field` suffix: `user.credit_card#expiry_mm`. The `user.*` namespace guard runs first,
on the whole ref, so `#`-addressing cannot escape the sandbox. When a `#field` is
present, `resolveSecretRef` reads the row with `getJSON`, looks up the `_schema` tag in
the registry, validates the document against that schema, and returns the projected
field as a string. **A JSON secret with no recognized `_schema` is refused for
`#`-addressing** — this is the gate that stops the generic-JSONPath exfiltration risk.
A bare `user.foo` (no `#`) resolves exactly as today, unchanged.

**3. Derived-projection vocabulary.** Each schema declares a fixed set of addressable
fields — raw fields plus computed views. For `credit_card`: `number`, `cvv`,
`cardholder_name`, `brand`, `billing_zip`, `expiry_month`, `expiry_year` (raw);
and derived `expiry_mm` (`"12"`), `expiry_m` (unpadded), `expiry_yy` (`"25"`),
`expiry_yyyy` (`"2025"`), `expiry_mm_yy` (`"12/25"`), `expiry_mm_yyyy` (`"12/2025"`),
`expiry_month_name` (`"December"`), `expiry_month_short` (`"Dec"`). Month names are
produced with `Intl.DateTimeFormat` pinned to **`en-US`** — form option labels are
overwhelmingly English, and using the agent's ambient locale would make a fill's
success depend on deployment config. The model chooses the projection that matches the
form control it sees; the value is still resolved and filled server-side.

**4. `select` gains a `secret_ref` path.** The web-browser `select` action accepts
`secret_ref` (mutually exclusive with `value`), resolving it the same way `type` does —
including registering the resolved value for redaction and suppressing the screenshot on
that action. This closes the dropdown gap: an expiry-month `<select>` fills from
`user.credit_card#expiry_month_name` (or `#expiry_mm`, matching the option labels)
without the value passing through the model. Expiry and brand are not truly secret, but
the fill guarantee is kept uniform to avoid a leak carve-out.

**5. Discoverability without disclosure.** Because sub-field names are not guessable, a
read-only path lets the agent enumerate a structured secret's addressable fields
(**names only, never values**) so it can map form controls to refs. This carries no
value and needs no `secret.accessed` audit.

**6. Capture stays write-only and validates on entry.** The principal enters a card
through a structured capture form (extending the existing one-time-token capture flow),
which assembles the canonical JSON — stamped with `_schema: "credit_card"` — and writes
it via `setJSON`. Validation at capture is **format + length plus a Luhn check on the
PAN and rejection of an already-expired card**; a card that fails validation returns an
error and does not consume the one-time token. The captured value is never read back,
preserving the mint-only guarantee.

**7. Audit records the field path, not the value.** The `secret.accessed` event gains an
optional field for the projected sub-path (e.g. `expiry_mm`), so filling four card
fields on a form produces four audit events, each naming the base secret and the field —
and never the value.

## Consequences

**Easier / safer:**

- A credit card is one grouped, canonical secret instead of four unrelated keys. The
  same stored expiry fills a single `MM/YY` text box, two separate boxes, or two
  dropdowns, with no re-capture — one source of truth per field.
- The `<select>` gap closes: card fields rendered as dropdowns fill server-side, keeping
  the "the model never sees the secret" guarantee that `secret_ref` exists to enforce.
- Sub-field addressing is a *gated* capability. Because it is confined to
  `_schema`-tagged documents, it does not become a generic reader over arbitrary JSON
  secrets, and wholesale-secret blobs (OAuth token sets) stay opaque.
- The registry generalizes: new structured types (address, login pair) are added by
  registering a schema + projections, without changing `resolveSecretRef` or the
  web-browser skill.

**Accepted trade-offs / risks:**

- **The PAN lives in the vault in full.** This is a deliberate, operator-owned choice
  for a self-hosted deployment with no PCI obligation. Protection is the vault's
  existing AES-256-GCM at rest; there is no tokenization layer. A compromised host with
  the encryption key can read stored cards, exactly as it can read any other secret.
- **Redaction over-scrubs short projections.** A value like `expiry_mm` = `"12"` is
  registered for redaction and will be scrubbed wherever `"12"` appears in returned page
  text. This is the intended fail-safe direction (over-redact, never under-redact) and
  is accepted.
- **`secret.accessed` payload gains an optional field** — a change to the bus-event
  public API surface, called out per the changelog policy. It is additive and
  backward-compatible.
- **`skill.json` for web-browser gains a `select` + `secret_ref` behavior** — a
  public-API (manifest schema) change, versioned with a minor bump.
- **Month-name projections are pinned to `en-US`.** A non-English payment form with
  localized month labels would not match; revisiting locale handling is deferred until
  such a form is actually encountered.

## Status of implementation

This ADR records the decision only. The implementation is tracked as future work in
[#1358](https://github.com/josephfung/curia/issues/1358), which carries the file-level
blueprint, and is expected to land in three independently shippable slices: the
projection module + gated resolver + audit field; the `select` secret path + field
discovery; and the structured capture form.
