# Agent-initiated secret capture (one-time link to the vault) — #971

## Goal
Let Curia help a user add a **new** secret to the vault mid-conversation by minting a
one-time, single-use, 30-minute tokenized link to a public web form. The value is entered
by the user and written straight to the encrypted vault server-side. The secret value never
passes through the LLM, the chat transcript, the agent context, or logs.

The "LLM never sees secrets" guarantee is **structural** — the skills have no code path that
returns a value.

## Components (build order, TDD)

### 1. Migration `053_create_secret_capture_tokens.sql`
Token-metadata-only store (no secret material). Schema per issue: `token_hash` PK (SHA-256 of
raw URL token), `secret_name`, `label`, `value_format` (`string|json`), `expires_at`,
`consumed_at`, `created_at`. Index on `expires_at`.

### 2. Core service `src/secrets/secret-capture-service.ts`
- Pure name-policy functions (exported, unit-tested):
  - `resolveUserSecretName(input)` → slugify to `user.<a-z0-9_>+`; reject empty/over-long.
  - `resolveSystemSecretName(input, allowedNames)` → must be in the allowlist, else throw.
- `SecretCaptureService` (implements `SecretCaptureMinter` for skills):
  - `mint({ secretName, label, valueFormat, ttlMinutes })` → `{ rawToken, expiresAt }`
    (low-level; secretName already validated). `randomBytes(32).hex`, store `hashToken(raw)`.
  - `mintUserSecret({ rawName, ... })` / `mintSystemSecret({ rawName, ... })` → resolve name + mint.
  - `getMetadata(rawToken)` → `{ label, valueFormat } | 'expired' | 'not_found'` (never the key).
  - `redeem(rawToken, value)` → `'ok' | 'expired' | 'not_found' | 'invalid_json'`.
    Atomic single-use claim via `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()`.
    JSON validated **before** claim (so invalid input doesn't burn the token). On vault-write
    failure: clear `consumed_at` (retry-able) and rethrow → route 500.
- Reuses `hashToken()` from `session-auth.ts` and `SecretsService.set/setJSON`.
- `CHANNEL_CREDENTIAL_KEYS` exported from `vault.ts` and reused for the system allowlist.

### 3. HTTP routes `src/channels/http/routes/secret-capture.ts`
Unauthenticated except for the token (the token is the capability). Rate limit 10 / 15 min / IP.
- `GET /api/secret-capture/:token` → `{ label, value_format }` | 410 | 404.
- `POST /api/secret-capture/:token` `{ value }` → `redeem` → `{ ok: true }` | 410 | 404 | 400.
- Registered in `http-adapter.ts` **outside** the bearer-auth guard (add `/api/secret-capture`
  to the `onRequest` exemption list) and before the console wildcard.

### 4. Skill capability wiring
- Add `secretCapture` to `VALID_CAPABILITIES` (loader.ts) and `SkillContext` (types.ts).
- Inject `this.secretCaptureService` + `appOrigin` / `httpPort` into `SkillContext` (execution.ts).
- `ExecutionLayer`: `appOrigin`/`httpPort` via constructor; `secretCaptureService` via a setter
  (it is constructed after `registryService`, which executionLayer precedes in bootstrap).

### 5. Skills
- `secret-capture-request` — any caller; `mintUserSecret`; name auto-prefixed `user.<slug>`.
  `sensitivity: normal`, `action_risk: low`.
- `system-secret-capture-request` — `allowed_callers: ["setup-wizard"]`; `mintSystemSecret`;
  literal declared/channel key. `sensitivity: normal`, `action_risk: none`.
- Handlers build `${origin}/secret-capture/${rawToken}` (origin = `ctx.appOrigin` or dev
  `http://localhost:${ctx.httpPort}`). Neither declares `requires_secrets`; neither can read a value.

### 6. Frontend `apps/console/src/pages/SecretCapturePage.tsx` + public route `/secret-capture/$token`
Child of `rootRoute` (no auth gate). GET metadata on mount; render value field (textarea; JSON
validated client-side when `value_format==='json'`); POST; success/expired states.

## Test matrix
Service (mint hashes, redeem atomic/single-use, expiry, vault-fail clears consumed_at, JSON);
name policy (user slug+prefix, rejects protected; system accepts declared/channel, rejects unknown);
routes (GET metadata/410/404, POST writes+consumes, rate limit); skills (URL from origin,
system blocked for non-setup-wizard, output shape); frontend (form for valid token, expired for 410).
