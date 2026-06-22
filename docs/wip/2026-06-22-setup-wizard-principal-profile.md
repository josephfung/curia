# Setup Wizard — Principal Operational Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a principal operational-profile step (timezone, email, preferred name, title, working hours) to the form-based setup wizard, and stop Step 1 from permanently auto-skipping so the principal's name can be confirmed/corrected.

**Architecture:** All profile data persists on the existing principal **contact** (canonical columns `timezone`, `preferred_name`, `title`, `primary_email`) and its **KG node** (a `working_hours` fact). Email is written as a verified `ceo_stated` channel identity so `index.ts` resolves `principalEmail` from it after the wizard-end restart. The system clock / `config.timezone` is **not** touched (deferred to a follow-up). Three setup endpoints back the flow: `GET /api/setup/principal` (load), extended `POST /api/setup/principal` (create-or-rename), new `POST /api/setup/principal/profile` (write profile).

**Tech Stack:** TypeScript (ESM, Node 24+), Fastify, PostgreSQL + pgvector, Vitest, React (apps/console, TanStack Router).

## Global Constraints

- ESM only; `.js` extensions on all relative imports; `import.meta.dirname` not `__dirname`.
- No `any`; no `console.log` (pino only); no empty `catch {}` — log, then handle/propagate.
- Parameterized SQL only (`$1` placeholders); never interpolate into SQL strings.
- Run `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-profile-392 run typecheck` before every commit touching `.ts`.
- Integration tests use real Postgres; they `describe.skip` when `DATABASE_URL` is unset. Run with `DATABASE_URL` pointed at an **empty** test DB (the partial unique index on `system_role='principal'` trips otherwise).
- Commit style: `feat:` / `fix:` / `chore:`; **no** `Co-Authored-By`, **no** Claude attribution anywhere.
- Conventions doc to honour: `CLAUDE.md` "Strict TypeScript Patterns" (array access `arr[0]!`, cast through `unknown`).
- All test/run commands below use the worktree path; the shell's CWD does not persist between calls, so always pass `-C <worktree>` / `--prefix <worktree>`.

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-profile-392` (branch `feat/setup-profile-392`). Abbreviated `$WT` below.

---

## File Structure

**Backend (create):**
- `src/contacts/working-hours.ts` — pure types + serializer (structured working hours → readable string).
- `src/contacts/working-hours.test.ts` — unit tests for the serializer.

**Backend (modify):**
- `src/channels/http/routes/setup.ts` — add `contactService` + `entityMemory` to options; extend `POST /api/setup/principal`; add `GET /api/setup/principal` and `POST /api/setup/principal/profile`.
- `src/channels/http/http-adapter.ts` — add `entityMemory` to config; pass `contactService` + `entityMemory` into `setupRoutes`.
- `src/index.ts` — pass `entityMemory` into the `HttpAdapter` config.
- `tests/integration/setup-routes.test.ts` — build real `ContactService` + `EntityMemory`; new endpoint tests.

**Frontend (modify):**
- `apps/console/src/pages/wizard-utils.ts` — profile fields on `WizardState`, working-hours type, timezone detect + validators, profile payload builder.
- `apps/console/src/pages/wizard-utils.test.ts` — unit tests for the new helpers.
- `apps/console/src/pages/WizardPage.tsx` — remove auto-skip; pre-populate Step 1; add Step 2 "Your details"; renumber; mount-load via `GET /api/setup/principal`; submit Step 2 via `POST /api/setup/principal/profile`.

**Docs (modify):**
- `docs/dev/setup.md` — reference the wizard for operational-profile configuration.
- `CHANGELOG.md` — `[Unreleased]` entries.

---

## Task 1: Working-hours serializer (pure, backend)

**Files:**
- Create: `src/contacts/working-hours.ts`
- Test: `src/contacts/working-hours.test.ts`

**Interfaces:**
- Produces: `interface WorkingHours { start: string; end: string; days: number[] }` (days: 0=Sun..6=Sat); `function serializeWorkingHours(wh: WorkingHours): string`; `function validateWorkingHours(value: unknown): WorkingHours | null` (returns the normalized object or `null` if malformed).

- [ ] **Step 1: Write the failing test**

```ts
// src/contacts/working-hours.test.ts
import { describe, it, expect } from 'vitest';
import { serializeWorkingHours, validateWorkingHours } from './working-hours.js';

describe('serializeWorkingHours', () => {
  it('formats weekdays as a Mon–Fri range', () => {
    expect(serializeWorkingHours({ start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }))
      .toBe('Mon–Fri, 9:00 AM–5:00 PM');
  });
  it('formats all seven days as Sun–Sat', () => {
    expect(serializeWorkingHours({ start: '08:30', end: '16:00', days: [0, 1, 2, 3, 4, 5, 6] }))
      .toBe('Sun–Sat, 8:30 AM–4:00 PM');
  });
  it('lists non-contiguous days individually', () => {
    expect(serializeWorkingHours({ start: '10:00', end: '14:00', days: [1, 3, 5] }))
      .toBe('Mon, Wed, Fri, 10:00 AM–2:00 PM');
  });
  it('formats a single day', () => {
    expect(serializeWorkingHours({ start: '00:00', end: '12:00', days: [2] }))
      .toBe('Tue, 12:00 AM–12:00 PM');
  });
});

describe('validateWorkingHours', () => {
  it('accepts a well-formed object and sorts/dedupes days', () => {
    expect(validateWorkingHours({ start: '09:00', end: '17:00', days: [5, 1, 1, 3] }))
      .toEqual({ start: '09:00', end: '17:00', days: [1, 3, 5] });
  });
  it('rejects a bad time', () => {
    expect(validateWorkingHours({ start: '9am', end: '17:00', days: [1] })).toBeNull();
  });
  it('rejects an out-of-range day', () => {
    expect(validateWorkingHours({ start: '09:00', end: '17:00', days: [7] })).toBeNull();
  });
  it('rejects an empty day list', () => {
    expect(validateWorkingHours({ start: '09:00', end: '17:00', days: [] })).toBeNull();
  });
  it('rejects non-objects', () => {
    expect(validateWorkingHours(null)).toBeNull();
    expect(validateWorkingHours('mon-fri')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx --prefix $WT vitest run src/contacts/working-hours.test.ts`
Expected: FAIL — `Cannot find module './working-hours.js'`.

- [ ] **Step 3: Implement the module**

```ts
// src/contacts/working-hours.ts
//
// Pure helpers for the principal's working-hours profile (issue #392).
//
// Working hours are NOT a canonical contact column (see canonical-attribute-guard.ts),
// so they are stored as a KG fact on the principal's node and surfaced to agents by the
// entity-context assembler. The wizard collects them structured; the setup endpoint
// serializes to a human-readable string for the fact value (richer for KG browsing and
// better for LLM consumption than raw JSON).

/** Structured working hours. days: 0=Sunday .. 6=Saturday. */
export interface WorkingHours {
  start: string; // "HH:MM" 24h
  end: string;   // "HH:MM" 24h
  days: number[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Validate + normalize an untrusted value into WorkingHours, or null if malformed. */
export function validateWorkingHours(value: unknown): WorkingHours | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.start !== 'string' || !HHMM.test(v.start)) return null;
  if (typeof v.end !== 'string' || !HHMM.test(v.end)) return null;
  if (!Array.isArray(v.days) || v.days.length === 0) return null;
  const days: number[] = [];
  for (const d of v.days) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) return null;
    if (!days.includes(d)) days.push(d);
  }
  days.sort((a, b) => a - b);
  return { start: v.start, end: v.end, days };
}

/** "09:00" → "9:00 AM"; "17:00" → "5:00 PM"; "00:00" → "12:00 AM". */
function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  const hour = h!;
  const meridiem = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(m!).padStart(2, '0')} ${meridiem}`;
}

/** Render days: a fully-contiguous run becomes "Mon–Fri"; otherwise "Mon, Wed, Fri". */
function formatDays(days: number[]): string {
  const isContiguous =
    days.length >= 2 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  if (isContiguous) return `${DAY_ABBR[days[0]!]}–${DAY_ABBR[days[days.length - 1]!]}`;
  return days.map((d) => DAY_ABBR[d]).join(', ');
}

/** Structured working hours → readable string stored in the KG fact value. */
export function serializeWorkingHours(wh: WorkingHours): string {
  return `${formatDays(wh.days)}, ${formatTime(wh.start)}–${formatTime(wh.end)}`;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx --prefix $WT vitest run src/contacts/working-hours.test.ts`
Expected: PASS (10 assertions).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C $WT run typecheck
git -C $WT add src/contacts/working-hours.ts src/contacts/working-hours.test.ts
git -C $WT commit -m "feat: add working-hours serializer for principal profile (#392)"
```

---

## Task 2: Thread `contactService` + `entityMemory` into setup routes

This is enabling plumbing for Tasks 3–5: the new endpoints need `ContactService` (canonical writes, identity link, display-name update) and `EntityMemory` (working-hours fact). Make both **required** options and update every call site + the test harness so existing tests keep compiling and passing.

**Files:**
- Modify: `src/channels/http/routes/setup.ts:27-61` (SetupRouteOptions), `:75-84` (destructure)
- Modify: `src/channels/http/http-adapter.ts:60-80` (HttpAdapterConfig — add `entityMemory`), `:314-336` (register call)
- Modify: `src/index.ts` (HttpAdapter construction — pass `entityMemory`)
- Modify: `tests/integration/setup-routes.test.ts:49-95` (build real services, pass them)

**Interfaces:**
- Consumes: `ContactService` from `../../../contacts/contact-service.js`; `EntityMemory` from `../../../memory/entity-memory.js`.
- Produces: `SetupRouteOptions` now has `contactService: ContactService` and `entityMemory: EntityMemory`.

- [ ] **Step 1: Add the two required options to `SetupRouteOptions`**

In `src/channels/http/routes/setup.ts`, add imports near the top:

```ts
import type { ContactService } from '../../../contacts/contact-service.js';
import type { EntityMemory } from '../../../memory/entity-memory.js';
```

Add to the `SetupRouteOptions` interface (after `pool`):

```ts
  /** Canonical contact writes + identity linking for the principal profile step (#392). */
  contactService: ContactService;
  /** KG fact store for the principal's working-hours fact (#392). */
  entityMemory: EntityMemory;
```

And add them to the destructure in `setupRoutes`:

```ts
  const {
    webAppBootstrapSecret,
    sessions,
    pool,
    logger,
    setupRequiredAtBoot,
    bootStartedAt,
    scheduleProcessExit,
    infraLlmService,
    contactService,
    entityMemory,
  } = options;
```

- [ ] **Step 2: Add `entityMemory` to `HttpAdapterConfig` and pass both through**

In `src/channels/http/http-adapter.ts`, the config interface already has `contactService: ContactService;` (line ~67). Add alongside it:

```ts
  entityMemory: EntityMemory;
```

Add the import if absent: `import type { EntityMemory } from '../../memory/entity-memory.js';`

In the `setupRoutes` registration (line ~314), add:

```ts
        contactService: this.config.contactService,
        entityMemory: this.config.entityMemory,
```

- [ ] **Step 3: Pass `entityMemory` into `HttpAdapter` from `index.ts`**

In `src/index.ts`, the `new HttpAdapter({ ... })` config (line ~2044) already passes `contactService`. Add `entityMemory,` to that object. `entityMemory` is in scope (assigned at `src/index.ts:531`).

> Note: `entityMemory` may be typed `EntityMemory | undefined` at that point if construction is conditional. Verify: if it can be `undefined`, the setup routes only register when `webAppBootstrapSecret` is set; gate or assert non-null. Inspect `src/index.ts:531` — if `entityMemory` is unconditional, pass directly. If conditional, pass `entityMemory` and widen `HttpAdapterConfig.entityMemory` to `EntityMemory` only if guaranteed; otherwise make the new endpoints 503 when it's absent. Prefer: confirm it's always constructed (the wizard requires the KG) and keep the type non-optional.

- [ ] **Step 4: Update the integration-test harness to build + pass the services**

In `tests/integration/setup-routes.test.ts`, add imports:

```ts
import { ContactService } from '../../src/contacts/contact-service.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
```

In `beforeAll`, after `pool` is created, build the services (mirrors `tests/integration/contacts.test.ts:36-40`):

```ts
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    const entityMemory = new EntityMemory(kgStore, validator, embeddingService, createSilentLogger());
    const contactService = ContactService.createWithPostgres(pool, entityMemory, logger);
```

Pass them into both `buildApp` registrations by adding to the `setupRoutes` options inside `buildApp`:

```ts
        contactService,
        entityMemory,
```

(Make `buildApp` close over the outer `contactService`/`entityMemory`, or add them as params — closing over is simplest.)

Extend the `afterAll` cleanup to clear KG rows the new tests create:

```ts
    await pool.query('DELETE FROM kg_edges');
    await pool.query('DELETE FROM kg_nodes');
```
(Keep the existing principal/identity deletes; order: identities → contacts → edges → nodes.)

- [ ] **Step 5: Typecheck + run existing setup tests, verify still green**

```bash
pnpm -C $WT run typecheck
npx --prefix $WT vitest run tests/integration/setup-routes.test.ts
```
Expected: PASS (existing cases) when `DATABASE_URL` is set; SKIP otherwise. Typecheck clean.

- [ ] **Step 6: Commit**

```bash
git -C $WT add src/channels/http/routes/setup.ts src/channels/http/http-adapter.ts src/index.ts tests/integration/setup-routes.test.ts
git -C $WT commit -m "chore: wire contactService + entityMemory into setup routes (#392)"
```

---

## Task 3: Extend `POST /api/setup/principal` to rename an existing principal

When the principal already exists and the submitted name differs from the current display name, update it (so Step 1 can correct a name) instead of the current no-op. Best-effort sync of the KG person-node label so KG browsing shows the right name.

**Files:**
- Modify: `src/channels/http/routes/setup.ts:102-135`
- Test: `tests/integration/setup-routes.test.ts`

**Interfaces:**
- Consumes: `contactService.updateDisplayName(contactId, name)`, `contactService.findContactBySystemRole('principal')`.
- Produces: response unchanged shape `{ contactId, kgNodeId, alreadyExisted, renamed: boolean }` (adds `renamed`).

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/setup-routes.test.ts` (inside the principal describe block):

```ts
it('renames the principal when called again with a different name', async () => {
  const first = await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
    payload: { name: 'Original Name' },
  });
  expect(first.statusCode).toBe(200);
  const { contactId } = first.json();

  const second = await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
    payload: { name: 'Corrected Name' },
  });
  expect(second.statusCode).toBe(200);
  const body = second.json();
  expect(body.alreadyExisted).toBe(true);
  expect(body.renamed).toBe(true);
  expect(body.contactId).toBe(contactId);

  const row = await pool.query<{ display_name: string }>(
    `SELECT display_name FROM contacts WHERE id = $1`, [contactId],
  );
  expect(row.rows[0]!.display_name).toBe('Corrected Name');
});

it('does not rename when the same name is submitted', async () => {
  await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
    payload: { name: 'Same Name' },
  });
  const again = await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
    payload: { name: 'Same Name' },
  });
  expect(again.json().renamed).toBe(false);
});
```

> Each `it` must start from a clean principal. Add a `beforeEach` in this block that runs the same delete as `beforeAll` (`DELETE FROM contact_channel_identities WHERE contact_id IN (...principal...)` then `DELETE FROM contacts WHERE system_role='principal'`), if one isn't already present.

- [ ] **Step 2: Run, verify failure**

Run: `npx --prefix $WT vitest run tests/integration/setup-routes.test.ts -t "renames the principal"`
Expected: FAIL — `renamed` is `undefined` (route doesn't set it / doesn't rename).

- [ ] **Step 3: Implement the rename branch**

Replace the `try` block body in `POST /api/setup/principal`:

```ts
    try {
      const result = await ensurePrincipalContact({ displayName: trimmed }, pool, logger);
      let renamed = false;
      if (result.alreadyExisted) {
        // The principal already exists. Step 1 is no longer auto-skipped (#392), so a
        // second submit is the operator correcting the name — apply it instead of no-op'ing.
        const current = await contactService.findContactBySystemRole('principal');
        if (current && current.displayName !== trimmed) {
          await contactService.updateDisplayName(result.contactId, trimmed);
          renamed = true;
          // Best-effort: keep the KG person-node label in sync so KG browsing shows the
          // corrected name. The unique index idx_kg_nodes_unique (lower(label), type) can
          // reject the rename if another non-fact node already owns that label; that's
          // non-fatal — the contact column is the authoritative display name.
          try {
            await pool.query(
              `UPDATE kg_nodes SET label = $1, last_confirmed_at = now()
                 WHERE id = $2 AND type = 'person'`,
              [trimmed, result.kgNodeId],
            );
          } catch (kgErr) {
            logger.warn(
              { kgErr, kgNodeId: result.kgNodeId },
              'POST /api/setup/principal: KG label rename skipped (likely label collision); contact display_name still updated',
            );
          }
        }
      }
      return reply.send({
        contactId: result.contactId,
        kgNodeId: result.kgNodeId,
        alreadyExisted: result.alreadyExisted,
        renamed,
      });
    } catch (err) {
      logger.error({ err }, 'POST /api/setup/principal: failed to ensure principal contact');
      return reply.status(500).send({
        error: 'Failed to create principal contact. Check server logs.',
      });
    }
```

- [ ] **Step 4: Run, verify pass**

Run: `npx --prefix $WT vitest run tests/integration/setup-routes.test.ts -t "principal"`
Expected: PASS (new rename cases + existing principal cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C $WT run typecheck
git -C $WT add src/channels/http/routes/setup.ts tests/integration/setup-routes.test.ts
git -C $WT commit -m "feat: allow setup wizard to rename an existing principal (#392)"
```

---

## Task 4: `GET /api/setup/principal` — load the principal profile

Returns the current principal's name + profile so the wizard can pre-populate Steps 1 and 2.

**Files:**
- Modify: `src/channels/http/routes/setup.ts` (add route)
- Test: `tests/integration/setup-routes.test.ts`

**Interfaces:**
- Consumes: `contactService.findContactBySystemRole`, `contactService.getContactWithIdentities`.
- Produces: `GET /api/setup/principal` → `{ exists: boolean, displayName: string | null, timezone: string | null, preferredName: string | null, title: string | null, email: string | null, workingHours: string | null }`. `email` is the verified+active email identity's identifier; `workingHours` is the stored fact's value string.

- [ ] **Step 1: Write the failing test**

```ts
it('GET /api/setup/principal returns { exists:false } when no principal', async () => {
  // beforeEach has cleared the principal
  const res = await appSetupMode.inject({
    method: 'GET', url: '/api/setup/principal', headers: AUTH_HEADER,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ exists: false, displayName: null });
});

it('GET /api/setup/principal returns the persisted profile', async () => {
  await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER,
    payload: { name: 'Profile Owner' },
  });
  await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
    payload: {
      timezone: 'America/Vancouver',
      email: 'owner@example.com',
      preferredName: 'Owner',
      title: 'CEO',
      workingHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
    },
  });

  const res = await appSetupMode.inject({
    method: 'GET', url: '/api/setup/principal', headers: AUTH_HEADER,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    exists: true,
    displayName: 'Profile Owner',
    timezone: 'America/Vancouver',
    preferredName: 'Owner',
    title: 'CEO',
    email: 'owner@example.com',
    workingHours: 'Mon–Fri, 9:00 AM–5:00 PM',
  });
});
```

> This test depends on Task 5's profile endpoint. Implement Task 4's route first (so the GET exists), then Task 5; run this test green at the end of Task 5. To keep Task 4 independently runnable, also keep the `{exists:false}` case (passes without Task 5).

- [ ] **Step 2: Run, verify the `{exists:false}` case fails**

Run: `npx --prefix $WT vitest run tests/integration/setup-routes.test.ts -t "exists:false"`
Expected: FAIL — 404 (route not found).

- [ ] **Step 3: Implement the route**

Add after the existing `POST /api/setup/principal` handler. Helper to read the working-hours fact uses the same KG traversal the assembler uses (`relates_to` edges to `type='fact'` nodes, `properties.attribute='working_hours'`):

```ts
  // -- GET /api/setup/principal --
  //
  // Loads the principal's name + operational profile so the wizard can pre-populate
  // Steps 1 and 2 (#392). Returns { exists:false } (not 404) when no principal yet —
  // the wizard treats that as a fresh install.
  app.get('/api/setup/principal', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const principal = await contactService.findContactBySystemRole('principal');
      if (!principal) {
        return reply.send({
          exists: false, displayName: null, timezone: null,
          preferredName: null, title: null, email: null, workingHours: null,
        });
      }
      const withIdentities = await contactService.getContactWithIdentities(principal.id);
      const email = (withIdentities?.identities ?? [])
        .find((i) => i.channel === 'email' && i.verified && i.status === 'active')
        ?.channelIdentifier ?? null;

      // Working-hours fact: a 'fact' node linked to the principal's KG node whose
      // properties.attribute === 'working_hours'. Mirrors the assembler's getFacts query.
      let workingHours: string | null = null;
      if (principal.kgNodeId) {
        const facts = await pool.query<{ value: string | null }>(
          `SELECT n.properties->>'value' AS value
             FROM kg_edges e JOIN kg_nodes n ON n.id = e.target_node_id
            WHERE e.source_node_id = $1 AND e.type = 'relates_to'
              AND n.type = 'fact' AND lower(n.properties->>'attribute') = 'working_hours'
            ORDER BY n.last_confirmed_at DESC LIMIT 1`,
          [principal.kgNodeId],
        );
        workingHours = facts.rows[0]?.value ?? null;
      }

      return reply.send({
        exists: true,
        displayName: principal.displayName,
        timezone: principal.timezone ?? null,
        preferredName: principal.preferredName ?? null,
        title: principal.title ?? null,
        email,
        workingHours,
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/setup/principal: failed to load principal profile');
      return reply.status(500).send({ error: 'Failed to load principal profile. Check server logs.' });
    }
  });
```

> Verify `Contact` exposes `displayName`, `timezone`, `preferredName`, `title`, `kgNodeId` (it does — `src/contacts/types.ts:3-53`). Verify `getContactWithIdentities` returns `{ identities }` (used at `src/index.ts:669`).

- [ ] **Step 4: Run the `{exists:false}` case, verify pass**

Run: `npx --prefix $WT vitest run tests/integration/setup-routes.test.ts -t "exists:false"`
Expected: PASS. (The full-profile case goes green after Task 5.)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C $WT run typecheck
git -C $WT add src/channels/http/routes/setup.ts tests/integration/setup-routes.test.ts
git -C $WT commit -m "feat: add GET /api/setup/principal profile load (#392)"
```

---

## Task 5: `POST /api/setup/principal/profile` — persist the profile

Writes timezone/preferred-name/title to canonical columns, links a verified `ceo_stated` email then sets `primary_email`, and stores working hours as a KG fact.

**Files:**
- Modify: `src/channels/http/routes/setup.ts` (add route; import working-hours helpers, `Intl` guard)
- Test: `tests/integration/setup-routes.test.ts`

**Interfaces:**
- Consumes: `contactService.findContactBySystemRole`, `contactService.linkIdentity`, `contactService.updateContactFields`, `entityMemory.storeFact`; `validateWorkingHours`, `serializeWorkingHours` from `../../../contacts/working-hours.js`.
- Produces: `POST /api/setup/principal/profile` → `{ ok: true }` on success; `400`/`422` on validation; `409` when no principal; `500` on failure.

- [ ] **Step 1: Write the failing tests**

```ts
it('POST profile rejects an invalid timezone with 422', async () => {
  await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER, payload: { name: 'TZ Tester' },
  });
  const res = await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
    payload: { timezone: 'Mars/Olympus_Mons' },
  });
  expect(res.statusCode).toBe(422);
});

it('POST profile 409s when no principal exists', async () => {
  const res = await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
    payload: { timezone: 'America/Toronto' },
  });
  expect(res.statusCode).toBe(409);
});

it('POST profile writes canonical fields, links a verified email, and stores a working-hours fact', async () => {
  const created = await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER, payload: { name: 'Full Profile' },
  });
  const { contactId, kgNodeId } = created.json();

  const res = await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
    payload: {
      timezone: 'America/Vancouver', email: 'FULL@Example.com',
      preferredName: 'Full', title: 'Founder',
      workingHours: { start: '08:00', end: '16:00', days: [1, 2, 3, 4, 5] },
    },
  });
  expect(res.statusCode).toBe(200);

  const contact = await pool.query<{ timezone: string; preferred_name: string; title: string; primary_email: string }>(
    `SELECT timezone, preferred_name, title, primary_email FROM contacts WHERE id = $1`, [contactId],
  );
  expect(contact.rows[0]).toMatchObject({
    timezone: 'America/Vancouver', preferred_name: 'Full', title: 'Founder',
    primary_email: 'full@example.com', // lower-cased
  });

  const ident = await pool.query<{ verified: boolean; status: string; source: string }>(
    `SELECT verified, status, source FROM contact_channel_identities
       WHERE contact_id = $1 AND channel = 'email'`, [contactId],
  );
  expect(ident.rows[0]).toMatchObject({ verified: true, status: 'active', source: 'ceo_stated' });

  const fact = await pool.query<{ value: string }>(
    `SELECT n.properties->>'value' AS value FROM kg_edges e JOIN kg_nodes n ON n.id = e.target_node_id
       WHERE e.source_node_id = $1 AND n.type = 'fact'
         AND lower(n.properties->>'attribute') = 'working_hours' LIMIT 1`, [kgNodeId],
  );
  expect(fact.rows[0]!.value).toBe('Mon–Fri, 8:00 AM–4:00 PM');
});

it('POST profile leaves omitted optional fields untouched', async () => {
  const created = await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal', headers: AUTH_HEADER, payload: { name: 'Partial' },
  });
  const { contactId } = created.json();
  await appSetupMode.inject({
    method: 'POST', url: '/api/setup/principal/profile', headers: AUTH_HEADER,
    payload: { timezone: 'America/Toronto', title: 'CTO' },
  });
  const row = await pool.query<{ preferred_name: string | null; primary_email: string | null }>(
    `SELECT preferred_name, primary_email FROM contacts WHERE id = $1`, [contactId],
  );
  expect(row.rows[0]).toMatchObject({ preferred_name: null, primary_email: null });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx --prefix $WT vitest run tests/integration/setup-routes.test.ts -t "POST profile"`
Expected: FAIL — 404 (route not found).

- [ ] **Step 3: Implement the route**

Add imports at the top of `setup.ts`:

```ts
import { validateWorkingHours, serializeWorkingHours } from '../../../contacts/working-hours.js';
```

Add a simple email syntactic check near the other constants:

```ts
// Pragmatic address shape check — full RFC validation is unnecessary; the address is
// the principal's own and is normalized to lowercase before linking.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

Add the route:

```ts
  // -- POST /api/setup/principal/profile --
  //
  // Persists the principal operational profile collected in the wizard's "Your details"
  // step (#392): timezone + preferred name + title onto canonical contact columns; the
  // email as a verified ceo_stated channel identity (so index.ts resolves principalEmail
  // after the wizard-end restart); working hours as a KG fact surfaced by entity-context.
  // Requires the principal to exist (created in Step 1). Omitted optional fields are not
  // written, so a partial submit never clobbers an existing value.
  app.post('/api/setup/principal/profile', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = (request.body ?? {}) as {
      timezone?: unknown; email?: unknown; preferredName?: unknown;
      title?: unknown; workingHours?: unknown;
    };

    // timezone is required and must be a real IANA zone (same guard as config.ts).
    if (typeof body.timezone !== 'string' || body.timezone.trim().length === 0) {
      return reply.status(400).send({ error: 'timezone is required.' });
    }
    const timezone = body.timezone.trim();
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return reply.status(422).send({ error: `"${timezone}" is not a recognized IANA timezone.` });
    }

    // Optional fields — validate shape before any write.
    let email: string | undefined;
    if (body.email !== undefined && body.email !== null && body.email !== '') {
      if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email.trim())) {
        return reply.status(422).send({ error: 'email is not a valid address.' });
      }
      email = body.email.trim().toLowerCase();
    }
    const preferredName =
      typeof body.preferredName === 'string' && body.preferredName.trim() ? body.preferredName.trim() : undefined;
    const title =
      typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;

    let workingHoursValue: string | undefined;
    if (body.workingHours !== undefined && body.workingHours !== null) {
      const wh = validateWorkingHours(body.workingHours);
      if (!wh) return reply.status(422).send({ error: 'workingHours is malformed.' });
      workingHoursValue = serializeWorkingHours(wh);
    }

    try {
      const principal = await contactService.findContactBySystemRole('principal');
      if (!principal) {
        return reply.status(409).send({ error: 'No principal exists yet — complete Step 1 first.' });
      }

      // Email first: updateContactFields validates primaryEmail against existing channel
      // identities, so the identity must be linked before primary_email is set. ceo_stated
      // is auto-verified (AUTO_VERIFIED_SOURCES), so this lands verified+active.
      if (email) {
        await contactService.linkIdentity({
          contactId: principal.id, channel: 'email', channelIdentifier: email,
          source: 'ceo_stated', verified: true,
        });
      }

      // Canonical columns — only defined fields are written (updateContactFields drops
      // undefined entries, so omitted optionals are never clobbered).
      await contactService.updateContactFields(principal.id, {
        timezone,
        ...(preferredName !== undefined ? { preferredName } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(email !== undefined ? { primaryEmail: email } : {}),
      });

      // Working hours → KG fact on the principal's node. Carries properties.attribute so
      // storeFact runs contradiction detection (a wizard re-run updates, not duplicates).
      if (workingHoursValue && principal.kgNodeId) {
        await entityMemory.storeFact({
          entityNodeId: principal.kgNodeId,
          label: 'Working hours',
          properties: { attribute: 'working_hours', value: workingHoursValue, category: 'preference' },
          confidence: 1.0,
          decayClass: 'permanent',
          source: 'system:setup-wizard',
        });
      }

      return reply.send({ ok: true });
    } catch (err) {
      logger.error({ err }, 'POST /api/setup/principal/profile: failed to persist profile');
      return reply.status(500).send({ error: 'Failed to save profile. Check server logs.' });
    }
  });
```

- [ ] **Step 4: Run profile + GET full-profile tests, verify pass**

Run: `npx --prefix $WT vitest run tests/integration/setup-routes.test.ts`
Expected: PASS (all setup-routes cases, including Task 4's full-profile case).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C $WT run typecheck
git -C $WT add src/channels/http/routes/setup.ts tests/integration/setup-routes.test.ts
git -C $WT commit -m "feat: add POST /api/setup/principal/profile (#392)"
```

---

## Task 6: Wizard utils — profile state, helpers, validators (frontend, pure)

**Files:**
- Modify: `apps/console/src/pages/wizard-utils.ts`
- Test: `apps/console/src/pages/wizard-utils.test.ts`

**Interfaces:**
- Produces:
  - `interface WizardWorkingHours { start: string; end: string; days: number[] }`
  - `WizardState` gains: `timezone: string`, `email: string`, `preferredName: string`, `principalTitle: string`, `workingHours: WizardWorkingHours | null`.
  - `function detectBrowserTimezone(): string` — `Intl.DateTimeFormat().resolvedOptions().timeZone` with a safe `'America/Toronto'` fallback.
  - `function validateProfileEmail(email: string): string | null` — `null` when empty (optional) or valid; error string when malformed.
  - `function buildProfilePayload(state: WizardState): { timezone: string; email?: string; preferredName?: string; title?: string; workingHours?: WizardWorkingHours }` — omits empties.

- [ ] **Step 1: Write the failing tests**

Add to `apps/console/src/pages/wizard-utils.test.ts`:

```ts
import {
  detectBrowserTimezone, validateProfileEmail, buildProfilePayload, DEFAULT_WIZARD_STATE,
} from './wizard-utils.js';

describe('validateProfileEmail', () => {
  it('returns null for empty (optional field)', () => {
    expect(validateProfileEmail('')).toBeNull();
    expect(validateProfileEmail('   ')).toBeNull();
  });
  it('returns null for a valid address', () => {
    expect(validateProfileEmail('a@b.com')).toBeNull();
  });
  it('returns an error for a malformed address', () => {
    expect(validateProfileEmail('not-an-email')).toMatch(/valid/i);
  });
});

describe('buildProfilePayload', () => {
  it('includes timezone and omits empty optionals', () => {
    const state = { ...DEFAULT_WIZARD_STATE, timezone: 'America/Vancouver' };
    expect(buildProfilePayload(state)).toEqual({ timezone: 'America/Vancouver' });
  });
  it('includes provided optionals and trims them', () => {
    const state = {
      ...DEFAULT_WIZARD_STATE, timezone: 'America/Toronto',
      email: '  Me@Example.com ', preferredName: ' Jo ', principalTitle: ' CEO ',
      workingHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
    };
    expect(buildProfilePayload(state)).toEqual({
      timezone: 'America/Toronto', email: 'Me@Example.com', preferredName: 'Jo',
      title: 'CEO', workingHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
    });
  });
});

describe('detectBrowserTimezone', () => {
  it('returns a non-empty IANA-looking string', () => {
    expect(detectBrowserTimezone()).toMatch(/^[A-Za-z]+\/[A-Za-z_]+/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx --prefix $WT vitest run apps/console/src/pages/wizard-utils.test.ts`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Implement**

In `wizard-utils.ts`, add the type and extend `WizardState`:

```ts
export interface WizardWorkingHours {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
  days: number[]; // 0=Sun..6=Sat
}
```

Add to the `WizardState` interface (after `principalName`):

```ts
  // Step 2 — Your details (principal operational profile, #392).
  timezone: string;
  email: string;
  preferredName: string;
  principalTitle: string; // distinct from `title` (the assistant's title, Step 3)
  workingHours: WizardWorkingHours | null;
```

Extend `DEFAULT_WIZARD_STATE`:

```ts
  timezone: '',
  email: '',
  preferredName: '',
  principalTitle: '',
  workingHours: null,
```

Add helpers:

```ts
// Browser timezone detection for the Step 2 prefill (#392). Falls back to the
// backend default if the platform doesn't expose a resolved zone.
export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Toronto';
  } catch {
    return 'America/Toronto';
  }
}

const PROFILE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Email is optional in Step 2. Returns null when blank (allowed) or valid; an error
// string when present-but-malformed.
export function validateProfileEmail(email: string): string | null {
  const trimmed = email.trim();
  if (trimmed.length === 0) return null;
  if (!PROFILE_EMAIL_RE.test(trimmed)) return 'Enter a valid email address.';
  return null;
}

// Builds the POST /api/setup/principal/profile body, omitting empty optionals so the
// backend never clobbers an existing value with a blank.
export function buildProfilePayload(state: WizardState): {
  timezone: string; email?: string; preferredName?: string; title?: string;
  workingHours?: WizardWorkingHours;
} {
  const payload: {
    timezone: string; email?: string; preferredName?: string; title?: string;
    workingHours?: WizardWorkingHours;
  } = { timezone: state.timezone.trim() };
  if (state.email.trim()) payload.email = state.email.trim();
  if (state.preferredName.trim()) payload.preferredName = state.preferredName.trim();
  if (state.principalTitle.trim()) payload.title = state.principalTitle.trim();
  if (state.workingHours) payload.workingHours = state.workingHours;
  return payload;
}
```

> The existing `buildIdentityPayload` and other helpers are unaffected. `principalTitle` is deliberately named to avoid colliding with `state.title` (the assistant's title).

- [ ] **Step 4: Run, verify pass**

Run: `npx --prefix $WT vitest run apps/console/src/pages/wizard-utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C $WT run typecheck
git -C $WT add apps/console/src/pages/wizard-utils.ts apps/console/src/pages/wizard-utils.test.ts
git -C $WT commit -m "feat: wizard-utils profile state + helpers (#392)"
```

---

## Task 7: WizardPage — pre-populate Step 1, add Step 2, wire endpoints

**Files:**
- Modify: `apps/console/src/pages/WizardPage.tsx`

**Interfaces:**
- Consumes: `GET /api/setup/principal`, `POST /api/setup/principal`, `POST /api/setup/principal/profile`; helpers from Task 6.

- [ ] **Step 1: Bump `TOTAL_STEPS` and add the principal-profile response type**

`const TOTAL_STEPS = 6;` (was 5).

Add a response interface near `SetupStatusResponse`:

```ts
interface PrincipalProfileResponse {
  exists: boolean;
  displayName: string | null;
  timezone: string | null;
  preferredName: string | null;
  title: string | null;
  email: string | null;
  workingHours: string | null; // serialized string; the form keeps its own structured state
}
```

- [ ] **Step 2: Remove the auto-skip effect and pre-populate from the principal**

Delete the auto-skip `useEffect` (`WizardPage.tsx:214-218`). In the mount `load()` effect, after fetching identity/status, also fetch the principal and merge into state:

```ts
        const principalRes = await apiFetch('/api/setup/principal');
        if (principalRes.ok) {
          const p = await principalRes.json() as PrincipalProfileResponse;
          setState(s => ({
            ...s,
            principalName: p.displayName ?? s.principalName,
            timezone: p.timezone ?? detectBrowserTimezone(),
            email: p.email ?? '',
            preferredName: p.preferredName ?? '',
            principalTitle: p.title ?? '',
            // workingHours stays structured in the form; a returning operator re-enters it
            // if they want to change it. (The string is shown as the current value hint.)
          }));
        } else {
          setState(s => ({ ...s, timezone: detectBrowserTimezone() }));
        }
```

Add the import: `detectBrowserTimezone, validateProfileEmail, buildProfilePayload` to the existing `wizard-utils.js` import block. `setPrincipalExists` is no longer needed for skipping — keep it only if other code reads it; otherwise remove the state and its setter.

- [ ] **Step 3: Renumber the existing render branches**

The render switches on `currentStep`. Shift the existing Assistant identity / Tone / Posture / Review branches from steps 2/3/4/5 to **3/4/5/6**. Insert the new Step 2 between Step 1 and the (now) Step 3. The Step 1 "About you" render (currently `WizardPage.tsx:539-584`) stays as step 1; ensure its input is bound to `state.principalName` (pre-populated) and has no skip.

- [ ] **Step 4: Implement the Step 2 "Your details" render + continue handler**

Add a `handleProfileContinue` that validates and POSTs, mirroring `handlePrincipalContinue`'s pattern (it already POSTs the name; ensure the principal exists before profile by calling `POST /api/setup/principal` with `state.principalName` in Step 1's continue, which already happens):

```tsx
async function handleProfileContinue(): Promise<void> {
  const tzError = state.timezone.trim() ? null : 'Select your timezone.';
  const emailError = validateProfileEmail(state.email);
  if (tzError || emailError) {
    setProfileError(tzError ?? emailError);
    return;
  }
  setProfileError(null);
  try {
    const res = await apiFetch('/api/setup/principal/profile', {
      method: 'POST',
      body: JSON.stringify(buildProfilePayload(state)),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      setProfileError(data.error ?? 'Could not save your details. Please try again.');
      return;
    }
    await goTo(3);
  } catch {
    setProfileError('Could not save your details. Please try again.');
  }
}
```

Step 2 form fields (follow the existing wizard's input/label styling already in the file):
- **Timezone** (required): a `<select>` of IANA zones. Source the list from `Intl.supportedValuesOf('timeZone')` with a fallback to a small hardcoded list if unavailable; default the selected value to `state.timezone`.
- **Email** (optional): `<input type="email">` bound to `state.email`; show `emailError` inline.
- **Preferred name** (optional): `<input>` bound to `state.preferredName`.
- **Title** (optional): `<input>` bound to `state.principalTitle`.
- **Working hours** (optional): start/end `<input type="time">` bound to `state.workingHours?.start/.end` and 7 weekday toggle buttons updating `state.workingHours.days`. Leaving it untouched keeps `workingHours: null` (skippable). When the operator sets times/days, assemble a `WizardWorkingHours`.
- A "Continue" button calling `handleProfileContinue`, and a "Back" to step 1.

Add `const [profileError, setProfileError] = useState<string | null>(null);` with the other `useState` hooks.

- [ ] **Step 5: Verify typecheck + console build**

```bash
pnpm -C $WT run typecheck
pnpm -C $WT run build
```
Expected: both succeed. (If the console app has a separate build script, e.g. `build:console`, run that; check `package.json` scripts.)

- [ ] **Step 6: Manual smoke (document, not automated)**

With a local empty DB and the app running (`pnpm -C $WT dev`), load `/setup`: Step 1 shows the name input (pre-populated if a principal exists), Step 2 shows timezone pre-filled from the browser, optional fields skippable, Continue advances to the assistant-identity step. Note the result in the PR description.

- [ ] **Step 7: Commit**

```bash
git -C $WT add apps/console/src/pages/WizardPage.tsx
git -C $WT commit -m "feat: add principal operational-profile step to setup wizard (#392)"
```

---

## Task 8: Docs, changelog, follow-up issue

**Files:**
- Modify: `docs/dev/setup.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `docs/dev/setup.md`**

Add a short subsection under the setup/onboarding section: the wizard now collects the principal's operational profile (timezone, email, preferred name, title, working hours) on the "Your details" step; the email is stored as a verified principal identity used after the wizard-end restart; **the system timezone (`TIMEZONE` env / cron scheduler) is still env-driven** — the wizard's timezone informs agent reasoning via entity-context, and aligning the system clock is tracked as a follow-up. Read the file first and match its existing heading style.

- [ ] **Step 2: Update `CHANGELOG.md`**

Under `## [Unreleased]`:

```markdown
### Added
- **Setup wizard — principal operational profile** — new "Your details" step captures the principal's timezone, email, preferred name, title, and working hours; email is stored as a verified identity that comes online after the wizard's restart. (#392)

### Fixed
- **Setup wizard — name step** — Step 1 no longer auto-skips when a principal exists; it pre-populates the current name so it can be corrected. (#392)
```

- [ ] **Step 3: Commit**

```bash
git -C $WT add docs/dev/setup.md CHANGELOG.md
git -C $WT commit -m "docs: document setup wizard principal profile + changelog (#392)"
```

- [ ] **Step 4: File the follow-up issue (after PR, manual)**

Create a GitHub issue: "make system timezone track the principal's contact timezone" — labels per repo convention (`enhancement`, `identities`, a `size:` label), acceptance criteria covering the cron scheduler / `config.timezone` reading the principal's contact timezone at boot, and how a mid-session timezone change is handled. Reference #392. (Draft as markdown first per upstream-workflow preference; do not file without confirmation.)

---

## Self-Review

**Spec coverage:**
- AC "Step 1 does not auto-skip; pre-populated" → Task 7 Step 2.
- AC "wizard captures timezone (required)" → Task 5 (server validation) + Task 7 (required select).
- AC "timezone pre-populates from browser locale" → Task 6 `detectBrowserTimezone` + Task 7 mount.
- AC "selected timezone persists to DB and is used by the runtime without env change/restart" → `contacts.timezone` (Task 5), surfaced live to agents via entity-context (existing assembler). **System clock/scheduler explicitly deferred** — documented in spec + Task 8 + follow-up issue.
- AC "collects/confirms principal email; persists to DB-backed config the restart picks up" → verified `ceo_stated` identity (Task 5); `index.ts` resolves `principalEmail` from it post-restart (existing).
- AC "working hours, preferred name, title optional/skippable" → Task 5 (optional handling) + Task 6/7.
- AC "first-time deployer ends timezone-aware" → agent reasoning timezone-aware via enrichment; system-clock caveat documented.
- AC "Steps 2–4 (assistant identity) unaffected" → Task 7 renumbers only; no behavior change.
- AC "docs/dev/setup.md references the wizard" → Task 8.

**Placeholder scan:** none — every code step has full code; manual-smoke step is explicitly documentation, not a code placeholder.

**Type consistency:** `WizardWorkingHours` (frontend) vs `WorkingHours` (backend) are intentionally separate (different packages, identical shape). `principalTitle` (Step 2, principal) is distinct from `title` (Step 3, assistant) — checked across Tasks 6 and 7. Response field names (`displayName`, `timezone`, `preferredName`, `title`, `email`, `workingHours`) match between Task 4 (GET) and Task 7 (consumer).
