# Design: Automated / Bulk Sender Class (Issue #953)

**Status:** Approved — ready for implementation planning  
**Depends on:** #945 (tier + kind schema — closed), #946 (contact/KG boundary — closed)  
**Milestone:** v0.36 Contacts redesign: entity ledger + capability tiers

---

## Context

~20–35% of contacts are newsletters, notifications, and machine-generated mail
(Google doc comments, Cloudflare alerts, Substack, Stripe receipts). These should
never look like a person to triage and never appear in the People view. The `kind`
column (from #945) defines `'automated'` as a first-class value for exactly this
class, but detection and wiring are not yet implemented.

The hold queue has already been removed. The remaining work is:
1. Classify automated senders correctly at contact creation time.
2. Backfill existing misclassified contacts.
3. Pass `kind` through to the coordinator so it treats automated senders as
   low-salience machine mail, not as addressable people.
4. Filter automated senders out of the People view.

Detection uses **address patterns only** (no DKIM/DMARC for now — added complexity
for marginal gain given the pattern coverage).

---

## Section 1: Detection — `classifyEmailSender()`

**File:** `src/contacts/contact-service.ts`

### Change

Split `NON_PERSON_LOCAL_RE` into two regexes and extend the function's return type
from `'person' | 'organization'` to `'person' | 'organization' | 'automated'`.

**`AUTOMATED_LOCAL_RE`** — unambiguously machine-sent local-parts:
- `noreply`, `no-reply`, `no_reply`
- `donotreply`, `do-not-reply`, `do_not_reply`
- `mailer-daemon`, `mailerdaemon`
- `notification`, `notifications`
- `alert`, `alerts`
- `newsletter`, `newsletters`
- `updates`
- `bounce`, `bounces`, `bounced`
- `unsubscribe`
- `postmaster`
- `automated`, `auto`

**Trimmed `NON_PERSON_LOCAL_RE`** — organisation addresses, not automated (kept):
`info`, `support`, `help`, `admin`, `billing`, `contact`, `feedback`, `team`,
`sales`, `marketing`, `legal`, `security`, `service`, `services`, `order`,
`orders`, `invoice`, `invoices`, `account`, `accounts`, `system`, `news`

### Detection order

1. Check `AUTOMATED_LOCAL_RE` → `'automated'`
2. Check personal webmail domain (gmail, yahoo, icloud, etc.) → `'person'`
3. Check trimmed `NON_PERSON_LOCAL_RE` → `'organization'`
4. Check personal name pattern (`first.last`, `first_last`, etc.) → `'person'`
5. Default → `'person'`

Order is important: automated check runs before webmail and name-pattern checks so
`noreply@gmail.com` is not misclassified as `'person'`.

---

## Section 2: Contact creation & KG node handling

**File:** `src/contacts/contact-service.ts` — `createContact()` and
`resolveOrCreateOrgNode()`

### Change

The existing flow calls `classifyEmailSender()` → on `'organization'`, calls
`resolveOrCreateOrgNode()` to find/create an org KG node, then sets
`kind='organization'`.

New `'automated'` branch: **skip `resolveOrCreateOrgNode()`**. Automated senders
are not an organisation to enrich — `noreply@stripe.com` is unrelated to the Stripe
org node. The contact gets `kind='automated'`; no KG node is created or linked
beyond what may already exist.

`tier` for new automated contacts stays `'unknown'` (same default as any new
contact). Tier is the capability axis; it simply will not be consulted for automated
senders in the coordinator layer.

---

## Section 3: Migration (057)

**File:** `src/db/migrations/057_backfill_automated_kind.sql`

Single-pass bulk UPDATE via a Postgres regex over the local-part of existing email
channel identities. Touches both `kind='organization'` and `kind='person'` rows to
catch contacts created before the classifier was added.

```sql
UPDATE contacts
SET kind = 'automated', updated_at = now()
WHERE id IN (
  SELECT c.id
  FROM contacts c
  JOIN contact_channel_identities cci ON cci.contact_id = c.id
  WHERE cci.channel = 'email'
    AND cci.identity_value ~* '^(noreply|no[_.-]reply|donotreply|do[_.-]not[_.-]reply|mailer[_.-]?daemon|mailerdaemon|notifications?|alerts?|newsletters?|updates?|bounced?|bounces?|unsubscribe|postmaster|automated|auto)@'
    AND c.kind != 'automated'  -- idempotent on re-run
);
```

The regex mirrors `AUTOMATED_LOCAL_RE` exactly — keep them in sync when either
changes.

---

## Section 4: Dispatch context

**File:** `src/dispatch/dispatcher.ts`

### Change

Confirm `kind` is included in the `senderContext` block passed to the coordinator
alongside `tier`. If missing, add it wherever `tier` is read from the contact for
the context block.

No routing logic changes. Automated senders flow through the same path as all other
non-blocked senders — the `kind` field is informational context for the coordinator,
not a dispatch gate.

**Build-time verification (required):** check the `senderContext` TypeScript type
definition and confirm it accepts `kind`; update if not.

---

## Section 5: ceo-inbox agent

**File:** `agents/ceo-inbox.yaml`

### Addition to agent instructions

Add a handling rule for `kind: automated` senders:

> **Automated senders (`kind: automated`):** Default to low-salience — most machine
> mail is noise and should be cleared without interrupting. Scan the content for
> genuinely actionable signals before clearing: account suspension, payment failure
> or successful payout, fraud or security alert, bounce notification, or a hard
> deadline embedded in the content. If any of those are present, escalate as you
> normally would regardless of sender kind. Do not draft replies to automated
> senders.

This satisfies the acceptance criterion "actionable machine mail is flagged distinct
from pure noise" without a second LLM pass. The existing triage judgment applies the
rule; `kind=automated` is the calibration input.

---

## Section 6: People view (contact-list skill)

**File:** `skills/contact-list/handler.ts`

### Changes

1. **Default query** — when no explicit `kind` param is passed, filter to
   `kind IN ('person', 'principal', 'organization')`. Excludes `kind='automated'`
   and `kind='agent'` from the default listing without breaking existing callers.

2. **Explicit `kind` param** — accept a single value or comma-separated list.
   Passing `kind=automated` returns the Subscriptions & Notifications surface.
   Provides the query seam needed by #11 (ledger surfaces) without further changes
   to this skill.

---

## Section 7: Tests

| Area | What to verify |
|------|----------------|
| `email-sender-classifier.test.ts` | `noreply@github.com`, `no-reply@stripe.com`, `notifications@slack.com`, `mailer-daemon@googlemail.com`, `bounce@amazonses.com` → `'automated'`; `support@stripe.com`, `billing@acme.com` → `'organization'`; `noreply@gmail.com` → `'automated'` (not `'person'`); ordering: automated checked before webmail |
| Migration 057 | Fixture with noreply contact at `kind='organization'` and real-person contact — only noreply reclassified; idempotent on re-run |
| `dispatcher.test.ts` | `kind` present in `senderContext` for automated sender; automated sender message not dropped |
| `contact-list` skill | Default query excludes `kind='automated'`; `kind=automated` param returns them |

---

## Acceptance criteria (from issue)

- [ ] Google / Cloudflare / newsletter-type senders are auto-classified `automated`
      and never held.
- [ ] Actionable machine mail is flagged distinct from pure noise.
- [ ] Automated senders do not appear in the People view.

---

## Out of scope

- DKIM/DMARC header parsing (future enhancement)
- Automated sender UI surface (tracked in #11 — ledger surfaces)
- Action gate at the autonomy approval level (tracked in #7)
