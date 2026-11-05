# Secrets Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the console `/secrets` page as a Contacts-style records table listing every personal, system and platform secret, with drawer-based create/view/edit, backed by the vault API changes it needs.

**Architecture:** Backend first: a platform-key list, `SecretsService` metadata reads, a `secret.accessed` usage repo, then the widened `GET /api/vault/secrets` and new write routes in `src/channels/http/routes/vault.ts`. Then the console: pure helpers in `secrets-utils.ts` (filter/sort/status/duplicates), and a rewritten `SecretsPage.tsx` plus drawers that copy the Contacts page's layout classes and drawer pattern.

**Tech Stack:** TypeScript (ESM), Fastify, node-pg-migrate, Postgres, React (console app), Vitest.

**Spec:** `docs/wip/2026-11-04-secrets-page-redesign-design.md`. Read it first; this plan argues from it.

Worktree: `/Users/josephfung/Projects/curia/worktrees/curia-secrets-page-redesign` (branch `secrets-page-redesign`). Below, `$W` means that path.

## Global Constraints

- **No secret value** may ever appear in any API response, log line, audit payload or DOM node. Every route test that touches a value asserts the response body does not contain it.
- Every new route uses `requireAuth` (`assertSecret`) and `AUTH_RATE` (30/min), same as the existing vault routes.
- Every write emits two-stage `secret.changed` (`requested` before the vault is touched, refusing on audit failure; `completed` after) through the existing `auditRequested` / `auditCompleted` helpers.
- Values: a non-empty string of at most `MAX_SECRET_VALUE_LENGTH` (8192) characters. Whitespace-only is rejected (400).
- Platform-key refusal copy (exact): `Managed by deployment — change it in the deploy environment, not here.`
- UI copy (exact):
  - Card option label `Card (later)`, tooltip `Coming soon — ADR-027`.
  - Name preview `Saved as <code>{name}</code> — named from the site.` (Website login) or `Saved as <code>{name}</code>.` (Other).
  - Duplicate warning `You already have {name} (updated {date}). Saving replaces it instead of adding a duplicate.`
  - Recent-uses note `"Used" means Curia read it; whether the sign-in worked isn't recorded.`
  - Recent-uses empty state `Curia hasn't read this secret yet.`
  - Startup-read text: Last used cell `At startup`; View `Read when Curia starts; individual reads aren't recorded.`
  - JSON value block `Recapture through Curia to change a structured value.`
- Migration prefix `117` (latest on main is `116`). Re-check `ls src/db/migrations | sort` for uniqueness after any rebase.
- ESM `.js` relative imports, no `any`, pino in backend (no `console.log`).
- Commits use `git -C $W commit -s` (DCO). No `Co-Authored-By` trailer.
- Typecheck with `pnpm -C $W run typecheck`; lint with `pnpm -C $W run lint`.
- Integration tests need `DATABASE_URL` pointing at a throwaway test database (`tests/integration/require-test-db.ts` enforces it). Without it they skip. Report skipped integration suites as skipped, not passed.

## Review Focus

1. **Malformed stored `login_url`** (old rows written before validation): the list must still render. `siteHost` returns `null` and "Used for" falls back to "No sign-in site saved". Pinned in Task 7.
2. **Create with a URL that has no ordinary domain** (`https://192.168.1.10/login`, `http://localhost:8080`): the name must still identify the site and never be the type-only `user.password`. Pinned in Task 5.
3. **Names with dots and dashes in route params** (`channel.email.my-acct.nylas_grant_id`, `user.x_password`) through `DELETE`, `PATCH` and `/uses`. The client must `encodeURIComponent`, and routes must match. Pinned in Tasks 6 and 4.
4. **Stale tab:** a PATCH on a `user.*` key that another tab or agent already removed must 404, not silently re-create it. Pinned in Task 6.
5. **Whitespace-only value** on POST/PATCH must 400 like PUT, so a blank never counts as "configured". Pinned in Task 6.

---

### Task 1: Platform key list

**Files:**
- Create: `src/secrets/platform-keys.ts`
- Modify: `src/channels/web/vapid.ts:19`: export the key name
- Test: `tests/unit/secrets/platform-keys.test.ts`

**Interfaces:**
- Produces:
  - `PLATFORM_VAULT_KEYS: ReadonlyMap<string, string>` (key → label)
  - `isPlatformVaultKey(name: string): boolean`
  - `platformKeyLabel(name: string): string | undefined`
  - `export const VAPID_SECRET_NAME = 'web_push_vapid'` in `vapid.ts`, replacing the local `SECRET_NAME`.

Labels (exact):

| Key | Label |
|---|---|
| `anthropic_api_key` | `LLM provider (Anthropic)` |
| `openai_api_key` | `LLM provider (OpenAI)` |
| `openrouter_api_key` | `LLM provider (OpenRouter)` |
| `aws_access_key_id`, `aws_secret_access_key` | `LLM provider (AWS Bedrock)` |
| `embedding_api_key` | `Embeddings` |
| `api_token` | `HTTP API token` |
| `web_app_bootstrap_secret` | `Console sign-in` |
| `nylas_api_key`, `nylas_grant_id`, `nylas_self_email` | `Nylas (legacy email)` |
| `web_push_vapid` | `Web push keys` |

- [ ] **Step 1: Write the failing tests**

  - `every key applyVaultSecrets reads is a platform key`: call `applyVaultSecrets(config, fake, silentLogger)` with a fake whose `get(name)` records `name` and returns `null`. Assert the recorded list is non-empty and `recorded.every(isPlatformVaultKey)`. This is the drift guard the spec asks for.
  - `the VAPID key is a platform key`: `expect(isPlatformVaultKey(VAPID_SECRET_NAME)).toBe(true)`.
  - `declared and personal keys are not platform keys`: `isPlatformVaultKey('tavily_api_key')`, `isPlatformVaultKey('user.rogers_password')` and `isPlatformVaultKey('channel.telegram.bot_token')` are all false.
  - `labels`: `platformKeyLabel('web_app_bootstrap_secret') === 'Console sign-in'`.

- [ ] **Step 2: Run them and see them fail**
  Run: `pnpm -C $W exec vitest run tests/unit/secrets/platform-keys.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `platform-keys.ts`** with a header comment saying why the list exists. Add the `VAPID_SECRET_NAME` export.

- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**
  `git -C $W add src/secrets/platform-keys.ts src/channels/web/vapid.ts tests/unit/secrets/platform-keys.test.ts; git -C $W commit -s -m "feat(vault): platform key list for the secrets page"`

---

### Task 2: SecretsService metadata and detail edits

**Files:**
- Modify: `src/secrets/secrets-service.ts`
- Test: `tests/integration/secrets-service.test.ts`

**Interfaces:**
- Produces:
  - `export interface SecretMetadata { name: string; valueFormat: ValueFormat; createdAt: Date; updatedAt: Date }`
  - `SecretsService.listMetadata(): Promise<SecretMetadata[]>`: one `SELECT name, value_format, created_at, updated_at FROM secrets ORDER BY name`. It never selects ciphertext.
  - `export interface UserSecretDetailsPatch { loginUrl?: string | null; username?: string | null }`
  - `SecretsService.patchUserDetails(name: string, patch: UserSecretDetailsPatch): Promise<void>`
    - An omitted field keeps its stored value. `null` clears it.
    - If there is no row yet, insert one.
    - Throw for a non-`user.*` name, same as `upsertUserDetails`.
    - Approach: pass a `has_` boolean plus a value per field, and use `CASE WHEN $has THEN $val ELSE existing END` in the `ON CONFLICT` update.
  - `SecretsService.deleteUserDetails(name: string): Promise<void>`. Removing a missing row is not an error.
  - `upsertUserDetails` is unchanged (COALESCE keep-semantics). Create-replace relies on it.

- [ ] **Step 1: Write the failing integration tests.** Use a suite-unique `user.svc_meta_` prefix and clean it up in `beforeEach`.
  - `listMetadata returns format and dates without values`:
    - Call `set('user.svc_meta_a', 'v1')` and `setJSON('user.svc_meta_b', {x: 1})`.
    - The row for `_a` has `valueFormat === 'string'` and the row for `_b` has `'json'`.
    - `createdAt` and `updatedAt` are `Date` instances.
    - `JSON.stringify(rows)` does not contain `'v1'`.
  - `updated_at moves on set, created_at does not`: call `set` twice with a 10ms sleep between. `updatedAt` grows and `createdAt` is unchanged.
  - `patchUserDetails keeps omitted and clears null`:
    - Start from `upsertUserDetails(n, {loginUrl: 'https://a.com/', username: 'u'})`.
    - `patchUserDetails(n, {username: null})` gives `listUserDetails().get(n)` equal to `{loginUrl: 'https://a.com/'}`.
    - `patchUserDetails(n, {loginUrl: 'https://b.com/'})` gives `{loginUrl: 'https://b.com/'}`.
  - `patchUserDetails inserts when no row exists`.
  - `deleteUserDetails removes the row` and is idempotent.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm -C $W exec vitest run tests/integration/secrets-service.test.ts`. Expected: FAIL, methods missing. If `DATABASE_URL` is unset, the suite skips: set it first.

- [ ] **Step 3: Implement the three methods.**

- [ ] **Step 4: Run and see them pass.**

- [ ] **Step 5: Commit**
  `feat(vault): secret metadata and sign-in detail patch/delete`

---

### Task 3: Secret usage from the audit log, plus the `details` action

**Files:**
- Modify: `src/bus/events.ts:996`. Change `SecretChangedPayload.action` to `'set' | 'delete' | 'details'` and extend its doc comment.
- Modify: `src/audit/field-extraction.ts`. Add a `'secret.accessed'` extractor next to `'secret.changed'` (`:142`).
- Create: `src/db/migrations/118_audit_log_secret_accessed_index.js`
- Create: `src/secrets/secret-usage-repo.ts`
- Test: `tests/unit/audit/field-extraction.test.ts`, `tests/integration/secret-usage-repo.test.ts`

**Interfaces:**
- The `secret.accessed` extractor returns:
  - `action: 'accessed'`, `outcome: 'success'`
  - `target_type: 'secret'`, `target_id: str(p, 'secretName', fail)`
  - `initiator_type: 'agent'` when `agentId` is a string, else `'system'`
  - `initiator_id`: `agentId`, else `str(p, 'toolName', fail)`
- Migration 117:
  - Copy 105's no-transaction CONCURRENTLY pattern, including the invalid-index drop.
  - One index: `idx_audit_log_secret_accessed ON audit_log ((payload->>'secretName'), timestamp DESC) WHERE event_type = 'secret.accessed'`.
  - `down` drops it CONCURRENTLY.
  - No backfill. The repo reads `payload->>'secretName'`, which old and new rows both carry. `audit_log` is append-only, so a backfill would need the trigger disabled; this approach avoids that.
- Produces, in `secret-usage-repo.ts`:
  - `export interface SecretUse { at: Date; agentId: string | null; toolName: string; source: 'vault' | 'env' | null; byReference: boolean }`
  - `export interface SecretUsagePort { lastUsedByName(): Promise<Map<string, Date>>; recentUses(name: string, limit: number): Promise<SecretUse[]> }`
  - `export class SecretUsageRepo implements SecretUsagePort { constructor(pool: DbPool) }`
    - `lastUsedByName` is one grouped query: `SELECT payload->>'secretName', max(timestamp) … WHERE event_type = 'secret.accessed' GROUP BY 1`.
    - `recentUses` orders by `timestamp DESC` and applies `LIMIT $2`.
- Consumed by: Task 4 (`lastUsedByName`) and Task 6 (`recentUses`).

- [ ] **Step 1: Write the failing tests**
  - Unit, `field-extraction.test.ts`: `secret.accessed maps to a secret target`. With payload `{toolName: 'web-browser', secretName: 'user.x_password', agentId: 'travel'}`, expect `{action: 'accessed', outcome: 'success', target_type: 'secret', target_id: 'user.x_password', initiator_type: 'agent', initiator_id: 'travel'}`. A second case without `agentId` gives `initiator_type: 'system'` and `initiator_id: 'web-browser'`.
  - Integration, `secret-usage-repo.test.ts`:
    - Write three `createSecretAccessed` events through a real `AuditLogger` for suite-unique `user.usage_rt_a` (two of them) and `user.usage_rt_b`.
    - `lastUsedByName().get('user.usage_rt_a')` equals the newer timestamp.
    - `recentUses('user.usage_rt_a', 1)` has length 1, is the newest, and has `toolName` set.
    - `recentUses('user.usage_rt_none', 5)` is `[]`.
    - Use unique names, not cleanup: `audit_log` rows can't be deleted.
  - Unit, `field-extraction.test.ts`: `secret.changed accepts the details action`. A `{secretName, action: 'details', stage: 'completed', initiatedBy: 'session', actorSessionId: 's1'}` payload gives `action: 'details'`.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm -C $W exec vitest run tests/unit/audit/field-extraction.test.ts tests/integration/secret-usage-repo.test.ts`.

- [ ] **Step 3: Implement** the union change, extractor, migration and repo. In `docs/specs/06-audit-and-security.md:44`, extend the `secret.changed` row to mention `details`, and say that `secret.accessed` is now indexed by secret.

- [ ] **Step 4: Run the tests, then the migration against the test DB.** Run the same vitest command (PASS). Then run `ls $W/src/db/migrations | sort | cut -c1-3 | uniq -d`, which must print nothing.

- [ ] **Step 5: Commit**
  `feat(audit): index secret.accessed by secret and add a details change action`

---

### Task 4: `GET /api/vault/secrets` lists every kind

**Files:**
- Modify: `src/channels/http/routes/vault.ts` (types `:80-110`, port `:75-79`, GET `:269-307`)
- Modify: `src/channels/http/http-adapter.ts:567-576`. Pass `usage: new SecretUsageRepo(pool)`.
- Test: `tests/unit/channels/http/routes/vault.test.ts`. Extend `fakeSecrets()` for the widened port.

**Interfaces:**
- Consumes: `isPlatformVaultKey` and `platformKeyLabel` (Task 1); `listMetadata` and `SecretMetadata` (Task 2); `SecretUsagePort` (Task 3).
- `VaultSecretsPort` becomes:
  - `list`, `set`, `delete`
  - `listMetadata(): Promise<SecretMetadata[]>`
  - `listUserNames(): Promise<string[]>`
  - `listUserDetails(): Promise<Map<string, UserSecretDetails>>`
  - `upsertUserDetails(name: string, d: UserSecretDetails): Promise<void>`
  - `patchUserDetails(name: string, p: UserSecretDetailsPatch): Promise<void>`
  - `deleteUserDetails(name: string): Promise<void>`
- `VaultRouteOptions` adds `usage?: SecretUsagePort`. When it is absent, `lastUsedAt` is `null`.
- `VaultSecretDeclarer.kind` adds `'platform'`.
- Produces (the console mirrors this type in Task 7):

```ts
export type VaultSecretKind = 'personal' | 'system' | 'platform';
export interface VaultSecretSummary {
  name: string;
  kind: VaultSecretKind;
  configured: boolean;
  required: boolean;
  envFallback: string | null;
  declaredBy: VaultSecretDeclarer[];
  valueFormat: 'string' | 'json' | null;   // null when not in the vault
  createdAt: string | null;                // ISO
  updatedAt: string | null;
  lastUsedAt: string | null;
  readAtStartup: boolean;
  loginUrl?: string;                       // personal only
  username?: string;
}
```

Row assembly. Each vault name lands in exactly one row; the first matching rule wins:

1. Platform list and in the vault → `kind: 'platform'`, `required: true`. `declaredBy` is any real declarations plus `{kind: 'platform', name: platformKeyLabel(n), required: true, enabled: true}`.
2. `user.*` → `kind: 'personal'`, `required: false`, `declaredBy: []`, details from `listUserDetails`.
3. Declared (today's `collectDeclarations`) → `kind: 'system'`. This includes declared names that aren't in the vault.
4. Anything else in the vault → `kind: 'system'`, `declaredBy: []` (orphan). This replaces the "(account removed)" email-grant special case at `:278-284`.

`readAtStartup` is true when `kind === 'platform'`, or when `kind === 'system'` and `declaredBy.length > 0` and no declarer has `kind === 'tool'`. The server keeps today's name sort; the client applies the default sort.

- [ ] **Step 1: Write the failing tests.** Fake vault: `tavily_api_key`, `openrouter_api_key`, `user.rogers_password` with details, `old_tool_key`, and a declared-but-unset `linear_api_key` from a fake MCP registry.
  - `lists personal, system, platform and orphan rows`: kinds are `system`, `platform`, `personal`, `system` (orphan, `declaredBy: []`), and `system` (`configured: false`).
  - `personal rows carry sign-in details and no value`: `loginUrl` and `username` are present, and the body does not contain the fake's stored value.
  - `dates and lastUsedAt come from metadata and usage`: with a fake `usage` returning `user.rogers_password → 2026-10-01T00:00:00.000Z`, `lastUsedAt` is that ISO string. It is `null` without `usage`.
  - `readAtStartup`: true for the platform row and for a `channel.*` row; false for a tool-declared key and for personal rows.
  - `a platform key that is also declared stays platform`: a fake registry declares `openrouter_api_key`, and the row is still `kind: 'platform'`.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm -C $W exec vitest run tests/unit/channels/http/routes/vault.test.ts`.

- [ ] **Step 3: Implement** the port, types, row assembly and `http-adapter` wiring. Update the file header comment's route list.

- [ ] **Step 4: Run and see them pass.** Then check that existing integration `tests/integration/vault-routes.test.ts` still passes.

- [ ] **Step 5: Commit**
  `feat(vault): list personal, platform and orphaned secrets with dates and last use`

---

### Task 5: Console naming input for personal secrets

**Files:**
- Modify: `src/secrets/user-secret-name.ts`
- Test: `tests/unit/secrets/user-secret-name.test.ts`

**Interfaces:**
- Produces:
  - `siteIdentityFromUrl(url: string): string`. Throws on a non-http(s) or unparseable URL. Algorithm:
    1. Lower-case the hostname and drop a leading `www.`.
    2. If it is an IPv4 address or has no dot, return it as-is.
    3. Otherwise split on `.`. If the last label has 2 characters and the one before it has at most 3 (as in `co.uk` or `com.au`), take the third-from-last label. Else take the second-from-last.
  - `consoleSecretNameInput(input: { type: 'website_login' | 'other'; label?: string; loginUrl?: string }): string`
    - `website_login` returns `` `${siteIdentityFromUrl(loginUrl)} password` `` and throws when `loginUrl` is missing.
    - `other` returns `label.trim()` and throws when the label is blank.
  - The result is fed to the existing `resolveUserSecretName(input, existingUserKeys)`.
- Consumed by: Task 6.

- [ ] **Step 1: Write the failing tests** (table-driven):
  - `siteIdentityFromUrl`:
    - `https://www.rogers.com/signin` → `rogers`
    - `https://secure.rbc.com/x` → `rbc`
    - `https://aircanada.com/aeroplan` → `aircanada`
    - `https://www.amazon.co.uk/` → `amazon`
    - `http://localhost:8080` → `localhost`
    - `https://192.168.1.10/login` → `192.168.1.10`
    - `ftp://x.com` throws
    - `not a url` throws
  - Through `resolveUserSecretName(consoleSecretNameInput(...), existing)`:
    - Rogers with `[]` gives `user.rogers_password`.
    - Rogers with `['user.rogers_password']` gives `user.rogers_password`.
    - The IP URL gives a name that is not `user.password` and starts with `user.192`.
    - `{type: 'other', label: 'Bank PIN'}` gives `user.bank_pin`.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm -C $W exec vitest run tests/unit/secrets/user-secret-name.test.ts`.

- [ ] **Step 3: Implement the two functions.**

- [ ] **Step 4: Run and see them pass.**

- [ ] **Step 5: Commit**
  `feat(vault): name personal secrets from a sign-in URL`

---

### Task 6: Vault write routes: platform guard, personal create/edit, wider delete, uses

**Files:**
- Modify: `src/channels/http/routes/vault.ts`
- Test: `tests/unit/channels/http/routes/vault.test.ts`, `tests/integration/vault-routes.test.ts`

**Interfaces:**
- Consumes: `isPlatformVaultKey` (Task 1); `patchUserDetails`, `deleteUserDetails` and `listMetadata` (Task 2); `SecretUsagePort.recentUses` (Task 3); `consoleSecretNameInput`, `resolveUserSecretName` and `parseUserSecretDetails` (Task 5).
- `SecretChange.action` widens to `'set' | 'delete' | 'details'`.
- **Platform guard:** `PUT /api/vault/secrets/:name`, `DELETE /api/vault/secrets/:name` and `PATCH /api/vault/user-secrets/:name` check `isPlatformVaultKey(name)` first, before the allowlist and before any audit. They return 403 `{ error: 'Managed by deployment — change it in the deploy environment, not here.' }`.
- **DELETE** is allowed when `isAllowedVaultName(name)` or the name exists in the vault. The platform guard has already run, so this covers `user.*` and orphans. For `user.*`, after the vault delete, call `deleteUserDetails(name)` before `auditCompleted`. The 409 flow is unchanged: personal keys and orphans have no declarers, so it never fires for them.
- **`POST /api/vault/user-secrets/preview`**
  - Body: `{ type, label?, loginUrl? }`.
  - 200 `{ name: string; existing: { updatedAt: string; valueFormat: 'string' | 'json' } | null }`.
  - 400 with the thrown message when naming input is invalid.
  - No audit, no writes.
- **`POST /api/vault/user-secrets`**
  - Body: `{ type, label?, loginUrl?, username?, value }`.
  - Name the secret as in preview.
  - Validate `value` (the Global Constraints rules) and the details (`parseUserSecretDetails`).
  - If the name exists with `valueFormat === 'json'`, return 409 `{ error: "'{name}' holds a structured value. Recapture through Curia to change a structured value." }`.
  - Otherwise: audit `set` requested → `set` → `upsertUserDetails` (keeps old details when fields are blank) → audit completed.
  - 200 `{ name, replaced: boolean }`.
- **`PATCH /api/vault/user-secrets/:name`**
  - Body: `{ loginUrl?: string | null; username?: string | null; value?: string }`.
  - 400 if the name doesn't start with `user.`. 404 `{ error: "'{name}' no longer exists." }` if it's not in the vault.
  - `''` counts as `null`. Non-null fields go through `parseUserSecretDetails`.
  - A `value` on a json-format key returns the same 409 as POST.
  - Publish `requested` for each change kind present (`set` if `value` is present; `details` if either detail field is present) before any write.
  - Write the value first, then `patchUserDetails`, then the `completed` events.
  - A details-only patch never calls `set`.
- **`GET /api/vault/secrets/:name/uses?limit=N`**
  - `limit` defaults to 5 and is clamped to 1..20.
  - 200 `{ uses: Array<{ at: string; agentId: string | null; toolName: string; source: 'vault' | 'env' | null; byReference: boolean }> }`.
  - `{ uses: [] }` when `usage` is absent.

- [ ] **Step 1: Write the failing unit tests**
  - Platform guard:
    - `PUT, DELETE and PATCH refuse a platform key with 403`: use `openrouter_api_key`, including when a fake registry declares it.
    - No `secret.changed` was published, and the fake vault saw no `set` or `delete`.
  - Create:
    - `POST user-secrets creates user.rogers_password with details`: `{type: 'website_login', loginUrl: 'https://www.rogers.com/signin', username: 'u@example.com', value: 'pw-123'}`. The response is `{name: 'user.rogers_password', replaced: false}`, two `secret.changed` events with action `set` were published, and the body doesn't contain `pw-123`.
    - `POST replaces an existing key and keeps blank details`: with existing details `{username: 'old'}`, a POST without `username` leaves `upsertUserDetails` called with no username.
    - `POST refuses to replace a JSON-valued key`: 409, and no set.
    - `POST and PATCH reject a whitespace-only value`: 400.
  - Preview:
    - `preview reports the existing key`: `existing.updatedAt` is set.
    - `preview 400s a bad URL`: `loginUrl: 'ftp://x'`.
  - Edit:
    - `PATCH details-only never writes the value`: no `set` call, and the audit has action `details` (requested + completed).
    - `PATCH null clears a field`: `patchUserDetails` is called with `{username: null}`.
    - `PATCH with value and details audits both actions`.
    - `PATCH on a removed key 404s and writes nothing` (Review Focus 4).
    - `PATCH on a JSON-valued key with a value 409s; with details only succeeds`.
  - Delete:
    - `DELETE removes a user.* key and its details`.
    - `DELETE removes an orphaned key`.
    - `DELETE still 400s a name that is neither declared nor in the vault`.
    - `DELETE a dotted email-grant name`: route `channel.email.my-acct.nylas_grant_id`, URL-encoded (Review Focus 3).
  - Uses:
    - `GET uses returns the repo's rows, clamps limit`: `limit=500` reaches the fake as `20`.
    - `GET uses works for a dotted, encoded name`.

- [ ] **Step 2: Run and see them fail.**

- [ ] **Step 3: Implement the routes.** Keep each handler's shape like PUT's: validate → guard → `auditRequested` → write → `auditCompleted`, with a try/catch that logs the key name only.

- [ ] **Step 4: Run unit, then integration.** Add one integration case to `vault-routes.test.ts`:
  - POST a personal secret.
  - Then `SELECT event_type, payload->>'action' FROM audit_log WHERE payload->>'secretName' = $1`. It shows `set` requested and completed.
  - Use a suite-unique `user.vault_rt_` name, and extend the cleanup to `DELETE FROM secrets WHERE name LIKE 'user.vault_rt_%'` plus the matching `user_secret_details`.

- [ ] **Step 5: Commit**
  `feat(vault): create and edit personal secrets, guard platform keys, recent uses`

---

### Task 7: Console helpers

**Files:**
- Modify: `apps/console/src/pages/secrets-utils.ts`
- Test: `apps/console/src/pages/secrets-utils.test.ts`

**Interfaces:**
- `SecretRowData` mirrors `VaultSecretSummary` from Task 4. `SecretDeclarer.kind` adds `'platform'`, and `KIND_LABEL` gets `platform: ''`.
- Produces:
  - `type SecretKind = 'personal' | 'system' | 'platform'`
  - `type SecretStatus = 'configured' | 'env' | 'missing' | 'not_set' | 'not_declared'`
  - `secretStatus(row): SecretStatus`. Rules, in order:
    1. `kind === 'system'` and `declaredBy.length === 0` → `not_declared`.
    2. `configured` → `configured`.
    3. `envFallback` → `env`.
    4. `required` → `missing`.
    5. Otherwise → `not_set`.
  - `interface SecretFilters { kind: SecretKind | 'all'; status: SecretStatus | 'all'; required: 'required' | 'optional' | 'all'; search: string }`
  - `filterSecrets(rows, f): SecretRowData[]`
    - The groups combine with AND.
    - Search is case-insensitive over the name, `declarerLabel` of each declarer, `siteHost(loginUrl)`, `loginUrl` and `username`.
  - `filterCounts(rows): { kind: Record<SecretKind | 'all', number>; status: Record<SecretStatus, number>; required: Record<'required' | 'optional', number> }`, counted over all rows (as Contacts does).
  - `type SecretSortKey = 'name' | 'kind' | 'status' | 'updatedAt' | 'lastUsedAt'`
  - `sortSecrets(rows, sort: { key: SecretSortKey; dir: 'asc' | 'desc' } | null): SecretRowData[]`
    - `null` means the default: `missing` first, then by name.
    - Status order: `missing`, `not_set`, `env`, `not_declared`, `configured`.
    - Null dates sort last in both directions.
  - `siteHost(loginUrl?: string): string | null`: lower-cased, leading `www.` stripped, `null` on a parse failure.
  - `duplicateSiteHints(rows): Map<string, string[]>`: for each personal row, the other personal rows with the same non-null `siteHost`.
  - `readableLabel(name): string`. For `user.*`, strip the prefix, replace `_` with a space and capitalize the first letter (`user.aircanada_password` → `Aircanada password`). Other names come back unchanged.
  - `lastUsedText(row, now: Date): string`
    - `readAtStartup` → `At startup`.
    - Not configured and no `lastUsedAt` → `n/a`.
    - No `lastUsedAt` → `Never`.
    - Otherwise a relative time: `5m ago`, `3h ago`, `2d ago`; past 30 days, a short date.

- [ ] **Step 1: Write the failing tests** (one `describe` per function). Cases:
  - Every `secretStatus` branch, including a configured orphan → `not_declared`.
  - `filterSecrets` combining kind=personal with a search that matches only the username.
  - Default sort puts `missing` first.
  - Sorting by `lastUsedAt` asc and desc both put nulls last.
  - `siteHost('not a url') === null` (Review Focus 1).
  - `duplicateSiteHints` pairs `user.rogers_password` and `user.rogers_login` via `https://www.rogers.com/a` and `https://rogers.com/b`, and ignores rows without a URL.
  - `readableLabel`.
  - `lastUsedText` for each branch, with a fixed `now`.
  - The existing `removeSecretFlow` and `declarerLabel` tests stay.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm -C $W exec vitest run apps/console/src/pages/secrets-utils.test.ts`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and see them pass.**

- [ ] **Step 5: Commit**
  `feat(console): secrets list helpers for filter, sort, status and duplicates`

---

### Task 8: Console page and drawers

**Files:**
- Rewrite: `apps/console/src/pages/SecretsPage.tsx`
- Create: `apps/console/src/pages/SecretsDrawers.tsx`, exporting `SecretViewDrawer`, `SecretEditDrawer` and `SecretCreateDrawer`
- Modify: `apps/console/src/styles/app.css`, only if a needed class is missing (chip-group label, status pills). Reuse `.records-*`, `.drawer*` and the existing pill classes first.

**Interfaces:**
- Consumes: everything from Task 7, `apiFetch`, `Topbar`/`TopbarSearch`/`TopbarDivider`, and the routes from Tasks 4 and 6.
- Drawer props:
  - `SecretViewDrawer({ row, onClose, onEdit, onRemoved })`. Fetches `GET /api/vault/secrets/:name/uses?limit=5` on open.
  - `SecretEditDrawer({ row, onClose, onSaved })`
  - `SecretCreateDrawer({ existingRows, onClose, onSaved })`. Calls `POST …/preview`, debounced 300ms, whenever the type, label or URL changes.
- Page state: `DrawerMode = 'view' | 'edit' | 'create' | null`, a `selected` row, `SecretFilters`, and the sort (or `null`).

Structure: copy `ContactsPage.tsx`.
- Topbar with search and `+ New secret` (`:1102-1113`).
- The mobile search div (`:1120-1128`).
- A `.records-toolbar` with three chip groups labelled Kind / Status / Required and `X of Y` on the right (`:1130-1161`).
- `.records-layout > .records-main > .records-table-wrap > table.records-table`, with the drawer as a sibling of `.records-main` (`:1162`, `:1270-1290`).
- No pagination: all rows render in the scrolling table.
- Delete the old `SecretRow` component and the `settings-section` markup.

Drawer behavior and copy follow the spec's Drawer section and the Global Constraints. In particular:
- Platform rows: no pencil icon, and View has no footer buttons.
- System rows not in the vault: View shows `Set value` instead of Edit and no Remove.
- System Edit is a single `New value` field. It calls `PUT /api/vault/secrets/:name` and keeps the `ceo_self_email` server validation message.
- Personal Edit sends only changed fields, with `null` for a cleared one. It omits the value when the "New password" field is blank, and hides that field for `valueFormat === 'json'`, showing the JSON copy instead.
- Create has the type segmented control. `Card (later)` is disabled with its tooltip. Website login requires a URL and password; Other requires a label and value.
- Remove uses the existing `removeSecretFlow`, with every name passed through `encodeURIComponent`.
- After any save or remove, reload the list, close the drawer (View stays open after Edit saves), and show server errors inline in the drawer.

- [ ] **Step 1: Build the page and drawers.**

- [ ] **Step 2: Typecheck and lint.** Run `pnpm -C $W run typecheck` and `pnpm -C $W run lint`. Expected: both clean.

- [ ] **Step 3: Live check.** Run the app (the `run` skill) on a throwaway database seeded with:
  - about 25 secrets: personal with and without details, two sharing a host, a JSON-valued personal key, platform keys, a declared-unset tool key, a required-missing channel key and an orphan;
  - a few `secret.accessed` rows.

  Check, with screenshots at 1440px and 375px:
  - The page scrolls to the last row with the header pinned.
  - Each chip filters and the counts are right.
  - Every sortable column sorts both ways.
  - The duplicate hint appears on both Rogers rows.
  - View shows recent uses, and the startup text for a channel key.
  - Create previews `user.rogers_password` with the replace warning.
  - A details-only edit leaves Updated unchanged.
  - Platform rows can't be edited.
  - Remove on a required key shows the second confirm.
  - Searching the DOM for a seeded value finds nothing.

- [ ] **Step 4: Commit**
  `feat(console): rebuild Secrets as a records table with create/view/edit drawers`

---

### Task 9: Changelog and full verification

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Add the entries.** At most 15 words after the em-dash:
  - Changed: `**Secrets page** — one searchable, sortable list of personal, system and platform secrets with drawers. (#2453 follow-up)`
  - Added: `**Personal secrets in the console** — create, edit and remove website logins; platform keys read-only.`
  - Changed (public API): `**\`secret.changed\` event** — new \`details\` action for sign-in detail edits. Bus event type change.`

- [ ] **Step 2: Run the full gate.**
  - `pnpm -C $W run typecheck`
  - `pnpm -C $W run lint`
  - `pnpm -C $W exec vitest run tests/unit apps/console`
  - The integration files touched: `pnpm -C $W exec vitest run tests/integration/secrets-service.test.ts tests/integration/secret-usage-repo.test.ts tests/integration/vault-routes.test.ts`

  Expected: all pass. Report any skipped integration suite as skipped. Per the repo's notes, the full local integration suite is flaky on a shared DB, so run only these files.

- [ ] **Step 3: Check migration prefixes are unique.** Run `ls $W/src/db/migrations | sort | cut -c1-3 | uniq -d`. Expected: no output.

- [ ] **Step 4: Commit**
  `docs: changelog for the secrets page redesign`
