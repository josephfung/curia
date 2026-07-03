# Calendar operates as the principal — implementation plan (#1217)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind the one calendar client to the CEO's own Nylas grant (`ceo_nylas_grant_id`) so calendar operations run first-person as the CEO, fixing RSVP `omittedAttendeesSpecified`. Fail closed when no CEO grant is configured.

**Architecture:** Calendar and the CEO's inbox share ONE identity: `ceo_nylas_grant_id` + `nylas_api_key`. We keep the existing `nylasCalendarClient` capability-injection wiring (the "minimal re-source" shape) and change only the grant the boot-constructed client binds to — from the primary email account grant (Curia's mailbox) to `ceo_nylas_grant_id`. No per-skill secret conversion, no new client class. No fallback to the email account grant (that fallback *is* the delegate-identity bug).

**Tech Stack:** TypeScript (ESM, nodenext), Vitest, Nylas v8 SDK, pino, node-pg-migrate. Worktree: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-calendar-principal-grant` on branch `fix/calendar-principal-grant`.

## Global Constraints

- **Worktree only.** All edits/commits happen in the worktree above. `pnpm -C <worktree>` (never `--prefix`), `git -C <worktree>`. No `&&`/`||` chaining in Bash.
- **Typecheck command:** `pnpm -C <WORKTREE> run typecheck` (runs `tsc` for src, `tsconfig.skills.json`, and `tsconfig.tests.json`). Run before every commit touching `.ts`.
- **Test command:** `pnpm -C <WORKTREE> test <path>` (= `vitest run <path>`).
- **ESM:** `.js` extensions on all relative imports; `import.meta.dirname` not `__dirname`; no `any`.
- **Strict null checks:** `array[0]` is `T | undefined` — assert `!` only when guaranteed.
- **No em dashes / no Claude attribution** in commits, PR body, or code comments. Conventional-commit style (`fix:`).
- **Skills return `{success}` — never throw.** The calendar client must fail *gracefully* (a missing `ceo_nylas_grant_id` → client left `undefined` → handler's existing `if (!ctx.nylasCalendarClient)` guard returns a clean "not configured" error).
- **CHANGELOG:** add an `## [Unreleased]` entry. Do NOT bump `package.json` version (that's a release step).
- **Versioning:** bump `skills/calendar-respond-to-invite/skill.json` (patch) and `agents/calendar.yaml` (patch) — only these two files change behavior/wording; the other 9 calendar skills are untouched.
- **Design decisions locked with Joseph (2026-07-02):** fail-closed (no email fallback); minimal re-source (keep capability injection); registry-defaults NOT modified.

---

## Non-goals (explicitly out of scope)

- **`config/registry-defaults.yaml` is NOT modified.** The pinned issue comment is correct: adding `calendar-*` there contradicts credential-gating, is a no-op for existing prod (rows already exist), and is inert on fresh installs (the calendar *agent* stays excluded, so nothing pins these skills). Record the rationale in the PR body. Separate operational follow-up: "warn when a registry enable takes effect only after a restart."
- **No per-skill secret conversion.** The 10 calendar handlers and their manifests keep `capabilities: ["nylasCalendarClient"]` and are not touched (except `calendar-respond-to-invite` wording). Chosen shape: minimal re-source.
- **No prod DB writes in this PR.** The `contact_calendars` re-registration is an operator cutover step (Task 6), run post-merge.
- **No `curia-docs` change in this PR.** Flag a follow-up: public docs should note calendar requires the CEO grant.

---

## Task 1: Resolve the principal calendar grant (fail-closed) + boot wiring

**Files:**
- Create: `src/channels/calendar/resolve-calendar-grant.ts`
- Test: `src/channels/calendar/resolve-calendar-grant.test.ts`
- Modify: `src/index.ts` (calendar client construction ~776-784; add import near other `channels/calendar` imports)

**Interfaces:**
- Produces: `resolvePrincipalCalendarGrant(secrets: { get(name: string): Promise<string | null> }, logger: Logger): Promise<string | undefined>` — returns the trimmed `ceo_nylas_grant_id`, or `undefined` when absent/blank/on read error. NO email fallback.
- Consumes: `secretsService` (already constructed at `src/index.ts:283`), `config.nylasApiKey`.

- [ ] **Step 1: Write the failing test**

Create `src/channels/calendar/resolve-calendar-grant.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolvePrincipalCalendarGrant } from './resolve-calendar-grant.js';
import { createSilentLogger } from '../../logger.js';

function secretsReturning(value: string | null) {
  return { get: vi.fn().mockResolvedValue(value) };
}

describe('resolvePrincipalCalendarGrant', () => {
  it('returns the CEO grant when configured', async () => {
    const grant = await resolvePrincipalCalendarGrant(secretsReturning('grant_ceo_123'), createSilentLogger());
    expect(grant).toBe('grant_ceo_123');
  });

  it('trims surrounding whitespace', async () => {
    const grant = await resolvePrincipalCalendarGrant(secretsReturning('  grant_ceo_123  '), createSilentLogger());
    expect(grant).toBe('grant_ceo_123');
  });

  it('returns undefined (fail closed) when the CEO grant is absent — NO email fallback', async () => {
    const grant = await resolvePrincipalCalendarGrant(secretsReturning(null), createSilentLogger());
    expect(grant).toBeUndefined();
  });

  it('returns undefined when the CEO grant is whitespace-only', async () => {
    const grant = await resolvePrincipalCalendarGrant(secretsReturning('   '), createSilentLogger());
    expect(grant).toBeUndefined();
  });

  it('returns undefined and does not throw when the vault read fails', async () => {
    const secrets = { get: vi.fn().mockRejectedValue(new Error('vault down')) };
    const grant = await resolvePrincipalCalendarGrant(secrets, createSilentLogger());
    expect(grant).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C <WORKTREE> test src/channels/calendar/resolve-calendar-grant.test.ts`
Expected: FAIL — cannot find module `./resolve-calendar-grant.js`.

- [ ] **Step 3: Write the helper**

Create `src/channels/calendar/resolve-calendar-grant.ts`:

```ts
import type { Logger } from '../../logger.js';

/**
 * Resolve the Nylas grant the calendar client operates as.
 *
 * Calendar is FIRST-PERSON: Nylas/Google `sendRsvp` records the response of the
 * attendee whose identity matches the authenticated grant. So the calendar client
 * must bind to the CEO's OWN grant (`ceo_nylas_grant_id`) — the same identity the
 * ceo-inbox skills use — not to Curia's mailbox grant. Binding to Curia's mailbox
 * made Curia a third-party delegate, and Google rejected RSVPs with
 * `omittedAttendeesSpecified` (#1217).
 *
 * Fail closed: with no `ceo_nylas_grant_id` configured there is no principal to act
 * as, so this returns `undefined` and the calendar client is left unconstructed
 * (calendar skills then return a clean "not configured" result). We deliberately do
 * NOT fall back to the primary email account grant — that fallback is exactly the
 * delegate-identity bug this change removes.
 */
export async function resolvePrincipalCalendarGrant(
  secrets: { get(name: string): Promise<string | null> },
  logger: Logger,
): Promise<string | undefined> {
  let grant: string | null;
  try {
    grant = await secrets.get('ceo_nylas_grant_id');
  } catch (err) {
    // A vault read failure must not crash boot; calendar degrades to disabled.
    logger.warn({ err }, 'ceo_nylas_grant_id lookup failed — calendar will be disabled this boot');
    return undefined;
  }
  // Coalesce null -> '' before trimming so a missing entry and a whitespace-only
  // value both resolve to "not configured" rather than a grant that fails auth.
  const trimmed = (grant ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C <WORKTREE> test src/channels/calendar/resolve-calendar-grant.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire it into boot**

In `src/index.ts`, add the import alongside the other `channels/calendar` import(s):

```ts
import { resolvePrincipalCalendarGrant } from './channels/calendar/resolve-calendar-grant.js';
```

Replace the calendar client construction block (currently ~776-784):

```ts
  // Calendar client — uses the primary email account's Nylas credentials.
  // For multi-account deployments the calendar is always associated with the first
  // (primary) account; a future spec can extend this to per-account calendars.
  let nylasCalendarClient: NylasCalendarClient | undefined;
  if (config.nylasApiKey && primaryNylasClient && resolvedEmailAccounts.length > 0) {
    const primaryAccount = resolvedEmailAccounts[0]!;
    nylasCalendarClient = new NylasCalendarClient(config.nylasApiKey, primaryAccount.nylasGrantId, logger);
    logger.info('Nylas calendar client initialized');
  }
```

with:

```ts
  // Calendar client — operates as the PRINCIPAL (the CEO), not as Curia's mailbox.
  // RSVP is first-person: Nylas/Google records the response of the attendee whose
  // identity matches the authenticated grant. So the calendar client binds to the
  // CEO's OWN grant (ceo_nylas_grant_id) — the same identity ceo-inbox uses. Binding
  // to Curia's mailbox grant made Curia a third-party delegate, and Google rejected
  // RSVPs with `omittedAttendeesSpecified` (#1217).
  //
  // Fail closed: with no CEO grant configured there is no principal to act as, so the
  // client is left undefined and calendar skills return a clean "not configured"
  // result via their existing `if (!ctx.nylasCalendarClient)` guard. We deliberately
  // do NOT fall back to the email account grant — that is the delegate-identity bug
  // this change removes.
  const principalCalendarGrant = await resolvePrincipalCalendarGrant(secretsService, logger);
  let nylasCalendarClient: NylasCalendarClient | undefined;
  if (config.nylasApiKey && principalCalendarGrant) {
    nylasCalendarClient = new NylasCalendarClient(config.nylasApiKey, principalCalendarGrant, logger);
    logger.info('Nylas calendar client initialized (bound to the CEO/principal Nylas grant)');
  } else if (config.nylasApiKey) {
    logger.warn(
      'Calendar disabled — ceo_nylas_grant_id is not configured. Set the CEO Nylas grant to enable calendar (RSVP/holds/events run as the CEO).',
    );
  }
```

NOTE: do NOT remove the `primaryNylasClient` declaration (line ~746) — it is still used at `src/index.ts:1641`. Only remove its use from this gate.

- [ ] **Step 6: Typecheck**

Run: `pnpm -C <WORKTREE> run typecheck`
Expected: PASS (no errors). If `NylasCalendarClient` import becomes the only remaining reason `resolvedEmailAccounts` is read here — it isn't; `resolvedEmailAccounts` is used elsewhere — no lint fallout expected.

- [ ] **Step 7: Commit**

```bash
git -C <WORKTREE> add src/channels/calendar/resolve-calendar-grant.ts src/channels/calendar/resolve-calendar-grant.test.ts src/index.ts
git -C <WORKTREE> commit -m "fix: bind calendar client to the CEO grant, fail closed (#1217)"
```

---

## Task 2: Strengthen the `sendRsvp` request-shape pin

**Files:**
- Modify: `src/channels/calendar/nylas-calendar-client.test.ts` (the "sends RSVP status through the Nylas sendRsvp endpoint" test, ~100-116)

**Interfaces:** none new. Hardens acceptance criterion 3: fails if attendee data ever leaks into the RSVP body.

- [ ] **Step 1: Add the stronger assertion**

In the existing RSVP test, after the current `expect(sendRsvp).toHaveBeenCalledWith(...)`, add an assertion that the request body has EXACTLY the `status` key (no `participants`/attendee leakage):

```ts
    // Pin the body shape: sendRsvp must carry ONLY { status } — never a participants
    // array or any attendee data (that would risk changing another attendee's state).
    const call = sendRsvp.mock.calls[0]![0];
    expect(Object.keys(call.requestBody)).toEqual(['status']);
    expect(call.requestBody).not.toHaveProperty('participants');
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm -C <WORKTREE> test src/channels/calendar/nylas-calendar-client.test.ts`
Expected: PASS (all tests including the strengthened RSVP test).

- [ ] **Step 3: Commit**

```bash
git -C <WORKTREE> add src/channels/calendar/nylas-calendar-client.test.ts
git -C <WORKTREE> commit -m "test: pin sendRsvp body to { status } only (#1217)"
```

---

## Task 3: Correct `calendar-respond-to-invite` identity wording + version bump

**Files:**
- Modify: `skills/calendar-respond-to-invite/skill.json` (line 11 `account` input description; `version`)
- Modify: `skills/calendar-respond-to-invite/handler.ts` (line 73 warning text)

**Interfaces:** none. Cosmetic/accuracy: describe the real (now-CEO) identity.

- [ ] **Step 1: Fix the manifest wording + bump version**

In `skills/calendar-respond-to-invite/skill.json`, change the `account` input description (line 11) to:

```json
    "account": "string? (named account hint; informational — the calendar client is bound to the CEO's own Nylas grant (ceo_nylas_grant_id), so RSVP always runs as the CEO regardless of this hint)",
```

and bump `"version": "0.1.1"` -> `"version": "0.1.2"`.

- [ ] **Step 2: Fix the handler warning**

In `skills/calendar-respond-to-invite/handler.ts`, change line ~73:

```ts
      warnings.push('account is informational; RSVP ran under the CEO\'s own Nylas grant (ceo_nylas_grant_id)');
```

- [ ] **Step 3: Run the handler test + typecheck**

Run: `pnpm -C <WORKTREE> test skills/calendar-respond-to-invite/handler.test.ts`
Expected: PASS (the account-warning test, if it asserts the exact string, may need its expected string updated — update the test to match the new wording if it fails on the literal).
Run: `pnpm -C <WORKTREE> run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C <WORKTREE> add skills/calendar-respond-to-invite/skill.json skills/calendar-respond-to-invite/handler.ts skills/calendar-respond-to-invite/handler.test.ts
git -C <WORKTREE> commit -m "fix: describe CEO-grant identity in calendar-respond-to-invite (#1217)"
```

---

## Task 4: Collapse the "my vs your calendar" disambiguation in `agents/calendar.yaml`

**Files:**
- Modify: `agents/calendar.yaml` (Entity Resolution ~20-34; Calendar Disambiguation ~36-47; Account Identity for Calendar Skills ~49-54; `version`)

**Interfaces:** none. The calendar client is unconditionally the CEO's; the agent has no separate calendar identity. Verified: the 01:00 holds-sweep cron already runs CEO-scoped (`${principal_contact_id}`), and nothing writes to an agent-owned calendar.

- [ ] **Step 1: Rewrite the Entity Resolution intro**

Replace the first paragraph of `## Entity Resolution` (the `${agent_contact_id}` / "what's your calendar look like?" lines) with:

```yaml
  ## Entity Resolution
  Your contact ID is ${agent_contact_id}. This is the ONLY contact ID you should EVER
  use directly for your own agent identity — NEVER derive or guess contact IDs from
  names. You do NOT operate a calendar of your own: the calendar client is bound to the
  CEO's Nylas grant, so every calendar operation acts on the CEO's calendar (see
  "Calendar Identity" below).
```

(Leave the `<resolved_entities>` and "given only a name" paragraphs unchanged.)

- [ ] **Step 2: Replace both calendar-ownership sections with one "Calendar Identity" section**

Delete `## Calendar Disambiguation` and `## Account Identity for Calendar Skills` entirely and replace with:

```yaml
  ## Calendar Identity
  You operate the CEO's calendar, and only the CEO's calendar. The calendar client is
  bound to the CEO's own Nylas grant (the same identity the CEO's inbox uses), so there
  is no separate "Curia calendar" or agent calendar to choose between. Every event,
  RSVP, hold, free/busy query, and registration runs as the CEO.

  - "my calendar" (the CEO speaking), "the CEO's calendar", and "your calendar" all
    resolve to the same place: the CEO's calendar.
  - To resolve the CEO's registered calendar IDs and timezone, use
    `${principal_contact_id}` (injected at bootstrap) with `entity-context`. Do NOT
    call `contact-lookup` by role for the CEO.
  - You cannot create events on a calendar of your own — there is none. If asked to
    "block your own time", treat it as blocking time on the CEO's calendar.
```

- [ ] **Step 3: Bump the agent version**

Change `version: "0.6.0"` -> `version: "0.6.1"`.

- [ ] **Step 4: Typecheck (YAML is validated at load; run the agent discovery test if present)**

Run: `pnpm -C <WORKTREE> run typecheck`
Expected: PASS.
(Optional) Run any agent-manifest discovery test: `pnpm -C <WORKTREE> test agents` — expected PASS if such a test exists; skip if none.

- [ ] **Step 5: Commit**

```bash
git -C <WORKTREE> add agents/calendar.yaml
git -C <WORKTREE> commit -m "fix: collapse calendar agent to single CEO-calendar identity (#1217)"
```

---

## Task 5: Update the design memo + CHANGELOG

**Files:**
- Modify: `docs/wip/2026-07-01-calendar-principal-grant-design.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Correct the memo to reflect the locked decisions**

In `docs/wip/2026-07-01-calendar-principal-grant-design.md`:
- In the **Decision** block, change the resolution from `ceo_nylas_grant_id ?? resolvedEmailAccounts[0]?.nylasGrantId` to `ceo_nylas_grant_id` only (fail closed, no email fallback).
- In **Migration / operations → "Deployments without a CEO grant"**, replace "the fallback preserves today's behavior (primary account)" with: calendar is **disabled** (fail closed) when no CEO grant is configured; single-identity/self-host deployments must set `ceo_nylas_grant_id`.
- Append an **"## Implementation decisions (2026-07-02)"** section recording: (a) minimal re-source — kept the `nylasCalendarClient` capability injection, changed only the bound grant; (b) fail-closed, no email fallback; (c) `registry-defaults.yaml` NOT modified (contradicts credential-gating, no-op on prod, inert on fresh installs); (d) follow-ups: "warn on registry-enable-needs-restart" and a curia-docs note that calendar requires the CEO grant.

- [ ] **Step 2: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md`:

```markdown
- **calendar** — the calendar client now operates as the CEO (binds to `ceo_nylas_grant_id`), fixing RSVP failures (`omittedAttendeesSpecified`) caused by acting as a third-party delegate on the CEO's calendar; fails closed when no CEO grant is configured. (#1217)
```

- [ ] **Step 3: Commit**

```bash
git -C <WORKTREE> add docs/wip/2026-07-01-calendar-principal-grant-design.md CHANGELOG.md
git -C <WORKTREE> commit -m "docs: record calendar principal-grant decisions + changelog (#1217)"
```

---

## Task 6: Document the operator cutover (contact_calendars re-registration)

**Files:**
- Modify: `docs/wip/2026-07-01-calendar-principal-grant-design.md` (add a "## Cutover steps (operator)" section)

**Why:** Nylas calendar IDs are grant-scoped. The CEO's existing `contact_calendars` row points at a calendar ID under the OLD grant (Curia's mailbox), which does not resolve under `ceo_nylas_grant_id`. It must be re-registered once after deploy.

- [ ] **Step 1: Write the cutover section**

Add to the memo:

```markdown
## Cutover steps (operator, post-merge)

Run once after the fix is deployed and the container restarted (boot rebinds the
calendar client to `ceo_nylas_grant_id`):

1. Confirm `ceo_nylas_grant_id` is set in the vault (calendar boots only when it is;
   the log line "bound to the CEO/principal Nylas grant" confirms it).
2. List the CEO's own calendars under the new grant (via the calendar agent or a
   one-off): `calendar-list-calendars` now enumerates the CEO's calendars. Note the
   CEO's PRIMARY calendar ID.
3. Re-point the CEO's `contact_calendars` row to that primary calendar ID. The old
   row holds the previous grant's (shared) calendar ID. Either:
   - `calendar-register` the new ID to `${principal_contact_id}` with `is_primary: true`
     (handle the unique-constraint on the existing primary), or
   - a parameterized SQL one-off updating the existing row's `nylas_calendar_id`
     (run via `docker exec curia-curia-1` per the prod one-off runbook).
4. Orphaned holds: HOLD (TBC) events created under the old grant's calendar ID orphan.
   `calendar-holds-sweep` tolerates staleness; optionally clear them at cutover.

Exact commands to be produced at cutover time (Joseph runs; step-by-step).
```

- [ ] **Step 2: Commit**

```bash
git -C <WORKTREE> add docs/wip/2026-07-01-calendar-principal-grant-design.md
git -C <WORKTREE> commit -m "docs: add calendar principal-grant cutover runbook (#1217)"
```

---

## Final verification (before PR)

- [ ] `pnpm -C <WORKTREE> run typecheck` — PASS
- [ ] `pnpm -C <WORKTREE> test src/channels/calendar/` — PASS (helper + client tests)
- [ ] `pnpm -C <WORKTREE> test skills/calendar-respond-to-invite/` — PASS
- [ ] `git -C <WORKTREE> log --oneline origin/main..HEAD` — review the commit series
- [ ] Auto-review (parallel): `pr-review-toolkit:code-reviewer` + `pr-review-toolkit:silent-failure-hunter` on the branch diff. Address high-priority findings.
- [ ] PR body includes `Closes #1217`, the registry-defaults rationale, the fail-closed deviation from the original AC1 wording, and links the design memo.

## Handoff (cannot be done in this PR)

- **AC2 — live RSVP verification.** After merge + cutover, verify accept/decline/tentative against a REAL invite under the CEO grant with no Google 400. I cannot run this (needs the live grant + a real invite). Offer Joseph a standalone script or `docker exec` one-liner.
  - **Fallback ready:** if the Nylas SDK `sendRsvp` misbehaves under the CEO grant (e.g. PATCHes the full event instead of hitting the send-rsvp endpoint), switch `NylasCalendarClient.sendRsvp` to a raw `fetch` mirroring `CeoNylasClient`. Do NOT pre-emptively add this — only if the live test shows it.
- **Operational follow-up issue:** "warn when a registry enable takes effect only after a restart."
- **curia-docs follow-up:** note that calendar now requires the CEO Nylas grant (`ceo_nylas_grant_id`).
