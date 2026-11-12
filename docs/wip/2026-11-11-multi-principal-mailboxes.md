# Multiple principal mailboxes and calendars — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Curia run two or more principal Gmail accounts (mail and calendar) in one install, choosing the right account for every action (#2475).

**Architecture:** A `principal_mailboxes` registry plus a `PrincipalMailboxes` service (injected as tool capability `principalMailboxes`) replaces the flat `ceo_nylas_grant_id` / `ceo_self_email` secrets. Code picks the account from the object whenever one exists (`locate`); new mail and meetings require a stated `mailbox`, backed by live evidence. Triage moves to a code heartbeat; calendar tools route through a `CalendarRouter` keyed by `contact_calendars.principal_mailbox_id`.

**Tech Stack:** TypeScript ESM (Node 26), PostgreSQL 16 + node-pg-migrate (plain SQL), Nylas v3 (SDK in `src/`, REST `CeoNylasClient` in `skills/_shared/`), vitest, React (apps/console).

**Spec:** `docs/wip/2026-11-11-multi-principal-mailboxes-design.md` (read it first; D-numbers below refer to it).

## Global Constraints

- Worktree: `/Users/josephfung/Projects/curia/worktrees/curia-multi-principal-mailboxes` (`$W` below). Commands use `pnpm -C $W …` / `git -C $W …`; no `&&` / `||` chaining.
- Four stacked PRs (Parts 1–4), merged in order with rebase-and-merge (never squash). Part 1 is branch `feat/2475-multi-principal-mailboxes`; Parts 2–4 branch from the previous part: `feat/2475-ceo-inbox-sending`, `feat/2475-triage`, `feat/2475-calendar`. Each PR body has `Part of #2475` (Part 4: `Closes #2475`). Open each PR with the `no-loop` label.
- Commits: `git -C $W commit -s` (DCO). No `Co-Authored-By` trailer and no "Generated with Claude Code" line.
- Single-mailbox installs behave exactly as today after every part. `MAX_LIVE_MAILBOXES = 1` until Task 33 lifts it.
- An unknown or removed mailbox id is an error, **never a fallback to the default** (D2).
- Migrations: next free prefix is `123`. After every rebase, `ls $W/src/db/migrations | sort` and check prefixes are unique.
- Mailbox id: `^[a-z][a-z0-9-]{0,31}$`, immutable, never reused (tombstoned rows keep it). Never `primary` or `default`.
- Vault key per mailbox: `principal.mailbox.<id>.nylas_grant_id`. API key stays `channel.email.nylas_api_key`.
- Every touched `tool.json` declares required inputs first, then the payload, then optional inputs; `mailbox` / `move_to_mailbox` / `treat_as_free` / `triage` go last.
- Defaults: send level `on_request`; cadence `hourly 06:00-23:00`; autonomous cap **10 per rolling 24h in total**; backlog alarm `> 100`; daily ceiling `120` batches; triage batch `5`; heartbeat every `15` minutes; dedupe TTL `30` days.
- No version bumps in `tool.json` / `SKILL.md` / agent YAML. One changelog fragment per PR: `changes/<branch-name-with-dashes>.md`, ≤15 words per bullet after the em-dash.
- Prompt budgets (`tests/unit/agents/prompt-budget.test.ts`) must stay green: behaviour goes in code, then tool descriptions; agent YAML prompts change only where a task says so, net-neutral or smaller where possible.
- Behaviour suites (`pnpm smoke`, `pnpm scenarios`) are written, never run, by this plan. Running them needs the maintainer's agreement with a cost estimate.
- `curia` is public: no employer names or personal data in code, tests, fixtures, docs or PR text. Use `work` / `personal` / `example.com` / `example.org`.
- Before each commit touching `.ts`: `pnpm -C $W run typecheck` passes. Integration tests need the local pgvector container (memory: scenarios throwaway DB recipe); unit tests don't.

## Review Focus

1. **A model omits `mailbox` on a tool that needs it** (provider drops the arg, or the model forgets): the call must locate, ask (`needs_mailbox`) or read all, never act on the default. Tests: Task 11 (`missing mailbox never defaults`), Task 15, Task 31.
2. **The same Nylas object ID exists in two grants** (Gmail IDs collide rarely but can): `locate` must refuse as ambiguous rather than pick the first hit. Test: Task 10 (`ambiguous when found in two mailboxes`).
3. **A mailbox's grant fails mid-operation** (revoked on the principal's last day): list/search still return the other mailbox with `mailbox_errors`; availability returns `partial`; `locate` reports a miss as non-definitive. Tests: Tasks 10, 13, 32.
4. **Removing then re-adding an account with the same label** ("Work" → resign → new "Work"): no state, rule, preference, ledger entry or identity of the old id attaches to the new one. Tests: Task 7 (`ids are never reused`), Task 27 (`rules scoped to a removed id`).
5. **The upgrade runs while Nylas is unreachable at boot**: the install keeps working on the flat grant through the in-memory fallback and migrates on a later tick, with no duplicate rows. Test: Task 5 (`deferred then migrated once`).

---

# Part 1 — Registry and resolver (PR 1: `feat/2475-multi-principal-mailboxes`)

No behaviour change. ceo-inbox tools still read the flat secrets in this part.

### Task 1: `principal_mailboxes` table

**Files:**
- Create: `src/db/migrations/123_principal_mailboxes.sql`
- Test: `tests/integration/principal-mailboxes-migration.test.ts`

**Interfaces:**
- Produces: table `principal_mailboxes(id TEXT PK, label TEXT NOT NULL, address TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'google', is_default BOOLEAN NOT NULL DEFAULT false, triage_start_at TIMESTAMPTZ NULL, removed_at TIMESTAMPTZ NULL, added_identity_id UUID NULL REFERENCES contact_channel_identities(id) ON DELETE SET NULL, created_at, updated_at)`; `CHECK (id ~ '^[a-z][a-z0-9-]{0,31}$' AND id NOT IN ('primary','default'))`; `CHECK (address = lower(address))`; unique index `idx_principal_mailboxes_one_default ON ((true)) WHERE is_default AND removed_at IS NULL` (pattern: `115_pairing_invitations.sql`); unique index `idx_principal_mailboxes_live_address ON (address) WHERE removed_at IS NULL`.

- [ ] **Step 1: Write the failing test** — `describe('123_principal_mailboxes')`: `it('allows one live default')` (second live default insert rejects with 23505); `it('allows a removed default alongside a live one')`; `it('rejects a reused live address')`; `it('rejects id primary and default')` (23514); `it('keeps a removed row so its id cannot be inserted again')` (PK 23505).
- [ ] **Step 2: Run** `pnpm -C $W exec vitest run tests/integration/principal-mailboxes-migration.test.ts` — FAIL (relation does not exist).
- [ ] **Step 3: Write the migration** with `-- Up Migration` / `-- Down Migration` sections (Down drops the table).
- [ ] **Step 4: Run the test** — PASS. `ls $W/src/db/migrations | sort` shows one `123_`.
- [ ] **Step 5: Commit** `feat(mailboxes): add principal_mailboxes registry table (#2475)`.

### Task 2: Registry store

**Files:**
- Create: `src/principal-mailboxes/types.ts`, `src/principal-mailboxes/store.ts`
- Test: `tests/integration/principal-mailboxes-store.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface PrincipalMailboxRecord { id: string; label: string; address: string; provider: 'google'; isDefault: boolean; triageStartAt: Date | null; removedAt: Date | null; addedIdentityId: string | null }
  export const MAILBOX_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
  export const RESERVED_MAILBOX_IDS = new Set(['primary', 'default']);
  export const MAX_LIVE_MAILBOXES = 1; // lifted in Task 33
  export class UnknownMailboxError extends Error { constructor(readonly mailboxId: string) }
  export class RemovedMailboxError extends Error { constructor(readonly mailboxId: string, readonly label: string) }
  ```
- Produces (`store.ts`): `class PrincipalMailboxStore { constructor(pool: Pool, logger: Logger); listLive(): Promise<PrincipalMailboxRecord[]>; getAny(id): Promise<PrincipalMailboxRecord | null>; insert(r: Omit<PrincipalMailboxRecord,'removedAt'>, client?: PoolClient): Promise<void>; relabel(id, label): Promise<void>; setDefault(id): Promise<void>; tombstone(id, newDefaultId: string | null): Promise<void> }`. `setDefault` and `tombstone` run in one transaction (clear old default, set new). `listLive` orders default first, then `created_at`.

- [ ] **Step 1: Write failing tests**: `setDefault moves the default in one transaction`; `tombstone sets removed_at and hands default to newDefaultId`; `tombstone of the default with others live and no newDefaultId throws`; `listLive excludes removed rows`; `getAny returns removed rows`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with parameterized queries only.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mailboxes): registry store (#2475)`.

### Task 3: Grant lookup on the core Nylas client

**Files:**
- Modify: `src/channels/email/nylas-client.ts` (`NylasLike` at :52, class at :268)
- Test: `tests/unit/channels/email/nylas-client-grant.test.ts`

**Interfaces:**
- Produces: `NylasClient.getGrant(): Promise<{ email: string; provider: string }>` — SDK `grants.find({ grantId })`; lowercases `email`; throws `NylasApiError`-style error on non-2xx (follow the class's existing error mapping). Add `grants: { find(args: { grantId: string }): Promise<{ data: { email?: string; provider?: string } }> }` to `NylasLike`.

- [ ] **Step 1: Failing tests**: `returns the grant's lowercased email and provider`; `throws when the grant has no email`; `propagates a 404`.
- [ ] **Step 2: Run** `pnpm -C $W exec vitest run tests/unit/channels/email/nylas-client-grant.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(nylas): read a grant's own address (#2475)`.

### Task 4: `PrincipalMailboxes` service and capability

**Files:**
- Create: `src/principal-mailboxes/service.ts`, `src/principal-mailboxes/secrets.ts`
- Modify: `src/skills/types.ts` (ToolContext, near `outboundGateway` :204), `src/skills/loader.ts:43` (`VALID_CAPABILITIES`), `src/skills/execution.ts` (field ~:374, options ~:454/:536, `capabilityServiceMap` :594)
- Test: `tests/unit/principal-mailboxes/service.test.ts`, extend `tests/unit/skills/execution.test.ts`

**Interfaces:**
- Produces (`secrets.ts`): `principalMailboxGrantSecretName(id: string): string` → `principal.mailbox.${id}.nylas_grant_id`; `PRINCIPAL_MAILBOX_GRANT_KEY_RE = /^principal\.mailbox\.[a-z][a-z0-9-]{0,31}\.nylas_grant_id$/`; `isPrincipalMailboxGrantKey(name): boolean`.
- Produces (`service.ts`):
  ```ts
  export interface PrincipalMailboxView { id: string; label: string; address: string; isDefault: boolean; triageStartAt: Date | null }
  export class PrincipalMailboxes {
    constructor(deps: { store: PrincipalMailboxStore; secrets: { get(n: string): Promise<string | null> }; apiKey: () => string | undefined; logger: Logger; createNylasClient?: (apiKey: string, grantId: string) => NylasClient; createCalendarClient?: (apiKey: string, grantId: string) => NylasCalendarClient })
    list(): Promise<PrincipalMailboxView[]>            // live only; the deferred fallback (Task 5) when the table is empty
    get(id: string): Promise<PrincipalMailboxView>     // throws UnknownMailboxError / RemovedMailboxError
    defaultMailbox(): Promise<PrincipalMailboxView | null>
    addresses(): Promise<string[]>                     // live mailbox addresses
    credentials(id: string): Promise<{ apiKey: string; grantId: string }> // read per call; throws when missing
    gatewayClient(id: string): Promise<NylasClient>
    calendarClient(id: string): Promise<NylasCalendarClient>
    setFallback(f: { id: string; grantId: string } | null): void // Task 5
  }
  ```
  Capability name `principalMailboxes`; `ctx.principalMailboxes?: PrincipalMailboxes`. Clients are built per call (no cache) so a grant change applies without restart.

- [ ] **Step 1: Failing tests**: `get throws UnknownMailboxError for an unknown id`; `get throws RemovedMailboxError for a removed id`; `credentials reads principal.mailbox.<id>.nylas_grant_id on every call`; `credentials never falls back to the default mailbox's grant`; `list returns the fallback when the table is empty and a fallback is set`; execution test `injects principalMailboxes for a tool declaring it`.
- [ ] **Step 2: Run** `pnpm -C $W exec vitest run tests/unit/principal-mailboxes/service.test.ts tests/unit/skills/execution.test.ts` — FAIL.
- [ ] **Step 3: Implement** and register the capability.
- [ ] **Step 4: Run** — PASS. Typecheck.
- [ ] **Step 5: Commit** `feat(mailboxes): PrincipalMailboxes service and tool capability (#2475)`.

### Task 5: Upgrade migration from the flat secrets

**Files:**
- Create: `src/principal-mailboxes/migrate-flat-mailbox.ts`
- Modify: `src/index.ts` (call after the vault is ready, beside `migrateLegacyTavilyKey` at ~:1291, in a try/catch that warns)
- Test: `tests/unit/principal-mailboxes/migrate-flat-mailbox.test.ts`

**Interfaces:**
- Produces: `migrateFlatPrincipalMailbox(deps: { store: PrincipalMailboxStore; secrets: { get; set }; lookupGrant: (grantId: string) => Promise<{ email: string; provider: string }>; logger: Logger }): Promise<'migrated' | 'already' | 'nothing' | 'deferred'>` and `mailboxIdFromAddress(address: string): string`.
- Rules (D1): runs only when `listLive()` is empty and `ceo_nylas_grant_id` is non-blank. Address = grant lookup, else `ceo_self_email`; neither → `'deferred'` and the caller sets `service.setFallback({ id: 'mailbox', grantId })`. Id: `gmail` for `gmail.com` / `googlemail.com`, else the domain's first label lowercased and stripped to `[a-z0-9-]`, prefixed `m-` if it starts with a digit; label = id capitalised. Inserts default row with `triage_start_at = null`, writes `principal.mailbox.<id>.nylas_grant_id`. **Never touches identities; never deletes the flat keys** (Part 2 retires them). Does not rename config keys (Parts 2 and 3 do, Tasks 18 and 27).
- Retry: a `'deferred'` result is retried by the per-mailbox canary tick (Task 9) until it returns `'migrated'`, then the fallback is cleared.

- [ ] **Step 1: Failing tests**: `migrates the flat grant into one default mailbox named from the grant domain`; `uses ceo_self_email when the grant lookup fails`; `defers when neither address source is available`; `is a no-op when a live mailbox exists` (`'already'`); `deferred then migrated once` (two calls, second succeeds, exactly one row); `mailboxIdFromAddress: gmail.com → gmail, googlemail.com → gmail, ops.example.org → ops, 9co.example → m-9co`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; wire in `index.ts`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mailboxes): migrate the single principal mailbox into the registry at boot (#2475)`.

### Task 6: Route existing single-grant readers through the service

**Files:**
- Modify: `src/channels/email/principal-mailbox-resolver.ts` (read the default mailbox's credentials from the service; signature unchanged in this part), `src/index.ts:1176-1211` (build the boot `NylasCalendarClient` from `service.defaultMailbox()` credentials), `src/index.ts:3298-3307` (`NylasPrincipalMailbox` from the default mailbox), `src/startup/test-mode-stack.ts:1178` (`calendarConfigured` from the service)
- Test: update `tests/unit/channels/email/principal-mailbox-resolver.test.ts`

**Interfaces:**
- Consumes: `PrincipalMailboxes.defaultMailbox()`, `credentials(id)`.
- `resolvePrincipalCalendarGrant` stays (used by the deferred fallback only) until Task 33 deletes it.

- [ ] **Step 1: Failing test**: `resolver uses the default mailbox's grant from the registry`; `resolver returns null when no mailbox exists`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the resolver test plus `tests/unit/startup/test-mode-stack.test.ts` — PASS.
- [ ] **Step 5: Commit** `refactor(mailboxes): read the principal grant through the registry (#2475)`.

### Task 7: Add, set default and remove (service layer)

**Files:**
- Create: `src/principal-mailboxes/admin.ts`
- Modify: `src/skills/outbound-gateway.ts:3059` (`emailPrincipal` sends to `contacts.primary_email` of the principal, as `primaryFor` does in `recipient-reference.ts:320`)
- Test: `tests/unit/principal-mailboxes/admin.test.ts`, extend `tests/unit/skills/outbound-gateway.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AddMailboxRefusal = 'bad_id' | 'id_taken' | 'cap_reached' | 'not_google' | 'grant_in_use' | 'address_in_use' | 'curia_account_address' | 'grant_unreadable';
  export class PrincipalMailboxAdmin {
    constructor(deps: { store; secrets: { get; set; delete }; contacts: Pick<ContactService, 'linkIdentity' | 'unlinkIdentity' | 'getContactWithIdentities' | 'updateContactFields'>; principalContactId: string; curiaAccountAddresses: () => Promise<string[]>; lookupGrant: (grantId: string) => Promise<{ email: string; provider: string }>; onRemoved?: Array<(id: string) => Promise<void>>; logger })
    add(input: { id: string; label: string; grantId: string; makeDefault?: boolean }): Promise<{ ok: true; mailbox: PrincipalMailboxView } | { ok: false; refusal: AddMailboxRefusal; detail: string }>
    setDefault(id: string): Promise<void>
    removalPreview(id: string): Promise<RemovalPreview>
    remove(input: { id: string; stillOwned: boolean; newDefaultId?: string; newPrimaryEmail?: string }): Promise<void>
  }
  export interface RemovalPreview { mailbox: PrincipalMailboxView; isDefault: boolean; isPrimaryEmail: boolean; stillOwnedDefault: boolean; otherLive: PrincipalMailboxView[]; scopedRules: Array<{ title: string; onlyThisMailbox: boolean }>; calendars: Array<{ calendarId: string; label: string }> }
  ```
- `add`: id regex and reserved names → `bad_id`; existing (live or removed) id → `id_taken`; live count ≥ `MAX_LIVE_MAILBOXES` → `cap_reached`; `lookupGrant` provider ≠ `google` → `not_google`; grant ID already in any live mailbox secret → `grant_in_use`; address live → `address_in_use`; address in Curia's own `email_accounts` → `curia_account_address`. On success: write secret, insert row with `triage_start_at = now()`, link a verified identity (`source: 'ceo_stated'`, pattern `src/channels/http/routes/setup.ts:300-320`) **only if not already an identity**, store its id in `added_identity_id`. Never changes `primary_email`.
- `remove`: default with others live requires `newDefaultId`; if the address equals `primary_email`, requires `newPrimaryEmail` (must be a live mailbox address or verified principal email) and sets it first; `stillOwned=false` unlinks `added_identity_id` (an identity that pre-existed the mailbox is never unlinked); deletes the grant secret; tombstones; runs `onRemoved` hooks (Part 2 deletes config keys, Part 3 rules, Part 4 calendars). `stillOwnedDefault` = `true` only for `gmail.com` / `googlemail.com`.

- [ ] **Step 1: Failing tests**: one per refusal above; `add links a verified identity and records it`; `add does not relink an existing identity`; `add never changes primary_email`; `remove of the default requires a new default`; `remove requires a new primary email when the address is primary`; `remove with stillOwned=false unlinks only the identity it added`; `remove with stillOwned=true keeps the identity`; `ids are never reused` (add `work`, remove, add `work` → `id_taken`); gateway: `emailPrincipal sends to the primary email, not the first identity`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `scopedRules` returns `[]` and `calendars` returns `[]` in this part (filled by Tasks 27 and 33).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mailboxes): add, set default and remove principal mailboxes (#2475)`.

### Task 8: Console routes and list UI

**Files:**
- Create: `src/channels/http/routes/principal-mailboxes.ts` (register at `src/channels/http/http-adapter.ts` beside `emailAccountsRoutes` ~:607), `apps/console/src/components/PrincipalMailboxesSection.tsx` (copy `EmailAccountsSection.tsx` structure)
- Delete: `apps/console/src/components/PrincipalMailboxSection.tsx`
- Modify: `apps/console/src/pages/ChannelSettings.tsx:8,260`; `src/channels/http/routes/vault.ts` (drop `PRINCIPAL_MAILBOX_KEYS` :87 / `principalMailboxKeys` :95 / the declarer at :635; allow `isPrincipalMailboxGrantKey` in `isAllowedVaultName` :298; keep the flat keys allowed until Part 2 so a deferred install can still edit them); `src/index.ts:191,2888`; `scripts/seed-vault.ts:40-41`
- Test: `tests/unit/channels/http/routes/principal-mailboxes.test.ts`, `apps/console/src/components/PrincipalMailboxesSection.test.tsx`, update `tests/unit/channels/http/routes/vault.test.ts`

**Interfaces:**
- Routes: `GET /api/registry/principal-mailboxes` → `{ mailboxes: PrincipalMailboxView[] }`; `POST` `{ id, label, grant_id, make_default? }` → 201 or 422 `{ refusal, detail }`; `PATCH /:id` `{ label?, make_default? }`; `GET /:id/removal-preview` → `RemovalPreview`; `DELETE /:id` `{ still_owned, new_default_id?, new_primary_email? }`; `POST /test` `{ grant_id }` → `{ email, provider }` (grant lookup only, nothing stored).
- UI: list with label, address, "Default" badge; Add (id, label, grant ID → Test shows address and provider before save); relabel; set default; remove opens a screen built from `removal-preview` with the "Is this address still yours?" question (default from `stillOwnedDefault`), new-default picker when needed, new-primary-email picker when needed, scoped rules and calendars listed.

- [ ] **Step 1: Failing tests**: route tests per endpoint including `422 with the refusal code`; UI tests `shows the grant's address after Test`, `remove asks for a new default when removing the default`, `still-yours defaults to no for a work domain`.
- [ ] **Step 2: Run** `pnpm -C $W exec vitest run tests/unit/channels/http/routes/principal-mailboxes.test.ts` and `pnpm -C $W/apps/console exec vitest run src/components/PrincipalMailboxesSection.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both plus `vault.test.ts` and `SecretsDrawers.test.tsx` — PASS.
- [ ] **Step 5: Commit** `feat(console): manage principal mailboxes as a list (#2475)`.

### Task 9: Health canary, outage alert, setup catalog, docs for Part 1

**Files:**
- Create: `src/health/mailbox-outage-notifier.ts`, `docs/adr/064-multiple-principal-mailboxes.md`, `changes/feat-2475-multi-principal-mailboxes.md`
- Modify: `src/health/health-service.ts:247-326` (replace the single `nylas_calendar` probe with one `principal_mailbox:<id>` probe per live mailbox: `getGrant` + `listMessages({limit:1})` + `listCalendars()`, 5 s timeout), `src/health/types.ts:18`, `src/index.ts:2594-2601,2646` (also run `migrateFlatPrincipalMailbox` retry when deferred), `skills/setup/tools/setup-status/catalog.yaml` (new entry after `email` :45), `skills/setup/tools/setup-status/handler.ts:11-24,269-296` (check type `principal_mailbox_ready`), `docs/adr/README.md`, `docs/specs/04-channels.md`
- Test: `tests/unit/health/health-service.test.ts`, `tests/unit/health/mailbox-outage-notifier.test.ts`, `skills/setup/tools/setup-status/handler.test.ts`

**Interfaces:**
- `MailboxOutageNotifier { constructor(deps: { gateway: Pick<OutboundGateway,'sendNotification'>; principalEmail: () => string | undefined; logger }); record(mailboxId: string, label: string, ok: boolean): Promise<void> }` — alerts once per outage episode (pattern `src/db/availability-monitor.ts:45-53`), clears on the first ok; alert body suggests removing the mailbox in the console if the account is gone.
- Catalog entry: `id: principal_mailboxes`, label "Principal mailboxes and calendars", `completion_check: { type: principal_mailbox_ready }` (≥1 live mailbox whose last canary passed), `handoff: console`, `handoff_path: /channels`, `docs_url: /channels/principal-mailboxes`.
- ADR-064: registry; code chooses the account from the object; evidence-based choice for new objects; never fall back to default; ids never reused.

- [ ] **Step 1: Failing tests**: `one canary per live mailbox`; `notifier alerts once per episode and again after recovery`; setup-status `principal_mailbox_ready is complete with one healthy mailbox`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement; write ADR-064, spec 04 section, changelog fragment** (e.g. `- **Principal mailboxes** — mailboxes are now a registry, upgraded automatically; managed as a list in the console. (#2475)`).
- [ ] **Step 4: Run** the three tests, `pnpm -C $W run typecheck`, `pnpm -C $W run lint`, `pnpm -C $W test` (unit) — PASS.
- [ ] **Step 5: Commit** `feat(health): per-mailbox canary and setup catalog entry (#2475)`.
- [ ] **Step 6: curia-docs page.** Create worktree `~/Projects/curia/worktrees/curia-docs-principal-mailboxes` from `repos/curia-docs` (pull `main` first), add `channels/principal-mailboxes` page (connect, label, default, remove; cadence and send level per mailbox), commit `-s`, open its PR with a link to this one.
- [ ] **Step 7: Open PR 1** (base `main`, label `no-loop`, body: summary, `Part of #2475`, test plan).

---

# Part 2 — ceo-inbox and sending (PR 2: `feat/2475-ceo-inbox-sending`)

### Task 10: Per-mailbox client and `locate` for skills

**Files:**
- Create: `skills/_shared/principal-mailbox-client.ts`
- Modify: `skills/_shared/ceo-nylas-client.ts` (add `deleteDraft(draftId): Promise<void>`)
- Test: `skills/_shared/principal-mailbox-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MailboxClient { mailbox: PrincipalMailboxView; client: CeoNylasClient }
  export function mailboxClient(ctx: ToolContext, mailboxId: string): Promise<MailboxClient>   // throws Unknown/RemovedMailboxError
  export function allMailboxClients(ctx: ToolContext): Promise<MailboxClient[]>
  export type LocateResult =
    | { kind: 'found'; at: MailboxClient }
    | { kind: 'not_found'; definitive: boolean; failed: Array<{ mailboxId: string; detail: string }> }
    | { kind: 'ambiguous'; mailboxes: PrincipalMailboxView[] };
  export function locate(ctx: ToolContext, kind: 'message' | 'draft', objectId: string, explicitMailbox?: string): Promise<LocateResult>
  export function mailboxFields(m: PrincipalMailboxView): { mailbox: string; mailbox_label: string }
  export function locateError(r: Exclude<LocateResult, { kind: 'found' }>, noun: string): string
  ```
- `locate`: explicit mailbox → one GET there; 404 → `not_found` definitive, no other mailbox tried. No explicit → GET in every live mailbox in parallel; one hit → found; two → ambiguous; none with any error → `definitive: false`. With one mailbox, it is that mailbox and makes no extra calls. Uses `getMessage` / `getDraft` and `nylasStatus(err) === 404` (`src/channels/email/nylas-message-id.ts:112`).

- [ ] **Step 1: Failing tests**: `found in exactly one mailbox`; `ambiguous when found in two mailboxes`; `explicit wrong mailbox is not_found without probing others`; `a failing mailbox makes a miss non-definitive`; `single mailbox makes one call`; `deleteDraft issues DELETE /drafts/:id`.
- [ ] **Step 2: Run** `pnpm -C $W exec vitest run skills/_shared/principal-mailbox-client.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ceo-inbox): per-mailbox clients and locate (#2475)`.

### Task 11: `mailbox` on every ceo-inbox tool; single-object tools; schema order

**Files:**
- Modify: every `skills/ceo-inbox/tools/*/tool.json` (append `"mailbox?"`; replace `secrets` `["channel.email.nylas_api_key","ceo_nylas_grant_id"]` with `[]` plus `"capabilities": ["principalMailboxes"]`; `shadow-draft`: move `thread_id?` after `body`); handlers for `read`, `download-attachment`, `archive`, `mark-read`, `mark-starred` (use `locate`, add `mailboxFields` to results)
- Create: `tests/unit/skills/manifest-input-order.test.ts`
- Test: those handlers' `handler.test.ts` (create `skills/ceo-inbox/tools/ceo-inbox-mark-read/handler.test.ts`)

**Interfaces:**
- Consumes: Task 10.
- Manifest test: walks `skills/ceo-inbox/tools/*/tool.json` and `skills/calendar/tools/*/tool.json` (walk pattern from `tests/unit/skills/manifest-placeholder-free.test.ts:51-69`) and fails when an optional input precedes a required one. Calendar entries are allowlisted until Task 31 fixes `calendar-list-events`.
- `mailbox` description (all tools): "Mailbox id. Omit unless the principal named an account; Curia finds the right one."

- [ ] **Step 1: Failing tests**: manifest order test; per handler `acts in the mailbox holding the message`, `returns mailbox and mailbox_label`, `missing mailbox never defaults` (two mailboxes, object only in the non-default one → acts there), `ambiguous id is refused`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those tests plus `tests/unit/skills/secret-manifest-coverage.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(ceo-inbox): optional mailbox on every tool, found automatically (#2475)`.

### Task 12: Label and folder tools verify the message first

**Files:**
- Modify: `skills/ceo-inbox/tools/ceo-inbox-label/handler.ts` (move `getMessage` :89 before `listFolders` :60), `skills/ceo-inbox/tools/ceo-inbox-update-folders/handler.ts` (move `getMessage` :129 before :56)
- Test: `skills/ceo-inbox/tools/ceo-inbox-label/handler.test.ts`, `tests/unit/skills/ceo-inbox-update-folders.test.ts`

- [ ] **Step 1: Failing tests**: `creates no label when the message is not in the mailbox` (assert `createFolder` not called); `labels in the mailbox holding the message`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (`locate`, then folders of that mailbox).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `fix(ceo-inbox): verify the message before creating labels (#2475)`.

### Task 13: Cross-mailbox list and search

**Files:**
- Create: `skills/_shared/composite-page-token.ts`
- Modify: `skills/ceo-inbox/tools/ceo-inbox-list/handler.ts`, `skills/ceo-inbox/tools/ceo-inbox-search/handler.ts`
- Test: `skills/_shared/composite-page-token.test.ts`, both handlers' tests

**Interfaces:**
- `encodePageToken(cursors: Record<string, string | null>): string` (base64url JSON; `null` = that mailbox exhausted); `decodePageToken(token: string): Record<string, string | null>` (throws on malformed).
- Without `mailbox`: query every live mailbox in parallel, merge by `date` desc, cut to `limit`, return `next_page_token` and `mailbox_errors: Array<{ mailbox, mailbox_label, error }>` when any failed. With `DRAFTS`, the same (drafts from every mailbox, labelled).

- [ ] **Step 1: Failing tests**: token round-trip and malformed; `merges two mailboxes by date and labels each`; `a failing mailbox is reported and does not hide the other`; `explicit mailbox reads only that mailbox`; `DRAFTS lists drafts from every mailbox`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ceo-inbox): list and search across mailboxes (#2475)`.

### Task 14: draft-reply in the message's mailbox; reply-all excludes every principal address

**Files:**
- Modify: `skills/ceo-inbox/tools/ceo-inbox-draft-reply/handler.ts` (drop `ceo_self_email` :24-36; exclusion :150-154), its `tool.json`; `src/principal-mailboxes/service.ts` (add `principalEmailAddresses(): Promise<string[]>` = live mailbox addresses ∪ verified active principal email identities)
- Test: `skills/ceo-inbox/tools/ceo-inbox-draft-reply/handler.test.ts`

- [ ] **Step 1: Failing tests**: `drafts in the mailbox the message is in`; `reply-all excludes both principal addresses`; `result and audit data carry mailbox`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; success data `{ draft_id, subject, to, cc, already_exists, reply_to_message_id, mailbox, mailbox_label }`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ceo-inbox): reply from the message's own mailbox (#2475)`.

### Task 15: Mailbox evidence and draft-compose

**Files:**
- Create: `src/principal-mailboxes/evidence.ts`
- Modify: `skills/ceo-inbox/tools/ceo-inbox-draft-compose/handler.ts`, its `tool.json` (append `mailbox?`; description carries the D5 rules: when to use silently, when to mention, when to ask)
- Test: `tests/unit/principal-mailboxes/evidence.test.ts`, `skills/ceo-inbox/tools/ceo-inbox-draft-compose/handler.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MailboxEvidence { mailbox: string; mailbox_label: string; sent_count: number; last_sent_at: string | null; recent_subjects: string[]; received_count: number; domain_match: boolean; error?: string }
  export function mailboxEvidence(svc: PrincipalMailboxes, recipients: string[], opts?: { limit?: number }): Promise<MailboxEvidence[]>
  export type EvidenceVerdict = 'agrees' | 'leans_other' | 'none' | 'split';
  export function classifyEvidence(e: MailboxEvidence[], chosen: string): EvidenceVerdict
  ```
  Counts come from `NylasClient.listMessages({ anyEmail: recipients, folders: [sent|inbox], limit: 20 })` per mailbox (pattern `NylasPrincipalMailbox.hasSentTo`), capped at 20; `recent_subjects` at most 3. `classifyEvidence`: score = `sent_count*2 + received_count + (domain_match ? 5 : 0)`; no mailbox > 0 → `none`; chosen strictly highest and every other score is 0 → `agrees`; another mailbox strictly higher → `leans_other`; otherwise `split`.
- The description also says: a remembered per-contact preference that names a mailbox not in the current list is history (that account was removed), not a rule.
- draft-compose: with >1 live mailbox and no `mailbox` → `{ success: true, data: { needs_mailbox: true, evidence } }`, nothing created. With `mailbox` → create there; data adds `mailbox`, `mailbox_label`, `evidence: EvidenceVerdict` (omitted with one mailbox).

- [ ] **Step 1: Failing tests**: classify cases (`agrees`, `leans_other`, `none`, `split`); compose `returns needs_mailbox with evidence and creates nothing`; `creates in the stated mailbox`; `single mailbox needs no mailbox input`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ceo-inbox): compose requires a mailbox, backed by evidence (#2475)`.

### Task 16: draft-edit `move_to_mailbox` and draft provenance by mailbox

**Files:**
- Modify: `skills/ceo-inbox/tools/ceo-inbox-draft-edit/handler.ts`, its `tool.json` (append `move_to_mailbox?`); `src/skills/principal-send/draft-provenance.ts` (`resultDraftId` :47 matches `(mailbox, draft_id)`; rows without `mailbox` match the default mailbox, so pre-upgrade audit rows keep working)
- Test: `skills/ceo-inbox/tools/ceo-inbox-draft-edit/handler.test.ts`, `tests/unit/skills/principal-send/draft-provenance.test.ts`

**Interfaces:**
- `DraftProvenance.createdByCuria(drafts: ReadonlyArray<{ mailbox: string; draftId: string }>, lookbackDays?)`, `editedByCuria(...)` same shape, `curiaWritesInTask({ mailbox, draftId }, taskEventId)`. Return sets keyed `` `${mailbox}:${draftId}` ``.
- Move: create in target (recipients, subject, body, attachments; `In-Reply-To`/`References` when the source was a reply and Nylas accepts them, verified once on a live grant), then `deleteDraft` on the source only after success. Data `{ draft_id, mailbox, mailbox_label, moved_from: { mailbox, draft_id }, new_thread: boolean, note }`, where `note` tells the agent to store the principal's account preference for this contact and topic with `memory-store` (D5 "Learning from corrections"; prompted here, not in the always-on prompt). Provenance: a draft with `moved_from` inherits the source's class (created-by-Curia stays created-by-Curia); unknown source → Curia's.

- [ ] **Step 1: Failing tests**: `moves and deletes the original only after create succeeds`; `failed create leaves the original`; provenance `matches on mailbox and draft id`; `legacy rows without mailbox match the default mailbox`; `a moved draft keeps its authorship class`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ceo-inbox): move a draft between mailboxes (#2475)`.

### Task 17: Gateway sends from the draft's mailbox at that mailbox's level

**Files:**
- Modify: `src/channels/email/principal-mailbox-resolver.ts` (`type PrincipalMailboxResolver = (mailboxId: string) => Promise<NylasClient | null>`), `src/skills/outbound-gateway.ts` (:420, :997, :1032, `sendPrincipalDraft` :4284 adds `mailbox?: string` option and locates the draft across mailboxes; `readSendLevel(mailboxId)` replaces :4312), `src/skills/principal-send/send-level.ts` (`readSendLevelValue(raw, mailbox)`: a missing key for this mailbox → `on_request`, not malformed), `skills/ceo-inbox/tools/ceo-inbox-send-draft/{handler.ts,tool.json}` (append `mailbox?`; description carries the D6 "which draft" rules), `src/startup/test-mode-sends.ts:347` (recording mailbox per id)
- Create: `src/principal-mailboxes/migrate-config-keys.ts` with `migrateSendingKey(configStore, defaultId)` (rename `default` → `<id>` inside `ceo_inbox/sending`; idempotent) — called at boot after Task 5
- Test: `tests/unit/skills/outbound-gateway.test.ts` (`sendPrincipalDraft (#2474)` block :5815), `tests/unit/skills/principal-send/send-level.test.ts`, `tests/unit/principal-mailboxes/migrate-config-keys.test.ts`, `skills/ceo-inbox/tools/ceo-inbox-send-draft/handler.test.ts`, `tests/unit/startup/test-mode-sends.test.ts`

- [ ] **Step 1: Failing tests**: `sends from the mailbox holding the draft`; `reads the level of the draft's mailbox` (work `autonomous`, personal `on_request` → autonomous send of a personal draft is refused `setting_off`); `refuses a draft id found in two mailboxes`; `new mailbox with no key reads on_request`; `migrateSendingKey renames default once and is idempotent`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(gateway): send from the draft's mailbox at its own send level (#2475)`.

### Task 18: Ledger, conversation cooldown and new autonomous limits

**Files:**
- Modify: `src/skills/principal-send/send-ledger.ts` (entries gain `mailbox` and `conversation_ids: string[]`; `recentForConversation(ids: string[], sinceEpochMs)`; legacy entries without `mailbox` read as the default mailbox), `src/skills/principal-send/autonomous-limits.ts` (`checkAutonomousLimits` input gains `otherPrincipalAddresses: readonly string[]`, `recentConversationEntries`; new refusals `principal_address_recipient`, `reply_to_principal_address`, checked before `recipient_not_on_thread`), `src/skills/outbound-gateway.ts` (pass `principalEmailAddresses()`; refusal tables :440-519; the ADR-062 "Curia email account whose address is the principal's" refusal covers every mailbox address)
- Test: `tests/unit/skills/principal-send/send-ledger.test.ts`, `autonomous-limits.test.ts`, gateway autonomous block (:6417)

**Interfaces:**
- `conversation_ids` = the draft's thread `Message-ID` + `References` values (lowercased, angle brackets stripped), read from the thread already fetched with `include_headers` (:4410).
- Thread cooldown refuses when either `recentForThread` (same mailbox) or `recentForConversation` has an entry in 24h.

- [ ] **Step 1: Failing tests**: `refuses an autonomous send to another principal address`; `refuses an autonomous reply to mail from a principal address`; `cooldown spans the same conversation in two mailboxes`; `cap counts sends from every mailbox` (10 total); `Curia account bound to any mailbox address is refused`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(gateway): cross-mailbox limits and conversation cooldown (#2475)`.

### Task 19: Replies held by a limit are reported as the limit

**Files:**
- Modify: `src/skills/outbound-gateway.ts` (`recordAutonomousStop` :4610-4695, `PRINCIPAL_SEND_DIGEST_REASONS` :498), `src/skills/principal-send/send-ledger.ts` (`recordLimitStop({ draftId, mailbox, reason: 'daily_cap' | 'thread_cooldown', at })` writes outcome `limited`, which `recentForThread` / `recentAutonomousSends` ignore; `limitStopsSince(sinceEpochMs, reason)`), `skills/ceo-inbox/tools/ceo-inbox-send-draft/handler.ts` (failure data `refusal_kind: 'limit' | 'judgement' | 'other'`)
- Test: gateway autonomous block, `send-ledger.test.ts`, send-draft handler test

**Interfaces:**
- `LIMIT_REFUSALS = new Set(['daily_cap', 'thread_cooldown'])`. Digest items are immutable, so:
  - first `daily_cap` stop in the rolling 24h → one item: `Reached the daily limit of 10 replies Curia sends on its own. Replies it would have sent wait in your Drafts until you send them or the limit resets.`
  - each later `daily_cap` stop → `Waiting only because of the daily limit: <draft label>.` (append ` (<mailbox label>)` when more than one mailbox exists)
  - `thread_cooldown` → `Waiting only because Curia already replied on this thread today: <draft label>.`
  - judgement stops keep `Left as a draft in your mailbox: …`.

- [ ] **Step 1: Failing tests**: `first cap stop files the limit notice`; `later cap stops file waiting items, not Left as a draft`; `judgement holds still read Left as a draft`; `send-draft reports refusal_kind limit`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(gateway): report limit holds apart from judgement holds (#2475)`.

### Task 20: Acquaintance across mailboxes, retire flat keys, prompts, docs for Part 2

**Files:**
- Create: `src/contacts/multi-principal-mailbox.ts`, `changes/feat-2475-ceo-inbox-sending.md`, scenario cases `tests/scenarios/cases/45a-mailbox-choice-cfo.yaml`, `45b-mailbox-choice-sister.yaml`, `45c-mailbox-choice-shared-accountant.yaml`, `45d-send-my-draft-one-candidate.yaml`, `45e-send-my-draft-ask.yaml`, `45f-send-my-draft-named.yaml`, `45g-move-draft-correction.yaml`, `45h-standing-preference-no-mention.yaml` (check `ls tests/scenarios/cases | sort | tail` for the next free number first; stubs in `tests/scenarios/stubs/ceo-inbox-office.yaml`, two mailboxes)
- Modify: `src/index.ts:3298-3307`; `src/principal-mailboxes/migrate-flat-mailbox.ts` (after a successful migration, delete `ceo_nylas_grant_id` and `ceo_self_email`: copy-then-delete like `migrate-legacy-tavily-key.ts`); `src/channels/http/routes/vault.ts` (stop allowing the flat keys); `agents/ceo-inbox.yaml` (pinned `ceo_inbox/sending` description: one level per mailbox id; "the principal's inbox" → "the principal's mailboxes"; net prompt size not larger); `docs/specs/15-outbound-safety.md`, `docs/adr/062-curia-sends-from-the-principals-mailbox.md` (amend the `default` key paragraph :40)
- Test: `tests/unit/contacts/multi-principal-mailbox.test.ts`, `tests/unit/principal-mailboxes/migrate-flat-mailbox.test.ts`, `tests/unit/agents/prompt-budget.test.ts`

**Interfaces:**
- `class MultiPrincipalMailbox implements PrincipalMailbox { constructor(svc: PrincipalMailboxes, logger, timeoutMs = 5000) }` — `hasSentTo` checks every live mailbox in parallel; any `true` → true; all failed → throws (the check's existing "unknown").

- [ ] **Step 1: Failing tests**: `hasSentTo is true when any mailbox has sent`; `throws when every mailbox fails`; `flat keys are deleted only after the registry row exists`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement; edit prompts and docs; write scenario cases (do not run); changelog fragment.**
- [ ] **Step 4: Run** `pnpm -C $W run typecheck`, `pnpm -C $W run lint`, `pnpm -C $W test`, `pnpm -C $W exec vitest run tests/unit/agents/prompt-budget.test.ts` — PASS. `grep -rn "ceo_nylas_grant_id\|ceo_self_email" $W/src $W/skills $W/apps` shows only the migration and its test.
- [ ] **Step 5: Commit** `feat(ceo-inbox): acquaintance across mailboxes; retire flat mailbox secrets (#2475)`.
- [ ] **Step 6: Open PR 2** (base `feat/2475-multi-principal-mailboxes`, `no-loop`). In the PR, list the scenario cases written and the run estimate for the maintainer; don't run them.

---

# Part 3 — Triage and sent-observe (PR 3: `feat/2475-triage`)

### Task 21: Cadence

**Files:**
- Create: `src/principal-mailboxes/triage-cadence.ts`
- Test: `tests/unit/principal-mailboxes/triage-cadence.test.ts`

**Interfaces:**
- `type Cadence = { every: { minutes: number } | { dailyAt: string /* HH:MM */ }; window?: { start: string; end: string }; weekdaysOnly?: boolean }`
- `parseCadence(s: string): Cadence | null` — grammar: `(every <N>m | every <N>h | hourly | daily HH:MM)( HH:MM-HH:MM)?( weekdays)?`; minutes must be a multiple of 15 and ≥ 15.
- `DEFAULT_CADENCE = 'hourly 06:00-23:00'`
- `readTriageCadences(raw: string | null, mailboxIds: string[]): Record<string, Cadence>` (unknown or invalid → default, logged)
- `isDue(c: Cadence, lastDrainedAt: Date | null, now: Date, tz: string): boolean` — inside the window and `now - lastDrainedAt ≥ every`; `daily HH:MM` is due once per local day at or after that time.

- [ ] **Step 1: Failing tests**: parse table (valid and invalid inputs incl. `every 10m` invalid); `isDue` cases: outside window false; inside window and elapsed true; daily before time false, after true, second time same day false; weekdays on Saturday false; DST day in `America/Toronto`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (use the repo's existing timezone helpers in `src/time/`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(triage): per-mailbox cadence (#2475)`.

### Task 22: Triage state

**Files:**
- Create: `src/principal-mailboxes/triage-state.ts`
- Test: `tests/unit/principal-mailboxes/triage-state.test.ts`

**Interfaces:**
- Over `ConfigStore` namespace `ceo_inbox`: `class TriageState { constructor(cfg: Pick<ConfigStore,'get'|'set'>, tz: () => string); lastDrainedAt(id): Promise<Date | null>; markDrained(id, at): Promise<void>; isDraining(id): Promise<boolean>; setDraining(id, v: boolean): Promise<void>; batchesToday(now): Promise<number>; addBatch(now): Promise<number>; backlogAlarmed(id): Promise<boolean>; setBacklogAlarmed(id, v): Promise<void> }`. Keys: `triage.<id>.last_drained_at`, `triage.<id>.draining`, `triage.batches.<YYYY-MM-DD local>`, `triage.<id>.backlog_alarmed`.

- [ ] **Step 1–5:** tests `batch counter resets on a new local day`, `state is per mailbox`; run FAIL; implement; run PASS; commit `feat(triage): per-mailbox triage state (#2475)`.

### Task 23: Message-ID dedupe store

**Files:**
- Create: `src/db/migrations/124_principal_mail_dedupe.sql`, `src/principal-mailboxes/triage-dedupe.ts`
- Test: `tests/integration/principal-mail-dedupe.test.ts`

**Interfaces:**
- Table `principal_mail_dedupe(message_id_header TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, nylas_message_id TEXT NOT NULL, triaged_at TIMESTAMPTZ NOT NULL DEFAULT now())`, index on `triaged_at`.
- `class TriageDedupe { constructor(pool, logger); claim(header: string, mailboxId: string, nylasMessageId: string): Promise<{ first: true } | { first: false; mailboxId: string; nylasMessageId: string }>; sweep(olderThanDays = 30): Promise<number> }` — `INSERT … ON CONFLICT DO NOTHING RETURNING`, else select the winner.

- [ ] **Step 1–5:** tests `first claim wins`, `second claim returns the winner`, `sweep removes rows older than 30 days`; FAIL; implement; PASS; commit `feat(triage): cross-mailbox message dedupe store (#2475)`.

### Task 24: Inbox heartbeat replaces the triage cron

**Files:**
- Create: `src/scheduler/inbox-heartbeat.ts`
- Modify: `src/index.ts` (construct and `start()` beside `BacklogHeartbeat` ~:3133-3145, `stop()` in shutdown ~:3706), `agents/ceo-inbox.yaml` (delete the `0 6-23 * * *` schedule :69-79 — `cancelStaleDeclarativeJobs` cancels the row on boot; rewrite "hourly cron, 6am–11pm" text at :103, :347-349, :404-422, :885-908, :939 to "the inbox heartbeat wakes you when a mailbox is due"; Step 6 self-continue stays), `src/agents/prompts/ceo-inbox-wake-guidance.ts:78-85` (`CEO_INBOX_INBOX_DRAIN_LINES`)
- Test: `tests/unit/scheduler/inbox-heartbeat.test.ts`, `tests/unit/agents/ceo-inbox-prompt.test.ts`, `tests/unit/agents/prompts/ceo-inbox-guidance.test.ts`, prompt budget

**Interfaces:**
- `class InboxHeartbeat { constructor(o: { mailboxes: PrincipalMailboxes; cadences: () => Promise<Record<string, Cadence>>; state: TriageState; hasUnreadSince: (mailboxId: string, since: Date | null) => Promise<boolean>; taskRepo: Pick<TaskRepo,'listTasks'|'createTask'>; scheduler: Pick<SchedulerService,'enqueueTaskWake'>; dailyCeiling: number; tz: () => string; logger; intervalMinutes?: number /* 15 */ }); start(): void; stop(): void; tick(now?: Date): Promise<'woke' | 'quiet' | 'drain_running' | 'ceiling'> }`
- `tick`: ceiling spent → `'ceiling'`; due = mailboxes that are draining or `isDue`; for each due, `hasUnreadSince(id, triageStartAt)` (one Nylas list with `unread: true, limit: 1, received_after`); none → `'quiet'`; a live `inbox-drain` task (open/in_progress with a wake) → `'drain_running'`; a stalled one → `enqueueTaskWake`; none → `createTask({ agentId: 'ceo-inbox', title: 'Inbox drain', tags: ['inbox-drain'], wakeAt: now, createdBy: 'heartbeat' })`. `setInterval` with an in-flight guard (pattern `backlog-heartbeat.ts`). No model call on any path.

- [ ] **Step 1: Failing tests**: `quiet tick makes no task and no wake`; `wakes when a due mailbox has unread mail`; `does not wake while a drain is running`; `re-wakes a stalled drain task instead of creating one`; `stops at the daily ceiling`; `a mailbox outside its window is not probed`; prompt tests no longer mention the hourly cron.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; edit YAML and wake guidance.
- [ ] **Step 4: Run** — PASS (budget too).
- [ ] **Step 5: Commit** `feat(triage): code heartbeat every 15 minutes replaces the triage cron (#2475)`.

### Task 25: `ceo-inbox-list` triage mode

**Files:**
- Modify: `skills/ceo-inbox/tools/ceo-inbox-list/{handler.ts,tool.json}` (append `triage?`), `src/skills/types.ts` + `execution.ts` + `loader.ts` (capability `triageServices` exposing `{ cadences, state, dedupe }`)
- Test: `skills/ceo-inbox/tools/ceo-inbox-list/handler.test.ts`

**Interfaces:**
- Start line: add `PrincipalMailboxStore.setTriageStart(id: string, at: Date | null): Promise<void>` and list input `sweep_since?` (ISO date, with `mailbox`): moves that mailbox's start line back for a principal-directed "sweep the last N days" request. Refused unless the turn is a live principal turn (`isLivePrincipalTurn`, `src/skills/principal-send/authority.ts`).
- `TRIAGE_DAILY_CEILING = 120` and `BACKLOG_ALARM_THRESHOLD = 100` live in `triage-cadence.ts`; the heartbeat (Task 24) uses the same ceiling.
- With `triage: true` (other filters ignored; `limit` forced to 5): due mailboxes as in Task 24; round-robin one message at a time across due mailboxes with unread mail past each `triageStartAt`; per message whose `from`/`to`/`cc` names another live mailbox address: fetch headers (`getMessage`), `dedupe.claim(Message-ID)`; a lost claim → mark read, label `↔ In <winner label>`, drop from the batch. Messages `from` another principal address get `from_principal_other_mailbox: true`. Result adds `{ mailboxes_due: string[], backlog?: Array<{ mailbox, mailbox_label, untriaged }> /* first time > 100 per episode */, budget_exhausted?: true }`; `addBatch` per call; `markDrained` + `setDraining(false)` for a mailbox with nothing left, `setDraining(true)` otherwise. At the ceiling: empty batch with `budget_exhausted: true`.

- [ ] **Step 1: Failing tests**: `round-robins across due mailboxes`; `ignores mail before the start line`; `sweep_since moves the start line on a principal turn only`; `backlog alarm once per episode`; `budget_exhausted at the ceiling with an empty batch`; `the second copy of a message is marked read and labelled`; `flags mail from the other principal address`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(triage): due, fair, bounded triage batches across mailboxes (#2475)`.

### Task 26: Reply on the copy the sender addressed

**Files:**
- Modify: `skills/ceo-inbox/tools/ceo-inbox-draft-reply/handler.ts`
- Test: its `handler.test.ts`

**Interfaces:**
- When the message's `to` (then `cc`) names another live mailbox first, search that mailbox for `rfc822msgid:<Message-ID>`; found → draft there; not reachable → draft in the given mailbox and return `reply_mailbox_fallback: true` (the triage summary says so).

- [ ] **Step 1–5:** tests `drafts on the copy in the mailbox named first in To`, `falls back to the triaged mailbox and says so`; FAIL; implement; PASS; commit `feat(ceo-inbox): reply from the address the sender wrote to (#2475)`.

### Task 27: Rule scope, notices, consults; rules on removal

**Files:**
- Create: `src/principal-mailboxes/rules-scope.ts`
- Modify: `agents/ceo-inbox.yaml` (Step 2 rule format adds an optional `- Mailbox: <id>[, <id>]` line, no line = every mailbox; rule creation confirms scope when >1 mailbox; urgent and digest lines name the mailbox when >1; both consult `Context:` lines :508-522 and :681-708 add `mailbox=<id>`; mail flagged `from_principal_other_mailbox` → 📌 Seen; a message that belongs to the other side is never `routine`), `agents/calendar.yaml:222-247` (consult shapes carry `mailbox`), `src/principal-mailboxes/admin.ts` (`removalPreview.scopedRules`; `remove` input gains `rules: 'delete' | { rescopeTo: string }`)
- Test: `tests/unit/principal-mailboxes/rules-scope.test.ts`, `tests/unit/principal-mailboxes/admin.test.ts`, prompt tests and budget

**Interfaces:**
- `parseRuleScopes(doc: string): Array<{ title: string; mailboxes: string[] | null; start: number; end: number }>`; `applyRemoval(doc: string, removedId: string, action: 'delete' | { rescopeTo: string }): string` — a rule scoped to several mailboxes just drops the removed id; a rule scoped only to it is deleted or rescoped.

- [ ] **Step 1: Failing tests**: `rules without a Mailbox line apply everywhere`; `rules scoped to a removed id are deleted or rescoped`; `a multi-mailbox rule keeps the others`; admin `removalPreview lists rules scoped only to the mailbox`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; prompt edits kept within budget (trim duplicated hour wording removed in Task 24).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(triage): mailbox-scoped rules, notices and consults (#2475)`.

### Task 28: Sent-observe and learning state per mailbox

**Files:**
- Modify: `skills/ceo-inbox/tools/ceo-inbox-sent-observe/handler.ts` (keys :52-66 become `sent_observe.<id>.*`; loop over live mailboxes; a failing mailbox doesn't move others' watermarks), `skills/_shared/learning-state.ts:14-22` (`matched_draft_ids`, `completion_candidates`, `asked_task_ids` per mailbox; `completion_digest`, `completion_digest_high_water`, `voice_learn.*` stay global), `skills/_shared/sent-observe-match.ts:276` (`isCuriaSend` filters ledger entries by mailbox), `skills/ceo-inbox/tools/ceo-inbox-shadow-draft/handler.ts` (record `mailbox`), `src/principal-mailboxes/migrate-config-keys.ts` (`migrateLearningKeys(cfg, defaultId)`: copy each global per-mailbox key to the default mailbox's key, then delete; idempotent; boot)
- Test: `skills/ceo-inbox/tools/ceo-inbox-sent-observe/handler.test.ts`, `skills/_shared/learning-state.test.ts`, `skills/_shared/sent-observe-match.test.ts`, `tests/unit/principal-mailboxes/migrate-config-keys.test.ts`

- [ ] **Step 1: Failing tests**: `watermarks are independent per mailbox`; `a failing mailbox does not move the other's watermark`; `isCuriaSend matches within the mailbox only`; `migrateLearningKeys moves global keys to the default mailbox once`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(sent-observe): independent state per mailbox (#2475)`.

### Task 29: Extraction provenance; Part 3 docs

**Files:**
- Modify: `src/audit/audit-log-repo.ts` (add `findMailboxesForConversation(conversationId: string): Promise<string[]>` — distinct `payload->'result'->'data'->>'mailbox'` from `tool.result` rows of `ceo-inbox-*` tools for that conversation, using `idx_audit_conversation`), `src/checkpoint/processor.ts:95` (append `/mailboxes:<a>,<b>` to `source` when non-empty; a lookup error logs a warning and keeps the plain source), `docs/adr/064-multiple-principal-mailboxes.md` (triage section)
- Create: `changes/feat-2475-triage.md`, scenario cases `45i-triage-both-mailboxes-once.yaml`, `45j-cross-mailbox-no-reply-loop.yaml`
- Test: `tests/integration/audit-log-mailboxes-for-conversation.test.ts`, `tests/unit/checkpoint/processor.test.ts`

- Not done: a mailbox suffix on `memory-store` writes. The stored source is the rate-limit key built in `src/skills/execution.ts:2944` (`agent:<id>/task:<id>/channel:<id>`), which can't know the mailbox, so adding it means new plumbing — out of scope per the principal. Checkpoint extraction covers the triage conversations. Record this deviation from design D8 in the PR.

- [ ] **Step 1: Failing tests**: `returns the distinct mailboxes a conversation touched`; processor `appends mailboxes to the extraction source`; `keeps the plain source when the lookup fails`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Before merging, run `EXPLAIN` of the new query on the local DB; if it doesn't use `idx_audit_conversation`, drop this step (the principal ruled out building provenance plumbing) and say so in the PR.
- [ ] **Step 4: Run** typecheck, lint, unit suite — PASS.
- [ ] **Step 5: Commit** `feat(memory): record source mailboxes on checkpoint extraction (#2475)`.
- [ ] **Step 6: Open PR 3** (base `feat/2475-ceo-inbox-sending`, `no-loop`).

---

# Part 4 — Calendar (PR 4: `feat/2475-calendar`)

### Task 30: Calendar registry column and iCal UID

**Files:**
- Create: `src/db/migrations/125_contact_calendars_mailbox.sql` (`ADD COLUMN principal_mailbox_id TEXT NULL REFERENCES principal_mailboxes(id)`; drop `idx_contact_calendars_primary`; `CREATE UNIQUE INDEX idx_contact_calendars_primary_per_mailbox ON contact_calendars (contact_id, COALESCE(principal_mailbox_id, '')) WHERE is_primary`)
- Modify: `src/contacts/calendar-types.ts`, `src/contacts/contact-service.ts` (`linkCalendar` :1826 takes `principalMailboxId`; `resolveCalendar` :1863 returns it; Postgres :3123-3181, :3571 and InMemory :3911-3966 backends), `src/entity-context/assembler.ts:656-671`, `src/principal-mailboxes/migrate-flat-mailbox.ts` (boot backfill: `UPDATE contact_calendars SET principal_mailbox_id = $default WHERE principal_mailbox_id IS NULL`, every existing row was read through the single grant), `src/channels/calendar/nylas-calendar-client.ts` (`icalUid?: string` on `NylasRawEvent` :118, `NylasCalendarEvent` :186, `normalizeEvent` :723)
- Test: `tests/integration/contact-calendars-mailbox.test.ts`, `tests/unit/contacts/contact-calendar-service.test.ts`, `tests/unit/channels/calendar/nylas-calendar-client.test.ts`

- [ ] **Step 1: Failing tests**: `one primary per contact per mailbox`; `nylas_calendar_id stays globally unique`; `backfill assigns the default mailbox once`; `normalizeEvent maps icalUid`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(calendar): calendars belong to a mailbox; events carry iCal UID (#2475)`.

### Task 31: `CalendarRouter` and tool routing

**Files:**
- Create: `src/channels/calendar/calendar-router.ts`
- Modify: every `skills/calendar/tools/*/{handler.ts,tool.json}` (capability `calendarRouter` replaces `nylasCalendarClient`; append `mailbox?`; reorder `calendar-list-events` to `timeMin, timeMax, calendarId?, contactId?, maxResults?, query?, attendeeEmail?, mailbox?`), `calendar-register` (owning grant wins: a calendar id equal to a live mailbox address is registered to that mailbox, rewriting the row), `src/principal-mailboxes/admin.ts` (`add` registers the grant's primary calendar by its real id as `is_primary` for that mailbox; `remove` marks its calendars disconnected via `onRemoved`, `removalPreview.calendars`), `src/index.ts` (drop the boot `NylasCalendarClient`; health uses the router), remove the calendar allowlist entries in `tests/unit/skills/manifest-input-order.test.ts`
- Test: `tests/unit/channels/calendar/calendar-router.test.ts`, each calendar tool test

**Interfaces:**
- ```ts
  export interface RoutedCalendar { mailboxId: string; calendarId: string; client: NylasCalendarClient }
  export class CalendarRouter {
    constructor(deps: { mailboxes: PrincipalMailboxes; contacts: Pick<ContactService,'resolveCalendar'|'getCalendarsForContact'>; principalContactId: string; logger })
    route(calendarId: string, mailboxHint?: string): Promise<RoutedCalendar>   // registry row's mailbox; unregistered needs mailboxHint when >1 live; literal 'primary' → throws without hint, rewritten to that mailbox's home id with it
    homeCalendars(): Promise<Array<RoutedCalendar & { label: string; removed: boolean }>>
  }
  ```
  `CalendarRouteError` codes `needs_mailbox`, `primary_alias_needs_mailbox`, `mailbox_removed`, `unknown_mailbox`.

- [ ] **Step 1: Failing tests**: `routes a registered calendar to its mailbox`; `an unregistered calendar needs a mailbox when two exist`; `refuses bare primary`; `rewrites primary with a mailbox to that mailbox's home calendar`; `owning grant wins on register`; `add registers the home calendar`; manifest order test passes for calendar.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(calendar): route every calendar call through its mailbox (#2475)`.

### Task 32: Writes, holds and RSVP on the right calendar

**Files:**
- Modify: `skills/calendar/tools/calendar-create-event/handler.ts` (with >1 live mailbox and a principal calendar: `mailbox` required; missing → `needs_mailbox` + `mailboxEvidence(attendees)`; `calendarId`'s mailbox must equal `mailbox` → else refuse `calendar_mailbox_mismatch`; result `evidence` verdict; hold release on booking :116-160 searches every home calendar), `calendar-create-hold` (same gate; place on that mailbox's home calendar), `calendar-respond-to-invite` (`account?` renamed `mailbox?`, enforced: routes to the mailbox the invite arrived in; `releaseMatchingHolds` :131-195 searches every home calendar), `calendar-holds-sweep` (every mailbox's calendars), `calendar-list-events` (collapse same-`icalUid` events into one with `calendars: [{calendarId, mailbox_label}]`), tool descriptions (D5 mention rules)
- Test: those tools' tests; `tests/integration/calendar-holds-collaboration.test.ts`

- [ ] **Step 1: Failing tests**: `create-event without mailbox returns needs_mailbox and creates nothing`; `refuses a calendar from another mailbox`; `hold placed on the chosen mailbox's calendar`; `booking releases a hold on the other calendar`; `RSVP answers through the arrival mailbox`; `sweep covers both mailboxes`; `same meeting on both calendars lists once`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(calendar): events, holds and RSVPs on the right account (#2475)`.

### Task 33: Availability, debrief, lift the cap, Part 4 docs

**Files:**
- Modify: `skills/calendar/tools/calendar-find-free-time/{handler.ts,tool.json}` (append `treat_as_free?` event IDs; principal calendars via `listEvents` with titles, others via `getFreeBusy`; output adds `blocking: [{ eventId, title, calendar_label, start, end }]`, `treated_as_free`, `partial?: [{ mailbox_label, error }]`, `removed?: [mailbox_label]`), `calendar-check-conflicts` (conflicts carry `eventId`, `title`, `calendar_label`; same `partial`), `agents/meeting-debrief.yaml:120-131` (guard keys `seen:<icalUid>` when present, else `<eventId>`), `agents/calendar.yaml` ("the principal's calendar" → "calendars"; conflicts judged against calendaring preferences, one line), `src/principal-mailboxes/types.ts` (delete `MAX_LIVE_MAILBOXES` check, i.e. no cap), delete `src/channels/calendar/resolve-calendar-grant.ts` and its test, `docs/adr/063-…` (calendar section), `docs/specs/17-meeting-debrief.md`
- Create: `changes/feat-2475-calendar.md`, scenario cases `45k-meeting-on-work-calendar-no-mention.yaml`, `45l-cleaner-not-a-conflict.yaml`, `45m-availability-across-calendars.yaml`
- Test: both tools' tests, `tests/unit/agent.meeting-debrief-idempotency.test.ts`, prompt budget

- [ ] **Step 1: Failing tests**: `reads every home calendar`; `partial when one grant fails, never clear`; `a removed mailbox's calendar is listed as removed, not partial`; `treat_as_free lets the cleaner's visit not block` (window returned free, event listed in `treated_as_free`); `events marked free never block`; `conflicts carry titles`; `two live mailboxes can be added` (cap lifted); debrief `dedupes a meeting on both calendars by iCal UID`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; prompt and docs edits; scenario cases written, not run.
- [ ] **Step 4: Run** `pnpm -C $W run typecheck`, `pnpm -C $W run lint`, `pnpm -C $W test`, integration tests for Tasks 1, 2, 23, 29, 30 — PASS. `ls $W/src/db/migrations | sort` prefixes unique.
- [ ] **Step 5: Commit** `feat(calendar): availability across every calendar; lift the one-mailbox cap (#2475)`.
- [ ] **Step 6: Open PR 4** (base `feat/2475-triage`, `no-loop`, `Closes #2475`). Ask the maintainer about running scenario cases 45a–45m with a cost estimate, and about the one-time live Gmail checks (iCal UID filter, `rfc822msgid:` search, reply headers on drafts, draft delete).
