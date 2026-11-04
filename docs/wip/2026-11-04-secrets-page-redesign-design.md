# Secrets page redesign — design

Status: draft for approval · 2026-11-04 · follows #2453 / PR #2468

## Why

The console `/secrets` page (shipped in #2468) works against what the principal actually
comes to it for:

- **It looks and behaves unlike every other Memory page.** Contacts, Tasks and Jobs are a
  searchable, filterable, sortable records table with a right-hand drawer. Secrets is a
  settings card with inline Set/Replace inputs inside each row.
- **It can't scroll.** `.app-root` and `.main` are `overflow: hidden` by design
  (`apps/console/src/styles/app.css:114-122`, `:251`), and the page body
  (`SecretsPage.tsx:165`) is a plain padded div with no scroll container, so anything below
  the fold is unreachable.
- **There is no create.** The page lists only names something declares.
- **The secrets the principal cares most about aren't on it.** `isAllowedVaultName`
  (`src/channels/http/routes/vault.ts:135-147`) excludes `user.*`, so website passwords and
  logins captured by agents are invisible and uneditable in the console.

The page has three jobs, in the principal's words and order of discovery:

1. **Audit** — see every secret at once and spot irrelevant, out-of-date or duplicate ones.
   This is what failed on first use.
2. **Setup** — add a password (later a credit card, etc.) directly.
3. **Debug** — when Curia can't sign in to a site, find that site's credential fast and see
   what's there, when it changed, and whether Curia has been using it.

## Goals

- One list of **all** secrets — personal (`user.*`) and system (declared) — in the same
  records-table pattern as Contacts / Tasks / Jobs.
- Search, filter chips, sortable columns, pinned header, a page that scrolls.
- Create, view, edit and remove through the same right-hand drawer the other Memory pages use.
- Enough per-secret metadata (dates, sign-in site, recent reads) to audit and debug.

## Non-goals

- Revealing secret values. Values stay write-only everywhere (ADR-020/021,
  `secret-capture-service.ts:1-8`). No reveal button, no copy-to-clipboard.
- Recording whether a sign-in succeeded or failed. Nothing records that today; this page
  surfaces "Curia read this secret", not "the login worked". (A future signal could join
  `verifications` or browser outcomes, but not in this work.)
- Building credit cards (ADR-027). Only a placeholder (below).
- Creating arbitrary *system* keys from the console. System keys exist because a tool,
  channel, MCP server or mailbox declares them; the console only sets/replaces/removes them.
- A shared table component refactor across Contacts/Tasks/Jobs. Follow the existing
  copy-the-pattern convention for this page (see "Left to the builder").

## Anti-goals (would be a failure even if it technically works)

- Any API response, log line, audit payload or DOM node carrying a secret value.
- The console creating a duplicate `user.*` key that capture-link naming would have merged.
- A page that still behaves differently from the other Memory pages (inline editors in rows,
  a different search/filter idiom, a modal instead of the drawer).
- Weakening the system-key allowlist: a console write must still be unable to touch an
  arbitrary non-`user.*` vault key.

## Decided by the principal

- **One list** for personal and system secrets, with filter chips and sortable columns.
- **Filters:** Kind (Personal / System / Platform), Status (Configured / From env / Missing /
  Not set), Required (Required / Optional).
- **Platform keys are listed but never changeable or removable from the console.** These are
  the keys Curia reads directly at boot that no tool/channel/MCP declares (see "Platform
  keys" below). The principal wants to *see* they exist; edit and remove are disabled.
- The list and drawer mockups below were reviewed and approved as shown.
- **Credit card ships as a visible, disabled "Card (later)" option** in the create drawer.
  Roadmap-aware placeholders are explicitly welcome.

## The design

### Page shell

Same structure as `ContactsPage.tsx`: `Topbar crumb="Memory" title="Secrets"` with a
`TopbarSearch` (plus the mobile search div, since TopbarSearch hides ≤768px) and a
"+ New secret" button; body is `.records-layout` > `.records-main` (`.records-toolbar` +
`.records-table-wrap`) with the drawer as a sibling. Using these classes is what fixes the
scroll — `.records-table-wrap` is the scroll container and `thead th` is already sticky.

Remove the `.settings-section` / inline-style layout entirely.

### List

**Toolbar:** three chip groups, each with counts, labelled Kind / Status / Required; "X of Y"
on the right. Chips within a group are single-select with "All" implied when none is on
(Kind shows an explicit "All"). Groups combine with AND.

**Search** matches vault key, declarer names, sign-in site/URL and username
(case-insensitive, client-side over the full list — same as Contacts).

**Columns:**

| Column | Personal (`user.*`) | System | Platform |
|---|---|---|---|
| Name | vault key in `<code>` | vault key in `<code>`, with "Required"/"Optional" as a sub-line | vault key in `<code>`, 🔒 icon, "Managed by deployment" sub-line |
| Kind | Personal | System | Platform |
| Status | Configured (a `user.*` row only exists when set) | Configured / From env / Missing / Not set / Not declared pill | Configured |
| Used for | sign-in site (host of `login_url`) with username sub-line; "No sign-in site saved" when absent | declarer label(s), e.g. "Tool web-search", "MCP linear (disabled)" | platform label, e.g. "LLM provider", "Console sign-in" |
| Updated | `secrets.updated_at` | `secrets.updated_at`; "n/a" when not in the vault | `secrets.updated_at` |
| Last used | most recent `secret.accessed` | same; "Never" / "n/a"; "At startup" for boot-read kinds | "At startup" |

Platform rows have no pencil icon. The Kind chip group gains **Platform**.

Sortable: Name, Kind, Status, Updated, Last used (same `toggleSort` / `aria-sort` pattern).
**Default sort:** Missing first, then name — anything broken floats to the top.

**Duplicate hint (audit aid):** when two or more `user.*` rows share a sign-in host, each
shows a warning sub-line under "Used for": "⚠ same site as user.x_y". Hosts compare after
lower-casing and stripping a leading `www.`. Rows without a `login_url` never match.

Mockup (approved):

```
Memory / Secrets                      [🔍 Search name, site, username…] [+ New secret]
KIND [All 14][Personal 6][System 8]  STATUS [Configured][From env][Missing][Not set]
REQUIRED [Required][Optional]                                             14 of 14
Name ▲                      Kind      Status      Used for              Updated  Last used
channel.telegram.bot_token  System    Missing     Channel telegram      n/a      n/a
  Required
user.rogers_login           Personal  Configured  rogers.com            Aug 19   Never
                                                  ⚠ same site as user.rogers_password
```

### Drawer

Same `.drawer` component/CSS and `DrawerMode = 'view' | 'edit' | 'create' | null` as
Contacts. Row click → View; pencil icon on the row or "Edit" in View → Edit;
"+ New secret" → Create.

**View** (the debugging view):

- Title: a readable label derived from the key (e.g. `user.aircanada_password` → "Aircanada
  password"); vault key shown below in `<code>`.
- Kind, Status pill.
- Personal: sign-in page (link), username.
- System: each declarer with kind, enabled state, required/optional and `purpose`; env
  fallback note when applicable (same copy as today's row).
- Created, Updated.
- **Recent uses:** the last 5 `secret.accessed` events — agent, tool, relative time — with
  the note *"Used" means Curia read it; whether the sign-in worked isn't recorded.*
  Empty state: "Curia hasn't read this secret yet."
- Platform: what reads it, plus "Managed by deployment — change it in the deploy
  environment, not here." **No footer buttons.**
- Footer: Remove (left, danger), Edit (primary). System rows not in the vault show
  "Set value" instead of Edit and no Remove.

**Create** (personal only):

- Type segmented control: **Website login** (default) · **Other** · **Card (later)**
  (disabled, tooltip "Coming soon — ADR-027").
- Website login: Sign-in page URL (required), Username (optional), Password (required,
  `type="password"`).
- Other: Label (required, free text, e.g. "Bank PIN"), Value (required, `type="password"`),
  optional Sign-in page URL and Username.
- **Name preview** under the fields, live: "Saved as `user.rogers_password`". Generated with
  the existing naming policy (`resolveUserSecretName` in `src/secrets/user-secret-name.ts`)
  so the console and capture links can never disagree. Input to the policy: for Website
  login, the URL host's registrable part plus "password" (e.g. `rogers password`); for Other,
  the label.
- **Duplicate warning** when the resolved name is an existing key: "You already have
  `user.rogers_password` (updated Jun 4). Saving replaces it instead of adding a
  duplicate." Save stays enabled; it replaces the value and upserts the details.
- Footer: Cancel, Save.

**Edit:**

- Personal: vault key (read-only, "Can't be renamed"), Sign-in page URL, Username,
  "New password" (blank = keep current). Saving with only details changed must not touch
  the vault row.
- System: read-only declarer info plus a single "New value" field (`ceo_self_email` keeps
  its email validation).
- Footer: Cancel, Save.

**Remove** keeps today's flow (`removeSecretFlow`: confirm → DELETE → on 409 show the
`affected` list and confirm `?force=true`). Removing a `user.*` key also deletes its
`user_secret_details` row. Confirms stay `window.confirm` for now, matching current
behaviour.

### Backend changes

All new/changed routes live in `src/channels/http/routes/vault.ts`, same auth
(`assertSecret`), same 30/min rate limit, same two-stage `secret.changed` audit for every
write, and **never return values**.

1. **`GET /api/vault/secrets` returns everything the list needs:**
   - Add `kind: 'personal' | 'system' | 'platform'`, `createdAt`, `updatedAt` (ISO or null
     when not in the vault), `lastUsedAt` (ISO or null), `valueFormat`.
   - Add **platform rows** for every name in the platform key list (below) that is in the
     vault: `kind: 'platform'`, `declaredBy: [{ kind: 'platform', name: <what reads it, e.g.
     "LLM provider", "Console sign-in">, required: true, enabled: true }]`.
   - Add `user.*` rows: every `user.*` name in the vault, `kind: 'personal'`,
     `configured: true`, `required: false`, `declaredBy: []`, plus `loginUrl` / `username`
     from `user_secret_details`.
   - Add **orphaned system keys**: names in the vault that are not `user.*`, not on the
     platform list, and that nothing currently declares (e.g. a key left by an uninstalled
     tool). `kind: 'system'`,
     `declaredBy: []`, and a new status **Not declared** (chip in the Status group). Today's
     only special case — leftover email grants — folds into this.
   - `SecretsService` gains a metadata read (names + `created_at` / `updated_at`, no
     ciphertext) so the route never decrypts anything to build the list.
2. **`POST /api/vault/user-secrets`** — create or replace a personal secret.
   Body: `{ type: 'website_login' | 'other', label?, loginUrl?, username?, value }`.
   Resolves the name server-side with `resolveUserSecretName` against
   `listUserNames()` (oldest first), validates details with `parseUserSecretDetails`,
   sets the value, upserts details. Returns `{ name, replaced: boolean }`.
   A companion **`POST /api/vault/user-secrets/preview`** (same body minus `value`) returns
   `{ name, existing: { updatedAt } | null }` for the live name preview and duplicate
   warning, so naming logic exists only on the server.
3. **`PATCH /api/vault/user-secrets/:name`** — `{ loginUrl?, username?, value? }`. Name must
   be an existing `user.*` key. Details-only edits don't write the vault row (so
   `updated_at` reflects value changes only). Value, when present, goes through the
   same set path.
4. **`DELETE /api/vault/secrets/:name`** accepts `user.*` names (never 409 — nothing
   declares them) and orphaned system keys, and deletes the matching
   `user_secret_details` row.
5. **`GET /api/vault/secrets/:name/uses?limit=5`** — recent `secret.accessed` events for that
   name: `{ at, agentId, toolName, source, byReference }`.
6. **Allowlist:** `isAllowedVaultName` stays the gate for `PUT /api/vault/secrets/:name`
   (system keys). Personal writes go only through the `user-secrets` routes, which can only
   ever produce a `user.` key (the naming policy guarantees the prefix). Orphan delete is
   allowed for names that exist in the vault; orphan *set* is not. **Platform keys are
   refused by every write route** (PUT, PATCH, DELETE, user-secrets) with a 403 and
   "Managed by deployment — change it in the deploy environment", checked before the
   allowlist so a platform key can never become writable by also being declared somewhere.

**Platform keys.** A single exported constant (e.g. `PLATFORM_VAULT_KEYS` in
`src/secrets/`) lists them with a human label each. Today that is everything
`src/secrets/apply-vault-secrets.ts` reads (`web_app_bootstrap_secret`, `api_token`, the
LLM/embedding provider keys, the AWS keys, `nylas_api_key` / `nylas_grant_id` /
`nylas_self_email`) plus `web_push_vapid` (`src/channels/web/vapid.ts`).
`apply-vault-secrets.ts` should read its key names from this constant so the two can't
drift; if that's awkward, a unit test asserts every key it reads is on the list.

**Last used.** `secret.accessed` has no structured-column extractor
(`src/audit/field-extraction.ts`), so today it's only queryable via
`payload->>'secretName'`. Add an extractor (`target_type='secret'`, `target_id=secretName`,
`action='accessed'`) so new rows are indexed like `secret.changed`. Historical rows: the
builder decides between a one-off backfill migration and a query that falls back to the
payload for older rows — either is fine as long as the list endpoint stays fast (it
computes `lastUsedAt` for all names in one grouped query, not N queries).

### Mobile

Follow the other records pages: chip groups wrap, the table scrolls horizontally inside
`.records-table-wrap`, the drawer follows its existing responsive rules.

### Edge cases settled after review

- **Keys read at startup have no "last used".** `secret.accessed` is emitted only from
  `ctx.secret()` / `ctx.resolveSecretRef()` (`src/skills/execution.ts`). Channel
  credentials, MCP keys, mailbox grants and platform keys are read at boot without an
  event. For those, Last used shows **"At startup"** (muted), not "Never", and View's
  Recent uses says "Read when Curia starts; individual reads aren't recorded." Emitting
  `secret.accessed` from the boot loaders is out of scope.
- **Details-only edits are audited** as `secret.changed` with a new
  `action: 'details'` (requested + completed, key name only). This extends a bus event
  type, so the CHANGELOG entry calls it out as a public-API change.
- **Clearing details.** In Edit, blanking Sign-in page URL or Username clears it. The PATCH
  contract distinguishes omitted (keep) from `null` (clear), which needs a non-COALESCE
  update path in `SecretsService`. In Create, when the resolved name already exists, blank
  details **keep** the existing ones; only provided fields overwrite.
- **JSON-valued personal secrets** (capture links can store `value_format: 'json'`). The
  metadata read returns `value_format`. View shows "Structured value". Edit hides the value
  field for these and says "Recapture through Curia to change a structured value"; details
  stay editable. Create refuses to replace a JSON-valued key and says why.

## Acceptance criteria

- `/secrets` scrolls; with 50+ secrets every row is reachable and the header stays pinned.
- The list shows every `user.*` secret, every declared system key, every platform key in the
  vault, and every orphaned vault key, with the columns above.
- Platform rows open View with no Edit/Remove; PUT, PATCH and DELETE on a platform key
  return 403 and leave the vault unchanged (route tests), even if the key is also declared.
- Every key `apply-vault-secrets.ts` reads is on the platform list (unit test or shared
  constant).
- Search matches key, declarer, sign-in site and username; each chip group filters and shows
  correct counts; groups combine; "X of Y" is right.
- Name, Kind, Status, Updated, Last used sort both ways; default is Missing first, then name.
- Two `user.*` secrets with the same sign-in host both show the duplicate hint.
- Row click opens View with dates and the last 5 reads; no value appears anywhere in the
  DOM or any response body (assert in route tests).
- "+ New secret" → Website login with URL `https://www.rogers.com/signin` previews
  `user.rogers_password`; if that key exists, the replace warning shows and saving replaces
  it (no new key).
- "Card (later)" is visible and disabled.
- Editing only the username of a personal secret leaves `secrets.updated_at` unchanged.
- Removing a `user.*` secret deletes its details row; removing a required system key still
  goes through the 409 → force confirm.
- Every create/replace/delete emits `secret.changed` requested + completed; new
  `secret.accessed` rows get `target_type='secret'`, `target_id=<name>`.
- `PUT /api/vault/secrets/:name` still rejects an arbitrary non-declared, non-`user.*` name.
- No inline editors remain in table rows.
- CHANGELOG entry under Unreleased.

## Left to the builder

- Whether to extract a small local `Pagination`/sort helper or copy Contacts' pattern
  (copying matches convention; don't refactor the other pages in this work).
- Readable-label derivation from a `user.*` key.
- Backfill vs. payload fallback for historical `secret.accessed` rows (see above).
- Exact chip/pill colours — reuse existing pill classes where they exist.
- PR split (e.g. backend endpoints first, page second) — either one PR or a short stack.

## My calls (not explicitly decided by the principal)

- Orphaned system keys (not declared, not platform) appear with a **Not declared** status
  and can be removed but not set.
- Platform-key writes are refused server-side (403), not just hidden in the UI.
- Boot-read keys show "At startup" for Last used rather than emitting new audit events.
- Details-only edits get a new `secret.changed` action `'details'`.
- Blank in Edit clears a detail; blank on a Create-replace keeps the old one.
- JSON-valued personal secrets: details editable, value replacement blocked.
- Create is personal-only; system keys are set from their row.
- Details-only edits don't bump `updated_at`.
- Default sort Missing-first.
- Server-side name preview endpoint rather than duplicating the naming policy in the console.
