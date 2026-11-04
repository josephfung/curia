# Structured secrets (saved cards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save credit cards as schema-tagged secrets, fill any card field into text boxes and dropdowns server-side after a per-checkout principal confirmation, and manage cards on the redesigned Secrets page (#1358, ADR-027).

**Architecture:** The card number and CVV are stored encrypted in `secrets`. Brand, last four, expiry and name are stored in plain text on `user_secret_details`. `resolveSecretRef` gains `#field` addressing gated by a schema registry. Every card resolve checks a card-use grant. A grant is written only by the approval-only `card-use-confirm` replay that the existing approval flow runs. The browser, capture and console surfaces build on those pieces.

**Tech Stack:** TypeScript (ESM, Node 26), PostgreSQL 16 + node-pg-migrate (plain SQL), Vitest (real Postgres for integration), React (apps/console), Patchright/Chromium.

**Spec:** `docs/wip/2026-11-04-structured-secrets-design.md` (read it first; this plan argues from it).

## Global Constraints

- Stack every PR on `secrets-page-redesign` (PR #2478). Branch: `structured-secrets-1358`. PR 1 = Tasks 1–7, PR 2 = Tasks 8–12, PR 3 = Tasks 13–15.
- A card number or CVV must never appear in any API response, DOM node, log line, audit payload, tool result, screenshot, approval message or LLM call.
- Viewing or listing a card never calls `SecretsService.get` / `getJSON`.
- Grant: one card × top-level registrable domain × conversation; valid 30 minutes after approval; `number` and `cvv` at most **2** fills each; public fields unlimited.
- A card-use approval expires **30 minutes** after it is filed.
- Projection month names: `Intl.DateTimeFormat('en-US', { month: 'long' | 'short', timeZone: 'UTC' })` over `Date.UTC(2000, month - 1, 1)`.
- Card validation:
  - PAN: 12–19 digits after stripping spaces and dashes, and it must pass Luhn.
  - CVV: 3 digits, or 4 for `amex`.
  - Month: `01`–`12`, stored zero-padded. Year: 4 digits.
  - Reject an expiry before the current UTC month.
  - `cardholder_name` required, at most 100 characters. `billing_zip` optional, at most 12 characters, letters, digits, spaces and dashes only.
- Brand IINs:
  - `visa`: 4
  - `mastercard`: 51–55 and 2221–2720
  - `amex`: 34 and 37
  - `discover`: 6011, 644–649 and 65
  - anything else: `other`
- Card key naming: `resolveUserSecretName(description)`, where the description is `"<label> <brand> card"`. Add `card: 'card'` / `cards: 'card'` to `TYPE_CANONICAL` (priority after `pin`).
- Tool versions:
  - `web-browser` 1.11.0 → 1.12.0
  - `list-user-secrets` 0.2.0 → 0.3.0
  - `secret-capture-request` 0.4.0 → 0.5.0
  - new `card-use-request` and `card-use-confirm` start at 0.1.0
- Migrations: 118 (PR 1), 119 (PR 2). Before every push, run `ls src/db/migrations | sort` and check every prefix is unique.
- New ADR: next free number (expected 059); check `ls docs/adr` and open branches first. Add a row to `docs/adr/README.md`.
- Commit with `git commit -s`, and no `Co-Authored-By` trailer. Run `pnpm -C <worktree> run typecheck` before every commit touching `.ts`.
- CHANGELOG: one bullet per logical change, ≤15 words after the em-dash, public-API changes called out.
- No behavior-suite runs (`pnpm smoke` / `pnpm scenarios`) without the maintainer's OK and a cost estimate. Writing scenario cases is fine.

## Review Focus

1. **A card ref arriving through `actions[]` batch steps, not the top-level input.** The card-use gate and screenshot suppression must apply per step, exactly as for a top-level `type`. Test: Task 8, `batch select step with secret_ref is gated and suppresses the screenshot`.
2. **The page navigates between approval and fill**, for example a checkout that moves from `aircanada.com` to `pay.aircanada.com` or to a third-party `checkout.example-pay.com` top-level page. The grant is per registrable domain, so a subdomain passes and a different top-level site is refused with a message telling the agent to request a new confirmation. Test: Task 4, `grant matches subdomain of approved site, refuses other top-level site`.
3. **The principal answers after 30 minutes, or answers twice** (👍 then "approve 3"). A late approval writes no grant and tells the agent the confirmation expired. A second answer on an already-resolved row does nothing. Test: Task 5, `late approval writes no grant` and `second approval is a no-op`.
4. **A card whose expiry passes while it's saved.** It lists as Expired, it still resolves (the site decides), and the agent is told to offer a renewal. Test: Task 9, `expired card is listed with expired: true and renewal hint`.
5. **Pre-existing untagged JSON `user.*` secrets in prod** (capture links with `value_format: 'json'`). Bare refs behave exactly as today, the console still shows them as "Structured value", and `#` on them is refused. Test: Task 4, `untagged json secret: bare ref unchanged, # refused`.

---

## PR 1 — Core

### Task 1: Card schema registry (pure)

**Files:**
- Create: `src/secrets/structured-secret-schema.ts`
- Test: `tests/unit/secrets/structured-secret-schema.test.ts`

**Interfaces:**
- Produces:
  - `type StructuredSchemaTag = 'credit_card'`
  - `type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'other'`
  - `interface CreditCardSecretDoc { _schema: 'credit_card'; number: string; cvv: string }`
  - `interface CreditCardPublicFields { brand: CardBrand; last4: string; expiry_month: string; expiry_year: string; cardholder_name: string; billing_zip?: string }`
  - `interface CreditCardInput { number: unknown; cvv: unknown; expiry_month: unknown; expiry_year: unknown; cardholder_name: unknown; billing_zip?: unknown }`
  - `type CardValidationReason = 'number_format' | 'number_checksum' | 'cvv_format' | 'expiry_format' | 'expired' | 'cardholder_missing' | 'billing_zip_format'`
  - `const CARD_VALIDATION_MESSAGES: Record<CardValidationReason, string>`. These are user-facing copy, e.g. `number_checksum` → "That card number doesn't look right. Check it and try again." and `expired` → "This card has expired."
  - `validateCreditCard(input: CreditCardInput, now?: Date): { ok: true; secret: CreditCardSecretDoc; publicFields: CreditCardPublicFields } | { ok: false; reason: CardValidationReason }`
  - `validateCardPublicPatch(patch: { expiry_month?: unknown; expiry_year?: unknown; cardholder_name?: unknown; billing_zip?: unknown }, current: CreditCardPublicFields, now?: Date): { ok: true; publicFields: CreditCardPublicFields } | { ok: false; reason: CardValidationReason }`. `billing_zip: null` clears it. Month and year are validated as a pair against `current`.
  - `validateCvv(cvv: unknown, brand: CardBrand): boolean`
  - `detectCardBrand(digits: string): CardBrand`
  - `isCardExpired(pub: CreditCardPublicFields, now?: Date): boolean`
  - `const CARD_FIELDS: readonly string[]` (the 15 ADR-027 projections, in ADR order)
  - `const CARD_SECRET_FIELDS: readonly ['number', 'cvv']`
  - `isCardSecretField(field: string): field is 'number' | 'cvv'`
  - `projectCardField(field: string, pub: CreditCardPublicFields, secret: CreditCardSecretDoc | null): string`. It throws `Error("Unknown card field '<f>'. Fields: …")`, and throws if a secret field is asked with `secret === null`.
  - `parseSecretRef(ref: string): { name: string; field: string | null }`. It throws when there is more than one `#` or an empty field.
  - `isStructuredSchemaTag(v: unknown): v is StructuredSchemaTag`
  - `describeCard(pub: CreditCardPublicFields, label: string | null): string`, e.g. `"Visa ••1111 (Personal)"` or `"Amex ••0005"`

- [ ] **Step 1: Write the failing tests**

```ts
describe('validateCreditCard', () => {
  const now = new Date(Date.UTC(2026, 10, 4));
  const ok = { number: '4111 1111 1111 1111', cvv: '123', expiry_month: '3', expiry_year: '2028', cardholder_name: 'Pat Doe' };
  it('accepts a valid card and splits secret from public fields', () => {
    expect(validateCreditCard(ok, now)).toEqual({ ok: true,
      secret: { _schema: 'credit_card', number: '4111111111111111', cvv: '123' },
      publicFields: { brand: 'visa', last4: '1111', expiry_month: '03', expiry_year: '2028', cardholder_name: 'Pat Doe' } });
  });
  it('rejects a Luhn failure', () => expect(validateCreditCard({ ...ok, number: '4111111111111112' }, now)).toEqual({ ok: false, reason: 'number_checksum' }));
  it('rejects last month, accepts this month', () => {
    expect(validateCreditCard({ ...ok, expiry_month: '10', expiry_year: '2026' }, now)).toEqual({ ok: false, reason: 'expired' });
    expect(validateCreditCard({ ...ok, expiry_month: '11', expiry_year: '2026' }, now).ok).toBe(true);
  });
  it('needs a 4-digit CVV for amex', () => expect(validateCreditCard({ ...ok, number: '378282246310005', cvv: '123' }, now)).toEqual({ ok: false, reason: 'cvv_format' }));
});
describe('projectCardField', () => {
  const pub = { brand: 'visa', last4: '1111', expiry_month: '12', expiry_year: '2027', cardholder_name: 'Pat Doe' } as const;
  it.each([['expiry_mm','12'],['expiry_m','12'],['expiry_yy','27'],['expiry_yyyy','2027'],['expiry_mm_yy','12/27'],
    ['expiry_mm_yyyy','12/2027'],['expiry_month_name','December'],['expiry_month_short','Dec']])('%s → %s', (f, v) =>
    expect(projectCardField(f, pub, null)).toBe(v));
  it('expiry_m is unpadded', () => expect(projectCardField('expiry_m', { ...pub, expiry_month: '03' }, null)).toBe('3'));
  it('month name ignores ambient locale', () => { /* run with process.env.LANG='fr_FR.UTF-8' and Intl default stubbed; expect 'December' */ });
  it('secret field without secret doc throws', () => expect(() => projectCardField('number', pub, null)).toThrow());
  it('unknown field lists fields', () => expect(() => projectCardField('pin', pub, null)).toThrow(/Fields: number, cvv/));
});
describe('parseSecretRef', () => {
  it('splits', () => expect(parseSecretRef('user.visa_card#cvv')).toEqual({ name: 'user.visa_card', field: 'cvv' }));
  it('no field', () => expect(parseSecretRef('user.x')).toEqual({ name: 'user.x', field: null }));
  it('two #', () => expect(() => parseSecretRef('user.x#a#b')).toThrow());
});
it.each([['4111111111111111','visa'],['5555555555554444','mastercard'],['2223003122003222','mastercard'],
  ['378282246310005','amex'],['6011111111111117','discover'],['3530111333300000','other']])('brand %s', (n, b) =>
  expect(detectCardBrand(n)).toBe(b));
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/secrets/structured-secret-schema.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the module per the Interfaces block and the Global Constraints values.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(secrets): credit card schema registry and projections (#1358)`.

### Task 2: Storage — migration 118 and `SecretsService` card methods

**Files:**
- Create: `src/db/migrations/118_structured_secrets_and_card_use.sql`
- Modify: `src/secrets/secrets-service.ts`, `src/secrets/user-secret-details.ts`, `src/secrets/user-secret-name.ts` (`card` type token)
- Test: `tests/integration/secrets-service.test.ts`, `tests/unit/secrets/user-secret-name.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - Migration 118, which:
    - adds to `user_secret_details`: `schema TEXT CHECK (schema IN ('credit_card'))`, `label TEXT`, `public_fields JSONB`, with CHECK `(schema IS NULL) = (public_fields IS NULL)`;
    - creates `card_use_requests`:
      - `id UUID PK DEFAULT gen_random_uuid()`, `secret_name TEXT NOT NULL CHECK (starts_with(secret_name,'user.'))`
      - `site_domain TEXT NOT NULL`, `conversation_id TEXT NOT NULL`, `task_id TEXT NOT NULL`
      - `amount TEXT NOT NULL`, `purpose TEXT NOT NULL`, `origin JSONB NOT NULL`
      - `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired'))`
      - `approval_short_ref TEXT`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `approved_at TIMESTAMPTZ`
      - `number_fills INT NOT NULL DEFAULT 0`, `cvv_fills INT NOT NULL DEFAULT 0`
      - index on `(secret_name, conversation_id, approved_at DESC) WHERE status='approved'`
    - has a Down section.
  - `UserSecretDetails` gains `schema?: StructuredSchemaTag; label?: string; publicFields?: CreditCardPublicFields`. `listUserDetails()` returns them.
  - `SecretsService.setCard(name: string, secret: CreditCardSecretDoc, publicFields: CreditCardPublicFields, label: string | null): Promise<void>`: one transaction; upsert `secrets` (json) and upsert the details row, preserving `login_url`/`username`.
  - `SecretsService.getCardPublic(name: string): Promise<{ label: string | null; publicFields: CreditCardPublicFields } | null>`: reads details only.
  - `SecretsService.getStructuredSchema(name: string): Promise<StructuredSchemaTag | null>`: reads details only.
  - `SecretsService.patchCardPublic(name: string, patch: { label?: string | null; publicFields?: CreditCardPublicFields }): Promise<void>`: never writes `secrets`.
  - `SecretsService.replaceCardSecret(name: string, change: { cvv: string } | { secret: CreditCardSecretDoc; publicFields: CreditCardPublicFields }): Promise<void>`: one transaction. The CVV-only form reads the doc with `getJSON`, checks `_schema`, sets `cvv` and writes it back.
  - `getCardSecret(name: string): Promise<CreditCardSecretDoc>` (resolver use only). It throws unless the doc's `_schema === 'credit_card'`.

- [ ] **Step 1: Failing tests** (integration, real Postgres):
  - `setCard writes both halves`. Assert `getCardPublic` equals the input, `getCardSecret` returns the doc, and `get(name)` holds no `expiry` text.
  - `setCard is atomic`. Make the details upsert fail (e.g. a name violating the details CHECK via a spy that throws), then assert no `secrets` row exists.
  - `patchCardPublic leaves secrets.updated_at unchanged`.
  - `replaceCardSecret cvv keeps number`.
  - `getCardPublic does not decrypt`. Spy `get`/`getJSON`: 0 calls.
- [ ] **Step 2: Failing unit test:** `resolveUserSecretName('personal visa card') === 'user.personal_visa_card'` and `'work visa card'` → `user.work_visa_card`. With `user.personal_visa_card` existing, `'Personal Visa'` + `card` stays distinct from `'work visa card'`.
- [ ] **Step 3: Run** `pnpm vitest run tests/integration/secrets-service.test.ts tests/unit/secrets/user-secret-name.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the migration, service methods and token. Verify migration prefixes are unique.
- [ ] **Step 5: Run.** Expected: PASS. Then run typecheck.
- [ ] **Step 6: Commit** `feat(vault): store cards as encrypted number/CVV plus public fields (#1358)`.

### Task 3: Card-use requests and grants

**Files:**
- Create: `src/secrets/card-use-repo.ts`
- Test: `tests/integration/card-use-repo.test.ts`

**Interfaces:**
- Consumes: the migration-118 table; `registrableDomain` from `src/verification/domain.ts`; `CaptureOrigin` from `src/secrets/secret-capture-service.ts`.
- Produces `class CardUseRepo` (constructor `(pool: Pool)`):
  - `create(r: { secretName: string; siteUrl: string; conversationId: string; taskId: string; amount: string; purpose: string; origin: CaptureOrigin }): Promise<{ id: string; siteDomain: string }>`. It throws when `registrableDomain(siteUrl)` is null.
  - `setShortRef(id: string, shortRef: string): Promise<void>`
  - `get(id: string): Promise<CardUseRequestRow | null>`
  - `approve(id: string): Promise<'approved' | 'expired' | 'already_resolved'>`. It runs `pending` → `approved` only if `created_at > now() - interval '30 minutes'`. Otherwise a pending row becomes `expired`.
  - `decide(id: string, status: 'denied' | 'expired'): Promise<boolean>` (pending only)
  - `consumeFill(q: { secretName: string; siteUrl: string; conversationId: string; field: 'number' | 'cvv' | null }): Promise<'ok' | 'no_grant' | 'fill_limit'>`. It takes the newest approved row matching `secret_name`, `conversation_id`, `site_domain = registrableDomain(siteUrl)` and `approved_at > now() - interval '30 minutes'`. For `number`/`cvv` it runs `UPDATE … SET <f>_fills = <f>_fills + 1 WHERE id=$1 AND <f>_fills < 2 RETURNING id`; `null` (a public field) only checks the row exists.
  - `interface CardUseRequestRow { id; secretName; siteDomain; conversationId; taskId; amount; purpose; origin: CaptureOrigin; status; approvalShortRef: string | null; createdAt: Date; approvedAt: Date | null }`

- [ ] **Step 1: Failing tests:**
  - `grant matches subdomain of approved site, refuses other top-level site` (approve on `https://www.aircanada.com/checkout`; `consumeFill` with `https://pay.aircanada.com/x` → `ok`; with `https://checkout.example-pay.com` → `no_grant`)
  - `third number fill is refused` (`ok`, `ok`, `fill_limit`); public-field fills are unlimited
  - `grant older than 30 minutes is refused` (back-date `approved_at` via SQL)
  - `approve after 30 minutes expires the row` (back-date `created_at`) → `'expired'`
  - `second approve is already_resolved`
  - `other conversation has no grant`
  - `concurrent number fills never exceed 2` (run `Promise.all` of 5 → exactly 2 `ok`)
- [ ] **Step 2: Run** `pnpm vitest run tests/integration/card-use-repo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(secrets): card-use requests with time- and fill-bounded grants (#1358)`.

### Task 4: Resolver — `#field`, bare-card refusal, grant check, `secretField` audit

**Files:**
- Modify: `src/skills/execution.ts` (the `secretResolver` branch, ~L2853–2897; constructor deps for `cardUseRepo`)
- Modify: `src/skills/types.ts:368` (signature), `src/bus/events.ts:971` (`SecretAccessedPayload.secretField?: string`), `src/audit/field-extraction.ts` (`secret.accessed` keeps `target_id = secretName`; add `secretField` to the extracted detail if the extractor records extras)
- Modify: `src/index.ts` (pass `CardUseRepo` into the execution layer)
- Test: `tests/unit/skills/execution-secret-resolver.test.ts` (create, or extend the existing resolver tests; find them with `grep -rl resolveSecretRef tests`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `ToolContext.resolveSecretRef?: (ref: string, opts?: { siteUrl?: string }) => Promise<string>` (public API change)
  - Exported error copy, as constants in `src/secrets/structured-secret-schema.ts` for reuse by Tasks 8 and 9:
    - `BARE_CARD_REF_ERROR(name)`: "`<name>` is a saved card. Address one field, e.g. `<name>#number`. Fields: …"
    - `CARD_USE_REQUIRED_ERROR(name, domain)`: "Using `<name>` on <domain> needs the principal's confirmation for this checkout. Call card-use-request with the amount and purpose, wait for the approval, then fill again."
    - `CARD_FILL_LIMIT_ERROR`: "This confirmation's card-number and CVV fills are used up. Ask the principal again with card-use-request for another checkout."

Resolver order (replacing L2863–2897 behavior; keep the existing guard, the not-configured throw and the audit and logging style):
1. Run the `user.*` guard on the whole ref.
2. `parseSecretRef`.
3. `schema = await secretsService.getStructuredSchema(name)`.
4. If `field === null`: when `schema` is set, throw `BARE_CARD_REF_ERROR`; otherwise do exactly today's `get()` path.
5. If `field !== null` and `schema !== 'credit_card'`: throw "`#` field addressing works only on saved cards; `<name>` isn't one".
6. Without `opts.siteUrl`: throw "card fields can only be filled into a web page".
7. Run `cardUseRepo.consumeFill({ secretName: name, siteUrl, conversationId: options.conversationId, field: isCardSecretField(field) ? field : null })`. `no_grant` → `CARD_USE_REQUIRED_ERROR`; `fill_limit` → `CARD_FILL_LIMIT_ERROR`. A missing `conversationId` → `no_grant`.
8. Read the public fields; for a secret field also call `getCardSecret`. Then `projectCardField`.
9. Publish `secret.accessed` with `secretName: name` and `secretField: field`.

The check runs on every path, including `humanApproved` and principal-originated tasks; it lives in the closure, not in the gates.

- [ ] **Step 1: Failing tests** (unit, with a fake `SecretsService` and a fake `CardUseRepo`):
  - `bare ref to a card is refused with field list`
  - `untagged json secret: bare ref unchanged, # refused`
  - `string secret: bare ref unchanged (returns get() value), # refused`
  - `channel.x#number refused by namespace guard`
  - `public field resolves with grant and makes no decrypt call` (`#expiry_month_name` → "December"; spies on `get`/`getJSON`/`getCardSecret` see 0 calls)
  - `secret field resolves with grant`
  - `no grant → CARD_USE_REQUIRED_ERROR`, including when `options.humanApproved` is true and when task metadata is principal-originated
  - `fill_limit → CARD_FILL_LIMIT_ERROR`
  - `no siteUrl → refused`
  - `emits exactly one secret.accessed with secretField and no value` (assert `JSON.stringify(payload)` contains neither `4111` nor `123`)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the resolver tests plus `pnpm vitest run tests/unit/audit/field-extraction.test.ts`. Expected: PASS. Then run typecheck.
- [ ] **Step 5: Commit** `feat(execution): gated #field resolution for saved cards (#1358)`.

### Task 5: `card-use-request` and `card-use-confirm` tools, and approval-path rules

**Files:**
- Create: `skills/web/tools/card-use-request/{tool.json,handler.ts,handler.test.ts}`, `skills/web/tools/card-use-confirm/{tool.json,handler.ts,handler.test.ts}`; list both in `skills/web/SKILL.md`
- Modify: `src/skills/loader.ts` / `src/skills/types.ts` (new capability `cardUse` in the capability list at loader L51, injecting `ctx.cardUse`)
- Modify: `src/skills/execution.ts` (inject `cardUse`; forward a new invoke option `approvalVia`)
- Modify: `src/autonomy/approval-trigger.ts` (`request()` accepts `expiresInMs?: number`; default unchanged)
- Modify: `skills/autonomy/tools/approve-action/handler.ts`, `src/autonomy/reaction-approval-mapper.ts`, `src/dashboard/console-approval.ts`, `skills/autonomy/tools/dismiss-action/handler.ts`, `src/autonomy/approval-expiry-sweep.ts`
- Test: the handler tests beside each tool, plus the existing tests for those four files

**Interfaces:**
- Consumes: Task 3 `CardUseRepo`, Task 1 `describeCard`, `buildCaptureOrigin(ctx, intent)` from the capture tools, and `ApprovalTriggerService.request`.
- Produces:
  - `class CardUseService` in `src/secrets/card-use-service.ts` (create), wrapping `CardUseRepo`, `SecretsService.getCardPublic`, `ApprovalTriggerService` and the bus:
    - `request(input: { secretName: string; siteUrl: string; amount: string; purpose: string }, ctx: { taskEventId: string; conversationId: string; origin: CaptureOrigin }): Promise<{ shortRef: string; approvalNumber: number; expiresAt: Date; card: string }>`. Publishes `card_use.requested`.
    - `confirm(requestId: string, via: ApprovalVia, approvingConversationId?: string): Promise<CardUseConfirmResult>`
    - `decline(requestId: string, status?: 'denied' | 'expired'): Promise<void>` (default `'denied'`). Publishes `card_use.decided` with `resume: true` when the row was pending.
  - `ctx.cardUse` exposes `request` and `confirm`. The approval paths and the sweep call `decline` on the service directly.
  - `type ApprovalVia = 'coordinator' | 'reaction' | 'console'`. `ExecutionLayer.invoke` options gain `approvalVia?: ApprovalVia`; `ToolContext` gains `approvalVia?: ApprovalVia`. Set by approve-action (`'coordinator'`), the reaction mapper (`'reaction'`) and console approval (`'console'`).
  - `card-use-request` manifest:
    - `action_risk: "low"`, `allowed_callers: ["coordinator"]`, `capabilities: ["cardUse"]`
    - inputs in this order: `secret_name`, `site_url`, `amount`, `purpose`
    - outputs: `approval_ref`, `approval_number`, `expires_at` (local ISO via `toLocalIso`), `card` (`describeCard`)
    - its description tells the agent to call `deliver-approval` next, then wait.
  - `card-use-request` behavior:
    - `secret_name` must be a stored card, else error.
    - `site_url` is the checkout page's top-level URL.
    - `create`, then `approvalTrigger.request({ toolName: 'card-use-confirm', input: { request_id }, displayInput: { card, site, amount, purpose }, actionRisk: 'critical', reason, expiresInMs: 30 * 60_000, taskId: ctx.taskEventId, conversationId: ctx.conversationId })`, then `setShortRef`.
    - `reason` copy, exactly: `Curia wants to pay ${amount} at ${siteDomain} with ${describeCard(...)} for: ${purpose}. The amount is what Curia read on the page.`
  - `card-use-confirm` manifest: `action_risk: "critical"`, `capabilities: ["cardUse"]`, and a description saying it runs only when the principal approves a card-use request. Pin it to no agent.
  - `card-use-confirm` handler: refuse unless `ctx.humanApproved === true`. Then call `ctx.cardUse.confirm(input.request_id, ctx.approvalVia, ctx.conversationId)`.
  - `CardUseConfirmResult = { outcome: 'approved' | 'expired' | 'already_resolved'; resumed: boolean; message: string }`. On `approved`:
    - via `'coordinator'` with `approvingConversationId === row.conversationId`: no resume; `message` = "Approved. Continue the checkout now in the same browser session."
    - otherwise: publish `card_use.decided` (Task 6) with `resume: true`.
  - **approve-action rules** (before `resolveRow`), for `row.toolName === 'card-use-confirm'`:
    - refuse when `row.notificationSentAt === null`, reusing the `UNSHOWN_PERSONAL_DETAILS_ERROR` pattern with new copy "This card confirmation hasn't reached the principal yet; deliver it first.";
    - refuse when `row.taskId === ctx.taskEventId`, with "The principal has to answer this confirmation themselves, in a later message."
  - **Deny and dismiss:** the reaction-mapper deny path, console deny and `dismiss-action` call `cardUseService.decline(requestId)` when `row.toolName === 'card-use-confirm'`. It sets the row to `denied` and publishes `card_use.decided` with `decision: 'denied', resume: true`. The approval-expiry sweep calls `cardUseService.decline(requestId, 'expired')` for expired card-use rows.

- [ ] **Step 1: Failing tests:**
  - `card-use-request on a non-card key errors`
  - `card-use-request files a 30-minute critical approval for card-use-confirm whose display has no number` (stub trigger; assert `expiresInMs`, `toolName`, and that the display JSON contains `••1111` but not `4111111111111111`)
  - `card-use-confirm refuses without humanApproved`
  - `approve via coordinator in originating conversation: grant, no resume`
  - `approve via reaction: grant and card_use.decided resume published`
  - `late approval writes no grant` (repo `approve` → `'expired'`; result tells the agent it expired; resume published with `decision: 'expired'`)
  - `second approval is a no-op` (`already_resolved`, no publish)
  - approve-action: `refuses undelivered card-use row` and `refuses approval in the requesting turn`
  - dismiss/deny: `declines the card-use request and resumes`
- [ ] **Step 2: Run** the new handler tests plus `pnpm vitest run skills/autonomy tests/unit/autonomy tests/unit/dashboard`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same set. Expected: all PASS (existing approval tests still green). Then run typecheck.
- [ ] **Step 5: Commit** `feat(web): card-use confirmation through the approval flow (#1358)`.

### Task 6: `card_use.*` events and resume subscriber

**Files:**
- Modify: `src/bus/events.ts` (`card_use.requested`, `card_use.decided`, plus factories), `src/bus/permissions.ts` (execution layer publishes both; system subscribes), `src/audit/field-extraction.ts` (`target_type='secret'`, `target_id=secretName`, `action='card_use_requested' | 'card_use_decided'`)
- Create: `src/secrets/card-use-resume-subscriber.ts`, modeled on `src/secrets/secret-capture-resume-subscriber.ts` (same routing registration and dedup-before-publish)
- Modify: `src/index.ts` (wire it next to `SecretCaptureResumeSubscriber`, ~L3291)
- Test: `tests/unit/secrets/card-use-resume-subscriber.test.ts`, `tests/unit/audit/field-extraction.test.ts`

**Interfaces:**
- Produces:
  - `CardUseRequestedPayload { requestId; secretName; siteDomain; amount; brand; last4; label?: string }`
  - `CardUseDecidedPayload { requestId; secretName; siteDomain; decision: 'approved' | 'denied' | 'expired'; via?: ApprovalVia; resume: boolean; origin: CaptureOrigin; purpose: string }`
- The subscriber publishes on `resume: true` a synthetic `agent.task` to `origin`. The text is fixed copy:
  - approved: "The principal approved the card payment for <purpose> on <site>. Continue the checkout in the same browser session."
  - denied: "The principal declined the card payment for <purpose>. Don't fill the card; tell them you stopped."
  - expired: "The card confirmation for <purpose> expired without an answer. Ask again only if they still want it."

- [ ] **Step 1: Failing tests:** `resumes with approved copy`, `resumes with denied copy`, `skips when resume is false`, `dedups a redelivered event`, `payload never contains number or cvv` (type-level: `CardUseDecidedPayload` has no such field; runtime: a JSON snapshot), `extractor maps card_use.decided to target secret`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run typecheck.
- [ ] **Step 5: Commit** `feat(secrets): resume the checkout after a card-use decision (#1358)`.

### Task 7: ADRs and CHANGELOG for PR 1

**Files:**
- Modify: `docs/adr/027-structured-secret-subfield-addressing.md`. Add an "Amended 2026-11-04" section covering:
  - the storage split;
  - bare-ref refusal;
  - discovery via `list-user-secrets`;
  - capture via `secret-capture-request`;
  - the grant check;
  - and a pointer to the design.
- Create: `docs/adr/059-card-use-needs-per-checkout-confirmation.md` (template `docs/adr/template.md`). Its sections:
  - context: no "always ask" mechanism existed, and principal tasks skip the gates;
  - the decision: grants written only by the `card-use-confirm` approval replay; top-level site with any frame; 30 min / 2 fills;
  - the rejected alternatives: a manifest `approval: always` field; per-field approval; frame-origin matching;
  - the consequences: the accepted hostile-frame risk, and the amount is as reported by the agent.
- Modify: `docs/adr/README.md`, `CHANGELOG.md` (Unreleased → Added/Security). Bullets to include:
  - saved cards with gated `#field` addressing;
  - card-use confirmation;
  - `secret.accessed.secretField` (public API);
  - `card_use.*` events (public API);
  - `resolveSecretRef` `siteUrl` option (public API).

- [ ] **Step 1:** Write the ADRs and bullets (≤15 words each after the em-dash).
- [ ] **Step 2:** Run `pnpm -C . run typecheck && pnpm vitest run tests/unit` (the unit suite only). Expected: PASS.
- [ ] **Step 3: Commit** `docs: ADR-027 amendment and ADR-059 card-use confirmation (#1358)`. Open PR 1 against `secrets-page-redesign` with `Part of #1358` (not `Closes`).

---

## PR 2 — Agent surface

### Task 8: `web-browser` — `select` with `secret_ref`, `siteUrl` to the resolver, dropdown fill tests

**Files:**
- Modify: `skills/web/tools/web-browser/handler.ts`:
  - `type` path L884: pass `{ siteUrl: page.url() }`;
  - `select` L923–942: accept `secret_ref` XOR `value`;
  - when the resolver's error is a card-use refusal, return it as the action error unchanged.
- Modify: `skills/web/tools/web-browser/tool.json`: version 1.12.0. Description additions (keep them short):
  - `secret_ref` accepts `user.<card>#<field>`;
  - choose the projection that matches the control's option labels (`#expiry_month_name` for "December", `#expiry_month_short` for "Dec", `#expiry_mm` for "12", `#expiry_yyyy` for "2027");
  - a card needs `card-use-request` first.
- Test: `skills/web/tools/web-browser/handler.test.ts`, and create `tests/integration/web-browser-card-fill.test.ts`

**Interfaces:**
- Consumes: Task 4's `resolveSecretRef(ref, { siteUrl })` and the error constants.

The `select` + `secret_ref` path follows `type`'s order: resolve, `session.registerInjectedSecret`, `deps.markSecretInjected()`, then run the tracked-code guard on the resolved value (unchanged), then `selectOption`. Pass Playwright `selectOption` the string; it matches value or label.

- [ ] **Step 1: Failing unit tests** (handler.test.ts, mocked page):
  - `select rejects secret_ref with value`
  - `select with secret_ref registers the value for redaction and suppresses the screenshot`
  - `batch select step with secret_ref is gated and suppresses the screenshot`
  - `type passes the top-level page URL as siteUrl`
  - `card-use refusal surfaces as the action error`
- [ ] **Step 2: Failing integration test** `web-browser-card-fill.test.ts`.
  - Setup:
    - launch Chromium the way `src/browser/browser-service.ts` does, through Patchright;
    - serve fixture pages with `context.route('https://shop.example.test/**', …)`;
    - drive `WebBrowserHandler` with the real `BrowserService` and a stub `ctx.resolveSecretRef` backed by `projectCardField` over a fixed card (expiry 12/2027) that asserts `siteUrl` is `https://shop.example.test/...`.
  - Cases (one per fixture), each asserting the selected option's **value** and that the result JSON has no value:
    - `month select, full-name labels, opaque values` (`<option value="m12">December</option>`, via `#expiry_month_name` → selected value `m12`)
    - `month select, short-name labels` (`Dec`, via `#expiry_month_short`)
    - `month select, 01–12 labels` (via `#expiry_mm`)
    - `year select, 2027 labels with two-digit values` (`<option value="27">2027</option>`, via `#expiry_yyyy` → `27`)
    - `MM/YY text box` (via `#expiry_mm_yy` → input value `12/27`)
    - `separate MM and YYYY boxes`
    - `card number inside a cross-origin iframe on the page` (frame served from `https://js.pay.example.test`, filled via `type` with `#number`; the stub asserts `siteUrl` is the top-level shop URL)
  - If CI has no Chromium for integration tests, don't skip silently. Add the browser install to the CI job, or put the test in the job that already has one; check `.github/workflows/*.yml` first.
- [ ] **Step 3: Run** `pnpm vitest run skills/web/tools/web-browser tests/integration/web-browser-card-fill.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run.** Expected: PASS. Then run typecheck.
- [ ] **Step 6: Commit** `feat(web-browser): fill saved-card fields into selects and text boxes (#1358)`.

### Task 9: `list-user-secrets` — card output and selection rule

**Files:**
- Modify: `skills/list-user-secrets/handler.ts`, `tool.json` (0.3.0); `src/skills/types.ts:368-376` (`listUserSecretDetails` returns the extended `UserSecretDetails`)
- Test: `skills/list-user-secrets/handler.test.ts`

**Interfaces:**
- Produces: `data.cards: Record<key, { label?: string; brand: CardBrand; last4: string; expiry: 'MM/YYYY'; expired: boolean }>`. Card keys are still in `keys`, and `data.card_fields: CARD_FIELDS` appears once.

Summary text added when at least one card exists (fixed copy):

> Saved cards are listed under `cards`. Match the principal's words to a card's label and brand ("personal Visa", "the Amex"). Exactly one match: use it. None or several: ask which card, naming each by label, brand and last four — never choose between plausible cards yourself. An expired card: tell the principal and offer a renewal link (secret-capture-request with template `credit_card_renewal`). To pay: card-use-request first, then fill fields with web-browser `secret_ref: "<key>#<field>"`.

- [ ] **Step 1: Failing tests:**
  - `lists cards with label, brand, last4, expiry, expired`
  - `expired card is listed with expired: true and renewal hint`
  - `no card → no card copy in summary`
  - `never calls a value read` (no such capability present)
  - `result JSON has no 12+ digit run`
- [ ] **Step 2: Run** `pnpm vitest run skills/list-user-secrets`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(list-user-secrets): describe saved cards for selection (#1358)`.

### Task 10: Capture — templates, card `details_only`, migration 119, route

**Files:**
- Create: `src/db/migrations/119_secret_capture_template.sql`. It adds `capture_template TEXT CHECK (capture_template IN ('credit_card','credit_card_renewal'))` to `secret_capture_tokens`.
- Modify:
  - `src/secrets/secret-capture-service.ts`:
    - `mintUserSecret` takes `template?`;
    - `RedeemStatus` adds `'invalid_shape'`, and `RedeemOutcome` carries `reason?: CardValidationReason`;
    - add `redeemCard(rawToken, card: Record<string, unknown>)`;
    - `setUserCardPublic`.
  - `src/channels/http/routes/secret-capture.ts`: GET returns `capture_template`, plus `card: { brand, last4, label }` for a renewal; POST accepts `{ card }` when the token has a template.
  - `skills/secret-capture-request/{handler.ts,tool.json}` (0.5.0)
- Test: `tests/integration/secret-capture-service.test.ts` (or the existing capture integration test file), `tests/unit/channels/http/routes/secret-capture.test.ts`, `skills/secret-capture-request/handler.test.ts`

**Interfaces:**
- Consumes: Task 1 `validateCreditCard`, `validateCardPublicPatch`, `validateCvv`; Task 2 `setCard`, `replaceCardSecret`, `patchCardPublic`, `getCardPublic`.
- Produces:
  - Tool inputs, appended after `details_only` in this order: `template?: 'credit_card' | 'credit_card_renewal'`, `card_label?`, `expiry_month?`, `expiry_year?`, `cardholder_name?`, `billing_zip?`.
  - `template: 'credit_card'`:
    - forces `valueFormat: 'json'`;
    - the name comes from `secret_name` as today (agents pass "personal visa card");
    - `card_label` is stored as the label at mint (or derived from `secret_name` minus brand/`card` tokens when absent; the builder picks the derivation and tests it).
  - `template: 'credit_card_renewal'`: requires `getCardPublic(secret_name)` non-null, else error "No saved card named …".
  - `details_only: true` on a card key with any card public field: validate with `validateCardPublicPatch`, then `patchCardPublic`; no link. Taking `number` or `cvv` as a tool input is impossible: those inputs don't exist.
  - `redeemCard(rawToken: string, card: Record<string, unknown>): Promise<RedeemOutcome>`:
    - validates **before** the atomic claim; failure → `{ status: 'invalid_shape', reason }`, token unspent;
    - `credit_card` → `setCard`;
    - renewal → validate expiry (`validateCardPublicPatch`) and CVV (`validateCvv` against the stored brand), then one transaction: `replaceCardSecret({ cvv })` + `patchCardPublic`.
  - The route maps `invalid_shape` → 400 `{ error: CARD_VALIDATION_MESSAGES[reason] }`.

- [ ] **Step 1: Failing tests:**
  - `credit_card token forces json`
  - `valid card redeems via setCard with _schema stamped`
  - `Luhn failure → invalid_shape, token re-redeemable` (redeem again with a valid card → ok)
  - `expired card → invalid_shape`
  - `concurrent valid redeems: exactly one ok`
  - `renewal keeps the number, updates expiry and cvv`
  - `renewal on a non-card key errors at mint`
  - `details_only updates card label and expiry with no link and no secrets.updated_at change`
  - `details_only past expiry is refused`
  - route: `GET exposes capture_template and renewal card summary`, `POST {card} on a string token → 400`
  - The pre-existing capture tests stay green.
- [ ] **Step 2: Run** these tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Verify migration prefixes are unique.
- [ ] **Step 4: Run.** Expected: PASS. Then run typecheck.
- [ ] **Step 5: Commit** `feat(capture): card and renewal capture links, card details_only (#1358)`.

### Task 11: Shared card form and capture page

**Files:**
- Create: `apps/console/src/components/CardFields.tsx`, `apps/console/src/pages/card-form-utils.ts`, `apps/console/src/pages/card-form-utils.test.ts`, `apps/console/src/components/CardFields.test.tsx`
- Modify: `apps/console/src/pages/SecretCapturePage.tsx`, `secret-capture-utils.ts`

**Interfaces:**
- Produces:
  - `type CardFormMode = 'full' | 'renewal' | 'edit-public'`
  - `interface CardFormState { label: string; number: string; expiryMonth: string; expiryYear: string; cvv: string; cardholderName: string; billingZip: string }`
  - `validateCardForm(state: CardFormState, mode: CardFormMode, now?: Date): Partial<Record<keyof CardFormState, string>>`. Client-side mirror of the server rules, for inline messages only; the server is the authority.
  - `buildCardPayload(state: CardFormState, mode: CardFormMode): Record<string, string>`. It produces `expiry_month` zero-padded and `expiry_year` 4-digit; strips spaces from `number`; omits fields the mode doesn't send.
  - `detectBrandForDisplay(number: string): string`
  - `<CardFields mode state onChange errors brandHint? />`. Month `<select>` options are "01 – January" … "12 – December". The year `<select>` runs from the current year to +15. `autoComplete`: `cc-number`, `cc-exp-month`, `cc-exp-year`, `cc-csc`, `cc-name`, `postal-code`. Number and CVV inputs use `inputMode="numeric"`, CVV `type="password"`.
- The capture page renders `CardFields` (`full`, or `renewal` with the "Visa ••1111" header) when GET returns `capture_template`, and POSTs `{ card: buildCardPayload(...) }`. It shows server `invalid_shape` messages, never touches localStorage or sessionStorage, and clears state on success.

- [ ] **Step 1: Failing tests:**
  - `buildCardPayload pads month and keeps 4-digit year`
  - `validateCardForm flags Luhn and past expiry`
  - `renewal mode sends only expiry and cvv`
  - `CardFields sets cc-* autocomplete`
  - `capture page posts {card} for a card template and clears on success`
  - `capture page never writes storage` (spy `Storage.prototype.setItem`)
  - `textarea still shown for a plain token`
- [ ] **Step 2: Run** `pnpm -C apps/console exec vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run typecheck.
- [ ] **Step 5: Commit** `feat(console): card capture form (#1358)`.

### Task 12: Disambiguation scenario case and PR 2 CHANGELOG

**Files:**
- Create: `tests/scenarios/cases/<next-number>a-card-pick-by-label-brand.yaml` and `…b-card-ambiguous-asks.yaml`. Copy the structure of `24a-signin-sms-code-over-signal.yaml`.
- Modify: `CHANGELOG.md`.

The cases:
- **Fixture:** three cards (Personal Visa ••1111, Work Visa ••4242, Amex ••0005) and a checkout page stub.
- **(a)** "Buy it with my personal Visa" → calls `card-use-request` with `user.personal_visa_card`, not the others.
- **(b)** "use my Visa" → asks which card, naming Personal and Work, and makes no `card-use-request`.

- [ ] **Step 1:** Write the cases. **Don't run them.** Ask the maintainer, with a cost estimate, before any run.
- [ ] **Step 2:** CHANGELOG bullets: `select` card fill; `list-user-secrets` cards; card capture links; tool version bumps.
- [ ] **Step 3: Commit** `test(scenarios): saved-card selection cases (#1358)`. Open PR 2, stacked on PR 1.

---

## PR 3 — Secrets page

### Task 13: Vault routes for cards

**Files:**
- Modify: `src/channels/http/routes/vault.ts`:
  - list rows ~L446;
  - `resolveConsoleName` L313;
  - `/preview` L621;
  - POST L641;
  - PATCH L685;
  - `/uses`.
- Modify: `src/secrets/user-secret-name.ts` (`consoleSecretNameInput` accepts `credit_card`: description `"<label> <brand> card"`, brand from the number)
- Modify: `src/secrets/secret-usage-repo.ts` (uses return `secretField` and card-use decisions)
- Test: `tests/unit/channels/http/routes/vault.test.ts`, `tests/integration/vault-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 6.
- Produces (console contract):
  - List row adds `card?: { label: string | null; brand: CardBrand; last4: string; expiry: string; expired: boolean }`. Status gains `'expired'` for expired cards (personal rows otherwise stay `configured`).
  - `POST /api/vault/user-secrets` and `/preview` accept `type: 'credit_card'` with `card: { label?, number, cvv, expiry_month, expiry_year, cardholder_name, billing_zip? }` (`/preview` takes `card` without `cvv`, and requires only `number` + `label` for naming). Validate → `setCard`. Replacing an existing card is allowed. Replacing an untagged JSON key is still refused with the existing 409. Validation failure → 400 with `CARD_VALIDATION_MESSAGES[reason]`.
  - `PATCH /api/vault/user-secrets/:name` on a card accepts:
    - `{ label?: string | null; expiry_month?; expiry_year?; cardholder_name?; billing_zip?: string | null }`, which goes to `patchCardPublic` (no vault write, `secret.changed` action `details`);
    - `cvv?`, which goes to `replaceCardSecret({ cvv })` (action `set`);
    - `replace?: { number, cvv, expiry_month, expiry_year, cardholder_name, billing_zip? }`, which goes to `replaceCardSecret({ secret, publicFields })` (action `set`).
    - `value` on a card → 409 "Use the card fields to change a saved card."
  - `GET /api/vault/secrets/:name/uses` items add `secretField?: string` and `kind: 'read' | 'card_use'`. `card_use` items carry `{ decision, siteDomain, amount }` from `card_use.decided` audit rows.
  - Duplicate-card detection is done client-side (Task 14) from `card.brand` + `card.last4`.

- [ ] **Step 1: Failing tests:**
  - `list returns card summary without decrypting` (spies)
  - `expired card status is expired`
  - `create card → setCard; response and audit payloads have no number or cvv` (assert `JSON.stringify` of body and published events lacks `4111111111111111` and `123`)
  - `create card validation failure → 400 with message`
  - `preview names user.personal_visa_card`
  - `patch label and expiry leaves secrets.updated_at unchanged and audits details`
  - `patch cvv keeps number`
  - `patch replace swaps the card`
  - `value on a card → 409`
  - `uses include secretField and card_use items`
  - `platform-key and allowlist guards unchanged` (the existing tests stay green)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run typecheck.
- [ ] **Step 5: Commit** `feat(vault): create, edit and list saved cards (#1358)`.

### Task 14: Secrets page — Card in list, Create, View and Edit

**Files:**
- Modify: `apps/console/src/pages/SecretsPage.tsx`, `SecretsDrawers.tsx` (the type control at L562–573, View L280, Edit around L339/L410), `secrets-utils.ts` (`SecretRowData.card`, status `'expired'`, search, duplicate-card hint, default sort: Missing and Expired first)
- Test: `apps/console/src/pages/SecretsDrawers.test.tsx`, `secrets-utils.test.ts`

**Interfaces:**
- Consumes: Task 11 `CardFields` and the helpers; Task 13 contract.

The behavior and copy follow design §8:
- **List:**
  - Used-for reads "Visa ••1111 · exp 12/2027", with the label as a sub-line.
  - There's an Expired chip in Status.
  - Duplicate-card hint: "⚠ same card as `user.x`".
  - Search matches label, brand and last four.
- **Create:** the "Card" option is enabled, with the "Coming soon" tooltip removed. Name preview and replace warning come from `/preview`.
- **View:** label, brand, last four, expiry with an Expired pill, cardholder name and postal code. Recent uses show "Filled `expiry_mm`" and "You approved CA$412.30 at aircanada.com".
- **Edit:** `CardFields` in `edit-public` mode, plus an optional "New CVV" field and a "Replace card" disclosure section that opens `full` mode.

- [ ] **Step 1: Failing tests:**
  - `card row shows brand, last four and expiry`
  - `expired chip filters expired cards`
  - `two cards with same brand+last4 both show duplicate hint`
  - `Card create posts card payload and shows preview name`
  - `view shows public fields only`
  - `edit public fields sends PATCH without cvv or number`
  - `new cvv sends cvv only`
  - `replace card sends replace object`
  - `no number or cvv in the DOM after save` (render, save, assert `container.innerHTML` lacks both)
- [ ] **Step 2: Run** `pnpm -C apps/console exec vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run typecheck.
- [ ] **Step 5: Commit** `feat(console): saved cards on the Secrets page (#1358)`.

### Task 15: Close-out

**Files:** `CHANGELOG.md`, `docs/dev/configuration.md` (Secrets section: cards), `docs/wip/2026-11-04-structured-secrets-design.md` (status line: implemented).

- [ ] **Step 1:** CHANGELOG bullet for the card management UI.
- [ ] **Step 2:** Run `pnpm -C . run typecheck && pnpm vitest run tests/unit && pnpm -C apps/console exec vitest run`. Expected: PASS. Run the integration tests touched in this plan individually on a fresh DB; the full local suite is flaky from shared-DB contention.
- [ ] **Step 3: Commit** `docs: saved cards configuration notes (#1358)`. Open PR 3 with `Closes #1358`.
