# Authority-aware PII — PR 1: redaction reporting, SIN, principal-bypass fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent learns when redaction changed a send; Canadian SINs are detected; PII no longer reaches a third party cc'd on a message to the principal.

**Architecture:** `OutboundGateway.send()` keeps the `RedactionEntry[]` it already gets from `PiiRedactor.redact()` and returns labels (plus the delivered body) on its result. A shared helper turns that into skill result data. The redactor's principal bypass keys on the gateway's existing "principal is the sole recipient" computation instead of the primary To contact's UUID. Both gating modes.

**Tech Stack:** TypeScript (ESM, Node 24), Vitest.

**Spec:** `docs/wip/2026-10-26-authority-aware-pii-design.md` (sections "Reporting to the agent", "Step 1.5 …" first bullet group, "Detection: Canadian SIN"). Issue #2312.

## Global Constraints

- Labels only, never PII values, in any result, log or event.
- No `any`; `.js` extensions on relative imports; no empty `catch {}`.
- `pnpm -C <worktree> run typecheck` and `pnpm -C <worktree> lint` before each commit; commit with `git commit -s`; **no** `Co-Authored-By` trailer.
- Bump `version` (minor) in each touched `tool.json`'s skill (`email-send`, `email-reply`, `signal-send`, `sms-send`, `slack-send`): new output field.
- CHANGELOG `## [Unreleased]` entries, 15 words max after the em-dash.

## Review Focus

1. A body *and* subject both redacted → both reported, `field` distinguishes them (Task 2 test).
2. A redacted send that is then durably **queued** (`queued: true`) or **deferred to digest** still reports redactions (Task 2 test).
3. Email "To: principal, CC: third party" with a phone number → redacted (Task 3 test); "To: principal" alone → not redacted (Task 3 test).
4. SIN detection must not fire inside UUIDs, 10+ digit runs, or Luhn-invalid 9-digit numbers (Task 1 tests).
5. A Signal **group** send (handler ~line 150) reports redactions too (Task 4 test).

---

### Task 1: Canadian SIN pattern

**Files:**
- Modify: `src/pii/scrubber.ts` (PiiPattern, `buildBuiltInPatterns`, `detectPii`, header comment that lists CANADIAN_SIN as excluded)
- Test: `tests/unit/pii/scrubber.test.ts`

**Interfaces:**
- Produces: `PiiPattern.validate?: (matched: string) => boolean`; built-in label `sin_ca`, scrub replacement `[SIN]`.

- [ ] **Step 1: Write failing tests** in a `describe('sin_ca')` block:
  - `'My SIN is 046 454 286'` (Luhn-valid but first digit 0) → **no** match.
  - `'130 692 544'` and `'130-692-544'` (Luhn-valid) → one `sin_ca` match each, `matched` equals the digits as written.
  - `'SIN: 130692544'` and `'social insurance number 130692544'` → one match whose `matched === '130692544'` (keyword excluded from span).
  - Bare `'130692544'` with no keyword → no match.
  - Luhn-invalid `'130 692 545'` → no match.
  - First digit 0 or 8 (`'830 692 544'` made Luhn-valid by the builder, and a 0-leading one) → no match.
  - Mixed separators `'130-692 544'` → no match.
  - Inside a UUID, inside `'1306925440'` (10 digits), inside an order id `'ORD-130-692-5441'` → no match.
  - `scrubPii('SIN 130 692 544')` → `'SIN [SIN]'`.
- [ ] **Step 2: Run** `pnpm -C <worktree> vitest run tests/unit/pii/scrubber.test.ts` → the new cases FAIL.
- [ ] **Step 3: Implement.** Add optional `validate` to `PiiPattern`; `detectPii` skips a match when `validate` returns false. Add one hand-written pattern after the openredaction entries (not extracted from the library):
  - regex (flags `gi`): `(?<!\d)[1-79]\d{2}([- ])\d{3}\1\d{3}(?!\d)|(?<=\b(?:SIN|social insurance(?: number| no\.?)?)\b[^\d\n]{0,12})[1-79]\d{8}(?!\d)`
  - `validate`: strip non-digits, require 9 digits, Luhn checksum.
  - Update the header comment: SIN is included, with checksum + format/keyword guard.
- [ ] **Step 4: Run** the scrubber tests and `tests/unit/dispatch/pii-redactor.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(pii): detect Canadian SINs with checksum validation (#2312)`.

### Task 2: Gateway reports redactions

**Files:**
- Modify: `src/skills/outbound-gateway.ts` (`OutboundSendResult` ~144; Step 1.5 ~1164-1216; Step 3 returns ~1424-1558; relay deferral return ~2144)
- Test: `tests/unit/skills/outbound-gateway.test.ts` (the `makePiiRedactor` block ~2175)

**Interfaces:**
- Produces on `OutboundSendResult`:
  - `redactions?: Array<{ label: string; field: 'body' | 'subject' }>` — set (non-empty) only when redaction changed what was sent.
  - `sentContent?: string` — the delivered body, set only when it differs from the draft's body.
- Set on every `success: true` result from `send()` that carries the redacted content: dispatched, queued, deferred-to-digest.

- [ ] **Step 1: Write failing tests:**
  - redactor returns `{content: 'call [REDACTED: PHONE_US]', redactions:[{patternLabel:'phone_us', …}]}` for the body → `result.redactions` equals `[{label:'phone_us', field:'body'}]` and `result.sentContent === 'call [REDACTED: PHONE_US]'`.
  - body and subject both redacted → two entries with `field: 'body'` and `'subject'`.
  - nothing redacted → `redactions` and `sentContent` are `undefined`.
  - queued send (channel unavailable, queue wired as existing tests do) → `redactions` present alongside `queued: true`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Keep `redactionResult.redactions` / `subjectResult.redactions` in a local `appliedRedactions`. Add `private withRedactions(result: OutboundSendResult, applied, sentContent): OutboundSendResult` that adds the two fields only when `result.success` and `applied.length > 0`; wrap each Step 3 `return result` and the deferral return.
- [ ] **Step 4: Run** the gateway test file → PASS.
- [ ] **Step 5: Commit** `feat(outbound): report applied redactions on send results (#2312)`.

### Task 3: Principal bypass keys on the sole-recipient set

**Files:**
- Modify: `src/dispatch/pii-redactor.ts` (`RedactContext`, `PiiRedactorOptions.ceoContactId` removed, Step 2 of `redact`, header comment)
- Modify: `src/skills/outbound-gateway.ts` (hoist `buildFilterRecipients(request)` from ~1227 to before Step 1.5; pass `principalIsSoleRecipient`)
- Modify: `src/index.ts:1636` (drop `ceoContactId`)
- Test: `tests/unit/dispatch/pii-redactor.test.ts`, `tests/unit/skills/outbound-gateway.test.ts`

**Interfaces:**
- `RedactContext` loses `recipientContactId`, gains `principalIsSoleRecipient?: boolean`. Bypass iff `=== true`.

- [ ] **Step 1: Write failing tests:**
  - redactor: `principalIsSoleRecipient: true` → content unchanged, no event published; `false`/absent → redacted.
  - gateway (real `PiiRedactor`, principal identities configured as existing principal-recipient tests do): email to principal only with a phone number → body delivered intact; To principal + CC `third@example.com` → delivered body contains `[REDACTED: PHONE_US]`; Signal 1:1 to principal → intact.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** as described; the subject call uses the same context. Update existing tests that pass `recipientContactId`/`ceoContactId`.
- [ ] **Step 4: Run** both files, then `pnpm -C <worktree> vitest run tests/unit/dispatch tests/unit/skills` → PASS.
- [ ] **Step 5: Commit** `fix(pii): redact when a third party shares a send with the principal (#2312)`.

### Task 4: Send skills tell the agent

**Files:**
- Modify: `src/skills/_shared/principal-directed.ts` (next to `relayDeferredData`)
- Modify: `skills/email/tools/email-send/handler.ts` (~275 `registerOutboundContext`, ~283 data), `skills/email/tools/email-reply/handler.ts` (~309, ~324), `skills/messaging/tools/signal-send/handler.ts` (group ~150-180 and 1:1 ~243-264), `skills/messaging/tools/sms-send/handler.ts` (~116-135), `skills/messaging/tools/slack-send/handler.ts` (~130-149); each `tool.json` (output field + minor version bump)
- Test: each `handler.test.ts` beside the skill

**Interfaces:**
- Produces: `export const REDACTION_NOTE: string` and `export function redactionData(result: { redactions?: ReadonlyArray<{ label: string; field: string }> }): Record<string, unknown>` → `{}` when none, else `{ redactions: [{label, field}], redaction_note: REDACTION_NOTE }`.
- `REDACTION_NOTE` text: `'Some details were removed before sending (see redactions). They were not shared: do not say they were. If the recipient needs them, ask the principal.'`
- `registerOutboundContext({ content: result.sentContent ?? <draft body> … })` in every skill.

- [ ] **Step 1: Write failing tests** per skill: gateway mock returns `{success:true, messageId:'m', redactions:[{label:'phone_us', field:'body'}], sentContent:'x [REDACTED: PHONE_US]'}` → `result.data.redactions` equals the array, `result.data.redaction_note === REDACTION_NOTE`, and `registerOutboundContext` was called with `content: 'x [REDACTED: PHONE_US]'`. Without redactions → no `redactions` key. Signal: one test for 1:1, one for group.
- [ ] **Step 2: Run** `pnpm -C <worktree> vitest run skills/email skills/signal-send skills/sms-send skills/slack-send` → FAIL.
- [ ] **Step 3: Implement** helper and spread `...redactionData(result)` into each success `data`; update manifests' output description.
- [ ] **Step 4: Run** → PASS; run `pnpm -C <worktree> run typecheck` and `pnpm -C <worktree> lint`.
- [ ] **Step 5: CHANGELOG** (Added: SIN detection; Changed: send results report redactions; Security: cc'd-principal redaction bypass fixed) and commit `feat(skills): send results tell the agent what was redacted (#2312)`.
