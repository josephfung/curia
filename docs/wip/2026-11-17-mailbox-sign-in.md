# Mailbox Sign-in (#2361) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Curia's own Google mailbox and the principal's through Nylas hosted auth, set up from a pasted Nylas API key. The operator and principal click through; nobody copies a grant id.

**Architecture:**
- **Nylas app client.** A small fetch-based client (`src/nylas/`) covers the application-level Nylas calls: the application and its callback URIs, connectors, the code exchange, and grants. It is region-aware.
- **Sign-in service.** `MailboxSignInService` mints single-use, hashed `state` tokens; the pattern copies secret capture. A public start route redirects to `/v3/connect/auth`, and a public callback route exchanges the code.
- **Writes go through the existing registries.** The callback reuses `PrincipalMailboxAdmin.add`/`replaceGrant` for the principal, which already goes live with no restart. For Curia, it upserts `email_accounts` and then schedules the existing supervisor restart.
- **Events.** Two new system-layer events: a per-attempt `mailbox_signin.finished`, which resumes the originating agent, and a one-time `principal_mailbox.connected`, which #2362 will consume.

**Tech Stack:** TypeScript (ESM), Fastify, Postgres (node-pg-migrate), React console (`apps/console`), Vitest, Mintlify docs (`curia-docs`).

**Spec:** issue #2361 (body as widened 2026-11-17) and `docs/wip/2026-11-17-mailbox-sign-in-google-findings.md`. Context: `docs/wip/2026-10-29-onboarding-journey-design.md` *1b*.

## Global Constraints

- **Google only** in this milestone. A non-Google grant is refused; `admin.add` already refuses `not_google`.
- **Required Google scopes**, requested on the link and checked on the grant:
  - `https://www.googleapis.com/auth/gmail.modify`
  - `https://www.googleapis.com/auth/gmail.compose`
  - `https://www.googleapis.com/auth/calendar`
- **Callback URL** = `${APP_ORIGIN}/api/mailbox-signin/callback`, byte-identical in `/v3/connect/auth` and `/v3/connect/token`.
- **Sign-in is unavailable** unless `APP_ORIGIN` starts with `https://`.
- **Token exchange:** `POST {apiUri}/v3/connect/token` with `client_secret` = the Nylas API key and `client_id` = the application id from `GET /v3/applications`. There is no separate client-id config.
- **Region:** `us` → `https://api.us.nylas.com`, `eu` → `https://api.eu.nylas.com`. It is stored as the non-secret email-channel credential field `nylas_region` (env fallback `NYLAS_REGION`), and a missing value means `us`.
- **Never let a grant id, API key, GCP client secret, auth code or raw `state` reach logs, audit payloads, tool output or event payloads.** Use `grantSafeErrorFields` (`src/principal-mailboxes/error-fields.ts`) on every Nylas error.
- **No `version` bumps.** New tool/agent artifacts start at `0.1.0`. Commits carry DCO `-s` and no AI-attribution trailers. Add a changelog fragment at `changes/<branch>.md`.
- **Next migration number is `127`.** Re-check prefix uniqueness after every rebase.

## Decisions taken here (principle applied)

- **Event name:** `principal_mailbox.connected`, not the issue's `principal.mailbox.connected`. The existing family is `principal_mailbox.changed`, so this keeps one convention; update the issue text.
- **"Once ever":** emit `principal_mailbox.connected` only when the callback's add created the **first-ever** `principal_mailboxes` row (`store.hasAnyRow()` was false before the add). This uses an existing bound and needs no new marker table ("look for an existing mechanism"). Concurrent first callbacks are a two-actions-by-one-principal race and get no lock.
- **Curia's own mailbox:** a **controlled self-restart** about 3 s after a successful callback, using the same `scheduleProcessExit` the setup route uses. The issue left "hot rebind or controlled self-restart" to the builder. Hot-adding is impossible when no account existed at boot (there is no gateway and no adapter wiring then; `src/index.ts:2352`). The principal path stays truly hot.
- **Link lifetime:** 60 minutes for in-conversation and console links, 7 days for links in an outage email. TTL is a mint parameter, capped at 7 days.
- **Re-auth to the same grant id:** Nylas returns the same id when the email already has a grant. If a live mailbox already stores it, that's a success with no write; `replaceGrant` would refuse it as `grant_in_use`.
- **Pub/Sub topic:** optional on the connector form. Curia polls (`nylasPollingIntervalMs`), so it needs no Gmail push.

## Parked for the maintainer (answer at plan review)

1. ~~Coordinator tool budget~~ — *settled 2026-11-17:* `mailbox-signin-link` is **pinned to setup-wizard** (operator flows; that agent isn't budgeted) and **discoverable, not pinned, for the coordinator** (`allow_discovery: true`; it's rare, like `image-generate`). #2360's agenda names the tool when onboarding needs it. No budget change.
2. **New public API.** Two new bus event types. `mailbox_signin.finished` is not named in the issue; it carries the result back to the agent that sent the link.
   - (a) Accept both (recommended).
   - (b) Fold the result into one event.

## Review Focus

1. **Re-auth of an address that is already Curia's own mailbox, during a principal sign-in.** This is a mismatch. The callback must **not** revoke the grant, because it is the live grant of `email_accounts`. Revoke a stray grant only when no registry row (principal or Curia) stores that grant id. Test in Task 6.
2. **A `state` that is valid but expired, reached after Google consent.** The callback must not exchange the code. It shows "this link expired, ask for a new one", resumes the agent with outcome `expired`, and stores nothing. Test in Task 6.
3. **Nylas redirects back with `error=` instead of `code=`** (an admin block, the user cancelling). The token is consumed, nothing is exchanged, the outcome is mapped (`admin_blocked`, `org_internal`, `cancelled`, `failed`), and the console page and agent message name the client id to trust for `admin_blocked`. Test in Task 6.
4. **The API key is saved in the console after boot,** and the operator presses "Check" before restarting. The Nylas setup routes must read the key **live from the vault** (`channel.email.nylas_api_key`), not from `config.nylasApiKey`, which is frozen at boot. Test in Task 3.
5. **An EU application.** Every Nylas call (SDK clients, `CeoNylasClient` in both `src` and `skills/_shared`, the app client) must use the configured region. A test asserts the base URL for `eu` in each. Tests in Tasks 1 and 2.

---

### Task 1: Nylas region

**Files:**
- Create: `src/nylas/region.ts`
- Modify:
  - `src/channels/catalog.ts:35` (add credential field `{ key: 'nylas_region', label: 'Nylas region (us or eu)', secret: false, envFallback: 'NYLAS_REGION' }`, not required)
  - `src/channels/apply-channel-vault-secrets.ts:71` (resolve it into `config.nylasRegion`)
  - `src/config.ts` (field `nylasRegion: NylasRegion`, default `'us'`)
  - `src/channels/email/nylas-client.ts:283` and `src/channels/calendar/nylas-calendar-client.ts:296` (optional trailing `apiUri?: string` passed as SDK `apiUri`)
  - `src/channels/email/ceo-nylas-client.ts:14,205` and `skills/_shared/ceo-nylas-client.ts` (base from `apiUri`)
  - every construction site (`src/index.ts` L1112, L1291, L1426, L4085; `src/principal-mailboxes/service.ts`; `src/channels/email/principal-mailbox-resolver.ts:24`; `skills/_shared/ceo-nylas-api-key.ts` gets a sibling `ceoNylasApiUri(ctx)` that reads `channel.email.nylas_region` live)
- Test:
  - `tests/unit/nylas/region.test.ts`
  - extend `tests/unit/channels/email/nylas-client-grant.test.ts` and `tests/unit/skills/ceo-nylas-client.test.ts`

**Interfaces — Produces:**
- `type NylasRegion = 'us' | 'eu'`
- `parseNylasRegion(raw: string | undefined): NylasRegion | null`; blank → `'us'`, unknown → `null`
- `nylasApiUri(region: NylasRegion): string`

- [ ] **Step 1: Write failing tests.**
  - `nylasApiUri('eu') === 'https://api.eu.nylas.com'`
  - `parseNylasRegion('EU') === 'eu'`, `parseNylasRegion('') === 'us'`, `parseNylasRegion('apac') === null`
  - `new NylasClient(key, grant, log, undefined, 'https://api.eu.nylas.com')` passes `apiUri` to the mocked SDK constructor
  - `CeoNylasClient` with the EU uri fetches `https://api.eu.nylas.com/v3/grants/<id>/...`
  - an unknown vault value logs a warning and falls back to `'us'` at boot
- [ ] **Step 2:** `pnpm -C <wt> vitest run tests/unit/nylas tests/unit/channels/email/nylas-client-grant.test.ts tests/unit/skills/ceo-nylas-client.test.ts` → FAIL.
- [ ] **Step 3:** Implement, and thread `nylasApiUri(config.nylasRegion)` through every construction site.
- [ ] **Step 4:** Tests pass. `pnpm -C <wt> run typecheck` is clean. A repo-wide grep for `api.us.nylas.com` finds only `src/nylas/region.ts`.
- [ ] **Step 5:** Commit `feat(email): selectable Nylas region (#2361)`.

### Task 2: Nylas application client

**Files:**
- Create: `src/nylas/app-client.ts`
- Test: `tests/unit/nylas/app-client.test.ts` (stub global `fetch`, the same style as `ceo-nylas-client.test.ts`)

**Interfaces — Produces:** `class NylasAppClient { constructor(opts: { apiKey: string; apiUri: string; logger: Logger; fetchImpl?: typeof fetch }) }` with:
- `getApplication(): Promise<{ applicationId: string; region: string; environment: string | null; callbackUris: string[] }>`
- `addCallbackUri(url: string): Promise<void>` (`POST /v3/applications/redirect-uris`, `{url, platform:'web'}`)
- `listConnectors(): Promise<Array<{ provider: string; scopes: string[]; clientId?: string }>>` (`clientId` from the non-secret `settings.client_id` when Nylas returns it; never read or return `client_secret`)
- `createGoogleConnector(input: { clientId: string; clientSecret: string; topicName?: string; scopes: string[] }): Promise<void>`
- `buildAuthUrl(input: { clientId: string; redirectUri: string; state: string; loginHint?: string; scopes: string[] }): string` (`provider=google`, `response_type=code`, `access_type=offline`)
- `exchangeCode(input: { clientId: string; code: string; redirectUri: string }): Promise<{ grantId: string; email: string | null; scopes: string[] }>`
- `getGrant(grantId: string): Promise<{ email: string; provider: string; scopes: string[]; status: 'valid' | 'invalid' }>`
- `deleteGrant(grantId: string): Promise<void>`
- `static probeRegion(apiKey: string, fetchImpl?): Promise<NylasRegion | null>` (tries `us` then `eu` with `GET /v3/applications` and returns the first 200)
- Errors: `NylasAppError extends Error { status: number; nylasType?: string }`. The message never contains the key, the code or the grant id.

- [ ] **Step 1: Write failing tests**, one per method:
  - the request URL, method and `Authorization: Bearer` header (the API-key value isn't asserted in snapshots);
  - the parsed response;
  - a 401 becomes `NylasAppError{status:401}` whose message excludes the key;
  - `exchangeCode` sends `client_secret` = the API key and `grant_type=authorization_code`;
  - `buildAuthUrl` url-encodes the scopes, space-joined;
  - `probeRegion` returns `'eu'` when US is 401 and EU is 200, and `null` when both fail.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, then typecheck.
- [ ] **Step 5:** Commit `feat(nylas): application-level API client (#2361)`.

### Task 3: Nylas setup from the API key (routes, console, setup status)

**Files:**
- Create:
  - `src/nylas/signin-readiness.ts`
  - `src/channels/http/routes/nylas-setup.ts`
  - `apps/console/src/components/NylasSignInSetupSection.tsx`
- Modify:
  - `src/channels/http/http-adapter.ts` (register beside the email-accounts routes)
  - `src/index.ts` (wire it)
  - `apps/console/src/pages/EmailCalendarSettingsPage.tsx`, with the section at the top
  - `skills/setup/tools/setup-status/handler.ts:11-26,316-322` (new check `{type:'nylas_signin_ready'}`) and `catalog.yaml` (new item `mailbox_signin`, then rewrite the `email` and `principal_mailboxes` `credential_how_to` for click-through)
  - `src/skills/types.ts` (`nylasSignInReadiness?: () => Promise<NylasSignInReadiness>`)
  - `src/skills/loader.ts:54`
- Test:
  - `tests/unit/nylas/signin-readiness.test.ts`
  - `tests/unit/channels/http/routes/nylas-setup.test.ts`
  - `skills/setup/tools/setup-status/handler.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseNylasRegion` and `nylasApiUri`; Task 2 `NylasAppClient`.
- Produces:
  - `type NylasSignInReadiness = { ready: true; applicationId: string; region: NylasRegion } | { ready: false; reason: 'no_api_key' | 'bad_api_key' | 'sandbox' | 'origin_not_https' | 'callback_unregistered' | 'no_google_connector' | 'nylas_unreachable'; detail: string }`
  - `checkNylasSignIn(deps: { readApiKey: () => Promise<string | undefined>; readRegion: () => Promise<NylasRegion>; appOrigin: string | undefined; makeClient?: (key, uri) => NylasAppClient }): Promise<NylasSignInReadiness>`. It reads the key and region **live** each call (Review Focus 4). `environment === 'sandbox'` means `sandbox`.
  - `mailboxSignInCallbackUrl(appOrigin: string): string`
- Routes, all under `/api/registry/nylas/` (already self-authed by the `/api/registry` prefix) with `assertSecret` and `AUTH_RATE`:
  - `GET /signin` → readiness plus `callbackUrl`
  - `POST /discover-region` → `{region}`, persisted to the vault
  - `POST /callback` → adds the callback URI
  - `POST /google-connector` with `{client_id, client_secret, topic_name?}`, using the scopes from Global Constraints. The client secret is never stored by Curia or echoed back.
  - Each POST audits with a new `action` on an existing audit path, never with values.

- [ ] **Step 1: Write failing tests.**
  - `checkNylasSignIn` returns each `reason` in turn: no key; a 401; `environment: 'sandbox'`; `appOrigin` is `http://...`; the callback is missing from `callbackUris`; no google connector.
  - It returns `ready: true` when everything is present.
  - A key written to the vault after construction is used on the next call.
  - Routes: `POST /google-connector` passes the secret to `createGoogleConnector`, and neither the response nor the logs contain it (assert on the captured pino output).
  - setup-status reports `mailbox_signin` done exactly when the readiness is `ready`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement the server side.
- [ ] **Step 4:** Build the console section: a region select, "Detect", "Check", "Register callback" and the connector form (client id, client secret, optional topic). Each failed readiness reason gets a one-line fix. Show the exact callback URL and Nylas's Google redirect `https://api.<region>.nylas.com/v3/connect/callback` to paste into GCP.
- [ ] **Step 5:** Tests pass, typecheck passes, and `pnpm -C <wt> --filter console run build` succeeds.
- [ ] **Step 6:** Boot logs `info` "mailbox sign-in unavailable: <reason>" when not ready, and never logs at error level. Commit `feat(setup): configure Nylas mailbox sign-in from the API key (#2361)`.

### Task 4: Events

**Files:**
- Modify: `src/bus/events.ts` (payloads near :1052, interfaces near :2024, union near :2348, factories near :3013) and `src/bus/permissions.ts:102,119` (the `system` set of both allowlists, plus a comment block)
- Test: `tests/unit/bus/mailbox-signin-events.test.ts`, modelled on `relay-deferred-event.test.ts`

**Interfaces — Produces:**
- `PrincipalMailboxConnectedPayload = { mailboxId: string }` and `createPrincipalMailboxConnected(payload, parentEventId?)`
- `MailboxSignInFinishedPayload = { target: 'principal' | 'curia'; outcome: MailboxSignInOutcome; mailboxId?: string; conversationId?; channelId?; agentId?; taskEventId?; originator?: Record<string, unknown>; resumeToken? }` and `createMailboxSignInFinished(payload, parentEventId?)`
- `type MailboxSignInOutcome = 'connected' | 'reconnected' | 'expired' | 'cancelled' | 'admin_blocked' | 'org_internal' | 'wrong_account' | 'missing_scopes' | 'not_google' | 'refused' | 'failed'`, exported from `src/nylas/signin-outcome.ts`
- Neither payload carries an address or a grant id.

- [ ] **Steps:**
  - Failing test: `canPublish('system', …)` and `canSubscribe('system', …)` are true for both types, false for `agent`/`channel`, and the factories set `sourceLayer: 'system'`.
  - Run → FAIL. Implement. Run → PASS, then typecheck.
  - Commit `feat(bus): mailbox sign-in events (#2361)`.

### Task 5: Sign-in tokens, start route and the agent tool

**Files:**
- Create:
  - `src/db/migrations/127_mailbox_signin_tokens.sql`
  - `src/nylas/mailbox-signin-service.ts`
  - `src/channels/http/routes/mailbox-signin.ts` (start route; Task 6 adds the callback)
  - `skills/mailbox-signin-link/{tool.json,handler.ts,handler.test.ts}`
- Modify:
  - `src/channels/http/auth.ts:48-79` (add `/api/mailbox-signin`)
  - `src/skills/types.ts`, `src/skills/loader.ts:54`, `src/execution.ts` (capability `mailboxSignIn`), `src/index.ts`
  - `agents/setup-wizard.yaml` (pin). **Not** `agents/coordinator.yaml`: the coordinator reaches it through discovery.
  - `config/registry-defaults.yaml` (`tools:` gets `mailbox-signin-link`, so it is enabled and discoverable)
- Test:
  - `tests/integration/mailbox-signin-service.test.ts` (real Postgres)
  - `tests/unit/channels/http/routes/mailbox-signin-start.test.ts`

**Interfaces:**
- Consumes: Task 3 `checkNylasSignIn` and `mailboxSignInCallbackUrl`; Task 2 `buildAuthUrl`; `buildCaptureOrigin` (`src/secrets/build-capture-origin.ts`).
- Table `mailbox_signin_tokens` columns:
  - `token_hash` (text PK), `target` (`'principal'|'curia'`), `expected_email` (text null), `mailbox_label` (text null)
  - `expires_at`, `consumed_at`, `created_at`
  - `conversation_id`, `channel_id`, `agent_id`, `task_event_id`, `originator` (jsonb), `resume_token`
- Produces: `class MailboxSignInService` with:
  - `mint(args: { target: 'principal' | 'curia'; expectedEmail?: string; label?: string; origin?: CaptureOrigin; ttlMinutes?: number }): Promise<{ url: string; expiresAt: Date }>`
    - Refuses with `MailboxSignInUnavailableError(reason)` unless readiness is `ready`.
    - `url` = `${appOrigin}/api/mailbox-signin/start/<rawToken>`.
    - TTL defaults to 60 and is capped at 10080.
  - `peek(rawToken): Promise<SignInTokenRow | 'expired' | 'not_found'>`
  - `consume(rawToken): Promise<SignInTokenRow | 'expired' | 'not_found' | 'used'>`, an atomic `UPDATE … WHERE consumed_at IS NULL RETURNING`. An expired token is still marked consumed, so it can't be replayed.
- Start route: `GET /api/mailbox-signin/start/:token`.
  - On `peek` ok: 302 to `buildAuthUrl({state: rawToken, loginHint: expected_email, …})`.
  - Otherwise: 302 to `/mailbox-signin/done?result=expired|not_found`.
  - Rate limit `{max: 20, timeWindow: '15 minutes'}`.
- Tool `mailbox-signin-link`:
  - Input `{ for?: 'principal' | 'curia'; mailbox_label?: string }`. Default `'principal'`. No `allowed_callers` restriction, so a discovering coordinator can call it. `for: 'curia'` is accepted only from `setup-wizard` (checked in the handler against `ctx.agentId`; refused otherwise).
  - For `'principal'`, `expectedEmail` is the principal's primary verified email. It's looked up in code, never from model input (ADR-047).
  - The description leads with a discovery-friendly phrase: "Connect, reconnect or sign in to the principal's Gmail and Google Calendar".
  - `action_risk: "none"`, `sensitivity: elevated`, capability `mailboxSignIn`, version `0.1.0`.
  - `data.summary` tells the agent to send the URL verbatim and to warn that Google may show an "unverified app" screen and consent twice, and that both boxes must stay ticked.

- [ ] **Step 1: Write failing tests.**
  - mint → peek ok;
  - consume twice → second is `'used'`;
  - consume after expiry → `'expired'` and the row is consumed;
  - mint when not ready → `MailboxSignInUnavailableError('origin_not_https')`;
  - the stored hash ≠ the raw token;
  - the start route 302s to `https://api.us.nylas.com/v3/connect/auth?...state=<raw>&login_hint=...`;
  - the tool rejects a call without the capability, and its output contains the URL and no grant id;
  - `for: 'curia'` from `ctx.agentId === 'coordinator'` is refused;
  - `tool-registry` search for "connect gmail" returns `mailbox-signin-link` (registry search unit test).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement, including migration 127.
- [ ] **Step 4:** Tests pass. Typecheck, `ls src/db/migrations | sort` unique, and `tests/unit/agents/prompt-budget.test.ts` passes unchanged (the coordinator gains no pin).
- [ ] **Step 5:** Commit `feat(email): single-use mailbox sign-in links (#2361)`.

### Task 6: Callback

**Files:**
- Create:
  - `src/nylas/mailbox-signin-callback.ts` (logic, framework-free)
  - `src/nylas/mailbox-signin-resume-subscriber.ts`
- Modify:
  - `src/channels/http/routes/mailbox-signin.ts` (add `GET /api/mailbox-signin/callback`)
  - `src/channels/email/` repo used by `email-accounts.ts` (an `upsertByAddress` helper)
  - `src/index.ts` (wire the subscriber like `SecretCaptureResumeSubscriber`, `index.ts:3861`)
- Test:
  - `tests/integration/mailbox-signin-callback.test.ts` (real Postgres, stubbed `NylasAppClient`)
  - `tests/unit/nylas/mailbox-signin-resume-subscriber.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 2, 4 and 5;
  - `PrincipalMailboxAdmin.add/replaceGrant` (`src/principal-mailboxes/admin.ts:126,268`);
  - `PrincipalMailboxStore.hasAnyRow`;
  - `mailboxIdFromAddress` (`migrate-flat-mailbox.ts:43`);
  - `emailAccountGrantSecretName`;
  - `scheduleProcessExit` (`http-adapter.ts:491`).
- Produces: `handleMailboxSignInCallback(query: { state?: string; code?: string; error?: string; error_description?: string }, deps): Promise<{ outcome: MailboxSignInOutcome; mailboxId?: string; restartScheduled: boolean }>`
- Order of operations:
  1. `consume(state)`. Not found or used → `failed`. Expired → `expired`. Nothing is exchanged in either case.
  2. If `error` is present, map it:
     - `admin_policy_enforced` → `admin_blocked`;
     - `org_internal` → `org_internal`;
     - `access_denied` → `cancelled`;
     - anything else → `failed`.

     Match on both `error` and `error_description`, since which field Nylas uses isn't documented.
  3. `exchangeCode`, then `getGrant`. Provider not google → `not_google`, and revoke if the grant is unused (step 6 rule).
  4. Any required scope missing → `missing_scopes`, and revoke if unused.
  5. **Principal target:** the grant email must equal `expected_email` (case-insensitive). Otherwise → `wrong_account`.
  6. **Revoke rule:** call `deleteGrant` only when no `principal_mailboxes` vault grant and no `email_accounts` vault grant equals this grant id.
  7. **Principal write:**
     - If a live mailbox has this address and its stored grant equals the id → `reconnected` (no write).
     - If a live mailbox has the address but a different grant → `replaceGrant` → `reconnected`.
     - Otherwise `firstEver = !(await store.hasAnyRow())`, then `admin.add({id: unique(mailboxIdFromAddress(email)), label: row.mailbox_label ?? 'Primary', grantId, makeDefault: firstEver || noLiveDefault})` → `connected`. On success, if `firstEver`, publish `principal_mailbox.connected`.
     - An `add` refusal → `refused` (log the refusal code).
  8. **Curia write:**
     - Refuse with `refused` if the address is a live principal mailbox.
     - Otherwise upsert `email_accounts` by `self_email`: a new name is a slug of the local part matching `EMAIL_ACCOUNT_NAME_RE`, suffixed `-2…` on collision, `enabled=true`.
     - Write the vault grant and audit.
     - Then `scheduleProcessExit(3000)` and `restartScheduled: true`.
  9. Always publish `mailbox_signin.finished` with the token's origin, then 302 to `/mailbox-signin/done?result=<outcome>&target=<target>&restart=<0|1>`.
- Resume subscriber: the same shape as `SecretCaptureResumeSubscriber`. Its content line per outcome:
  - on success, "connected — continue";
  - otherwise the plain reason, and "call `mailbox-signin-link` for a fresh link". For `admin_blocked` it also says the operator was told and gives the client id to trust.

  `admin_blocked` additionally sends `OutboundGateway.sendNotification` to the operator, with the application's Google client id.

- [ ] **Step 1: Write failing integration tests**, one per row:
  - success for the principal → row, vault grant, exactly one `principal_mailbox.connected`;
  - a second mailbox → no `connected` event;
  - re-auth returning the same id → `reconnected`, no write, no event;
  - wrong account → stray grant revoked;
  - wrong account whose grant is Curia's `email_accounts` grant → **not** revoked (Review Focus 1);
  - expired state with a code → no exchange (Review Focus 2);
  - `error=admin_policy_enforced` → `admin_blocked`, no exchange (Review Focus 3);
  - missing calendar scope → `missing_scopes`;
  - a failing exchange (400) → `failed`, nothing stored, a warning logged without the code;
  - Curia target → `email_accounts` row and restart scheduled; a second run for the same address updates the row and adds none;
  - every outcome publishes exactly one `mailbox_signin.finished`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, then typecheck.
- [ ] **Step 5:** Commit `feat(email): hosted-auth callback for Curia and principal mailboxes (#2361)`.

### Task 7: Console click-through and result page

**Files:**
- Create: `apps/console/src/pages/MailboxSignInDonePage.tsx`
- Modify:
  - `apps/console/src/router.tsx:242` (public route `/mailbox-signin/done` under `rootRoute`)
  - `apps/console/src/components/PrincipalMailboxesSection.tsx:494` and `EmailAccountsSection.tsx` ("Connect with Google" button; the grant-id form moves behind "Paste a grant ID instead")
  - `src/channels/http/routes/nylas-setup.ts` (`POST /api/registry/nylas/signin-links` with `{target, label?}` → `{url}`; operator-minted principal links get `expectedEmail` = the principal's primary email)
- Test: `apps/console/src/pages/MailboxSignInDonePage.test.tsx`, plus a route test for `signin-links`

- [ ] **Steps:**
  - Failing tests: the done page renders a distinct message per `result`. `admin_blocked` names "ask your Google Workspace admin to mark Curia's app as Trusted". `restart=1` shows "Curia is restarting to start using this mailbox" and polls `/api/health` until it answers.
  - The button is disabled with the readiness reason when sign-in isn't ready.
  - Implement. Tests pass, then the console build.
  - Commit `feat(console): connect mailboxes with Google sign-in (#2361)`.

### Task 8: Reconnect offers from the health canary

**Files:**
- Modify:
  - `src/health/health-service.ts:559` (auth-failure detail text)
  - `src/health/mailbox-outage-notifier.ts:57` (include a 7-day reconnect link)
  - `src/index.ts` (pass `MailboxSignInService` to the notifier)
- Test: extend `tests/unit/health/mailbox-outage-notifier.test.ts` and `health-service.test.ts`

- [ ] **Steps:**
  - Failing tests:
    - an auth failure on principal mailbox `work` makes the notification contain a `/api/mailbox-signin/start/` URL minted with `target:'principal'`, `expectedEmail` = that mailbox's address, `ttlMinutes: 10080`;
    - a non-auth failure contains no link;
    - when sign-in isn't ready, the message keeps today's grant-paste text.
  - The canary detail says "reconnect it from Settings → Email & Calendar".
  - Implement. Tests pass.
  - Commit `feat(health): offer a reconnect link when a principal grant fails (#2361)`.

### Task 9: Docs, catalog and changelog

**Files:**
- Modify (curia):
  - `docs/wip/2026-10-29-onboarding-journey-design.md` *1b*: the client id is derived; the grant goes to the registries; the event is renamed
  - `docs/dev/google-drive.md:65`: Testing → In production
  - `docs/specs/` email/channel spec if it names the grant-id flow (grep `grant ID`)
- Create (curia): `changes/<branch>.md`. The **Added** section gets mailbox sign-in, Nylas setup from the API key and the region. The **Changed** section calls out the two new bus events as public API.
- curia-docs: a separate worktree `curia-docs-2361-mailbox-signin`, with a PR paired to the curia PR.
  - Rewrite `get-started/curia-email.mdx`, `get-started/principal-email-calendar.mdx` and `channels/email-setup.mdx` around the click-through:
    - the Nylas app (non-Sandbox) and API key;
    - the region;
    - the GCP project, **Web** client and Nylas redirect;
    - copying the secret at once;
    - Internal vs External/In production, never Testing;
    - Workspace pre-trust steps;
    - the findings, as a "Why unverified is OK" note.
  - New `onboarding/connecting-your-email.mdx` (principal-facing), with:
    - what delegated access means;
    - what Curia will and won't do;
    - what to expect (labelling/archiving and where mail goes, unsent drafts, calendar holds and what asks first), matching #2360;
    - the unverified screen;
    - consent possibly shown twice; keep both boxes ticked;
    - a password change means reconnecting.

    Add it to `docs.json` nav.

- [ ] **Steps:**
  - Write the docs. Run `pnpm -C <wt> vitest run tests/unit/changelog-fragments.test.ts` → PASS.
  - Run the curia-docs link check, if present (`mint broken-links`).
  - Commit in each repo.

### Task 10: The real run (maintainer, after merge to a test install)

- [ ] Follow the new guide end to end on a real Google account (R1, R7, R8 with Gmail scopes) and record the result on #2361. The Workspace item is met at the first real Workspace sign-in (issue AC).
