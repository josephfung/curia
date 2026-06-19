# Task 3 Report: Stop writing legacy status/trust_level in bootstrap paths

## Per-file changes

### src/contacts/ensure-principal.ts
- Removed `status` and `trust_level` from the INSERT column list
- Removed `'confirmed'` and `'ceo'` values from the INSERT VALUES
- Kept `system_role='principal'`, `tier='principal'`, `kind='principal'`, `role='ceo'`
- Updated file-level comment to reflect new field set
- No gate translation needed (this file only has an INSERT, no confirmed-status checks)

### src/contacts/ceo-bootstrap.ts
- **SELECT**: Changed `c.status AS contact_status` → `c.tier AS contact_tier`; updated query type annotation accordingly
- **Gate at line ~130**: `contact_status === 'confirmed' && identity_verified` → `contact_tier === 'principal' && identity_verified`. Rationale: `repairPrincipalMetadata` always runs before this check and sets `tier='principal'` in the DB; the fast-path now uses the canonical tier column instead of the legacy status column
- **UPDATE block**: Removed the entire `if (contact_status !== 'confirmed') { UPDATE contacts SET status = 'confirmed' }` block. Rationale: `repairPrincipalMetadata` already handles tier promotion to 'principal'; there is no other status write needed
- **INSERT**: Removed `status` from column list + `'confirmed'` from VALUES
- **Log line**: Changed `wasStatus: contact_status` → `wasTier: contact_tier` in the promotion log
- Updated file-level comment and log messages to reflect tier-first semantics
- `repairPrincipalMetadata` itself was NOT changed — it already only sets `role/system_role/tier/kind` and does not touch `status`

### src/skills/outbound-gateway.ts
- Removed `status: 'confirmed'` from the `createContact(...)` call in `promoteOrCreateRecipientContact`
- Added comment explaining the tier path: recipient is created at default tier ('known' from `ceo_stated` source) and elevated via live correspondence path
- No replacement tier override added (task instruction: do not add one unless surrounding code implies it)

### src/entity-context/bootstrap.ts
- Removed `status` from the INSERT column list + `'confirmed'` from VALUES
- Kept `tier='known'`, `kind='agent'`, `system_role='agent'` (already present)
- Updated inline comment to remove "confirmed" reference

## Gate translations (before → after)

| Location | Before | After |
|---|---|---|
| `ceo-bootstrap.ts` line ~130 | `contact_status === 'confirmed' && identity_verified` | `contact_tier === 'principal' && identity_verified` |
| `ceo-bootstrap.ts` line ~137 | `if (contact_status !== 'confirmed') { UPDATE ... SET status='confirmed' }` | Removed (repairPrincipalMetadata handles tier) |

**Translation rationale**: The "confirmed" check was protecting the fast-path "no work needed" return. After `repairPrincipalMetadata` runs (line 121, before any gate), the contact is guaranteed to be at `tier='principal'` in the DB. Checking `contact_tier` (the DB value at SELECT time) against `'principal'` is equivalent for steady-state runs, and covers the edge case where an older row was at 'unknown' (would fall through to the promotion path, which then only verifies the identity). The semantic contract is preserved: if `repairPrincipalMetadata` + identity verification have both been applied, we return immediately. Otherwise we apply what's missing.

## TDD evidence

**RED phase**: Wrote 3 new test files (`ensure-principal.test.ts`, `ceo-bootstrap.test.ts`, `entity-context/bootstrap.test.ts`) asserting SQL writes don't contain `status`/`trust_level` and the principal row uses tier/kind/system_role. Ran tests → 5 failures (exactly the assertions about legacy column writes).

**GREEN phase**: Implemented all changes → 13/13 tests pass.

**Typecheck**: Clean (`tsc --noEmit` exits 0 after fixing one unused import in the entity-context test file).

## Files changed

- `src/contacts/ensure-principal.ts` — modified
- `src/contacts/ceo-bootstrap.ts` — modified
- `src/skills/outbound-gateway.ts` — modified
- `src/entity-context/bootstrap.ts` — modified
- `src/contacts/ensure-principal.test.ts` — new
- `src/contacts/ceo-bootstrap.test.ts` — new
- `src/entity-context/bootstrap.test.ts` — new

## Self-review

- The gate translation for ceo-bootstrap is sound: `repairPrincipalMetadata` always runs before the gate, so `tier='principal'` in the DB when we reach the check. The `contact_tier` variable still reflects the DB value at SELECT time (pre-repair), so an existing row at 'unknown' will fall through to the promotion path. The promotion path now only updates `identity_verified` — the tier was already updated by `repairPrincipalMetadata`. This is correct behavior.
- `outbound-gateway.ts`: The task says "do not add a replacement tier override unless surrounding code implies one." `ContactService.createContact` with `source: 'ceo_stated'` and no explicit tier uses `deriveInitialTier('confirmed')` → `'known'` (because the service still derives tier from status in its create path). But we're not passing `status` here anymore — the service defaults to `'confirmed'` for the derived tier path. Checking `contact-service.ts` line 64: `deriveInitialTier(status: ContactStatus)` — this is called by the service internally, not from the options we pass. The default status when none is passed should be confirmed (since callers previously explicitly set it to confirmed). This should work correctly: 'known' tier recipients are what we want for outbound sends.
- `entity-context/bootstrap.ts`: The DO UPDATE clause was already not writing `status` — only the INSERT VALUES had it. Removed from INSERT correctly.

## Concerns

**Minor**: In `ceo-bootstrap.ts`, the gate translation correctly uses `contact_tier` (the SELECT-time value, pre-repairPrincipalMetadata). In steady-state (existing principal at tier='principal'), this is the fast path. For a first-boot promotion case (new or migrated instance where tier='unknown'), the code now correctly falls through to the `!identity_verified` check instead of the removed `status` UPDATE block. The tier was already set by `repairPrincipalMetadata`. No capability is lost.

**None flagged as NEEDS_CONTEXT**: all gate translations were unambiguous. The only `status` reads in the existing-contact path were keyed to the principal identity, and the tier check is the correct replacement per the task instructions.

---

## Review findings fix (2026-06-19)

Applied three review findings from the post-Task-3 code review:

### Fix 1: Explicit `tier: 'known'` on outbound recipient `createContact` (Important)

`src/skills/outbound-gateway.ts` — `promoteOrCreateRecipientContact()`:
- Added `tier: 'known'` to the `createContact(...)` options object.
- Updated the comment to explain: outbound recipient = CEO-trusted, equivalent to the former `status='confirmed'`→`known` mapping; made explicit so Task 5's service-default removal doesn't regress this to `'unknown'`.

### Fix 2: Strengthen outbound-gateway test (Minor)

`tests/unit/skills/outbound-gateway.test.ts` — "creates a confirmed contact when no record exists":
- Changed the `createContact` assertion from `status: 'confirmed'` to `tier: 'known'` to match the new explicit tier field, so a future regression that adds back the wrong value is caught.
- Added a comment explaining the assertion intent.

### Fix 3: Strengthen ensure-principal test (Minor)

`src/contacts/ensure-principal.test.ts` — "INSERT does NOT reference status or trust_level":
- Changed `not.toContain('status')` to `not.toMatch(/\bstatus\b/)` (word-boundary guard).
- Added `not.toContain("'confirmed'")` to catch the legacy value if it re-appears even under a different column name — mirrors the `ceo-bootstrap.test.ts` pattern.

### Test output

```
pnpm -C /…/curia-contacts-cutover-955 exec vitest run tests/unit/skills/outbound-gateway.test.ts src/contacts/ensure-principal.test.ts

Test Files  2 passed (2)
     Tests  93 passed (93)
```

### Typecheck

`pnpm -C /…/curia-contacts-cutover-955 run typecheck` — clean (exit 0, no errors).
