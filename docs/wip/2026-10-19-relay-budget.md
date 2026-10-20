# Relay Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap how many immediate messages to the principal an outside contact (tier `known` or below) can cause, sending the excess to the principal's digest instead (#1320).

**Architecture:** A new in-memory `RelayBudget` (sliding one-hour window per originator contact id) sits inside `OutboundGateway.send()` between the content filter and the band review. Send skills pass the task's `originator` on a new send option. When a budgeted send to the principal alone is over budget, the gateway publishes a `relay_deferred` digest item, sends one notice per window, records an `autonomy.relay_deferred` audit event and returns `{ success: true, deferredToDigest: true }`.

**Tech Stack:** TypeScript (ESM, Node 24), Vitest, pino, the Curia bus (`src/bus/events.ts`, `src/bus/permissions.ts`).

**Spec:** `docs/wip/2026-10-19-relay-budget-design.md`

## Global Constraints

- Budgeted only when: principal is the sole recipient; not `isSystemNotification`, not `humanApproved`, not `principalDirected`; `originator` present, `systemRole` not `principal`/`system`/`agent`, tier `known`, `unknown`, `blocked` or missing (missing counts as `unknown`).
- `trusted` and `principal`-tier originators are never budgeted. A send with no `originator` is never budgeted.
- Config: `autonomy.relay_budget.per_hour`, integer ≥ 0, default `3`; `0` turns the budget off. Window is one hour (3,600,000 ms).
- Over budget: digest item first (source `relay_deferred`, urgency `digest`, full redacted text); if that publish throws, deliver the relay and log an error.
- Notice text, verbatim: `[name] has more updates. I'm holding them for your digest.` Email subject: `Holding updates from [name]`. Fallback name: `A contact` (sentence start) / `a contact` (mid-sentence).
- Neither the log line nor the audit event carries message content.
- Applies under both `autonomy.gating: tier` and `band`.
- Commits: conventional style, `git commit -s`, no Co-Authored-By, no Claude credits.
- Run `pnpm -C <worktree> run typecheck` before every commit touching `.ts`. Use `pnpm -C`, never `--prefix`. No `&&` chaining in shell.
- Don't refer to the principal as "CEO" in new code, docs or comments.

## Review Focus

1. **Notice recursion.** The notice is sent through `send()` itself; it must skip the budget (system notification) or one over-budget relay loops forever. Pinned in Task 3 ("the notice is sent once and is not itself budgeted").
2. **A relay that goes to several recipients including the principal** (email with cc) must never be deferred — the other recipients would never get it. Pinned in Task 3's exemption table (`principal not sole recipient`).
3. **Content-filter blocks win.** A relay the filter blocks must be blocked, not queued, and must not consume budget. Pinned in Task 3 ("a filter-blocked relay is blocked, not deferred, and does not count").
4. **Missing display name / contact lookup throws.** The deferral must still happen with "a contact". Pinned in Task 3 ("falls back to 'a contact' when the lookup throws").
5. **The coordinator retrying on another channel.** The skill result must say success with a "do not re-send" note, so the agent doesn't fall back to Signal after email. Pinned in Task 4 (each skill surfaces `deferred_to_digest` and the note).

---

### Task 1: `RelayBudget` and its config

**Files:**
- Create: `src/autonomy/relay-budget.ts`
- Create: `tests/unit/autonomy/relay-budget.test.ts`
- Create: `tests/unit/config.relay-budget.test.ts`
- Modify: `src/config.ts` (YamlConfig `autonomy` type near line 777; new resolver after `resolveAutonomyGating` near line 256; validation in `loadYamlConfig` after the `autonomy.gating` check near line 1426)
- Modify: `schemas/default-config.schema.json` (add `relay_budget` beside `report_fallback`, near line 486)
- Modify: `config/default.yaml` (add `relay_budget` under `autonomy:`, after `report_fallback`)

**Interfaces:**
- Produces:
  - `export const RELAY_BUDGET_WINDOW_MS = 3_600_000;`
  - `export class RelayBudget { constructor(opts: { perHour: number; now?: () => number }); tryAcquire(contactId: string): 'allowed' | 'over'; shouldNotify(contactId: string): boolean; count(contactId: string): number; trackedCount(): number }`
  - `export function budgetedOriginator(options: { isSystemNotification?: boolean; humanApproved?: boolean; principalDirected?: boolean; originator?: TaskOriginator } | undefined): TaskOriginator | null`
  - `export interface RelayBudgetConfig { perHour: number }` and `export function resolveRelayBudgetConfig(yaml: YamlConfig['autonomy']): RelayBudgetConfig` in `src/config.ts`

- [ ] **Step 1: Write the failing `RelayBudget` tests**

`tests/unit/autonomy/relay-budget.test.ts`:

```ts
// relay-budget.test.ts — the per-originator cap on relays to the principal (#1320).
import { describe, it, expect } from 'vitest';
import { RelayBudget, RELAY_BUDGET_WINDOW_MS, budgetedOriginator } from '../../../src/autonomy/relay-budget.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('RelayBudget', () => {
  it('allows perHour relays per originator, then reports over', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 3, now: c.now });
    expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.tryAcquire('a')).toBe('over');
    // Another originator has its own budget.
    expect(budget.tryAcquire('b')).toBe('allowed');
  });

  it('does not count an over-budget relay', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 1, now: c.now });
    budget.tryAcquire('a');
    budget.tryAcquire('a');
    budget.tryAcquire('a');
    expect(budget.count('a')).toBe(1);
  });

  it('slides: a relay frees up an hour after the oldest one', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 2, now: c.now });
    budget.tryAcquire('a');
    c.advance(10 * 60_000);
    budget.tryAcquire('a');
    expect(budget.tryAcquire('a')).toBe('over');
    c.advance(RELAY_BUDGET_WINDOW_MS - 10 * 60_000); // the first relay is now an hour old
    expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.tryAcquire('a')).toBe('over');
  });

  it('is off at perHour 0', () => {
    const budget = new RelayBudget({ perHour: 0 });
    for (let i = 0; i < 50; i++) expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.trackedCount()).toBe(0);
  });

  it('notifies once per window per originator', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 1, now: c.now });
    expect(budget.shouldNotify('a')).toBe(true);
    expect(budget.shouldNotify('a')).toBe(false);
    expect(budget.shouldNotify('b')).toBe(true);
    c.advance(RELAY_BUDGET_WINDOW_MS - 1);
    expect(budget.shouldNotify('a')).toBe(false);
    c.advance(1);
    expect(budget.shouldNotify('a')).toBe(true);
  });

  it('forgets originators that have gone quiet for a window', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 3, now: c.now });
    budget.tryAcquire('a');
    budget.shouldNotify('a');
    budget.tryAcquire('b');
    expect(budget.trackedCount()).toBe(2);
    c.advance(RELAY_BUDGET_WINDOW_MS);
    budget.tryAcquire('c'); // any call past a window sweeps idle keys
    expect(budget.trackedCount()).toBe(1);
  });

  it('rejects a negative or fractional perHour', () => {
    expect(() => new RelayBudget({ perHour: -1 })).toThrow(/perHour/);
    expect(() => new RelayBudget({ perHour: 1.5 })).toThrow(/perHour/);
  });
});

describe('budgetedOriginator', () => {
  function originator(over: Partial<TaskOriginator> = {}): TaskOriginator {
    return { contactId: 'c-1', systemRole: null, channel: 'email', initiatedAt: '2026-10-19T12:00:00Z', tier: 'known', ...over };
  }

  it.each(['known', 'unknown', 'blocked'] as const)('budgets a %s originator', (tier) => {
    expect(budgetedOriginator({ originator: originator({ tier }) })?.contactId).toBe('c-1');
  });

  it('budgets an originator with no tier, as unknown (#1059 fails closed)', () => {
    expect(budgetedOriginator({ originator: originator({ tier: null }) })).not.toBeNull();
    const { tier: _omit, ...noTier } = originator();
    expect(budgetedOriginator({ originator: noTier as TaskOriginator })).not.toBeNull();
  });

  it.each(['trusted', 'principal'] as const)('never budgets a %s-tier originator', (tier) => {
    expect(budgetedOriginator({ originator: originator({ tier }) })).toBeNull();
  });

  it.each(['principal', 'system', 'agent'] as const)('never budgets a %s-originated task', (systemRole) => {
    expect(budgetedOriginator({ originator: originator({ systemRole, tier: null }) })).toBeNull();
  });

  it('never budgets a send with no originator', () => {
    expect(budgetedOriginator(undefined)).toBeNull();
    expect(budgetedOriginator({})).toBeNull();
  });

  it.each([
    ['isSystemNotification', { isSystemNotification: true }],
    ['humanApproved', { humanApproved: true }],
    ['principalDirected', { principalDirected: true }],
  ] as const)('never budgets a %s send', (_name, flags) => {
    expect(budgetedOriginator({ ...flags, originator: originator() })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/autonomy/relay-budget.test.ts`
Expected: FAIL — cannot resolve `src/autonomy/relay-budget.js`.

- [ ] **Step 3: Implement `src/autonomy/relay-budget.ts`**

```ts
// relay-budget.ts — caps the immediate messages to the principal an outsider can cause (#1320).
//
// An external contact who writes to Curia again and again can get the coordinator to message
// the principal each time. Sends to the principal alone skip the band review (nobody else reads
// them) and Gate C's tier rules allow them, so nothing else limits that. The gateway asks this
// budget before such a send; over budget, the relay goes to the principal's digest instead.
//
// In memory only: a restart resets the counts, and an outsider cannot cause a restart.
// See docs/wip/2026-10-19-relay-budget-design.md and spec 14 (Relay budget).

import type { TaskOriginator } from '../contacts/types.js';

/** The budget's window: relays are counted over the last hour. */
export const RELAY_BUDGET_WINDOW_MS = 3_600_000;

/** Tiers whose relays are budgeted. A missing tier is treated as 'unknown' (#1059 fails closed). */
const BUDGETED_TIERS: ReadonlySet<string> = new Set(['known', 'unknown', 'blocked']);

/**
 * The originator to count this send against, or null when it is not budgeted. Sends the
 * principal approved or directed, and system notifications (approvals, notices), are never
 * budgeted; nor is work the principal, the system or an agent started, or a trusted contact's.
 * The caller checks separately that the principal is the sole recipient.
 */
export function budgetedOriginator(
  options: {
    isSystemNotification?: boolean;
    humanApproved?: boolean;
    principalDirected?: boolean;
    originator?: TaskOriginator;
  } | undefined,
): TaskOriginator | null {
  if (!options?.originator) return null;
  if (options.isSystemNotification || options.humanApproved || options.principalDirected) return null;
  const { systemRole } = options.originator;
  if (systemRole === 'principal' || systemRole === 'system' || systemRole === 'agent') return null;
  return BUDGETED_TIERS.has(options.originator.tier ?? 'unknown') ? options.originator : null;
}

/**
 * A sliding one-hour window of relay timestamps per originator contact id. Modelled on
 * FailOpenLimiter (band-policy.ts) for the window and on the inbound RateLimiter (#1665) for
 * evicting originators that have gone quiet, so the maps never grow without bound.
 */
export class RelayBudget {
  private readonly perHour: number;
  private readonly now: () => number;
  private readonly stamps = new Map<string, number[]>();
  /** When each originator's last "holding them for your digest" notice went out. */
  private readonly notices = new Map<string, number>();
  private lastSweepAt = 0;

  constructor(opts: { perHour: number; now?: () => number }) {
    if (!Number.isInteger(opts.perHour) || opts.perHour < 0) {
      throw new Error(`RelayBudget: perHour must be a non-negative integer, got ${String(opts.perHour)}`);
    }
    this.perHour = opts.perHour;
    this.now = opts.now ?? Date.now;
  }

  /** Records the relay and returns 'allowed', or returns 'over' and records nothing. */
  tryAcquire(contactId: string): 'allowed' | 'over' {
    if (this.perHour === 0) return 'allowed'; // budget switched off
    const t = this.now();
    this.sweep(t);
    const live = this.live(contactId, t);
    if (live.length >= this.perHour) {
      this.stamps.set(contactId, live);
      return 'over';
    }
    live.push(t);
    this.stamps.set(contactId, live);
    return 'allowed';
  }

  /**
   * True for the first over-budget relay in a window: the principal gets one line saying more
   * updates are waiting in the digest. False again until a full window has passed.
   */
  shouldNotify(contactId: string): boolean {
    const t = this.now();
    const last = this.notices.get(contactId);
    if (last !== undefined && t - last < RELAY_BUDGET_WINDOW_MS) return false;
    this.notices.set(contactId, t);
    return true;
  }

  /** Relays counted for this originator in the current window. */
  count(contactId: string): number {
    return this.live(contactId, this.now()).length;
  }

  /** Originators currently tracked (either map). For tests of the eviction sweep. */
  trackedCount(): number {
    return new Set([...this.stamps.keys(), ...this.notices.keys()]).size;
  }

  private live(contactId: string, t: number): number[] {
    return (this.stamps.get(contactId) ?? []).filter((s) => t - s < RELAY_BUDGET_WINDOW_MS);
  }

  /** At most once per window: drop originators with no relay or notice inside the window. */
  private sweep(t: number): void {
    if (t - this.lastSweepAt < RELAY_BUDGET_WINDOW_MS) return;
    this.lastSweepAt = t;
    for (const [id, stamps] of this.stamps) {
      const live = stamps.filter((s) => t - s < RELAY_BUDGET_WINDOW_MS);
      if (live.length === 0) this.stamps.delete(id);
      else this.stamps.set(id, live);
    }
    for (const [id, at] of this.notices) {
      if (t - at >= RELAY_BUDGET_WINDOW_MS) this.notices.delete(id);
    }
  }
}
```

Note on the eviction test: the first `tryAcquire` call sets `lastSweepAt` (the clock starts at 1,000,000, already more than a window past 0), so the sweep after `advance(RELAY_BUDGET_WINDOW_MS)` runs exactly one window later.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/autonomy/relay-budget.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Write the failing config tests**

`tests/unit/config.relay-budget.test.ts`:

```ts
// config.relay-budget.test.ts — autonomy.relay_budget resolution and validation (#1320).
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig, resolveRelayBudgetConfig } from '../../src/config.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(defaultYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-relay-budget-cfg-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'default.yaml'), defaultYaml);
  return dir;
}

describe('resolveRelayBudgetConfig (#1320)', () => {
  it('defaults to 3 per hour', () => {
    expect(resolveRelayBudgetConfig(undefined)).toEqual({ perHour: 3 });
    expect(resolveRelayBudgetConfig({})).toEqual({ perHour: 3 });
  });

  it('reads per_hour, including 0 (off)', () => {
    expect(resolveRelayBudgetConfig({ relay_budget: { per_hour: 5 } })).toEqual({ perHour: 5 });
    expect(resolveRelayBudgetConfig({ relay_budget: { per_hour: 0 } })).toEqual({ perHour: 0 });
  });
});

describe('loadYamlConfig — autonomy.relay_budget validation (#1320)', () => {
  it('accepts a non-negative integer', () => {
    const cfg = loadYamlConfig(writeConfig('autonomy:\n  relay_budget:\n    per_hour: 4\n'));
    expect(resolveRelayBudgetConfig(cfg.autonomy)).toEqual({ perHour: 4 });
  });

  it.each(['-1', '1.5', '"three"'])('rejects per_hour: %s at load time', (value) => {
    expect(() => loadYamlConfig(writeConfig(`autonomy:\n  relay_budget:\n    per_hour: ${value}\n`)))
      .toThrow(/autonomy.relay_budget.per_hour must be a non-negative integer/);
  });

  it('rejects a relay_budget that is not a mapping', () => {
    expect(() => loadYamlConfig(writeConfig('autonomy:\n  relay_budget: 3\n')))
      .toThrow(/autonomy.relay_budget must be a YAML mapping/);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/config.relay-budget.test.ts`
Expected: FAIL — `resolveRelayBudgetConfig` is not exported.

- [ ] **Step 7: Implement the config**

In `src/config.ts`, inside the `autonomy?: { ... }` YamlConfig block, after `report_fallback?: {...};`:

```ts
    /** Cap on immediate relays to the principal that one outside contact can cause (#1320). */
    relay_budget?: {
      /** Relays per originator per hour; over it, relays go to the digest. 0 turns it off. Default 3. */
      per_hour?: number;
    };
```

After `resolveAutonomyGating`:

```ts
// ---------------------------------------------------------------------------
// Relay budget (#1320)
// ---------------------------------------------------------------------------

export interface RelayBudgetConfig {
  /** Immediate relays to the principal one outside contact may cause per hour. 0 = off. */
  perHour: number;
}

const DEFAULT_RELAY_BUDGET_PER_HOUR = 3;

/** Resolve autonomy.relay_budget. Validated in loadYamlConfig. */
export function resolveRelayBudgetConfig(yaml: YamlConfig['autonomy']): RelayBudgetConfig {
  return { perHour: yaml?.relay_budget?.per_hour ?? DEFAULT_RELAY_BUDGET_PER_HOUR };
}
```

In `loadYamlConfig`, directly after the `autonomy.gating` `includes` check (before the band/judge check):

```ts
  // autonomy.relay_budget (#1320): a bad value must fail at boot, not silently drop the cap.
  const relayBudget = config.autonomy?.relay_budget;
  if (relayBudget !== undefined) {
    if (typeof relayBudget !== 'object' || Array.isArray(relayBudget) || relayBudget === null) {
      throw new Error(`autonomy.relay_budget must be a YAML mapping, got: ${typeof relayBudget}`);
    }
    const perHour = relayBudget.per_hour;
    if (perHour !== undefined && (!Number.isInteger(perHour) || perHour < 0)) {
      throw new Error(`autonomy.relay_budget.per_hour must be a non-negative integer, got: ${String(perHour)}`);
    }
  }
```

In `schemas/default-config.schema.json`, after the `report_fallback` property (add a comma after its closing brace):

```json
        "relay_budget": {
          "type": "object",
          "additionalProperties": false,
          "description": "Cap on immediate relays to the principal that one outside contact can cause (#1320).",
          "properties": {
            "per_hour": { "type": "integer", "minimum": 0 }
          }
        }
```

In `config/default.yaml`, after the `report_fallback:` block under `autonomy:`:

```yaml
  # Cap on immediate messages to the principal that one outside contact (tier known
  # or below) can cause (#1320). Over the cap, the relay goes to the digest and the
  # principal gets one line saying more is waiting. 0 turns the cap off.
  relay_budget:
    per_hour: 3
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/config.relay-budget.test.ts tests/unit/config.gating.test.ts tests/unit/startup/validator.test.ts`
Expected: PASS (the validator test proves default.yaml still matches the schema).

- [ ] **Step 9: Typecheck and commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget add src/autonomy/relay-budget.ts src/config.ts schemas/default-config.schema.json config/default.yaml tests/unit/autonomy/relay-budget.test.ts tests/unit/config.relay-budget.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget commit -s -m "feat(autonomy): relay budget per outside originator (#1320)"
```

---

### Task 2: `relay_deferred` report source and `autonomy.relay_deferred` event

**Files:**
- Modify: `src/bus/events.ts` (`PrincipalReportSource` near line 1508; new payload beside `AutonomySendBlockedPayload` near line 903; new event beside `AutonomySendBlockedEvent` near line 1557; union near line 1779; factory beside `createAutonomySendBlocked` near line 2495)
- Modify: `src/reports/report-queue.ts` (`SOURCE_KEYS`)
- Modify: `src/bus/permissions.ts` (publish allowlist `dispatch` and `system`; subscribe allowlist `system`; header comment)
- Modify: `tests/unit/bus/principal-report-event.test.ts`, `tests/unit/reports/report-queue.test.ts`
- Create: `tests/unit/bus/relay-deferred-event.test.ts`

**Interfaces:**
- Produces:
  - `PrincipalReportSource` gains `'relay_deferred'`
  - `export interface AutonomyRelayDeferredPayload { originatorContactId: string; tier: ContactTier; channel: string; conversationId?: string; taskEventId?: string; noticeSent: boolean }`
  - `export interface AutonomyRelayDeferredEvent extends BaseEvent { type: 'autonomy.relay_deferred'; sourceLayer: 'dispatch'; payload: AutonomyRelayDeferredPayload }`
  - `export function createAutonomyRelayDeferred(payload: AutonomyRelayDeferredPayload, parentEventId?: string): AutonomyRelayDeferredEvent`

- [ ] **Step 1: Write the failing tests**

`tests/unit/bus/relay-deferred-event.test.ts`:

```ts
// autonomy.relay_deferred — a relay to the principal went to the digest (#1320).
import { describe, it, expect } from 'vitest';
import { createAutonomyRelayDeferred } from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';

describe('autonomy.relay_deferred', () => {
  const event = createAutonomyRelayDeferred({
    originatorContactId: 'contact-1',
    tier: 'known',
    channel: 'signal',
    conversationId: 'signal:+15550000000',
    taskEventId: 'task-1',
    noticeSent: true,
  }, 'task-1');

  it('names the originator, never the message', () => {
    expect(event.type).toBe('autonomy.relay_deferred');
    expect(event.sourceLayer).toBe('dispatch');
    expect(event.parentEventId).toBe('task-1');
    expect(Object.keys(event.payload).sort()).toEqual(
      ['channel', 'conversationId', 'noticeSent', 'originatorContactId', 'taskEventId', 'tier'],
    );
  });

  it('is published by dispatch (the gateway) and read only by system (the audit logger)', () => {
    expect(canPublish('dispatch', 'autonomy.relay_deferred')).toBe(true);
    expect(canSubscribe('system', 'autonomy.relay_deferred')).toBe(true);
    expect(canPublish('agent', 'autonomy.relay_deferred')).toBe(false);
    expect(canSubscribe('agent', 'autonomy.relay_deferred')).toBe(false);
    expect(canSubscribe('channel', 'autonomy.relay_deferred')).toBe(false);
  });
});
```

In `tests/unit/bus/principal-report-event.test.ts`, add inside the `describe('principal.report', ...)` block:

```ts
  it('accepts the relay_deferred source from dispatch (#1320)', () => {
    const ev = createPrincipalReport({
      summary: 'Held for your digest (relay limit reached for Dana Example):\nThe contract is signed.',
      urgency: 'digest',
      source: 'relay_deferred',
      parentEventId: 'task-4',
      sourceLayer: 'dispatch',
    });
    expect(ev.payload.source).toBe('relay_deferred');
  });
```

In `tests/unit/reports/report-queue.test.ts`, add inside `describe('ReportQueue.list', ...)`:

```ts
  it('lists relay_deferred items without relabelling them (#1320)', async () => {
    const { queue, warn } = makeQueue({
      pages: [{
        rows: [
          { seq: '30', row: row('f', '2026-10-19T09:00:00.000Z', { summary: 'Held for your digest (relay limit reached for Dana Example):\nSigned.', urgency: 'digest', source: 'relay_deferred' }) },
        ],
        hasMore: false,
      }],
    });

    const batch = await queue.list();

    expect(batch.items.map((i) => i.source)).toEqual(['relay_deferred']);
    expect(warn).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/bus/relay-deferred-event.test.ts tests/unit/bus/principal-report-event.test.ts tests/unit/reports/report-queue.test.ts`
Expected: FAIL — `createAutonomyRelayDeferred` not exported; the report-queue test sees `agent` and a warning.

- [ ] **Step 3: Implement**

`src/bus/events.ts` — add to `PrincipalReportSource` after `'claim_trimmed'` (move the `;`):

```ts
  | 'claim_trimmed'        // unverified statements were cut from a send after one bounce (#2159)
  | 'relay_deferred';      // an outside contact used up their relay budget; the relay waits here (#1320)
```

After `AutonomySendBlockedPayload` (check `ContactTier` is imported in events.ts; if not, add `import type { ContactTier } from '../contacts/types.js';`):

```ts
// AutonomyRelayDeferredPayload — published by the outbound gateway when a relay to the
// principal that an outside contact caused was over that contact's relay budget and went to
// the digest instead (#1320). Names the originator, never the message.
export interface AutonomyRelayDeferredPayload {
  originatorContactId: string;
  /** The originator's tier; a missing tier is reported as 'unknown'. */
  tier: ContactTier;
  channel: string;
  conversationId?: string;
  taskEventId?: string;
  /** Whether the once-per-window "holding them for your digest" line went out with it. */
  noticeSent: boolean;
}
```

After `AutonomySendBlockedEvent`:

```ts
// AutonomyRelayDeferredEvent — the gateway held a relay to the principal for the digest
// because its outside originator was over the relay budget (#1320).
export interface AutonomyRelayDeferredEvent extends BaseEvent {
  type: 'autonomy.relay_deferred';
  sourceLayer: 'dispatch';
  payload: AutonomyRelayDeferredPayload;
}
```

In the `BusEvent` union, after `AutonomySendBlockedEvent`:

```ts
  | AutonomyRelayDeferredEvent // #1320: a relay to the principal went to the digest (relay budget)
```

After `createAutonomySendBlocked`:

```ts
export function createAutonomyRelayDeferred(
  payload: AutonomyRelayDeferredPayload,
  parentEventId?: string,
): AutonomyRelayDeferredEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'autonomy.relay_deferred',
    sourceLayer: 'dispatch',
    payload,
    parentEventId,
  };
}
```

`src/reports/report-queue.ts` — `SOURCE_KEYS` gains `relay_deferred: true,`.

`src/bus/permissions.ts`:
- Add `'autonomy.relay_deferred'` to the `dispatch` and `system` sets of the publish allowlist (beside `'autonomy.send_blocked'`).
- Add `'autonomy.relay_deferred'` to the `system` set of `subscribeAllowlist` only (beside `'autonomy.send_blocked'`).
- Add to the header comment, after the `#2159 (report queue)` entry:

```ts
// #1320 (relay budget): dispatch (the outbound gateway) publishes autonomy.relay_deferred when
//          a relay to the principal goes to the digest. Only system subscribes (the audit logger).
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/bus tests/unit/reports`
Expected: PASS (all bus and reports tests, including the permissions and layer-enforcement suites).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget add src/bus/events.ts src/bus/permissions.ts src/reports/report-queue.ts tests/unit/bus/relay-deferred-event.test.ts tests/unit/bus/principal-report-event.test.ts tests/unit/reports/report-queue.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget commit -s -m "feat(bus): relay_deferred digest source and autonomy.relay_deferred event (#1320)"
```

---

### Task 3: The gateway step

**Files:**
- Modify: `src/skills/outbound-gateway.ts`
  - `OutboundSendResult` (near line 142): add `deferredToDigest?: boolean`
  - `OutboundGatewayConfig` (after `bandReview`, near line 340): add `relayBudget?: RelayBudget`
  - private field + constructor assignment (near lines 575 and 605)
  - `send()` options (near line 749, after `holdRecipe`): add `originator?: TaskOriginator`
  - new Step 2.4 directly after the `if (!filterPassed) { ... }` block and before the "Step 2.5: Band review" banner (near line 1277)
  - new private methods `deferRelay`, `sendRelayNotice`, `originatorName` beside `publishBandReport` (near line 1957)
  - new module-level helper `relayNoticeRequest` in the Helpers section (after `redactId`, near line 372)
- Modify: `src/index.ts` (gateway construction near line 1780)
- Create: `tests/unit/skills/outbound-gateway-relay-budget.test.ts`

**Interfaces:**
- Consumes: `RelayBudget`, `budgetedOriginator` (Task 1); `createAutonomyRelayDeferred`, source `'relay_deferred'` (Task 2); `resolveRelayBudgetConfig` (Task 1).
- Produces: `send(request, { ..., originator?: TaskOriginator })`; `OutboundSendResult.deferredToDigest?: boolean`; `OutboundGatewayConfig.relayBudget?: RelayBudget`.

- [ ] **Step 1: Write the failing gateway tests**

`tests/unit/skills/outbound-gateway-relay-budget.test.ts`:

```ts
// The relay budget in OutboundGateway.send() (#1320): an outside contact can cause only so many
// immediate messages to the principal; the rest go to the digest.
import { describe, it, expect, vi } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { RelayBudget } from '../../../src/autonomy/relay-budget.js';
import { createLogger } from '../../../src/logger.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { SignalRpcClient } from '../../../src/channels/signal/signal-rpc-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent } from '../../../src/bus/events.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';

const PRINCIPAL_EMAIL = 'principal@example.com';
const PRINCIPAL_SIGNAL = '+15195550100';

function principalIdentity(channel: 'email' | 'signal', channelIdentifier: string) {
  return {
    id: `pi-${channel}`, contactId: 'principal-contact', channel, channelIdentifier, label: null,
    verified: true, verifiedAt: null, source: 'ceo_stated' as const, status: 'active' as const,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function outsider(over: Partial<TaskOriginator> = {}): TaskOriginator {
  return { contactId: 'dana-contact', systemRole: null, channel: 'email', initiatedAt: '2026-10-19T12:00:00Z', tier: 'known', ...over };
}

function makeGateway(opts: {
  perHour?: number;
  publish?: (layer: string, event: BusEvent) => Promise<void>;
  getContact?: ContactService['getContact'];
  filterPasses?: boolean;
} = {}) {
  const sendMessage = vi.fn().mockResolvedValue({ id: 'msg-1' });
  const signalSend = vi.fn().mockResolvedValue(undefined);
  const published: BusEvent[] = [];
  const publish = vi.fn(async (layer: string, event: BusEvent) => {
    if (opts.publish) await opts.publish(layer, event);
    published.push(event);
  });
  const contentFilter = {
    check: vi.fn().mockResolvedValue(opts.filterPasses === false
      ? { passed: false, findings: [{ rule: 'secret-pattern', detail: 'x' }] }
      : { passed: true, findings: [] }),
  };
  const budget = new RelayBudget({ perHour: opts.perHour ?? 1 });
  const gateway = new OutboundGateway({
    nylasClients: new Map([['curia', { sendMessage } as unknown as NylasClient]]),
    signalClient: { send: signalSend, isConnected: () => true } as unknown as SignalRpcClient,
    signalPhoneNumber: '+10000000000',
    contactService: {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      getContact: opts.getContact ?? vi.fn().mockResolvedValue({ id: 'dana-contact', displayName: 'Dana Example' }),
    } as unknown as ContactService,
    contentFilter: contentFilter as unknown as OutboundContentFilter,
    bus: { publish, subscribe: vi.fn() } as unknown as EventBus,
    principalIdentities: [principalIdentity('email', PRINCIPAL_EMAIL), principalIdentity('signal', PRINCIPAL_SIGNAL)],
    logger: createLogger('error'),
    relayBudget: budget,
  });
  const reports = () => published.filter((e) => e.type === 'principal.report');
  const deferredEvents = () => published.filter((e) => e.type === 'autonomy.relay_deferred');
  return { gateway, budget, sendMessage, signalSend, published, reports, deferredEvents, publish };
}

const toPrincipalSignal = (message: string) => ({ channel: 'signal' as const, recipient: PRINCIPAL_SIGNAL, message });

describe('relay budget (#1320)', () => {
  it('delivers within budget, then holds the next relay for the digest', async () => {
    const g = makeGateway({ perHour: 1 });

    const first = await g.gateway.send(toPrincipalSignal('Dana says the contract is signed.'), { originator: outsider(), taskEventId: 'task-1' });
    expect(first).toMatchObject({ success: true });
    expect(first.deferredToDigest).toBeUndefined();
    expect(g.signalSend).toHaveBeenCalledTimes(1);

    const second = await g.gateway.send(toPrincipalSignal('Dana asks about Friday.'), { originator: outsider(), taskEventId: 'task-2', conversationId: 'email:t1' });
    expect(second).toEqual({ success: true, deferredToDigest: true });

    // The digest item carries who and the full redacted text.
    const [report] = g.reports();
    expect(report).toMatchObject({
      sourceLayer: 'dispatch',
      parentEventId: 'task-2',
      payload: { source: 'relay_deferred', urgency: 'digest', conversationId: 'email:t1' },
    });
    expect((report!.payload as { summary: string }).summary).toBe(
      'Held for your digest (relay limit reached for Dana Example):\nDana asks about Friday.',
    );

    // One notice instead of the relay, on the same channel, as a system notification.
    expect(g.signalSend).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(g.signalSend.mock.calls[1])).toContain("Dana Example has more updates. I'm holding them for your digest.");
    expect(JSON.stringify(g.signalSend.mock.calls[1])).not.toContain('Friday');

    // The audit event names the originator, not the content.
    const [ev] = g.deferredEvents();
    expect(ev).toMatchObject({
      parentEventId: 'task-2',
      payload: { originatorContactId: 'dana-contact', tier: 'known', channel: 'signal', conversationId: 'email:t1', taskEventId: 'task-2', noticeSent: true },
    });
    expect(JSON.stringify(ev)).not.toContain('Friday');
  });

  it('sends the notice only once per window', async () => {
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });
    await g.gateway.send(toPrincipalSignal('three'), { originator: outsider() });

    // one delivered + one notice; 'three' is deferred silently.
    expect(g.signalSend).toHaveBeenCalledTimes(2);
    expect(g.reports()).toHaveLength(2);
    expect(g.deferredEvents().map((e) => (e.payload as { noticeSent: boolean }).noticeSent)).toEqual([true, false]);
  });

  it('sends an email notice with its own subject and no threading or attachments', async () => {
    const g = makeGateway({ perHour: 1 });
    const relay = { channel: 'email' as const, to: PRINCIPAL_EMAIL, subject: 'Re: contract', body: 'first' };
    await g.gateway.send(relay, { originator: outsider() });
    const deferred = await g.gateway.send({ ...relay, body: 'second' }, { originator: outsider() });

    expect(deferred.deferredToDigest).toBe(true);
    expect((g.reports()[0]!.payload as { summary: string }).summary).toBe(
      'Held for your digest (relay limit reached for Dana Example):\nSubject: Re: contract\nsecond',
    );
    const notice = g.sendMessage.mock.calls[1]![0] as Record<string, unknown>;
    expect(notice).toMatchObject({ subject: 'Holding updates from Dana Example' });
    expect(JSON.stringify(notice)).not.toContain('second');
    expect(JSON.stringify(notice)).not.toContain('Re: contract');
  });

  it('counts a missing tier as unknown and reports it so', async () => {
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider({ tier: null }) });
    await g.gateway.send(toPrincipalSignal('two'), { originator: outsider({ tier: null }) });
    expect(g.deferredEvents()[0]!.payload).toMatchObject({ tier: 'unknown' });
  });

  it.each([
    ['system notification', { originator: outsider(), isSystemNotification: true }],
    ['principal-approved', { originator: outsider(), humanApproved: true }],
    ['principal-directed', { originator: outsider(), principalDirected: true }],
    ['trusted originator', { originator: outsider({ tier: 'trusted' }) }],
    ['principal-originated', { originator: outsider({ systemRole: 'principal', tier: null }) }],
    ['system-originated', { originator: outsider({ systemRole: 'system', tier: null }) }],
    ['agent-originated', { originator: outsider({ systemRole: 'agent', tier: null }) }],
    ['no originator', {}],
  ])('never defers a %s send', async (_name, options) => {
    const g = makeGateway({ perHour: 1 });
    for (let i = 0; i < 3; i++) {
      const result = await g.gateway.send(toPrincipalSignal(`m${i}`), options);
      expect(result.deferredToDigest).toBeUndefined();
    }
    expect(g.signalSend).toHaveBeenCalledTimes(3);
    expect(g.deferredEvents()).toHaveLength(0);
  });

  it('never defers a send where the principal is not the sole recipient', async () => {
    const g = makeGateway({ perHour: 1 });
    const relay = { channel: 'email' as const, to: PRINCIPAL_EMAIL, cc: ['someone@example.org'], subject: 'S', body: 'b' };
    for (let i = 0; i < 3; i++) {
      expect((await g.gateway.send(relay, { originator: outsider() })).deferredToDigest).toBeUndefined();
    }
    expect(g.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('a filter-blocked relay is blocked, not deferred, and does not count', async () => {
    const blocked = makeGateway({ perHour: 1, filterPasses: false });
    const result = await blocked.gateway.send(toPrincipalSignal('secret'), { originator: outsider(), skipNotificationOnBlock: true });
    expect(result.success).toBe(false);
    expect(result.deferredToDigest).toBeUndefined();
    expect(blocked.deferredEvents()).toHaveLength(0);
    expect(blocked.budget.count('dana-contact')).toBe(0);
  });

  it('delivers the relay after all when its digest item cannot be recorded', async () => {
    const g = makeGateway({
      perHour: 1,
      publish: async (_layer, event) => {
        if (event.type === 'principal.report') throw new Error('audit write failed');
      },
    });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    const second = await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });

    expect(second.success).toBe(true);
    expect(second.deferredToDigest).toBeUndefined();
    expect(JSON.stringify(g.signalSend.mock.calls[1])).toContain('two');
    expect(g.deferredEvents()).toHaveLength(0);
  });

  it('still defers when the notice fails to send', async () => {
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    g.signalSend.mockRejectedValueOnce(new Error('signal down'));
    const second = await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });

    expect(second).toEqual({ success: true, deferredToDigest: true });
    expect(g.reports()).toHaveLength(1);
    expect(g.deferredEvents()[0]!.payload).toMatchObject({ noticeSent: false });
  });

  it("falls back to 'a contact' when the lookup throws", async () => {
    const g = makeGateway({ perHour: 1, getContact: vi.fn().mockRejectedValue(new Error('db down')) });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    const second = await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });

    expect(second.deferredToDigest).toBe(true);
    expect((g.reports()[0]!.payload as { summary: string }).summary).toContain('relay limit reached for a contact');
    expect(JSON.stringify(g.signalSend.mock.calls[1])).toContain("A contact has more updates. I'm holding them for your digest.");
  });

  it('the notice is sent once and is not itself budgeted', async () => {
    // perHour 1: the notice would be over budget if it were counted against Dana.
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });
    expect(g.signalSend).toHaveBeenCalledTimes(2);
    expect(g.reports()).toHaveLength(1);
  });

  it('does nothing without a relay budget configured', async () => {
    const g = makeGateway({ perHour: 1 });
    const bare = new OutboundGateway({
      signalClient: { send: g.signalSend, isConnected: () => true } as unknown as SignalRpcClient,
      signalPhoneNumber: '+10000000000',
      contactService: { resolveByChannelIdentity: vi.fn().mockResolvedValue(null) } as unknown as ContactService,
      contentFilter: { check: vi.fn().mockResolvedValue({ passed: true, findings: [] }) } as unknown as OutboundContentFilter,
      bus: { publish: g.publish, subscribe: vi.fn() } as unknown as EventBus,
      principalIdentities: [principalIdentity('signal', PRINCIPAL_SIGNAL)],
      logger: createLogger('error'),
    });
    for (let i = 0; i < 3; i++) await bare.send(toPrincipalSignal(`m${i}`), { originator: outsider() });
    expect(g.signalSend).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/skills/outbound-gateway-relay-budget.test.ts`
Expected: FAIL — vitest does not typecheck, so the file runs; the deferral tests fail because the second relay is delivered (`deferredToDigest` undefined). The exemption tests already pass (nothing defers yet).

- [ ] **Step 3: Implement in `src/skills/outbound-gateway.ts`**

Imports (top of file): add

```ts
import { budgetedOriginator, type RelayBudget } from '../autonomy/relay-budget.js';
import type { TaskOriginator } from '../contacts/types.js';
```

and add `createAutonomyRelayDeferred` to the existing `../bus/events.js` import list. (If `TaskOriginator` or `ContactTier` is already imported from `../contacts/types.js`, extend that import instead.)

`OutboundSendResult`, after `queueable?: boolean;`:

```ts
  /**
   * True when the relay budget held this send for the principal's digest instead of sending
   * it (#1320). `success` is true: the message is kept, and the caller must not re-send it
   * another way.
   */
  deferredToDigest?: boolean;
```

`OutboundGatewayConfig`, after `bandReview?`:

```ts
  /**
   * Caps the immediate messages to the principal that one outside contact can cause (#1320).
   * Absent: no cap.
   */
  relayBudget?: RelayBudget;
```

Private field beside `bandReview`: `private readonly relayBudget?: RelayBudget;` and in the constructor after `this.bandReview = config.bandReview;`: `this.relayBudget = config.relayBudget;`

`send()` options, after `holdRecipe?: SendRecipe;`:

```ts
      /**
       * Who started the work this send belongs to: the task's originator, which send skills
       * pass through. Used only by the relay budget (#1320). Omitted: never budgeted.
       */
      originator?: TaskOriginator;
```

Helpers section, after `redactId`:

```ts
/**
 * The once-per-window relay-budget notice (#1320), addressed exactly as the held relay was:
 * same channel, account and principal address, with the body replaced and any threading or
 * attachments dropped, so nothing of the held message rides along.
 */
function relayNoticeRequest(request: OutboundSendRequest, text: string, subject: string): OutboundSendRequest {
  switch (request.channel) {
    case 'email':
      return { channel: 'email', to: request.to, subject, body: text, ...(request.accountId ? { accountId: request.accountId } : {}) };
    case 'slack':
      return { channel: 'slack', slackChannelId: request.slackChannelId, ...(request.slackUserId ? { slackUserId: request.slackUserId } : {}), message: text };
    case 'sms':
      return { channel: 'sms', recipient: request.recipient, message: text };
    case 'signal':
      return { channel: 'signal', ...(request.recipient ? { recipient: request.recipient } : {}), message: text };
  }
}
```

(If TypeScript reports the switch is not exhaustive because `OutboundSendRequest` has more members, read the union at the `OutboundSendRequest` type definition and add a case per member following the same pattern.)

In `send()`, directly after the closing brace of `if (!filterPassed) { ... }` and before the `// Step 2.5: Band review` banner:

```ts
    // ------------------------------------------------------------------
    // Step 2.4: Relay budget (#1320)
    // ------------------------------------------------------------------
    // An outside contact can only cause so many immediate messages to the principal. Sends to
    // the principal alone skip the band review below, so this is the only limit on them. Over
    // budget, the relay goes to the digest. Runs after the content filter, so blocked content is
    // never queued and the digest gets redacted text.
    const relayOriginator = principalIsSoleRecipient && this.relayBudget ? budgetedOriginator(options) : null;
    if (relayOriginator && this.relayBudget!.tryAcquire(relayOriginator.contactId) === 'over') {
      const deferred = await this.deferRelay(request, redactedBody, redactedSubject, relayOriginator, options);
      if (deferred) return deferred;
      // The digest item could not be recorded: deliver after all. Noise beats a lost message.
    }
```

Private methods, after `publishBandReport`:

```ts
  /**
   * Hold an over-budget relay for the principal's digest (#1320): record the digest item, send
   * the once-per-window notice, log and audit it. Returns null when the digest item could not be
   * recorded, so the caller delivers the relay instead of losing it. Never throws.
   */
  private async deferRelay(
    request: OutboundSendRequest,
    body: string,
    subject: string | undefined,
    originator: TaskOriginator,
    options: { taskEventId?: string; parentEventId?: string; conversationId?: string } | undefined,
  ): Promise<OutboundSendResult | null> {
    const name = await this.originatorName(originator.contactId);
    const summary = [
      `Held for your digest (relay limit reached for ${name ?? 'a contact'}):`,
      ...(request.channel === 'email' && subject ? [`Subject: ${subject}`] : []),
      body,
    ].join('\n');
    try {
      await this.bus.publish('dispatch', createPrincipalReport({
        summary,
        urgency: 'digest',
        source: 'relay_deferred',
        ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
        parentEventId: options?.taskEventId ?? options?.parentEventId ?? 'system',
        sourceLayer: 'dispatch',
      }));
    } catch (err) {
      this.log.error(
        { err, originatorContactId: originator.contactId, channel: request.channel },
        'outbound-gateway: relay over budget, but its digest item could not be recorded — delivering it now',
      );
      return null;
    }

    const noticeSent = this.relayBudget!.shouldNotify(originator.contactId)
      ? await this.sendRelayNotice(request, name ?? 'A contact', options)
      : false;
    const tier = originator.tier ?? 'unknown';
    this.log.warn(
      { originatorContactId: originator.contactId, tier, channel: request.channel, count: this.relayBudget!.count(originator.contactId), noticeSent },
      'outbound-gateway: relay budget reached — relay held for the digest',
    );
    try {
      await this.bus.publish('dispatch', createAutonomyRelayDeferred({
        originatorContactId: originator.contactId,
        tier,
        channel: request.channel,
        ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
        ...(options?.taskEventId ? { taskEventId: options.taskEventId } : {}),
        noticeSent,
      }, options?.taskEventId));
    } catch (err) {
      // The relay is already safe in the digest; only the audit row is missing.
      this.log.error({ err, originatorContactId: originator.contactId }, 'AUDIT FAILURE: autonomy.relay_deferred could not be published');
    }
    return { success: true, deferredToDigest: true };
  }

  /** The once-per-window "holding them for your digest" line (#1320). True if delivered. Never throws. */
  private async sendRelayNotice(
    request: OutboundSendRequest,
    name: string,
    options: { taskEventId?: string; conversationId?: string } | undefined,
  ): Promise<boolean> {
    const notice = relayNoticeRequest(request, `${name} has more updates. I'm holding them for your digest.`, `Holding updates from ${name}`);
    try {
      // A system notification: never budgeted, so this cannot recurse into another deferral.
      const result = await this.send(notice, {
        isSystemNotification: true,
        skipNotificationOnBlock: true,
        ...(options?.taskEventId ? { taskEventId: options.taskEventId } : {}),
        ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
      });
      if (!result.success) {
        this.log.warn({ channel: request.channel, reason: result.blockedReason }, 'outbound-gateway: relay-budget notice was not delivered');
      }
      return result.success;
    } catch (err) {
      this.log.warn({ err, channel: request.channel }, 'outbound-gateway: relay-budget notice threw');
      return false;
    }
  }

  /** The originator's display name, or null when there is none or the lookup fails. Never throws. */
  private async originatorName(contactId: string): Promise<string | null> {
    try {
      const name = (await this.contactService.getContact(contactId))?.displayName?.trim();
      return name ? name : null;
    } catch (err) {
      this.log.warn({ err, contactId }, 'outbound-gateway: could not look up the relay originator\'s name');
      return null;
    }
  }
```

(`options.conversationId` in `send()` is typed `string | undefined`; if TypeScript widens it to `string | null`, accept `string | null` in these signatures and keep the truthiness checks.)

`src/index.ts` — import `RelayBudget` from `./autonomy/relay-budget.js` and `resolveRelayBudgetConfig` from `./config.js` (extend the existing import), and in the `new OutboundGateway({ ... })` call after `...(bandReview ? { bandReview } : {}),`:

```ts
      // Caps immediate relays to the principal per outside contact (#1320).
      relayBudget: new RelayBudget({ perHour: resolveRelayBudgetConfig(yamlConfig.autonomy).perHour }),
```

(Test mode's `createNoSendOutboundGateway` delivers nothing, so it gets no budget.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/skills/outbound-gateway-relay-budget.test.ts tests/unit/skills/outbound-gateway.test.ts`
Expected: PASS (new file, and the existing gateway suite unchanged).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget add src/skills/outbound-gateway.ts src/index.ts tests/unit/skills/outbound-gateway-relay-budget.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget commit -s -m "feat(gateway): hold over-budget relays to the principal for the digest (#1320)"
```

---

### Task 4: Send skills pass the originator and surface a deferral

**Files:**
- Modify: `src/skills/_shared/principal-directed.ts` (two new exports)
- Modify: `tests/unit/skills/_shared/principal-directed.test.ts`
- Modify: `skills/email/tools/email-send/handler.ts`, `skills/signal-send/handler.ts` (both send sites), `skills/slack-send/handler.ts`, `skills/sms-send/handler.ts`
- Modify: each skill's `handler.test.ts`
- Modify: `tool.json` versions — `email-send` 1.6.2 → 1.7.0, `signal-send` 1.4.3 → 1.5.0, `slack-send` 0.4.3 → 0.5.0, `sms-send` 0.4.3 → 0.5.0 (new output field: minor)

**Interfaces:**
- Consumes: `send()` option `originator?: TaskOriginator`; `OutboundSendResult.deferredToDigest` (Task 3).
- Produces:
  - `export function originatorOption(ctx: Pick<ToolContext, 'taskMetadata'>): { originator?: TaskOriginator }`
  - `export const RELAY_DEFERRED_NOTE: string`
  - `export function relayDeferredData(result: { deferredToDigest?: boolean }): Record<string, unknown>` → `{ deferred_to_digest: true, note: RELAY_DEFERRED_NOTE }` or `{}`

- [ ] **Step 1: Write the failing helper tests**

Append to `tests/unit/skills/_shared/principal-directed.test.ts` (extend the import to `{ isPrincipalDirectedSend, originatorOption, relayDeferredData, RELAY_DEFERRED_NOTE }`):

```ts
describe('originatorOption (#1320)', () => {
  it('passes the task originator through for the relay budget', () => {
    const meta = originator(null);
    expect(originatorOption({ taskMetadata: meta })).toEqual({ originator: meta.originator });
  });

  it('is empty when the task has no originator', () => {
    expect(originatorOption({ taskMetadata: undefined })).toEqual({});
    expect(originatorOption({ taskMetadata: {} })).toEqual({});
  });
});

describe('relayDeferredData (#1320)', () => {
  it('tells the agent the message is queued and must not be re-sent', () => {
    expect(relayDeferredData({ deferredToDigest: true })).toEqual({ deferred_to_digest: true, note: RELAY_DEFERRED_NOTE });
    expect(RELAY_DEFERRED_NOTE).toMatch(/digest/);
    expect(RELAY_DEFERRED_NOTE).toMatch(/not re-send/i);
  });

  it('adds nothing to a delivered send', () => {
    expect(relayDeferredData({})).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/skills/_shared/principal-directed.test.ts`
Expected: FAIL — the new exports don't exist.

- [ ] **Step 3: Implement the helpers**

Append to `src/skills/_shared/principal-directed.ts` (add `import type { TaskOriginator } from '../../contacts/types.js';`):

```ts
/**
 * The task's originator as a send() option, for the relay budget (#1320): the gateway counts a
 * relay to the principal against the outside contact who started the work. Every send skill
 * reads it here so they all read it the same way. Empty when the task has none.
 */
export function originatorOption(ctx: Pick<ToolContext, 'taskMetadata'>): { originator?: TaskOriginator } {
  // Runtime shape is stamped by the dispatcher (stamp-originator.ts); cast through unknown per repo policy.
  const originator = (ctx.taskMetadata as Record<string, unknown> | undefined)?.['originator'] as unknown as TaskOriginator | undefined;
  return originator ? { originator } : {};
}

/** What a send skill tells the agent when the relay budget held its message (#1320). */
export const RELAY_DEFERRED_NOTE =
  'Not sent now: this contact has reached the limit on messages to the principal for this hour, ' +
  'so the message is queued in the principal\'s digest. Do not re-send it on another channel.';

/** Result-data fields for a send the relay budget held; empty for a delivered send. */
export function relayDeferredData(result: { deferredToDigest?: boolean }): Record<string, unknown> {
  return result.deferredToDigest ? { deferred_to_digest: true, note: RELAY_DEFERRED_NOTE } : {};
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit/skills/_shared/principal-directed.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing skill tests**

Shared fixture for all four (define at the top of each test file, after imports):

```ts
const OUTSIDER = { originator: { contactId: 'dana-contact', systemRole: null, channel: 'email', initiatedAt: '2026-10-19T12:00:00Z', tier: 'known' } };
```

`skills/sms-send/handler.test.ts`, inside `describe('send by reference (#2033)', ...)`:

```ts
    it('passes the task originator to the gateway and surfaces a relay-budget deferral (#1320)', async () => {
      const send = vi.fn().mockResolvedValue({ success: true, deferredToDigest: true });
      const result = await new SmsSendHandler().execute(makeCtx({
        input: { recipient: 'principal', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
        taskMetadata: OUTSIDER,
      }));
      expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ originator: OUTSIDER.originator }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toMatchObject({ deferred_to_digest: true, note: expect.stringMatching(/digest/) });
    });
```

`skills/slack-send/handler.test.ts` — the same test with `SlackSendHandler` (keep `recipient: 'principal'`).

`skills/signal-send/handler.test.ts` — its `makeCtx` takes no `taskMetadata`, so spread it in:

```ts
  it('passes the task originator to the gateway and surfaces a relay-budget deferral (#1320)', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, deferredToDigest: true });
    const ctx = { ...makeCtx({ input: { recipient: 'principal', message: 'Hello' }, gateway: { send } }), taskMetadata: OUTSIDER } as ToolContext;
    const result = await handler.execute(ctx);
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ originator: OUTSIDER.originator }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ deferred_to_digest: true, note: expect.stringMatching(/digest/) });
  });
```

(Check that signal-send's test-file `resolveRecipientReference` resolves `'principal'` to an E.164 number; if not, use a recipient value it resolves to E.164.)

`skills/email/tools/email-send/handler.test.ts`:

```ts
  it('passes the task originator to the gateway and surfaces a relay-budget deferral (#1320)', async () => {
    const ctx = makeCtx({ to: 'principal', subject: 'Update', body: 'Hello' }, { taskMetadata: OUTSIDER });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, deferredToDigest: true });
    const result = await handler.execute(ctx);
    expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ originator: OUTSIDER.originator }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ deferred_to_digest: true, note: expect.stringMatching(/digest/) });
  });
```

- [ ] **Step 6: Run to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run skills/email/tools/email-send skills/signal-send skills/slack-send skills/sms-send`
Expected: FAIL — `originator` not passed; no `deferred_to_digest` in data.

- [ ] **Step 7: Wire the four skills**

In each handler, extend the `principal-directed.js` import to `{ isPrincipalDirectedSend, originatorOption, relayDeferredData }`. Then at each `ctx.outboundGateway.send(...)` call, add one line to the options object directly after `principalDirected: isPrincipalDirectedSend(ctx),`:

```ts
        // Counted against the outside contact who started this work (#1320).
        ...originatorOption(ctx),
```

(signal-send: both the group and the 1:1 call sites.) And in each success `return { success: true, data: { ... } }`, add as the last property of `data`:

```ts
          // Held by the relay budget for the principal's digest (#1320).
          ...relayDeferredData(result),
```

(signal-send group return is `{ success: true, data: { delivered_to: groupId, channel: 'signal' } }` — make it `{ delivered_to: groupId, channel: 'signal', ...relayDeferredData(result) }`.)

Bump the four `tool.json` versions as listed under **Files**.

- [ ] **Step 8: Run to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run skills/email/tools/email-send skills/signal-send skills/slack-send skills/sms-send tests/unit/skills/_shared/principal-directed.test.ts`
Expected: PASS, including the email-send test that asserts the exact options object (`originatorOption` adds no key when there is no originator).

- [ ] **Step 9: Typecheck and commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget add src/skills/_shared/principal-directed.ts tests/unit/skills/_shared/principal-directed.test.ts skills/email/tools/email-send skills/signal-send skills/slack-send skills/sms-send
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget commit -s -m "feat(skills): send skills pass the originator for the relay budget (#1320)"
```

---

### Task 5: Docs, CHANGELOG, full verification

**Files:**
- Modify: `docs/specs/14-autonomy-engine.md` (new subsection after "### Send-time review", before "### Sampling and feedback"; edit the "are not reviewed" sentence)
- Modify: `docs/specs/15-outbound-safety.md` ("Pipeline (in order)" list under "## Outbound Gateway")
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Modify: `docs/wip/2026-10-19-relay-budget-design.md` (Testing section: the integration line)

- [ ] **Step 1: Spec 14**

Change the sentence "Sends the principal approved (`humanApproved`), system notifications and sends to the principal alone are not reviewed." to:

```markdown
Sends the principal approved (`humanApproved`), system notifications and sends to the principal alone are not reviewed; sends to the principal alone are capped by the relay budget instead (below).
```

Insert before `### Sampling and feedback`:

```markdown
### Relay budget (`RelayBudget`, `src/autonomy/relay-budget.ts`) (#1320)

Sends to the principal alone skip the review above, and Gate C allows them, so an outside contact who keeps writing could get Curia to message the principal without limit. The gateway counts those relays per originator and, past the budget, sends them to the digest. It applies under both `tier` and `band`.

A send counts when the principal is its only recipient and the task's originator (passed by the send skills as `originator`) is an outside contact at `known`, `unknown` or `blocked`, or with no tier recorded. Never counted: system notifications (approval prompts included), sends the principal approved or directed, work the principal, the system or an agent started, `trusted` contacts, and sends with no originator.

The budget is `autonomy.relay_budget.per_hour` (default 3; 0 turns it off) over a sliding hour, in memory. Over it:

1. The relay becomes a `relay_deferred` digest item carrying the contact's name and the full redacted text. If that item cannot be recorded, the relay is sent after all.
2. The first deferral in a window also sends the principal one line on the same channel: "[name] has more updates. I'm holding them for your digest."
3. A warning log line and an `autonomy.relay_deferred` audit event record the originator's contact id, tier and channel, never the content.
4. The skill gets `success` with `deferred_to_digest` and a note not to re-send the message another way.

The budget runs after the content filter, so blocked content is never queued.
```

- [ ] **Step 2: Spec 15**

Replace the "Pipeline (in order)" list with:

```markdown
**Pipeline (in order):**
1. **Blocked contact check** — reject immediately if the recipient is blocked
2. **Content filter** — run the two-stage filter pipeline (see below)
3. **Relay budget** — a send to the principal alone that an outside contact caused counts against that contact's hourly budget; over it, the message goes to the principal's digest instead (#1320, spec 14)
4. **Channel dispatch** — route to the appropriate channel client (`email` → Nylas, etc.)
5. **Audit emission** — on successful wire-level delivery, emit `outbound.delivered`
```

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]` → `### Added`, append (≤15 words after the em-dash):

```markdown
- **Relay budget** — outside contacts can trigger at most three immediate principal messages hourly; extras go to the digest. (#1320)
```

- [ ] **Step 4: Design doc testing line**

In `docs/wip/2026-10-19-relay-budget-design.md`, replace the line starting `- Integration: a deferred relay appears in` with:

```markdown
- Report queue: a `relay_deferred` row lists with its own source (unit, `report-queue.test.ts`). No integration test: `principal.report` already reaches `audit_log` through the audit logger like every other source, and the only new code on that path is the `SOURCE_KEYS` entry.
```

- [ ] **Step 5: Full verification**

Run each, in the worktree, and read the output:

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget run typecheck
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget run lint
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget exec vitest run tests/unit skills
```

Expected: typecheck clean; lint clean apart from the pre-existing `src/pii/scrubber.ts` warning; all unit and skill tests pass. (Integration tests need Docker; CI runs them.)

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget add docs/specs/14-autonomy-engine.md docs/specs/15-outbound-safety.md CHANGELOG.md docs/wip/2026-10-19-relay-budget-design.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relay-budget commit -s -m "docs: relay budget in specs 14 and 15, changelog (#1320)"
```
