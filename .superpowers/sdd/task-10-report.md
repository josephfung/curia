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

---

## Skills Fix (follow-up to Concerns #1 and #2)

**Commit**: `aa6b5fb2` — `fix(skills): retire contact status refs in contact-list/lookup + dead test mocks (#955)`

### Per-file changes

**`skills/contact-list/handler.ts`**
- Removed `import ... ContactStatus ...` from `src/contacts/types.js` (deleted type).
- Removed `VALID_STATUSES` array and all `status` input validation/guards (5 guards removed).
- Removed `status` destructuring from input, `status` from `listContacts()` call, `status: c.status` from output map — replaced with `tier: c.tier`.
- Updated file header comment and log/error-log call sites to drop `status`.
- Role-combo guard updated: `role + status` mutual exclusion removed; only `role + limit/offset` remains.

**`skills/contact-list/skill.json`** — bumped `1.3.0 → 1.4.0`. Removed `status` from `inputs`; updated description to drop "status" language.

**`skills/contact-list/handler.test.ts`** — full rewrite of status-related tests:
- `makeContact` factory: removed `status:` field (not on `Contact`), removed `trustLevel: null` (also not on `Contact`).
- Contact fixtures (alice/bob/carol/dave): switched from `status:` to `tier:`.
- `getContacts` helper: return type changed from `status: string` to `tier: string`.
- Removed 8 status-filter tests (provisional/confirmed/blocked, status+limit, offset+status).
- Removed 4 status-validation tests (invalid status, role-as-status redirects, role+status combo).
- Kept: no-filter, limit, offset, role, kind, error handling tests. Output assertion now checks `tier` instead of `status`.
- Kind-filter section: updated raw contact objects from `status:` to `tier:`.

**`skills/contact-lookup/handler.ts`** — contact-level status classification:

| Line | Expression | Classification | Action |
|---|---|---|---|
| 110 | `status: resolved.status` | Contact-level (`ResolvedSender.status` removed) | Changed to `tier: resolved.tier` |
| 127 | `enrichContact` param `status: string` | Contact-level | Changed to `tier: string` |
| 143 | `status: i.status` | Identity-level (`ChannelIdentity.status: IdentityStatus`) | **Left untouched** |
| 158 | `contactToSummary` param `status: string` | Contact-level | Changed to `tier: string` |
| 164 | `status: contact.status` | Contact-level | Changed to `tier: contact.tier` |

No `skill.json` version bump needed — the outputs docs already just say `"contacts": "array"` (no field-level detail). No test file exists for contact-lookup.

**`skills/contact-register/handler.test.ts`** — removed `status: 'confirmed'` from 4 `createContact()` calls in `beforeEach` seed blocks; replaced with `tier: 'known'` (confirmed→known mapping). Comments updated to reflect the new terminology.

**`skills/signal-send/handler.test.ts`** — removed dead `status:` property from 3 `resolveByChannelIdentity` mock return objects (lines 24, 121, 163). Kept existing `tier:` values. Identity of test behavior confirmed: `group-trust.ts` uses `contact.tier` exclusively; `status` was an unused extra prop.

### Test results
All 64 tests passed across 3 files (`contact-list`, `contact-register`, `signal-send`). No test file exists for `contact-lookup`.

### Typecheck
`pnpm run typecheck` exited clean (no errors). Skills directory is excluded from tsconfig scope — the `tsc --noEmit` covers only `src/**`. The skill handlers cannot be typechecked via the project's standard typecheck command; this is a pre-existing structural gap (noted as a concern by Task 10 grep gate).

### Re-grep output
```
skills/contact-list/handler.test.ts:3: // kind filter. Status filter removed along with ContactStatus (#955).
```
Only a comment. No live references remain.

### Concerns
- Skills are excluded from tsconfig — they cannot be typechecked via `pnpm run typecheck`. The skill handlers are runtime-checked only (by the test suite). This structural gap predates this PR and is worth tracking as a separate issue.
- `contact-lookup` has no test file. The handler changes were verified by code inspection and grep only.

---

## Final-Review Fixes (whole-branch review findings)

### Fix 1 — `contact-set-trust` skill removed

**What changed:**
- `git rm -r skills/contact-set-trust/` (handler.ts + skill.json)
- Removed `- contact-set-trust` from `agents/contacts.yaml` pinned_skills (line 279)
- Removed `- contact-set-trust` from `config/registry-defaults.yaml` (line 49)
- Bumped `agents/contacts.yaml` version `0.6.0 → 0.7.0` (minor: removed a pinned skill)
- Added `### Removed` CHANGELOG bullet: "contact-set-trust skill removed, superseded by contact-set-tier (#955)"

**Grep result:** Zero hits across src/, skills/, agents/, config/, tests/ after removal.

### Fix 2 — `outbound-gateway.ts` catch fall-through

**What changed:**
- `src/skills/outbound-gateway.ts` ~line 1126: removed the `return;` inside the `catch (err)` block for `elevateTierToKnown`
- Replaced with a comment explaining that execution must fall through to the confidence `incrementalUpdate` call; the warn log is preserved
- No other changes to the block

### Fix 3 — `scripts/rederive-contact-tiers.ts` outer await guards

**What changed:**
- `pipeline.fullRecomputeAll()` now wrapped in a `try/catch` that logs `'rederive: fullRecomputeAll failed, aborting'` and re-throws
- `contactService.listContacts(...)` now wrapped in a `try/catch` that logs `'rederive: listContacts failed, aborting after recompute'` and re-throws
- `recomputed` and `candidates` declared as `let` before their respective try blocks so they remain in scope for the rest of the function
- `candidates` typed as `Awaited<ReturnType<ServiceLike['listContacts']>>` (resolves to `Contact[]`)
- Per-contact loop and error accounting unchanged

### Verification

**Typecheck:** `pnpm run typecheck` — clean (0 errors)

**Tests:** `pnpm exec vitest run scripts/rederive-contact-tiers.test.ts tests/unit/skills/outbound-gateway.test.ts`
- 2 test files passed, 89 tests passed

**Grep gate (contact-set-trust):** Zero hits across src/, skills/, agents/, config/, tests/

### contacts.yaml version

`0.6.0 → 0.7.0` (removing a pinned skill = minor bump)
