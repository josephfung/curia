# Contacts Cutover (#955) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Final cutover from the legacy `status`/`trust_level` contact model to the entity-centric `tier`/`kind` ledger — re-derive tiers from correspondence history, then physically drop the dead columns, tables, code paths, and agent schedule.

**Architecture:** The `tier`/`kind` columns are already canonical (since #945/#1055) and `trust_level` reads/writes were retired in #1070. This plan (a) runs a one-shot re-derivation that recomputes confidence and elevates `unknown→known` where correspondence warrants, then (b) removes every remaining `status` reference, the vestigial `trust_level` residue, the dead `held_messages` table + `group_held` event, and the daily provisional-promotion agent schedule, and (c) drops the `status` + `trust_level` columns + `held_messages` table in migration `059`.

**Tech Stack:** TypeScript (ESM, Node 24+), PostgreSQL 16 via node-pg-migrate (plain SQL, `-- Up`/`-- Down`), Vitest (unit + real-Postgres integration), pino, pnpm workspace.

## Global Constraints

- ESM only; `.js` extensions on all relative imports; `import.meta.dirname` not `__dirname`.
- No `any`; parameterized SQL only; no `console.log` (pino only); no empty catch blocks.
- Run `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contacts-cutover-955 run typecheck` before every commit touching `.ts`.
- Migrations live in `src/db/migrations/`, named `NNN_description.sql`; next number is **059**. After any rebase, `ls src/db/migrations/ | sort` and confirm `059` is unique before merge.
- Conventional commits (`feat:`/`fix:`/`chore:`); **no Co-Authored-By, no Claude attribution anywhere.**
- Every PR updates `CHANGELOG.md` under `## [Unreleased]`. Bump `agents/contacts.yaml` `version` when edited.
- Working dir for all commands: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contacts-cutover-955` (use `pnpm -C <path>` / `git -C <path>`).
- Keep the build green between tasks: code stops reading/writing the legacy columns (Tasks 2–7) **before** the migration drops them (Task 8).

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `scripts/rederive-contact-tiers.ts` (new) | One-shot: recompute confidence for all contacts, elevate `unknown→known` person/org contacts whose recomputed confidence ≥ threshold | 1 |
| `scripts/rederive-contact-tiers.test.ts` (new) | Unit test for the re-derivation routine against an in-memory/seeded backend | 1 |
| `package.json` | Add `rederive:contact-tiers` script | 1 |
| `src/channels/http/routes/kg.ts` | Remove `status` from contact POST/PATCH/PUT (validation, default, write) | 2 |
| `src/contacts/ceo-bootstrap.ts` | Stop writing `status`/`trust_level` columns; gate on `tier`/`system_role` | 3 |
| `src/contacts/ensure-principal.ts` | Drop `status`/`trust_level` from the principal INSERT | 3 |
| `src/skills/outbound-gateway.ts` | Drop `status:'confirmed'` create option | 3 |
| `src/entity-context/bootstrap.ts` | Drop `status` from agent-contact INSERT | 3 |
| `skills/contact-register/handler.ts` + `skill.json` | Remove provisional-create + promote-to-confirmed flow; keep core registration | 4 |
| `src/contacts/contact-service.ts` | Remove `setStatus`, `promoteToConfirmed`, `deriveInitialTier`, `deriveTierFromStatusUpdate`, `status` from createContact/listContacts/SQL/row-mappers; drop `trust_level` SQL + mapper residue | 5 |
| `src/contacts/types.ts` | Remove `ContactStatus`, `STATUS_RANK`, `status` interface fields; remove `trustLevel` residue fields | 6 |
| `src/db/migrations/059_drop_legacy_contact_columns.sql` (new) | Drop `contacts.status`, `contacts.trust_level`, `held_messages` table | 7 |
| `src/bus/events.ts` | Remove `group_held` notification kind + stale comments | 8 |
| `src/skills/outbound-gateway.ts` | Remove stale `notifyCeoGroupHeld()` doc-comment | 8 |
| `agents/contacts.yaml` | Remove daily provisional-sweep schedule + principal-context block + provisional prompt language; keep weekly dedup + Wed grant-rec; bump `version` | 9 |
| `tests/integration/contacts-cutover.integration.test.ts` (new) | Post-cutover data-integrity assertions (every contact valid tier/kind; columns/table gone) | 10 |
| `CHANGELOG.md` | `Removed` entries | 10 |

---

## Task 1: Re-derivation one-shot script

**Files:**
- Create: `scripts/rederive-contact-tiers.ts`
- Test: `scripts/rederive-contact-tiers.test.ts`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Consumes: `ContactService.createWithPostgres(pool, undefined, logger)`; `ContactService.listContacts({ tier?, kind?, limit?, offset? })`; `ContactService.elevateTierToKnown(contactId, 'judgment'): Promise<boolean>`; `new ConfidencePipeline(contactService, logger)`; `ConfidencePipeline.fullRecompute(contactId): Promise<number>` and `fullRecomputeAll()`; `JUDGMENT_ELEVATION_THRESHOLD` from `src/contacts/confidence-scorer.js`.
- Produces: `runRederive(contactService, pipeline): Promise<{ recomputed: number; elevated: number; skipped: number; errors: number; failedContactIds: string[] }>` — exported for testing; plus a CLI entry like `backfill-contact-attributes.ts`.

**Design:** Recompute confidence for every contact, then re-list `tier='unknown'` person/org contacts and elevate those whose recomputed `contactConfidence ≥ JUDGMENT_ELEVATION_THRESHOLD` via `elevateTierToKnown(id, 'judgment')`. This mirrors what the live dispatcher does on inbound, applied retroactively across correspondence history. `trusted` is a grant decision (#952), not derivable here — only the `unknown→known` boundary is re-derived. Idempotent: re-running elevates nothing new once scores are stable.

- [ ] **Step 1: Write the failing test** (`scripts/rederive-contact-tiers.test.ts`)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runRederive } from './rederive-contact-tiers.js';
import { JUDGMENT_ELEVATION_THRESHOLD } from '../src/contacts/confidence-scorer.js';

describe('runRederive', () => {
  it('elevates unknown person/org contacts whose recomputed confidence clears the threshold, leaves others', async () => {
    const unknown = [
      { id: 'a', tier: 'unknown', kind: 'person', contactConfidence: 0 },
      { id: 'b', tier: 'unknown', kind: 'organization', contactConfidence: 0 },
    ];
    // After recompute, 'a' clears the threshold, 'b' does not.
    const confidenceById: Record<string, number> = {
      a: JUDGMENT_ELEVATION_THRESHOLD + 0.1,
      b: JUDGMENT_ELEVATION_THRESHOLD - 0.1,
    };
    const pipeline = {
      fullRecomputeAll: vi.fn().mockResolvedValue(undefined),
      fullRecompute: vi.fn((id: string) => Promise.resolve(confidenceById[id] ?? 0)),
    };
    const contactService = {
      listContacts: vi.fn().mockResolvedValue(unknown),
      elevateTierToKnown: vi.fn().mockResolvedValue(true),
    };

    const result = await runRederive(contactService as never, pipeline as never);

    expect(contactService.elevateTierToKnown).toHaveBeenCalledWith('a', 'judgment');
    expect(contactService.elevateTierToKnown).not.toHaveBeenCalledWith('b', 'judgment');
    expect(result.elevated).toBe(1);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `pnpm -C <worktree> exec vitest run scripts/rederive-contact-tiers.test.ts`
Expected: FAIL — `runRederive` not found.

- [ ] **Step 3: Implement `scripts/rederive-contact-tiers.ts`**

Model on `scripts/backfill-contact-attributes.ts` (pino logger, `pg.Pool`, CLI guard, `DATABASE_URL`). Core:

```typescript
// scripts/rederive-contact-tiers.ts
//
// One-shot re-derivation of contact tiers from correspondence history (#955).
// Recomputes contact_confidence for every contact, then elevates unknown→known
// for person/org contacts whose recomputed confidence clears the judgment
// elevation threshold — the retroactive equivalent of the live dispatcher's
// judgment elevation. 'trusted' is a grant decision (#952), not re-derived here.
//
// Run: pnpm run rederive:contact-tiers
// Safety: idempotent — re-running elevates nothing once scores are stable.

import pg from 'pg';
import pino from 'pino';
import { ContactService } from '../src/contacts/contact-service.js';
import { ConfidencePipeline } from '../src/contacts/confidence-pipeline.js';
import { JUDGMENT_ELEVATION_THRESHOLD } from '../src/contacts/confidence-scorer.js';

const logger = pino({ name: 'rederive-contact-tiers' });
const { Pool } = pg;

type ServiceLike = Pick<ContactService, 'listContacts' | 'elevateTierToKnown'>;
type PipelineLike = Pick<ConfidencePipeline, 'fullRecomputeAll' | 'fullRecompute'>;

export async function runRederive(contactService: ServiceLike, pipeline: PipelineLike): Promise<{
  recomputed: number; elevated: number; skipped: number; errors: number; failedContactIds: string[];
}> {
  // 1. Refresh every contact's confidence from current correspondence stats.
  await pipeline.fullRecomputeAll();

  // 2. Re-list unknown-tier person/org contacts (post-recompute confidence) and elevate those over threshold.
  const candidates = await contactService.listContacts({ tier: 'unknown', kind: ['person', 'organization'] });
  let elevated = 0, skipped = 0, errors = 0;
  const failedContactIds: string[] = [];

  for (const c of candidates) {
    try {
      // fullRecompute returns the freshly-persisted confidence; trust it over the listed snapshot.
      const confidence = await pipeline.fullRecompute(c.id);
      if (confidence >= JUDGMENT_ELEVATION_THRESHOLD) {
        const didElevate = await contactService.elevateTierToKnown(c.id, 'judgment');
        if (didElevate) { elevated++; } else { skipped++; }
      } else {
        skipped++;
      }
    } catch (err) {
      logger.error({ contactId: c.id, err }, 'rederive: contact failed');
      errors++;
      failedContactIds.push(c.id);
    }
  }

  const summary = { recomputed: candidates.length, elevated, skipped, errors, failedContactIds };
  logger.info(summary, 'rederive: done');
  return summary;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) { logger.error('rederive: DATABASE_URL is not set'); process.exit(1); }
  const pool = new Pool({ connectionString: databaseUrl });
  const contactService = ContactService.createWithPostgres(pool, undefined, logger);
  const pipeline = new ConfidencePipeline(contactService, logger);
  runRederive(contactService, pipeline)
    .then(async ({ errors }) => { await pool.end(); process.exit(errors > 0 ? 1 : 0); })
    .catch(async (err) => { logger.error({ err }, 'rederive: fatal error'); await pool.end(); process.exit(1); });
}
```

Note: if `fullRecomputeAll()`'s real signature differs (confirm in `src/contacts/confidence-pipeline.ts`), adapt the call; the per-contact `fullRecompute` loop is the load-bearing part.

- [ ] **Step 4: Add the npm script** to `package.json` (next to `backfill:contact-attributes`):

```json
"rederive:contact-tiers": "tsx scripts/rederive-contact-tiers.ts",
```

- [ ] **Step 5: Run test — verify it passes**

Run: `pnpm -C <worktree> exec vitest run scripts/rederive-contact-tiers.test.ts` → PASS. Then `pnpm -C <worktree> run typecheck`.

- [ ] **Step 6: Commit**

```bash
git -C <worktree> add scripts/rederive-contact-tiers.ts scripts/rederive-contact-tiers.test.ts package.json
git -C <worktree> commit -m "feat: add one-shot contact-tier re-derivation script (#955)"
```

---

## Task 2: Remove `status` from the HTTP contact API (`kg.ts`)

**Files:** Modify `src/channels/http/routes/kg.ts` (lines ~276, ~856–857, ~885, ~931, ~985); Test `src/channels/http/routes/kg.test.ts`.

**Interfaces:** Consumes `ContactService.setTier`, `setKind` (already present). Produces: contact POST/PATCH no longer accept a `status` field; tier/kind are the only capability inputs (already wired by #1055).

- [ ] **Step 1: Update the failing test** — in `kg.test.ts`, change/extend the PATCH + POST contact tests to assert a `status` field in the body is rejected (HTTP 400) or ignored, and that `setStatus` is never called. Add:

```typescript
it('PATCH /api/kg/contacts/:id ignores a legacy status field and does not call setStatus', async () => {
  // setStatus no longer exists on the service — assert the route does not reference it.
  const res = await patchContact(id, { status: 'confirmed' });
  expect(res.statusCode).toBe(400); // unknown field rejected, OR 200 with status ignored — match the route's validation policy
});
```

- [ ] **Step 2: Run test — verify it fails** (`vitest run src/channels/http/routes/kg.test.ts`).
- [ ] **Step 3: Implement** — remove `validContactStatuses` (line 276), the POST `status` default + validation + write (856–857, 885), the PATCH `status` validation + `setStatus` call (931, 985). Where POST previously set `status`, rely on the existing `tier`/`kind` handling. Remove now-unused `ContactStatus` import.
- [ ] **Step 4: Run tests — verify pass** + `typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "refactor(contacts): drop status field from contact HTTP API (#955)"`

---

## Task 3: Stop writing `status`/`trust_level` in contact creation/bootstrap paths

**Files:** Modify `src/contacts/ceo-bootstrap.ts` (97, 139, 176–177), `src/contacts/ensure-principal.ts` (94–95), `src/skills/outbound-gateway.ts` (1042), `src/entity-context/bootstrap.ts` (86). Tests: the co-located `*.test.ts` for each.

**Interfaces:** These INSERTs must set `tier`/`kind`/`system_role` (already in the column lists) and drop `status`/`trust_level`. Principal: `tier='principal'`, `kind='principal'`, `system_role='principal'`. CEO-bootstrap "confirm" semantics become tier checks (`tier='principal'` for the principal; `meetsMinimumTier` elsewhere). Agent contact (entity-context): `kind='agent'`, appropriate tier.

- [ ] **Step 1: Update failing tests** — adjust each module's test to assert the INSERT/UPDATE no longer references `status`/`trust_level` and that the principal row lands at `tier='principal'`/`kind='principal'`/`system_role='principal'`. (For ensure-principal, assert the INSERT column list excludes `status`,`trust_level`.)
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Implement:**
  - `ensure-principal.ts:94–95`: drop `status`,`trust_level` from the column list + `'confirmed'`,`'ceo'` from VALUES.
  - `ceo-bootstrap.ts`: replace the `status === 'confirmed'` gate (97) and `SET status='confirmed'` (139) with tier logic; drop `status`/`trust_level` from the bootstrap INSERT (176–177). Keep `repairPrincipalMetadata` repairing `tier`/`kind`/`system_role`.
  - `outbound-gateway.ts:1042`: remove `status: 'confirmed'` from the create options (the recipient is created at the default `tier` and elevated via the live correspondence path).
  - `entity-context/bootstrap.ts:86`: drop `status` from the INSERT.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** — `git commit -m "refactor(contacts): stop writing legacy status/trust_level in bootstrap paths (#955)"`

---

## Task 4: Retire the confirm-the-person / promote flow in `contact-register`

**Files:** Modify `skills/contact-register/handler.ts` (11–14, 114, 121, 232–245, 273, 334), `skills/contact-register/skill.json` (3, 13–14, 19, 22–23). Test: `skills/contact-register/handler.test.ts`.

**Interfaces:** `contact-register` keeps its core job (register/resolve a contact on contact, update last-seen) but loses: creating at `status:'provisional'`, the `promoteToConfirmed` call, the `ceo_has_sent`/`calendar_accepted` promotion inputs, and the `promoted`/`promotion_signal` outputs. New contacts are created at the default `tier` (`unknown`), and elevation is the live correspondence/judgment path's job — not this skill's.

- [ ] **Step 1: Update failing tests** — in `handler.test.ts`, delete/replace the 14 promotion-signal tests with assertions that: a new unknown sender is registered at `tier='unknown'` (not provisional), the handler never calls `promoteToConfirmed`, and `ceo_has_sent`/`calendar_accepted` inputs are absent from the schema.
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Implement** — strip the promotion branch (handler 232–273), the `status:'provisional'` create (121, default to tier-based create), the promotion inputs/outputs from `skill.json`, and the response `status` field (334). Bump `skill.json` `version` (minor — removing input/output fields is a manifest change). Update the manifest `description`.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** — `git commit -m "refactor(contacts): remove provisional/promote flow from contact-register (#955)"`

---

## Task 5: Remove `status`/`trust_level` from `ContactService` + backends

**Files:** Modify `src/contacts/contact-service.ts` — methods `setStatus` (iface 183 + impl ~1847), `promoteToConfirmed` (iface 193 + impl ~1806), `deriveInitialTier` (64), `deriveTierFromStatusUpdate` (81); `createContact` status option (~1492 INSERT); `listContacts` status filter (179, ~1561); SELECT column lists (~1532, ~1724, ~1788); row mappers (~1744, ~2132) reading `row.status`/`row.trust_level`; `updateStoredContact` SET clause (~1609–1610). Test: `src/contacts/contact-service.test.ts`.

**Interfaces:** After this task `ContactService` exposes `setTier`/`setKind`/`elevateTierToKnown` only for capability changes; no method reads or writes `status`/`trust_level`. `CreateContactOptions` loses `status`. `listContacts` loses the `status` filter (keeps `tier`/`kind`).

- [ ] **Step 1: Update failing tests** — remove/rewrite `setStatus`, `promoteToConfirmed`, `deriveInitialTier`, `deriveTierFromStatusUpdate`, and `listContacts({status})` tests. Add assertions: `createContact` ignores/rejects a `status` option; row mapper returns a `Contact` with no `status`/`trustLevel` field.
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Implement** — delete the four methods + their interface declarations; remove `status` from the createContact INSERT column list/params and the `CreateContactOptions` usage; remove the `status` filter branch from `listContacts`; remove `status`,`trust_level` from every SELECT column list and from the `updateStoredContact` SET clause; delete the `row.status`/`row.trust_level` reads in both row mappers (Pg + InMemory). Remove now-unused `TRUST_RANK`/`TrustLevel` imports if they become unused here.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** — `git commit -m "refactor(contacts): remove status/trust_level from ContactService and backends (#955)"`

---

## Task 6: Remove the `ContactStatus` type, `STATUS_RANK`, and `trustLevel` residue from `types.ts`

**Files:** Modify `src/contacts/types.ts` — `Contact.status` (10) + `Contact.trustLevel` (11); `ContactStatus` type (95); `CreateContactOptions.status` (119); `ResolvedSender.status`/`.trustLevel` (161/162); `SenderContext.status`/`.trustLevel` (179/187–188); `MergeGoldenRecord.status` (406); `STATUS_RANK` (search). Test: `src/contacts/types.test.ts` if present.

**Interfaces:** `Contact` and the resolver/sender contexts carry `tier`/`kind` only for capability; no `status`/`trustLevel` fields remain. Any remaining consumer that destructured `status`/`trustLevel` was already removed in Tasks 2–5.

- [ ] **Step 1: Failing check** — run `pnpm -C <worktree> run typecheck`; it should be GREEN before this task (Tasks 2–5 removed all consumers). If any consumer remains, the typecheck names it — fix that consumer first.
- [ ] **Step 2: Implement** — delete the `status` and `trustLevel` fields from `Contact`, `ResolvedSender`, `SenderContext`, `CreateContactOptions`, `MergeGoldenRecord`; delete the `ContactStatus` type and `STATUS_RANK` const. Update any builder that constructs these interfaces (contact-resolver synthetic principal/fallback objects: drop `status`/`trustLevel` literals).
- [ ] **Step 3: Verify** — `typecheck` GREEN; `grep -rn "ContactStatus\|STATUS_RANK\|\.trustLevel\|'provisional'\|'confirmed'" src --include="*.ts" | grep -v ".test.ts"` returns only legitimate hits (none for these symbols).
- [ ] **Step 4: Run full unit suite** — `pnpm -C <worktree> exec vitest run src/contacts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "refactor(contacts): remove ContactStatus type, STATUS_RANK, and trustLevel residue (#955)"`

---

## Task 7: Migration 059 — drop legacy columns + `held_messages`

**Files:** Create `src/db/migrations/059_drop_legacy_contact_columns.sql`. Test: covered by Task 10 integration test.

- [ ] **Step 1: Confirm next number** — `ls src/db/migrations/ | sort | tail -3` shows `058_*` last. Use `059`.
- [ ] **Step 2: Author migration** (parameter-free DDL; match the `-- Up`/`-- Down` format of `058`):

```sql
-- Up Migration
-- Drop the legacy contact capability columns now fully superseded by tier/kind
-- (status retired in #955; trust_level reads/writes retired in #1070). Also drop
-- the never-used held_messages table (the confirm-the-person hold flow is gone).

ALTER TABLE contacts DROP COLUMN IF EXISTS status;
ALTER TABLE contacts DROP COLUMN IF EXISTS trust_level;
DROP TABLE IF EXISTS held_messages;

-- Down Migration
-- Schema-only rollback. Legacy VALUES are not restorable — tier/kind are the
-- source of truth post-cutover. Columns return nullable with neutral defaults.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS trust_level TEXT;
-- held_messages is intentionally NOT recreated on rollback (dead since before #955).
```

Confirm the exact Down delimiter `058` uses and mirror it. If `held_messages` (migration 056) participates in an FK that blocks `DROP TABLE`, drop the dependent constraint first (verify in 056).

- [ ] **Step 3: Run migrations against the test DB** — `pnpm -C <worktree> run <migrate-script>` (find the migrate command in `package.json`), confirm it applies cleanly and startup succeeds.
- [ ] **Step 4: Commit** — `git commit -m "feat(db): migration 059 drops contacts.status, contacts.trust_level, held_messages (#955)"`

---

## Task 8: Remove the dead `group_held` notification kind

**Files:** Modify `src/bus/events.ts` (176, 185, 1134), `src/skills/outbound-gateway.ts` (stale `notifyCeoGroupHeld` doc-comment ~840). Test: `src/bus/events.test.ts` if it enumerates notification kinds.

**Interfaces:** `group_held` is removed from the notification-kind union. Confirmed no emitter/consumer exists (`notifyCeoGroupHeld` has no definition; no `createNotification` builds it), so removing the union member breaks no switch.

- [ ] **Step 1: Grep gate (pre)** — `grep -rn "group_held\|notifyCeoGroupHeld" src --include="*.ts"` lists only the union member + comments. If a switch/handler references `'group_held'`, stop and handle it.
- [ ] **Step 2: Implement** — remove the `| 'group_held'` union member (185) and its doc lines (176, 1134); remove the stale `SignalAdapter.notifyCeoGroupHeld()` mention in `outbound-gateway.ts`.
- [ ] **Step 3: Verify** — `typecheck` GREEN; grep returns nothing.
- [ ] **Step 4: Commit** — `git commit -m "chore: remove dead group_held notification kind (#955)"`

---

## Task 9: Remove the daily provisional-promotion sweep from `agents/contacts.yaml`

**Files:** Modify `agents/contacts.yaml` — delete the daily sweep schedule (lines 328–408), the "Promotion Sweep — Principal Context" prompt block (135–143), and the provisional-flagging prompt language (112–113, 29–32). **Keep** the weekly dedup schedule (324–326) and the Wed grant-rec schedule (410–433). Bump `version` (2).

- [ ] **Step 1: Implement** — remove the three blocks above. After removal, the `schedule:` list contains exactly the Monday dedup entry and the Wednesday grant-rec entry. Rewrite the provisional prompt lines (112–113) to describe tier-based handling (e.g. "If a contact is `tier: unknown`, treat them in low-trust mode") rather than provisional-confirm. Bump `version: "0.5.0"` → `"0.6.0"` (removing a scheduled capability is a minor change).
- [ ] **Step 2: Verify YAML** — load/lint: `pnpm -C <worktree> run <config-validate-or-test>` (or the agent-config test) confirms `contacts.yaml` parses and has 2 schedules. Grep gate: `grep -n "provisional\|promotion sweep\|promoteToConfirmed" agents/contacts.yaml` returns nothing.
- [ ] **Step 3: Commit** — `git commit -m "chore(agents): remove provisional-promotion sweep from contacts agent (#955)"`

---

## Task 10: Post-cutover data-integrity verification + CHANGELOG

**Files:** Create `tests/integration/contacts-cutover.integration.test.ts`; Modify `CHANGELOG.md`.

- [ ] **Step 1: Write the integration test** (real Postgres, mirrors existing integration tests' harness):

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
// ...use the repo's standard integration DB setup (see an existing *.integration.test.ts)...

describe('contacts cutover (#955) data integrity', () => {
  it('contacts.status and contacts.trust_level columns no longer exist', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'contacts' AND column_name IN ('status','trust_level')`,
    );
    expect(rows).toHaveLength(0);
  });

  it('held_messages table no longer exists', async () => {
    const { rows } = await pool.query(
      `SELECT to_regclass('public.held_messages') AS t`,
    );
    expect(rows[0]!.t).toBeNull();
  });

  it('every contact carries a valid tier and kind', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS bad FROM contacts
       WHERE tier NOT IN ('blocked','unknown','known','trusted','principal')
          OR kind NOT IN ('person','organization','automated','principal','agent')`,
    );
    expect(rows[0]!.bad).toBe(0);
  });
});
```

- [ ] **Step 2: Run** — `pnpm -C <worktree> exec vitest run tests/integration/contacts-cutover.integration.test.ts` (Docker Postgres up) → PASS.
- [ ] **Step 3: Grep gate (whole repo)** — `grep -rn "ContactStatus\|STATUS_RANK\|'provisional'\|setStatus\|promoteToConfirmed\|trust_level\|held_messages\|group_held" src skills agents --include="*.ts" --include="*.json" --include="*.yaml" | grep -v ".test.ts"` returns only intentional historical references (migrations 006/007/055/056 SQL files, CHANGELOG). No live code references remain.
- [ ] **Step 4: Update CHANGELOG** under `## [Unreleased]` → `### Removed`:

```markdown
- **Contacts `status` / `trust_level`** — dropped the legacy `status` and `trust_level` columns; `tier`/`kind` are the sole capability axis. Migration 059. (#955)
- **Confirm-the-person flow** — removed the provisional-promote path, `setStatus`/`promoteToConfirmed`, and the daily provisional-promotion agent sweep. (#955)
- **`held_messages` table & `group_held` event** — removed the dead hold/confirm machinery. (#955)
```

- [ ] **Step 5: Commit** — `git commit -m "test: post-cutover data-integrity checks + CHANGELOG (#955)"`

---

## Self-Review Notes (acceptance-criteria coverage)

- AC "all contacts valid tier/kind; no retired `status` refs in code" → Tasks 2–6 + grep gate (Task 10 Step 3) + integrity test (Task 10 Step 1).
- AC "status + trust_level columns dropped" → Task 7 + integrity test.
- AC "held-message confirm path removed" → Tasks 4 (confirm/promote) + 7 (`held_messages` table) + 8 (`group_held`).
- AC "remove daily provisional sweep; keep weekly dedup" → Task 9 (explicit keep of 324–326 + 410–433).
- AC "no data loss; verification queries pass" → Task 1 re-derivation (preserves capability in `tier`) + Task 10 integrity test.
- Dependency #1070 (trust_level reader/writer retirement) is merged — verified on `main`.

## Pre-PR

Run the auto-review subagents (code-reviewer, silent-failure-hunter; security review since this touches the trust/contacts boundary), then `gh pr create` with `Closes #955`. Confirm CI started.
