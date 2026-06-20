# Task 10 Report — Post-cutover data-integrity checks + CHANGELOG

## Files Changed

- **Created**: `tests/integration/contacts-cutover.integration.test.ts`
- **Modified**: `CHANGELOG.md` (added Gate-1 Changed bullet)
- **Created**: `.superpowers/sdd/task-10-report.md` (this file)

---

## Part A — Integration Test

**File**: `tests/integration/contacts-cutover.integration.test.ts`

### Harness match confirmation

The test mirrors the sibling harness exactly:

| Pattern | Sibling examples | This test |
|---|---|---|
| Skip guard | `const describeIf = DATABASE_URL ? describe : describe.skip` | Same |
| Pool setup | `pool = new Pool({ connectionString: DATABASE_URL })` | Same |
| Fail-fast probe | `await pool.query('SELECT 1 FROM contacts LIMIT 0')` | Same |
| Cleanup | `await pool.end()` | Same (no data written, pool close only) |
| Import style | ESM `.js` not needed for `pg` (it's a CJS package, direct import) | Same as dedup-contacts-merge.test.ts |

This test uses only direct `pool.query()` calls — no application-layer services needed. The three assertions are:

1. `information_schema.columns` query returns no rows for `status`/`trust_level` in the `contacts` table.
2. `to_regclass('public.held_messages')` returns NULL.
3. A `count(*)::int` of contacts with out-of-enum `tier` or `kind` is 0.

**Local execution blocked**: Docker is paused on this machine. CI will verify.

---

## Part B — Grep Gate Results

### Grep 1: `ContactStatus|setStatus|promoteToConfirmed|deriveInitialTier|deriveTierFromStatusUpdate|STATUS_RANK|group_held|held_messages`

```
tests/unit/skills/outbound-gateway.test.ts:1126  — "promotion goes through elevateTierToKnown, not setStatus"
tests/integration/outbound-delivered-emission.test.ts:37  — "createContact, linkIdentity, or setStatus calls are made"
skills/contact-register/handler.test.ts:426,427,431,485,489,514  — assertions that promoteToConfirmed is NEVER called
skills/contact-list/handler.ts:10  — import { ContactStatus, ContactKind } from '../../src/contacts/types.js'
skills/contact-list/handler.ts:12  — const VALID_STATUSES: readonly ContactStatus[] = ['confirmed', 'provisional', 'blocked']
```

**Justifications:**

- `outbound-gateway.test.ts:1126`: Prose comment describing history. **LEGITIMATE KEEP.**
- `outbound-delivered-emission.test.ts:37`: Prose comment inside a test noting what isn't called. **LEGITIMATE KEEP.**
- `contact-register/handler.test.ts:426-514`: Test assertions using `promoteToConfirmed` as a Proxy trap to verify it is NEVER invoked after the promotion flow was retired. These are retirement verification tests. **LEGITIMATE KEEP.**
- **`contact-list/handler.ts:10-12`: FLAGGED — live production code.** `ContactStatus` is not exported anywhere in `src/contacts/types.ts` (grepped; zero results). The import will produce a TypeScript compile error. Additionally, line 108 passes `status: status as ContactStatus | undefined` to `ctx.contactService.listContacts()`, which now only accepts `{ tier?, kind?, limit?, offset? }` — `status` is silently dropped at the type level and the filter is a no-op at runtime. This indicates an earlier task (contact-list cutover) missed cleaning up `skills/contact-list/handler.ts` and its companion `skills/contact-list/handler.test.ts`.

### Grep 2: `status: 'confirmed'|status: 'provisional'|status: 'blocked'|status === 'confirmed'|status === 'provisional'`

**Justifications (all legitimate keeps):**

- `src/contacts/ceo-bootstrap.ts:137`: Prose comment "gate was previously on contact_status === 'confirmed'". **LEGITIMATE KEEP** (history comment).
- `src/channels/http/routes/kg.test.ts:128,140,176`: HTTP request body `status:'confirmed'` payloads that deliberately assert the API ignores a legacy status field. **LEGITIMATE KEEP** per task spec.
- `tests/unit/skills/calendar-list-events.test.ts`, `nylas-calendar-client.test.ts`, `calendar-update-event.test.ts`, `calendar-create-event.test.ts`: Calendar event `status:'confirmed'`, participant `status:'accepted'`. **LEGITIMATE KEEP** — calendar event domain, not contact status.
- `tests/integration/heartbeat-selection.test.ts:88,96`: Task `status:'blocked'`. **LEGITIMATE KEEP** — task domain.
- `skills/signal-send/handler.test.ts:24,120,162`: Mock objects with stale `status: 'confirmed'/'blocked'` alongside current `tier` field. The handler (`signal-send/handler.ts`) never reads `status` from the resolved contact; the mock extra field is harmless. **BORDERLINE**: technically stale mock data but not a live code path issue. The handler is tier-correct. Not flagging as a blocker.
- `skills/contact-register/handler.test.ts:113,232,300,364`: `contactService.createContact({ ..., status: 'confirmed', ... })` where `createContact` uses the in-memory `ContactService` and `CreateContactOptions` no longer has a `status` field. TypeScript would flag this as an unknown property on a strict excess-property check. **BORDERLINE**: stale test data. The in-memory service likely ignores the unknown field at runtime, but the TypeScript strictness depends on whether these objects pass through the interface or cast as `any`. Flagging as a secondary concern (the primary flag is `contact-list/handler.ts`).
- `skills/contact-list/handler.test.ts:17,44-47,...`: Extensive `status` use in mock `Contact` objects and filter assertions. `Contact` interface no longer has `status` (confirmed via `src/contacts/types.ts:3-37`). The `makeContact()` factory at line 17 sets `status: 'confirmed'` which is not a `Contact` field — TypeScript strict excess-property check would flag this. Tests also assert `c.status === 'provisional'` at line 109 against `Contact` objects that have no such field. **This is a secondary stale-test finding** tied to the primary flagged finding at `contact-list/handler.ts`.

### Primary flagged finding

**`skills/contact-list/handler.ts` (lines 10, 12, 108) — live code stale reference.**

- `ContactStatus` is imported but does not exist in `src/contacts/types.ts`.
- `listContacts()` is called with a `status` filter that `IContactService` does not accept.
- This is a TypeScript compile error that would surface in `pnpm run typecheck`.
- Indicates the earlier task that cleaned up contact-list missed the skill handler itself.

**Recommendation**: Dispatch a targeted fix for `skills/contact-list/handler.ts` (remove the `ContactStatus` import and `VALID_STATUSES` constant; replace the `status` filter with `tier`; update `skills/contact-list/handler.test.ts` to match). Do not fix here per task instructions.

---

## Part C — CHANGELOG Verification

### Coverage check

| Requirement | Status | Entry location |
|---|---|---|
| `contacts.status` + `trust_level` columns dropped (migration 059) | Covered | `### Removed` line 30 |
| confirm-the-person/promote flow removed (setStatus/promoteToConfirmed + daily sweep) | Covered | `### Removed` lines 29, 32, 35 |
| `held_messages` table + `group_held` event removed | Covered | `### Removed` lines 30, 31 |
| `rederive:contact-tiers` script added | Covered | `### Added` line 18 |
| Gate-1 status→tier conversion (behavior-preserving Changed entry) | **Added this task** | `### Changed` (new bullet) |

### Gate-1 entry added

```markdown
- **Authorization Gate-1: status→tier conversion (behavior-preserving)** — the permission resolver's deny-all gate now uses `meetsMinimumTier(tier, 'known')` instead of `status !== 'confirmed'`; the effective behavior is identical under migration-055's mapping (`confirmed ⟺ tier ∈ {known,trusted,principal}`; `provisional ⟺ unknown`; `blocked ⟺ blocked`). Contacts at `unknown` or `blocked` tier still receive zero permissions. (#955)
```

No existing bullets were duplicated or lost. The entry was inserted into the first `### Changed` block under `## [Unreleased]`.

---

## Concerns

1. **Primary flag — `skills/contact-list/handler.ts`**: Live production skill imports a non-existent `ContactStatus` type and passes a `status` filter to `listContacts()` which doesn't accept it. This is a TypeScript compile error. A `pnpm run typecheck` pass would surface it. The controller should dispatch a targeted fix.

2. **Secondary flag — `skills/contact-register/handler.test.ts` and `skills/contact-list/handler.test.ts`**: Both test files use `status` fields on `Contact`/`CreateContactOptions` objects where those fields no longer exist in the interfaces. These are TypeScript strict errors. The contact-list test is a direct consequence of the contact-list handler fix needed above.

3. **Local Docker paused**: Integration test not locally executable. CI will be the verification point.
