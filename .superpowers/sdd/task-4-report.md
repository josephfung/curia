## Task 4 Report: Retire provisional/promote flow from `contact-register`

### Status: DONE

---

### What Was Removed

**`handler.ts`**
- Removed `ceo_has_sent` and `calendar_accepted` from the destructured input and input type annotation.
- Changed `createContact({ status: 'provisional', ... })` to `createContact({ tier: 'unknown', ... })`. This is semantically equivalent (status='provisional' maps to tier='unknown' via `deriveInitialTier()`), but uses the new tier axis directly and is explicit about the intended starting tier.
- Removed the entire Step 2b block (~60 lines): the `promoted` / `promotionSignal` variables, the `resolvedSender.status === 'provisional'` gate, the `getContact` re-fetch for TOCTOU protection, all three signal checks (`curia_outbound`, `ceo_has_sent`, `calendar_accepted`), and the `promoteToConfirmed()` call.
- Removed the `promoted` / `promotionSignal` null-check in the refetch warning (Step 4 guard).
- Removed `promoted` and `promotionSignal` from the success return value.
- Removed `status` from the success return value (was `updatedContact?.status ?? resolvedSender.status`).
- Updated the file-level comment block (steps 2b, promotion rules section).
- Cleaned up orphan comment (removed "provisional" wording in the concurrent-race comment).

**`skill.json`**
- Removed `ceo_has_sent` and `calendar_accepted` from `inputs`.
- Removed `status`, `promoted`, and `promotion_signal` from `outputs`.
- Updated `description` to drop provisional/promotion language; added note that elevation is the dispatcher/judgment path's job.
- Bumped `version` from `1.1.0` → `1.2.0` (minor: removing manifest input/output fields is a manifest-schema change).

**`handler.test.ts`**
- Removed the entire `ContactRegisterHandler — auto-promotion signals` describe block (8 tests, ~200 lines).
- Replaced with `ContactRegisterHandler — promotion flow removed` block (3 tests):
  - Verifies new unknown sender is created at `tier='unknown'` and `promoteToConfirmed` is never called (via Proxy trap).
  - Verifies `promoted` and `promotion_signal` and `status` are absent from the response.
  - Verifies that `ceo_has_sent`/`calendar_accepted` inputs, if supplied by a stale caller, are silently ignored and do not trigger promotion.
- Updated existing `resolves an existing contact and returns it` test: removed `expect(data.status).toBe('confirmed')` (field no longer returned), replaced with `expect(data).not.toHaveProperty('status')`.
- Updated `creates a provisional contact for an unknown email address` test: renamed to `creates a contact at tier=unknown...`, added DB-level assertion that `contact.tier === 'unknown'`, removed the `expect(data.status).toBe('provisional')` assertion (status not in response).

**`CHANGELOG.md`**
- Added entry under `[Unreleased] → Removed` for the `contact-register` skill version bump and what was removed.

---

### What Was Kept

- Full resolve-or-create path (Step 1) including concurrent race handling via 23505 guard, orphan cleanup, and re-resolve.
- Step 2: confidence pipeline delegation + direct `updateScoringFields` fallback for last_seen_at.
- Step 3: bus event emission (`contact.resolved`) — fire-and-forget, non-blocking.
- Step 4: refetch and return `contact_id`, `display_name`, `contact_confidence`, `created`.
- All input validation (channel, identifier, displayName, messageTimestamp, direction bounds checks).
- All identity-linking tests, last_seen_at idempotency tests, pipeline tests, bus-event tests.

---

### Boundary Verified: curia_outbound signal

Before removing `curia_outbound`, I confirmed it was used exclusively for promotion (checking `outboundMessageCount > 0` to decide whether to call `promoteToConfirmed`). It is not used for any other purpose in the handler. Removing it is safe.

---

### TDD Evidence

**RED** (after updating tests, before implementation):
```
Tests  2 failed | 19 passed (21)
  × does not include promoted or promotion_signal in the response
  × ignores ceo_has_sent and calendar_accepted if supplied
```

**GREEN** (after implementation):
```
Tests  21 passed (21)
```

Note: the `tier='unknown'` assertion in the new creation test passed even in RED because `status:'provisional'` and `tier:'unknown'` are equivalent via `deriveInitialTier()`. The RED correctly targeted the output-field removals.

---

### Files Changed

- `skills/contact-register/handler.ts` — removed promotion machinery; changed create to `tier:'unknown'`; removed response fields
- `skills/contact-register/skill.json` — removed promotion inputs/outputs; updated description; bumped 1.1.0 → 1.2.0
- `skills/contact-register/handler.test.ts` — replaced 8 promotion tests with 3 retirement-verification tests; fixed 2 core tests
- `CHANGELOG.md` — added Removed entry

---

### Typecheck

Clean. `pnpm run typecheck` (tsc --noEmit) exits zero.

---

### Self-Review

- No remaining references to `promoteToConfirmed`, `ceo_has_sent`, `calendar_accepted`, `promotion_signal`, or `status:'provisional'` in these files.
- `tier:'unknown'` is explicit at the call site — future readers know why this tier was chosen.
- The Proxy-based `promoteToConfirmed` call trap in the test is appropriate: it proves the method is never called without requiring a mock framework; it degrades gracefully if the method is later removed from ContactService (the trap will never fire).
- No drive-by refactoring beyond the stated scope.

---

### Concerns

None. The boundary between promotion flow and core registration was unambiguous. The `curia_outbound` signal check was purely within the promotion block (not feeding any other logic). All core behaviors (resolve, create, last-seen, bus event, return) are intact.

---

### Commit

SHA: `5fed7cd6`
Subject: `refactor(contacts): remove provisional/promote flow from contact-register (#955)`

### skill.json version

`1.1.0` → `1.2.0`

---

## Review Fix Report (post-task-4 findings)

### Commit

SHA: `c6b948d9`
Subject: `fix: drop stale provisional log wording + strengthen contact-register test (#955)`

### Changes

**handler.ts — Fix 1 (Important): Stale log wording**

- Line 162 warn log: `'contact-register: could not clean up orphaned provisional contact'` → `'contact-register: could not clean up orphaned contact (tier=unknown)'`
- Line 126 inline comment: `clean up our orphaned provisional contact` → `clean up our orphaned contact (tier=unknown)`
- No other "provisional" mentions remain in handler.ts (line 17 is a historical note about the retired flow — accurate, not stale).

**handler.test.ts — Fix 2 (Minor): Test expressiveness**

- Added Proxy-based `promoteToConfirmed` trap to the `'ignores ceo_has_sent and calendar_accepted if supplied'` test, identical in pattern to the sibling `'never calls promoteToConfirmed'` test.
- The trap records any call to `promoteToConfirmed` into a `promoteCalls` array; test asserts `expect(promoteCalls).toHaveLength(0)` after handler execution with stale promotion inputs.
- `contactService` in this test now routes through `proxiedService as unknown as ContactService`.

### Test output

```
Test Files  1 passed (1)
     Tests  21 passed (21)
  Duration  298ms
```

### Typecheck

Clean. `pnpm run typecheck` (tsc --noEmit) exits zero.
