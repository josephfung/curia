# Skill/Agent Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate skill/agent loading on a database-backed install/enable lifecycle, with a startup reconciliation step, a one-shot prod backfill, and a Workspace Settings management UI.

**Architecture:** Two new tables (`skill_registry`, `agent_registry`) store only `enabled` + timestamps; the four operational states (uninstalled / installed / enabled / ghost) are *derived* by cross-referencing on-disk manifest discovery against registry rows. Discovery (lenient, all items) is split from load+register (strict, enabled only). A `RegistryService` powers `/api/registry/*` routes feeding two settings sections modeled on `ContactsPage`. Enforcement is restart-based (no hot-reload).

**Tech Stack:** TypeScript (ESM, Node 22+), PostgreSQL via `pg` + `node-pg-migrate`, Fastify routes, React 19 + Vite + TanStack Router console, Vitest (unit + Postgres integration).

**Spec:** `docs/wip/2026-06-09-skill-agent-registry-design.md`

**Conventions (from CLAUDE.md):**
- Run commands with `pnpm --prefix <worktree>` / `git -C <worktree>` — never `cd && cmd`.
- Worktree root: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-skill-agent-registry`
- Parameterized SQL only. No `console.log` (use the pino `logger`). No empty catches.
- Run `pnpm run typecheck` before every commit touching `.ts`. Array access under strict null checks needs `!` or a guard.
- Commit messages: `feat:` / `fix:` / `chore:` / `docs:`, no Co-Authored-By, no Claude credits.

In every command below, `WT` = `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-skill-agent-registry`.

**Prereq for integration tests:** a Postgres reachable via `DATABASE_URL` (in `.env`), with migrations applied via `pnpm --prefix $WT migrate`. Integration tests `describe.skip` when `DATABASE_URL` is unset.

---

## Task 1: Migration — create registry tables

**Files:**
- Create: `src/db/migrations/051_create_skill_agent_registry.sql`

- [ ] **Step 1: Verify `051` is the next free prefix**

Run: `ls $WT/src/db/migrations/ | sort | tail -3`
Expected: highest is `050_create_secrets_vault.sql`. If a rebase introduced another `051_*`, renumber THIS file to the next free slot (CLAUDE.md migration-numbering hazard).

- [ ] **Step 2: Write the migration**

Create `src/db/migrations/051_create_skill_agent_registry.sql`:

```sql
-- Up Migration
-- Database-backed registry that gates skill/agent loading on an install/enable
-- lifecycle (spec: docs/wip/2026-06-09-skill-agent-registry-design.md, #541).
-- Stores only enabled + timestamps; the uninstalled/installed/enabled/ghost states
-- are derived in app code by cross-referencing these rows against on-disk manifests.

CREATE TABLE skill_registry (
  name         TEXT PRIMARY KEY,                 -- matches skill.json "name"
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT        NOT NULL DEFAULT 'system',
  enabled_at   TIMESTAMPTZ,                      -- set when enabled flips true, cleared on disable
  enabled_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_registry (
  name         TEXT PRIMARY KEY,                 -- matches agents/<name>.yaml "name"
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT        NOT NULL DEFAULT 'system',
  enabled_at   TIMESTAMPTZ,
  enabled_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No secondary indexes: both tables hold dozens of rows at most and the only hot
-- query is a full "list all rows" at startup. The PRIMARY KEY on name suffices.

-- Down Migration
DROP TABLE skill_registry;
DROP TABLE agent_registry;
```

- [ ] **Step 3: Apply the migration**

Run: `pnpm --prefix $WT migrate`
Expected: output includes `### MIGRATION 051_create_skill_agent_registry (UP) ###` and no errors.

- [ ] **Step 4: Verify tables exist**

Run: `psql "$DATABASE_URL" -c "\d skill_registry" -c "\d agent_registry"` (or, if `psql` is unavailable, defer verification to Task 7's integration test).
Expected: both tables list the seven columns with `name` as primary key.

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/db/migrations/051_create_skill_agent_registry.sql
git -C $WT commit -m "feat: add skill_registry and agent_registry tables (#541)"
```

---

## Task 2: Registry types

**Files:**
- Create: `src/registry/types.ts`

- [ ] **Step 1: Write the types**

Create `src/registry/types.ts`:

```typescript
// types.ts — shared types for the skill/agent registry (install/enable lifecycle).
// State is DERIVED (never stored): we cross-reference on-disk manifest discovery
// against registry rows to compute uninstalled / installed / enabled / ghost.

export type RegistryKind = 'skill' | 'agent';

/** Operational state of a registry item. Derived, not stored. */
export type DerivedState = 'uninstalled' | 'installed' | 'enabled' | 'ghost';

/** A row in skill_registry / agent_registry, mapped to camelCase. */
export interface RegistryRow {
  name: string;
  enabled: boolean;
  installedAt: string;
  installedBy: string;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

/** Manifest metadata surfaced to the UI. Superset for skills + agents; unused
 *  fields are simply absent. `null` only when the manifest failed to parse. */
export interface ManifestMetadata {
  name: string;
  description: string;
  version: string;
  // skills
  actionRisk?: string | number;
  sensitivity?: string;
  capabilities?: string[];
  // agents
  role?: string;
  modelTier?: string;
}

/** One on-disk item found during discovery. `metadata` is null when the manifest
 *  could not be parsed (the parse error is captured in `error`). */
export interface Discovery {
  name: string;
  metadata: ManifestMetadata | null;
  error?: string;
}

/** A fully-resolved entry the API returns: discovery × row → derived state. */
export interface RegistryEntry {
  name: string;
  kind: RegistryKind;
  state: DerivedState;
  metadata: ManifestMetadata | null; // null for ghosts
  manifestError?: string;            // set when the on-disk manifest failed to parse
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

/** The DB-access contract RegistryService and reconciliation depend on.
 *  The Postgres implementation is RegistryRepo; tests use an in-memory fake. */
export interface IRegistryRepo {
  listRows(): Promise<RegistryRow[]>;
  getRow(name: string): Promise<RegistryRow | null>;
  /** Insert enabled=false if absent; no-op + return existing row if present. */
  install(name: string, actor: string): Promise<RegistryRow>;
  /** Set enabled=true (+ enabled_at/by). Throws if no row exists. */
  enable(name: string, actor: string): Promise<RegistryRow>;
  /** Set enabled=false (+ clear enabled_at/by). Throws if no row exists. */
  disable(name: string, actor: string): Promise<RegistryRow>;
  /** Delete the row. No error if absent. */
  uninstall(name: string): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --prefix $WT run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git -C $WT add src/registry/types.ts
git -C $WT commit -m "feat: registry types (#541)"
```

---

## Task 3: RegistryService (derived state + lifecycle ops)

**Files:**
- Create: `src/registry/registry-service.ts`
- Test: `src/registry/registry-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/registry/registry-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { RegistryService } from './registry-service.js';
import type { IRegistryRepo, RegistryRow, Discovery } from './types.js';

// In-memory fake repo — exercises RegistryService logic without a database.
class FakeRepo implements IRegistryRepo {
  rows = new Map<string, RegistryRow>();
  async listRows() { return [...this.rows.values()]; }
  async getRow(name: string) { return this.rows.get(name) ?? null; }
  async install(name: string, actor: string) {
    const existing = this.rows.get(name);
    if (existing) return existing;
    const row: RegistryRow = {
      name, enabled: false, installedAt: 't0', installedBy: actor,
      enabledAt: null, enabledBy: null, updatedAt: 't0',
    };
    this.rows.set(name, row); return row;
  }
  async enable(name: string, actor: string) {
    const row = this.rows.get(name);
    if (!row) throw new Error(`no row ${name}`);
    const next = { ...row, enabled: true, enabledAt: 't1', enabledBy: actor, updatedAt: 't1' };
    this.rows.set(name, next); return next;
  }
  async disable(name: string, actor: string) {
    const row = this.rows.get(name);
    if (!row) throw new Error(`no row ${name}`);
    const next = { ...row, enabled: false, enabledAt: null, enabledBy: null, updatedAt: 't1' };
    this.rows.set(name, next); return next;
  }
  async uninstall(name: string) { this.rows.delete(name); }
}

const disc = (name: string, extra: Partial<Discovery> = {}): Discovery => ({
  name, metadata: { name, description: `${name} desc`, version: '1.0.0' }, ...extra,
});

describe('RegistryService.list — derived state', () => {
  let skillRepo: FakeRepo;
  let svc: RegistryService;
  beforeEach(() => {
    skillRepo = new FakeRepo();
    svc = new RegistryService(skillRepo, new FakeRepo(), [], []);
  });

  it('on disk, no row → uninstalled', async () => {
    svc.setDiscovery('skill', [disc('a')]);
    const [entry] = await svc.list('skill');
    expect(entry!.state).toBe('uninstalled');
  });

  it('row + disabled → installed', async () => {
    svc.setDiscovery('skill', [disc('a')]);
    await skillRepo.install('a', 'web-app');
    const [entry] = await svc.list('skill');
    expect(entry!.state).toBe('installed');
  });

  it('row + enabled → enabled', async () => {
    svc.setDiscovery('skill', [disc('a')]);
    await skillRepo.install('a', 'web-app');
    await skillRepo.enable('a', 'web-app');
    const [entry] = await svc.list('skill');
    expect(entry!.state).toBe('enabled');
  });

  it('row + no files → ghost (metadata null)', async () => {
    svc.setDiscovery('skill', []);
    await skillRepo.install('gone', 'web-app');
    const [entry] = await svc.list('skill');
    expect(entry!.state).toBe('ghost');
    expect(entry!.metadata).toBeNull();
  });

  it('bad manifest → entry carries manifestError', async () => {
    svc.setDiscovery('skill', [{ name: 'b', metadata: null, error: 'bad json' }]);
    const [entry] = await svc.list('skill');
    expect(entry!.manifestError).toBe('bad json');
  });
});

describe('RegistryService lifecycle guards', () => {
  let skillRepo: FakeRepo;
  let svc: RegistryService;
  beforeEach(() => {
    skillRepo = new FakeRepo();
    svc = new RegistryService(skillRepo, new FakeRepo(), [], []);
  });

  it('install rejects a ghost (not on disk)', async () => {
    svc.setDiscovery('skill', []);
    await expect(svc.install('skill', 'ghost', 'web-app')).rejects.toThrow(/not on disk/);
  });

  it('install rejects an item with a manifest error', async () => {
    svc.setDiscovery('skill', [{ name: 'b', metadata: null, error: 'bad json' }]);
    await expect(svc.install('skill', 'b', 'web-app')).rejects.toThrow(/manifest/i);
  });

  it('enable requires an installed row', async () => {
    svc.setDiscovery('skill', [disc('a')]);
    await expect(svc.enable('skill', 'a', 'web-app')).rejects.toThrow(/not installed/);
  });

  it('installAndEnable installs then enables', async () => {
    svc.setDiscovery('skill', [disc('a')]);
    const entry = await svc.installAndEnable('skill', 'a', 'web-app');
    expect(entry.state).toBe('enabled');
  });

  it('uninstall clears a ghost row', async () => {
    svc.setDiscovery('skill', []);
    await skillRepo.install('gone', 'web-app');
    await svc.uninstall('skill', 'gone', 'web-app');
    expect(await skillRepo.getRow('gone')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix $WT exec vitest run src/registry/registry-service.test.ts`
Expected: FAIL — `Cannot find module './registry-service.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/registry/registry-service.ts`:

```typescript
// registry-service.ts — merges on-disk manifest discovery with registry rows to
// compute derived state, and exposes the install/enable/disable/uninstall lifecycle
// the /api/registry routes call. State changes touch the DB only; the live in-memory
// SkillRegistry/AgentRegistry are NOT mutated — enforcement is restart-based (spec §6).

import type {
  IRegistryRepo, RegistryKind, RegistryEntry, Discovery,
} from './types.js';

export class RegistryService {
  // Discovery is captured once at startup and held here. setDiscovery exists so the
  // bootstrap (and tests) can inject the lenient discovery results after construction.
  constructor(
    private readonly skillRepo: IRegistryRepo,
    private readonly agentRepo: IRegistryRepo,
    private skillDiscovery: Discovery[],
    private agentDiscovery: Discovery[],
  ) {}

  setDiscovery(kind: RegistryKind, discovery: Discovery[]): void {
    if (kind === 'skill') this.skillDiscovery = discovery;
    else this.agentDiscovery = discovery;
  }

  private repo(kind: RegistryKind): IRegistryRepo {
    return kind === 'skill' ? this.skillRepo : this.agentRepo;
  }

  private discovery(kind: RegistryKind): Discovery[] {
    return kind === 'skill' ? this.skillDiscovery : this.agentDiscovery;
  }

  /** Every known item (on disk and/or in DB) with its derived state. */
  async list(kind: RegistryKind): Promise<RegistryEntry[]> {
    const rows = await this.repo(kind).listRows();
    const rowByName = new Map(rows.map(r => [r.name, r]));
    const discovery = this.discovery(kind);
    const discByName = new Map(discovery.map(d => [d.name, d]));

    const names = new Set<string>([...discByName.keys(), ...rowByName.keys()]);
    const entries: RegistryEntry[] = [];

    for (const name of names) {
      const disc = discByName.get(name);
      const row = rowByName.get(name);
      const onDisk = disc !== undefined;

      let state: RegistryEntry['state'];
      if (!onDisk) state = 'ghost';
      else if (!row) state = 'uninstalled';
      else state = row.enabled ? 'enabled' : 'installed';

      entries.push({
        name,
        kind,
        state,
        metadata: disc?.metadata ?? null,
        manifestError: disc?.error,
        installedAt: row?.installedAt ?? null,
        installedBy: row?.installedBy ?? null,
        enabledAt: row?.enabledAt ?? null,
        enabledBy: row?.enabledBy ?? null,
      });
    }

    // Stable alphabetical order for a predictable UI.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /** Look up a single derived entry (used to return the post-op state). */
  private async entry(kind: RegistryKind, name: string): Promise<RegistryEntry> {
    const all = await this.list(kind);
    const found = all.find(e => e.name === name);
    if (!found) throw new Error(`Registry entry '${name}' not found after operation`);
    return found;
  }

  /** Reject installing/enabling something that isn't a healthy on-disk manifest. */
  private assertInstallable(kind: RegistryKind, name: string): void {
    const disc = this.discovery(kind).find(d => d.name === name);
    if (!disc) {
      throw new Error(`Cannot install '${name}': not on disk (no manifest found).`);
    }
    if (disc.metadata === null) {
      throw new Error(`Cannot install '${name}': its manifest failed to parse (${disc.error ?? 'unknown error'}).`);
    }
  }

  async install(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    await this.repo(kind).install(name, actor);
    return this.entry(kind, name);
  }

  async enable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    const row = await this.repo(kind).getRow(name);
    if (!row) throw new Error(`Cannot enable '${name}': not installed. Install it first.`);
    await this.repo(kind).enable(name, actor);
    return this.entry(kind, name);
  }

  async installAndEnable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    await this.repo(kind).install(name, actor);
    await this.repo(kind).enable(name, actor);
    return this.entry(kind, name);
  }

  async disable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    const row = await this.repo(kind).getRow(name);
    if (!row) throw new Error(`Cannot disable '${name}': no registry row.`);
    await this.repo(kind).disable(name, actor);
    return this.entry(kind, name);
  }

  /** Uninstall is allowed even for ghosts — it's the only way to clear a ghost row. */
  async uninstall(kind: RegistryKind, name: string, _actor: string): Promise<void> {
    await this.repo(kind).uninstall(name);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix $WT exec vitest run src/registry/registry-service.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --prefix $WT run typecheck
git -C $WT add src/registry/registry-service.ts src/registry/registry-service.test.ts
git -C $WT commit -m "feat: RegistryService derived-state + lifecycle (#541)"
```

---

## Task 4: reconcileRegistries (core-set enrollment)

**Files:**
- Create: `src/registry/reconcile.ts`
- Test: `src/registry/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/registry/reconcile.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileRegistries } from './reconcile.js';
import type { IRegistryRepo, RegistryRow } from './types.js';
import { createLogger } from '../logger.js';

class FakeRepo implements IRegistryRepo {
  rows = new Map<string, RegistryRow>();
  async listRows() { return [...this.rows.values()]; }
  async getRow(n: string) { return this.rows.get(n) ?? null; }
  async install(name: string, actor: string) {
    const e = this.rows.get(name); if (e) return e;
    const row: RegistryRow = { name, enabled: false, installedAt: 't0', installedBy: actor, enabledAt: null, enabledBy: null, updatedAt: 't0' };
    this.rows.set(name, row); return row;
  }
  async enable(name: string, actor: string) {
    const r = this.rows.get(name)!; const n = { ...r, enabled: true, enabledAt: 't1', enabledBy: actor, updatedAt: 't1' };
    this.rows.set(name, n); return n;
  }
  async disable(name: string, actor: string) {
    const r = this.rows.get(name)!; const n = { ...r, enabled: false, enabledAt: null, enabledBy: null, updatedAt: 't1' };
    this.rows.set(name, n); return n;
  }
  async uninstall(name: string) { this.rows.delete(name); }
}

const logger = createLogger('silent');

describe('reconcileRegistries', () => {
  let skillRepo: FakeRepo;
  let agentRepo: FakeRepo;
  beforeEach(() => { skillRepo = new FakeRepo(); agentRepo = new FakeRepo(); });

  const run = (defaults: { skills: string[]; agents: string[] }, onDisk: { skills: string[]; agents: string[] }) =>
    reconcileRegistries({
      skillRepo, agentRepo,
      skillDiscoveryNames: new Set(onDisk.skills),
      agentDiscoveryNames: new Set(onDisk.agents),
      defaults, logger,
    });

  it('enrolls a core item with no row as enabled', async () => {
    await run({ skills: ['core-skill'], agents: [] }, { skills: ['core-skill', 'other'], agents: [] });
    const row = await skillRepo.getRow('core-skill');
    expect(row?.enabled).toBe(true);
    expect(row?.enabledBy).toBe('reconciliation');
    // Non-core stays uninstalled (no row).
    expect(await skillRepo.getRow('other')).toBeNull();
  });

  it('is idempotent — second run changes nothing', async () => {
    const defaults = { skills: ['core-skill'], agents: [] };
    const onDisk = { skills: ['core-skill'], agents: [] };
    await run(defaults, onDisk);
    const first = await skillRepo.getRow('core-skill');
    await run(defaults, onDisk);
    const second = await skillRepo.getRow('core-skill');
    expect(second).toEqual(first);
  });

  it('respects an admin-disabled core item (row present, disabled)', async () => {
    await skillRepo.install('core-skill', 'web-app'); // row exists, enabled=false
    await run({ skills: ['core-skill'], agents: [] }, { skills: ['core-skill'], agents: [] });
    expect((await skillRepo.getRow('core-skill'))?.enabled).toBe(false);
  });

  it('warns (no throw) when a core default is not on disk', async () => {
    await expect(run({ skills: ['missing'], agents: [] }, { skills: [], agents: [] })).resolves.toBeUndefined();
    expect(await skillRepo.getRow('missing')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix $WT exec vitest run src/registry/reconcile.test.ts`
Expected: FAIL — `Cannot find module './reconcile.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/registry/reconcile.ts`:

```typescript
// reconcile.ts — startup enrollment of the trusted core set.
//
// Runs after migrations, before the load+register pass. For each core item named in
// config/registry-defaults.yaml that has NO registry row, it inserts an enabled row.
// It never touches an item that already has a row, so an admin who disables a core
// skill stays disabled across restarts. Non-core items are left uninstalled.
//
// The core set lives in a trusted in-repo file — NOT in individual manifests — so an
// uploaded skill cannot self-enable on upload (spec §3, security rationale).

import type { IRegistryRepo } from './types.js';
import type { Logger } from '../logger.js';

export interface RegistryDefaults {
  skills: string[];
  agents: string[];
}

export interface ReconcileDeps {
  skillRepo: IRegistryRepo;
  agentRepo: IRegistryRepo;
  skillDiscoveryNames: Set<string>;
  agentDiscoveryNames: Set<string>;
  defaults: RegistryDefaults;
  logger: Logger;
}

export async function reconcileRegistries(deps: ReconcileDeps): Promise<void> {
  const { skillRepo, agentRepo, skillDiscoveryNames, agentDiscoveryNames, defaults, logger } = deps;
  await reconcileOne('skill', skillRepo, skillDiscoveryNames, defaults.skills ?? [], logger);
  await reconcileOne('agent', agentRepo, agentDiscoveryNames, defaults.agents ?? [], logger);
}

async function reconcileOne(
  kind: 'skill' | 'agent',
  repo: IRegistryRepo,
  discoveryNames: Set<string>,
  coreNames: string[],
  logger: Logger,
): Promise<void> {
  const existing = new Set((await repo.listRows()).map(r => r.name));

  for (const name of coreNames) {
    if (existing.has(name)) continue; // respect any existing admin state
    if (!discoveryNames.has(name)) {
      logger.warn({ kind, name }, 'registry: core default not found on disk; skipping enrollment');
      continue;
    }
    await repo.install(name, 'reconciliation');
    await repo.enable(name, 'reconciliation');
    logger.info({ kind, name }, 'registry: enrolled core default as enabled');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix $WT exec vitest run src/registry/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --prefix $WT run typecheck
git -C $WT add src/registry/reconcile.ts src/registry/reconcile.test.ts
git -C $WT commit -m "feat: registry core-set reconciliation (#541)"
```

---

## Task 5: RegistryRepo (Postgres) + integration test

**Files:**
- Create: `src/registry/registry-repo.ts`
- Test: `tests/integration/registry-repo.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/registry-repo.test.ts`:

```typescript
// Integration tests for RegistryRepo — requires Postgres with migrations applied.
// Skips gracefully when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { RegistryRepo } from '../../src/registry/registry-repo.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('RegistryRepo (skill_registry)', () => {
  let pool: pg.Pool;
  let repo: RegistryRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM skill_registry LIMIT 0'); // fails loudly if migration 051 not applied
    repo = new RegistryRepo(pool, 'skill_registry');
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await pool.query('DELETE FROM skill_registry'); });

  it('install inserts a disabled row with installed_by', async () => {
    const row = await repo.install('alpha', 'tester');
    expect(row.enabled).toBe(false);
    expect(row.installedBy).toBe('tester');
    expect(row.enabledAt).toBeNull();
  });

  it('install is idempotent — second call returns the same row', async () => {
    const first = await repo.install('alpha', 'tester');
    const second = await repo.install('alpha', 'someone-else');
    expect(second.installedBy).toBe(first.installedBy); // unchanged
  });

  it('enable sets enabled + enabled_at/by', async () => {
    await repo.install('alpha', 'tester');
    const row = await repo.enable('alpha', 'enabler');
    expect(row.enabled).toBe(true);
    expect(row.enabledBy).toBe('enabler');
    expect(row.enabledAt).not.toBeNull();
  });

  it('disable clears enabled_at/by', async () => {
    await repo.install('alpha', 'tester');
    await repo.enable('alpha', 'enabler');
    const row = await repo.disable('alpha', 'disabler');
    expect(row.enabled).toBe(false);
    expect(row.enabledAt).toBeNull();
    expect(row.enabledBy).toBeNull();
  });

  it('enable throws when no row exists', async () => {
    await expect(repo.enable('ghost', 'x')).rejects.toThrow(/no registry row/i);
  });

  it('uninstall deletes the row', async () => {
    await repo.install('alpha', 'tester');
    await repo.uninstall('alpha');
    expect(await repo.getRow('alpha')).toBeNull();
  });

  it('listRows returns all rows', async () => {
    await repo.install('alpha', 'tester');
    await repo.install('beta', 'tester');
    const rows = await repo.listRows();
    expect(rows.map(r => r.name).sort()).toEqual(['alpha', 'beta']);
  });
});
```

- [ ] **Step 2: Ensure migrations are applied, then run the test to verify it fails**

Run: `pnpm --prefix $WT migrate`
Run: `pnpm --prefix $WT exec vitest run tests/integration/registry-repo.test.ts`
Expected: FAIL — `Cannot find module '../../src/registry/registry-repo.js'`. (If `DATABASE_URL` is unset, the suite is skipped — set it before proceeding.)

- [ ] **Step 3: Write the implementation**

Create `src/registry/registry-repo.ts`:

```typescript
// registry-repo.ts — Postgres-backed CRUD over skill_registry / agent_registry.
// One instance per table (the table name is validated against an allowlist so it can
// never be attacker-influenced). All queries parameterized. Mirrors the SecretsService
// / AutonomyService injection pattern: constructor takes (pool, table).

import type { DbPool } from '../db/connection.js';
import type { IRegistryRepo, RegistryRow } from './types.js';

// Fixed allowlist — the table name is interpolated into SQL (identifiers can't be
// parameterized), so it MUST come from this set and never from user input.
const ALLOWED_TABLES = new Set(['skill_registry', 'agent_registry']);

interface DbRegistryRow {
  name: string;
  enabled: boolean;
  installed_at: string;
  installed_by: string;
  enabled_at: string | null;
  enabled_by: string | null;
  updated_at: string;
}

function mapRow(row: DbRegistryRow): RegistryRow {
  return {
    name: row.name,
    enabled: row.enabled,
    installedAt: row.installed_at,
    installedBy: row.installed_by,
    enabledAt: row.enabled_at,
    enabledBy: row.enabled_by,
    updatedAt: row.updated_at,
  };
}

const COLS = 'name, enabled, installed_at, installed_by, enabled_at, enabled_by, updated_at';

export class RegistryRepo implements IRegistryRepo {
  private readonly table: string;

  constructor(private readonly pool: DbPool, table: string) {
    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`RegistryRepo: invalid table '${table}'`);
    }
    this.table = table;
  }

  async listRows(): Promise<RegistryRow[]> {
    const { rows } = await this.pool.query<DbRegistryRow>(`SELECT ${COLS} FROM ${this.table}`);
    return rows.map(mapRow);
  }

  async getRow(name: string): Promise<RegistryRow | null> {
    const { rows } = await this.pool.query<DbRegistryRow>(
      `SELECT ${COLS} FROM ${this.table} WHERE name = $1`, [name],
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async install(name: string, actor: string): Promise<RegistryRow> {
    // Insert a disabled row; if it already exists, leave it untouched and return it.
    const { rows } = await this.pool.query<DbRegistryRow>(
      `INSERT INTO ${this.table} (name, enabled, installed_by)
       VALUES ($1, false, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING ${COLS}`,
      [name, actor],
    );
    return mapRow(rows[0]!);
  }

  async enable(name: string, actor: string): Promise<RegistryRow> {
    const { rows } = await this.pool.query<DbRegistryRow>(
      `UPDATE ${this.table}
         SET enabled = true, enabled_at = now(), enabled_by = $2, updated_at = now()
       WHERE name = $1
       RETURNING ${COLS}`,
      [name, actor],
    );
    if (!rows[0]) throw new Error(`enable: no registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async disable(name: string, actor: string): Promise<RegistryRow> {
    const { rows } = await this.pool.query<DbRegistryRow>(
      `UPDATE ${this.table}
         SET enabled = false, enabled_at = NULL, enabled_by = NULL, updated_at = now()
       WHERE name = $1
       RETURNING ${COLS}`,
      [name],
    );
    if (!rows[0]) throw new Error(`disable: no registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async uninstall(name: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table} WHERE name = $1`, [name]);
  }
}
```

> Note: `actor` is unused in `disable`'s SQL (we clear `enabled_by`); it stays in the signature to satisfy `IRegistryRepo` and document intent. Prefix-rename is unnecessary because it's a parameter of an interface method.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --prefix $WT exec vitest run tests/integration/registry-repo.test.ts`
Expected: PASS (7 cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --prefix $WT run typecheck
git -C $WT add src/registry/registry-repo.ts tests/integration/registry-repo.test.ts
git -C $WT commit -m "feat: Postgres RegistryRepo + integration tests (#541)"
```

---

## Task 6: Manifest schema — reserved install/uninstall blocks

**Files:**
- Modify: `src/skills/types.ts` (add `install`/`uninstall` to `SkillManifest`)
- Modify: `src/agents/loader.ts` (add `install`/`uninstall` to `AgentYamlConfig`)
- Modify: `schemas/skill-manifest.schema.json`
- Modify: `schemas/agent-config.schema.json`

- [ ] **Step 1: Add optional fields to `SkillManifest`**

In `src/skills/types.ts`, inside `interface SkillManifest`, after the `allowed_callers?` field (the last field, ends at line 83), add:

```typescript
  /** Optional declarative install/uninstall blocks (spec: skill/agent registry, #541).
   *  Reserved schema surface — PARSED BUT INERT in PR1. PR2 (secrets) and PR3 (config)
   *  define and act on their contents. Existing manifests omit both. */
  install?: Record<string, unknown>;
  uninstall?: Record<string, unknown>;
```

- [ ] **Step 2: Add optional fields to `AgentYamlConfig`**

In `src/agents/loader.ts`, inside `interface AgentYamlConfig`, after the `enable_task_management?` field (the last field, line 71), add:

```typescript
  /** Optional declarative install/uninstall blocks (skill/agent registry, #541).
   *  Reserved schema surface — parsed but inert in PR1. */
  install?: Record<string, unknown>;
  uninstall?: Record<string, unknown>;
```

- [ ] **Step 3: Extend the JSON schemas**

In `schemas/skill-manifest.schema.json`, add two properties inside the top-level `"properties"` object (alongside `name`, `description`, etc.):

```json
    "install":   { "type": "object" },
    "uninstall": { "type": "object" }
```

In `schemas/agent-config.schema.json`, add the same two properties inside its `"properties"` object. (This schema has `"additionalProperties": false`, so these declarations are REQUIRED for an agent YAML carrying an `install:` block to pass startup validation.)

- [ ] **Step 4: Typecheck + verify existing manifests still validate**

Run: `pnpm --prefix $WT run typecheck`
Expected: PASS.

Run: `pnpm --prefix $WT exec vitest run tests/integration/agent-bootstrap.test.ts` (or the startup-validator unit test if present)
Expected: PASS — existing manifests omit `install`/`uninstall` and validate unchanged. If no such test runs without a DB, instead start the app once (`pnpm --prefix $WT run typecheck` is sufficient for the schema's structural validity; the schema is exercised at boot in Task 8).

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/skills/types.ts src/agents/loader.ts schemas/skill-manifest.schema.json schemas/agent-config.schema.json
git -C $WT commit -m "feat: reserve optional install/uninstall manifest blocks (#541)"
```

---

## Task 7: Discovery + gated loaders

**Files:**
- Modify: `src/skills/loader.ts` (add `discoverSkillManifests`; change `loadSkillsFromDirectory` to consume discoveries + `enabledNames`)
- Modify: `src/agents/loader.ts` (add `discoverAgentManifests`)
- Test: `src/skills/loader.test.ts` (create if absent; otherwise append)
- Test: `src/agents/loader.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing skill-loader test**

Create `src/skills/loader.test.ts` (if it exists, append the new `describe` blocks):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverSkillManifests, loadSkillsFromDirectory } from './loader.js';
import { SkillRegistry } from './registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('silent');

function writeSkill(dir: string, name: string, manifest: object, handler: string) {
  const sdir = path.join(dir, name);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'skill.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(sdir, 'handler.js'), handler);
}

describe('discoverSkillManifests', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns metadata without importing handlers', () => {
    writeSkill(dir, 'good', { name: 'good', description: 'd', version: '1.0.0', action_risk: 'low' }, 'throw new Error("should not import");');
    const found = discoverSkillManifests(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('good');
    expect(found[0]!.metadata?.actionRisk).toBe('low');
    expect(found[0]!.error).toBeUndefined();
  });

  it('captures a parse error instead of throwing', () => {
    const sdir = path.join(dir, 'broken');
    fs.mkdirSync(sdir);
    fs.writeFileSync(path.join(sdir, 'skill.json'), '{ not json');
    const found = discoverSkillManifests(dir);
    expect(found[0]!.metadata).toBeNull();
    expect(found[0]!.error).toBeTruthy();
  });
});

describe('loadSkillsFromDirectory (gated)', () => {
  let dir: string;
  let registry: SkillRegistry;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    registry = new SkillRegistry('UTC');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const HANDLER = 'export default { async execute() { return { success: true, data: {} }; } };';

  it('registers only enabled skills', async () => {
    writeSkill(dir, 'on',  { name: 'on',  description: 'd', version: '1.0.0', action_risk: 'none' }, HANDLER);
    writeSkill(dir, 'off', { name: 'off', description: 'd', version: '1.0.0', action_risk: 'none' }, HANDLER);
    const discoveries = discoverSkillManifests(dir);
    const loaded = await loadSkillsFromDirectory(discoveries, registry, logger, new Set(['on']));
    expect(loaded).toBe(1);
    expect(registry.get('on')).toBeDefined();
    expect(registry.get('off')).toBeUndefined();
  });

  it('hard-fails on an ENABLED skill with a bad manifest', async () => {
    const discoveries = [{ name: 'bad', metadata: null, error: 'bad json', dir: path.join(dir, 'bad') }];
    await expect(
      loadSkillsFromDirectory(discoveries as never, registry, logger, new Set(['bad'])),
    ).rejects.toThrow();
  });

  it('skips a DISABLED skill with a bad manifest (no throw)', async () => {
    const discoveries = [{ name: 'bad', metadata: null, error: 'bad json', dir: path.join(dir, 'bad') }];
    const loaded = await loadSkillsFromDirectory(discoveries as never, registry, logger, new Set());
    expect(loaded).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix $WT exec vitest run src/skills/loader.test.ts`
Expected: FAIL — `discoverSkillManifests` is not exported / signature mismatch.

- [ ] **Step 3: Refactor `src/skills/loader.ts`**

Replace the top imports and the `loadSkillsFromDirectory` function. First, add this `SkillDiscovery` type and `discoverSkillManifests` function ABOVE `loadSkillsFromDirectory` (after the `VALID_CAPABILITIES` block). Keep `VALID_CAPABILITIES` and `validateAllowedCallers` as-is.

```typescript
import type { ManifestMetadata } from '../registry/types.js';

/** One discovered on-disk skill: lenient parse for the registry UI + reconciliation.
 *  `metadata` is null when skill.json failed to parse (error captured). `dir` is the
 *  skill directory, needed by loadSkillsFromDirectory to import the handler. */
export interface SkillDiscovery {
  name: string;
  metadata: ManifestMetadata | null;
  error?: string;
  dir: string;
  /** Full parsed+defaulted manifest, present only when metadata !== null. */
  manifest?: SkillManifest;
}

/**
 * Scan skillsDir and parse every skill.json leniently (no handler import).
 * A parse error is captured per-skill rather than thrown, so a broken DISABLED
 * skill never crashes startup. Used by the registry UI, reconciliation, and as
 * the input to loadSkillsFromDirectory.
 */
export function discoverSkillManifests(skillsDir: string): SkillDiscovery[] {
  if (!fs.existsSync(skillsDir)) {
    throw new Error(`Skills directory not found: ${skillsDir}`);
  }
  const out: SkillDiscovery[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(skillsDir, entry.name);
    const manifestPath = path.join(dir, 'skill.json');
    if (!fs.existsSync(manifestPath)) continue; // not a skill dir (e.g. _shared)

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SkillManifest;
      manifest.timeout ??= 30000;
      manifest.sensitivity ??= 'normal';
      manifest.permissions ??= [];
      manifest.secrets ??= [];
      manifest.inputs ??= {};
      manifest.outputs ??= {};
      out.push({
        name: manifest.name,
        dir,
        manifest,
        metadata: {
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          actionRisk: manifest.action_risk,
          sensitivity: manifest.sensitivity,
          capabilities: manifest.capabilities,
        },
      });
    } catch (err) {
      out.push({ name: entry.name, dir, metadata: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
```

Now replace the existing `loadSkillsFromDirectory` (lines 46–144) with a version that consumes discoveries + `enabledNames`:

```typescript
/**
 * Register enabled skills from pre-computed discovery results.
 *
 * Only skills whose name is in `enabledNames` are imported + registered. A disabled
 * skill is skipped (info-logged). An ENABLED skill with a bad manifest (metadata null)
 * is a hard failure — a thing going live must be valid (fail closed, unchanged from
 * the old behavior). Returns the number of skills registered.
 */
export async function loadSkillsFromDirectory(
  discoveries: SkillDiscovery[],
  registry: SkillRegistry,
  logger: Logger,
  enabledNames: Set<string>,
): Promise<number> {
  let loaded = 0;

  for (const disc of discoveries) {
    if (!enabledNames.has(disc.name)) {
      logger.info({ skill: disc.name }, 'Skill not enabled in registry; skipping');
      continue;
    }
    if (disc.metadata === null || !disc.manifest) {
      // Enabled but unparseable — fail closed.
      throw new Error(`Enabled skill '${disc.name}' has an invalid manifest: ${disc.error ?? 'unknown error'}`);
    }

    try {
      const manifest = disc.manifest;

      if (manifest.capabilities !== undefined) {
        for (const cap of manifest.capabilities) {
          if (!VALID_CAPABILITIES.has(cap)) {
            throw new Error(
              `Skill '${manifest.name}' declares unknown capability '${cap}'. ` +
              `Valid capabilities: ${[...VALID_CAPABILITIES].join(', ')}`,
            );
          }
        }
      }

      const handlerPath = fs.existsSync(path.join(disc.dir, 'handler.ts'))
        ? path.join(disc.dir, 'handler.ts')
        : path.join(disc.dir, 'handler.js');
      if (!fs.existsSync(handlerPath)) {
        throw new Error(`No handler.ts or handler.js found in ${disc.dir}`);
      }

      const handlerModule = await import(`file://${handlerPath}`) as Record<string, unknown>;
      let handler: SkillHandler;
      if (handlerModule.default && typeof (handlerModule.default as Record<string, unknown>).execute === 'function') {
        handler = handlerModule.default as SkillHandler;
      } else {
        const HandlerClass = Object.values(handlerModule).find(
          (exp: unknown) => typeof exp === 'function' && (exp as { prototype?: { execute?: unknown } }).prototype?.execute,
        ) as (new () => SkillHandler) | undefined;
        if (!HandlerClass) throw new Error(`No valid SkillHandler export found in ${handlerPath}`);
        handler = new HandlerClass();
      }

      if (manifest.capabilities !== undefined) Object.freeze(manifest.capabilities);
      if (manifest.allowed_callers !== undefined) Object.freeze(manifest.allowed_callers);
      Object.freeze(manifest);

      registry.register(manifest, handler);
      logger.info({ skill: manifest.name, version: manifest.version }, 'Skill loaded');
      loaded++;
    } catch (err) {
      logger.error({ err, skill: disc.name }, 'Failed to load skill');
      throw new Error(`Failed to load skill '${disc.name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return loaded;
}
```

- [ ] **Step 4: Run the skill-loader test to verify it passes**

Run: `pnpm --prefix $WT exec vitest run src/skills/loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing agent-loader test**

Create `src/agents/loader.test.ts` (append if it exists):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverAgentManifests } from './loader.js';

describe('discoverAgentManifests', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parses valid agent YAML into name + config', () => {
    fs.writeFileSync(path.join(dir, 'cool.yaml'),
      'name: cool\ndescription: a cool agent\nversion: "1.0.0"\nrole: specialist\nmodel:\n  tier: fast\nsystem_prompt: hi\n');
    const found = discoverAgentManifests(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('cool');
    expect(found[0]!.config?.model.tier).toBe('fast');
    expect(found[0]!.error).toBeUndefined();
  });

  it('captures a YAML parse error instead of throwing', () => {
    fs.writeFileSync(path.join(dir, 'busted.yaml'), 'name: busted\n  bad: : indent');
    const found = discoverAgentManifests(dir);
    expect(found[0]!.config).toBeNull();
    expect(found[0]!.error).toBeTruthy();
    expect(found[0]!.name).toBe('busted'); // falls back to filename
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --prefix $WT exec vitest run src/agents/loader.test.ts`
Expected: FAIL — `discoverAgentManifests` not exported.

- [ ] **Step 7: Add `discoverAgentManifests` to `src/agents/loader.ts`**

Add this `AgentDiscovery` type and function after `loadAllAgentConfigs` (line 113). It reuses `loadAgentConfig` so persona interpolation is preserved:

```typescript
/** One discovered on-disk agent: lenient parse for the registry UI + reconciliation.
 *  `config` is null when the YAML failed to parse (error captured). When valid, the
 *  full parsed config is reused by the bootstrap so enabled agents aren't re-read. */
export interface AgentDiscovery {
  name: string;
  config: AgentYamlConfig | null;
  error?: string;
}

/**
 * Scan dirPath and parse every agent YAML leniently. A parse error is captured
 * per-file rather than thrown, so a broken DISABLED agent never crashes startup.
 */
export function discoverAgentManifests(dirPath: string): AgentDiscovery[] {
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  return files.map(f => {
    try {
      const config = loadAgentConfig(path.join(dirPath, f));
      return { name: config.name, config };
    } catch (err) {
      return {
        name: f.replace(/\.ya?ml$/, ''),
        config: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
```

- [ ] **Step 8: Run the agent-loader test to verify it passes**

Run: `pnpm --prefix $WT exec vitest run src/agents/loader.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
pnpm --prefix $WT run typecheck
git -C $WT add src/skills/loader.ts src/skills/loader.test.ts src/agents/loader.ts src/agents/loader.test.ts
git -C $WT commit -m "feat: lenient discovery + registry-gated loaders (#541)"
```

---

## Task 8: config/registry-defaults.yaml + bootstrap wiring

**Files:**
- Create: `config/registry-defaults.yaml`
- Modify: `src/index.ts` (discovery → reconcile → enabled-gated load; build `RegistryService`; widen `validateAllowedCallers` input)

This task changes the live boot path. After it, the app boots with registry gating. The integration verification is Step 8.

- [ ] **Step 1: Create the defaults file**

Create `config/registry-defaults.yaml`:

```yaml
# Trusted, in-repo list of skills/agents enabled by default on a FRESH install.
# NOT read from individual manifests (which are attacker-controlled on upload) —
# this file ships with the codebase. Reconciliation enrolls these as enabled ONLY
# when no registry row already exists (it never overrides an admin's choice).
#
# The existing production deployment ignores this file: it is migrated by the
# one-shot scripts/backfill-registry-enable-all.ts, which enables everything on disk.
#
# Finalize this list so a fresh install is usable out of the box but minimal. Start
# with the coordinator + the skills it pins, then trim. Update as the core set evolves.
skills:
  - skill-registry
agents:
  - coordinator
```

> The implementer should expand `skills:`/`agents:` to the genuine minimal core set (the coordinator's `pinned_skills` plus anything required to boot a usable instance), confirming each name exists in `skills/`/`agents/`. Keep it minimal — everything else is opt-in via the UI.

- [ ] **Step 2: Add imports to `src/index.ts`**

At the top of `src/index.ts`, update the loader imports and add registry imports.

Change line 33 from:
```typescript
import { loadAllAgentConfigs, interpolateRuntimeContext } from './agents/loader.js';
```
to:
```typescript
import { discoverAgentManifests, interpolateRuntimeContext, type AgentYamlConfig } from './agents/loader.js';
```

Change line 50 from:
```typescript
import { loadSkillsFromDirectory, validateAllowedCallers } from './skills/loader.js';
```
to:
```typescript
import { discoverSkillManifests, loadSkillsFromDirectory, validateAllowedCallers } from './skills/loader.js';
```

Add near the other imports (use the default-import style that `src/agents/loader.ts` uses — `import yaml from 'js-yaml'` — not a namespace import):
```typescript
import yaml from 'js-yaml';
import { RegistryRepo } from './registry/registry-repo.js';
import { RegistryService } from './registry/registry-service.js';
import { reconcileRegistries, type RegistryDefaults } from './registry/reconcile.js';
import type { Discovery } from './registry/types.js';
```
(If `js-yaml` is already imported in index.ts, reuse the existing import instead of adding a duplicate.)

- [ ] **Step 3: Replace the skill-loading block (lines 767–778)**

Replace:
```typescript
  const skillRegistry = new SkillRegistry(config.timezone);
  const skillsDir = path.resolve(import.meta.dirname, '../skills');
  try {
    const skillCount = await loadSkillsFromDirectory(skillsDir, skillRegistry, logger);
    logger.info({ skillCount }, 'Skills loaded');
  } catch (err) {
    logger.fatal({ err }, 'Failed to load skills');
    process.exit(1);
  }
```
with:
```typescript
  const skillRegistry = new SkillRegistry(config.timezone);
  const skillsDir = path.resolve(import.meta.dirname, '../skills');
  const agentsDir = path.resolve(import.meta.dirname, '../agents');

  // --- Registry: discover everything on disk (lenient), reconcile the core set,
  // then load+register ONLY enabled skills/agents. (Spec: skill/agent registry, #541.)
  const skillDiscovery = discoverSkillManifests(skillsDir);
  const agentDiscovery = discoverAgentManifests(agentsDir);

  const skillRegistryRepo = new RegistryRepo(pool, 'skill_registry');
  const agentRegistryRepo = new RegistryRepo(pool, 'agent_registry');

  // Load the trusted fresh-install core set.
  let registryDefaults: RegistryDefaults = { skills: [], agents: [] };
  try {
    const defaultsPath = path.resolve(import.meta.dirname, '../config/registry-defaults.yaml');
    if (fs.existsSync(defaultsPath)) {
      registryDefaults = (yaml.load(fs.readFileSync(defaultsPath, 'utf-8')) as RegistryDefaults) ?? registryDefaults;
    }
  } catch (err) {
    logger.fatal({ err }, 'Failed to read config/registry-defaults.yaml');
    process.exit(1);
  }

  try {
    await reconcileRegistries({
      skillRepo: skillRegistryRepo,
      agentRepo: agentRegistryRepo,
      skillDiscoveryNames: new Set(skillDiscovery.map(d => d.name)),
      agentDiscoveryNames: new Set(agentDiscovery.map(d => d.name)),
      defaults: registryDefaults,
      logger,
    });
  } catch (err) {
    logger.fatal({ err }, 'Registry reconciliation failed');
    process.exit(1);
  }

  // Ghost warnings: a registry row whose files are gone never loads.
  const skillDiscNames = new Set(skillDiscovery.map(d => d.name));
  for (const row of await skillRegistryRepo.listRows()) {
    if (!skillDiscNames.has(row.name)) {
      logger.warn({ skill: row.name }, 'registry: enabled/installed skill has no files on disk (ghost); not loaded');
    }
  }

  const enabledSkillNames = new Set(
    (await skillRegistryRepo.listRows()).filter(r => r.enabled).map(r => r.name),
  );
  try {
    const skillCount = await loadSkillsFromDirectory(skillDiscovery, skillRegistry, logger, enabledSkillNames);
    logger.info({ skillCount }, 'Skills loaded');
  } catch (err) {
    logger.fatal({ err }, 'Failed to load skills');
    process.exit(1);
  }
```

(Note: this introduces `fs` and `yaml` usage — `fs` is already imported in index.ts as `* as fs from 'node:fs'` or similar; verify and reuse. `import.meta.dirname` is already used at lines 195/768.)

> The `import fs` check: run `grep -n "from 'node:fs'" $WT/src/index.ts`. If absent, add `import * as fs from 'node:fs';`.

- [ ] **Step 4: Replace the agent-loading block (lines 805–815)**

Replace:
```typescript
  const agentsDir = path.resolve(import.meta.dirname, '../agents');
  let agentConfigs;
  try {
    agentConfigs = loadAllAgentConfigs(agentsDir);
    logger.info({ agents: agentConfigs.map(c => c.name) }, 'Agent configs loaded');
  } catch (err) {
    logger.fatal({ err }, 'Failed to load agent configs');
    process.exit(1);
  }
```
with (note `agentsDir` is now declared earlier in Step 3 — remove the duplicate declaration):
```typescript
  // Agents: ghost warnings, then keep only ENABLED, healthy agent configs. An enabled
  // agent with a broken manifest is a hard failure (fail closed); a disabled broken one
  // is skipped silently (already surfaced in the registry UI).
  const agentDiscNames = new Set(agentDiscovery.map(d => d.name));
  for (const row of await agentRegistryRepo.listRows()) {
    if (!agentDiscNames.has(row.name)) {
      logger.warn({ agent: row.name }, 'registry: enabled/installed agent has no files on disk (ghost); not loaded');
    }
  }
  const enabledAgentNames = new Set(
    (await agentRegistryRepo.listRows()).filter(r => r.enabled).map(r => r.name),
  );
  let agentConfigs: AgentYamlConfig[];
  try {
    agentConfigs = [];
    for (const disc of agentDiscovery) {
      if (!enabledAgentNames.has(disc.name)) continue;
      if (!disc.config) {
        throw new Error(`Enabled agent '${disc.name}' has an invalid config: ${disc.error ?? 'unknown error'}`);
      }
      agentConfigs.push(disc.config);
    }
    logger.info({ agents: agentConfigs.map(c => c.name) }, 'Agent configs loaded');
  } catch (err) {
    logger.fatal({ err }, 'Failed to load agent configs');
    process.exit(1);
  }
```

- [ ] **Step 5: Widen `validateAllowedCallers` input (lines 1388–1390)**

Replace:
```typescript
    const knownAgentNames = new Set(agentConfigs.map(c => c.name));
    validateAllowedCallers(skillRegistry, knownAgentNames);
```
with:
```typescript
    // Use ALL discovered agent names (enabled + disabled), not just enabled ones, so a
    // skill that allows a currently-disabled agent as a caller doesn't trip the typo
    // check. A genuinely unknown name still throws. (Spec: pinned/caller knock-on.)
    const knownAgentNames = new Set(agentDiscovery.map(d => d.name));
    validateAllowedCallers(skillRegistry, knownAgentNames);
```

- [ ] **Step 6: Build and expose `RegistryService`**

Immediately AFTER the `validateAllowedCallers` try/catch block (after line 1394), add:
```typescript
  // RegistryService backs the /api/registry/* routes. Seed it with the discovery
  // captured above so the UI can show uninstalled/ghost/error items, not just enabled.
  const registryService = new RegistryService(
    skillRegistryRepo,
    agentRegistryRepo,
    skillDiscovery as unknown as Discovery[],
    agentDiscovery.map(d => ({
      name: d.name,
      metadata: d.config
        ? { name: d.config.name, description: d.config.description ?? d.config.name, version: d.config.version ?? '0.0.0', role: d.config.role, modelTier: d.config.model?.tier }
        : null,
      error: d.error,
    })),
  );
```

> `skillDiscovery` items already carry `{ name, metadata, error }` (plus `dir`/`manifest`), which structurally satisfy `Discovery`; the cast documents that the extra fields are ignored by the service.

- [ ] **Step 7: Pass `registryService` to the HTTP adapter**

At the `new HttpAdapter({` construction (line 1720), add `registryService,` to the config object (next to `autonomyService,` on line 1735). (The field is added to `HttpAdapterConfig` in Task 9, so do Task 9 before typechecking this, or expect a transient type error until then.)

- [ ] **Step 8: Verify the app boots with gating**

Run: `pnpm --prefix $WT migrate`
Run: `pnpm --prefix $WT run typecheck` (after Task 9 adds the config field)
Then boot once against the dev DB:
Run: `pnpm --prefix $WT run local` — watch the logs.
Expected: `registry: enrolled core default as enabled` for each core item on a fresh registry; `Skills loaded` with a count equal to the enabled set; no fatal. Stop the process (Ctrl-C) once you see the HTTP server listening.

> If the registry is empty (fresh), only core skills/agents load — that's expected. To restore full behavior on a populated dev DB, run the backfill script (Task 10) or enable items via the UI (Task 11).

- [ ] **Step 9: Commit**

```bash
git -C $WT add config/registry-defaults.yaml src/index.ts
git -C $WT commit -m "feat: wire registry reconciliation + enabled-gated loading into bootstrap (#541)"
```

---

## Task 9: HTTP routes + adapter wiring

**Files:**
- Create: `src/channels/http/routes/registry.ts`
- Modify: `src/channels/http/http-adapter.ts` (config field, bearer-bypass, route registration)
- Test: `tests/integration/registry-routes.test.ts`

- [ ] **Step 1: Write the route module**

Create `src/channels/http/routes/registry.ts`:

```typescript
// registry.ts — HTTP routes for the skill/agent registry management UI.
// Session-cookie or x-web-bootstrap-secret auth (same pattern as autonomy.ts/kg.ts).
// Only mounted when webAppBootstrapSecret + registryService are configured.
//
//   GET    /api/registry/skills                  — list all skills with derived state
//   GET    /api/registry/agents                  — list all agents with derived state
//   POST   /api/registry/:kind/:name/install
//   POST   /api/registry/:kind/:name/enable
//   POST   /api/registry/:kind/:name/install-enable
//   POST   /api/registry/:kind/:name/disable
//   DELETE /api/registry/:kind/:name             — uninstall

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RegistryService } from '../../../registry/registry-service.js';
import type { RegistryKind } from '../../../registry/types.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface RegistryRouteOptions {
  registryService: RegistryService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

const ACTOR = 'web-app'; // no per-user identity in the console today (same as autonomy routes)

function parseKind(raw: string): RegistryKind | null {
  return raw === 'skills' ? 'skill' : raw === 'agents' ? 'agent' : null;
}

export async function registryRoutes(
  app: FastifyInstance,
  options: RegistryRouteOptions,
): Promise<void> {
  const { registryService, webAppBootstrapSecret, sessions } = options;
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  app.get('/api/registry/skills', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send({ skills: await registryService.list('skill') });
    } catch (err) {
      request.log.error({ err }, 'GET /api/registry/skills failed');
      return reply.status(500).send({ error: 'Failed to list skills. Check server logs.' });
    }
  });

  app.get('/api/registry/agents', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send({ agents: await registryService.list('agent') });
    } catch (err) {
      request.log.error({ err }, 'GET /api/registry/agents failed');
      return reply.status(500).send({ error: 'Failed to list agents. Check server logs.' });
    }
  });

  // Single handler for the four state-changing POST actions.
  const action = (op: 'install' | 'enable' | 'install-enable' | 'disable') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAuth(request, reply)) return;
      const { kind: rawKind, name } = request.params as { kind: string; name: string };
      const kind = parseKind(rawKind);
      if (!kind) return reply.status(400).send({ error: `Unknown kind '${rawKind}' (expected 'skills' or 'agents')` });
      try {
        let entry;
        if (op === 'install') entry = await registryService.install(kind, name, ACTOR);
        else if (op === 'enable') entry = await registryService.enable(kind, name, ACTOR);
        else if (op === 'install-enable') entry = await registryService.installAndEnable(kind, name, ACTOR);
        else entry = await registryService.disable(kind, name, ACTOR);
        return reply.send({ entry });
      } catch (err) {
        // Service guard failures (ghost install, not-installed enable) are caller errors → 400.
        request.log.warn({ err, kind, name, op }, `registry ${op} rejected`);
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Operation failed' });
      }
    };

  app.post('/api/registry/:kind/:name/install', AUTH_RATE, action('install'));
  app.post('/api/registry/:kind/:name/enable', AUTH_RATE, action('enable'));
  app.post('/api/registry/:kind/:name/install-enable', AUTH_RATE, action('install-enable'));
  app.post('/api/registry/:kind/:name/disable', AUTH_RATE, action('disable'));

  app.delete('/api/registry/:kind/:name', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { kind: rawKind, name } = request.params as { kind: string; name: string };
    const kind = parseKind(rawKind);
    if (!kind) return reply.status(400).send({ error: `Unknown kind '${rawKind}'` });
    try {
      await registryService.uninstall(kind, name, ACTOR);
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err, kind, name }, 'registry uninstall failed');
      return reply.status(500).send({ error: 'Uninstall failed. Check server logs.' });
    }
  });
}
```

- [ ] **Step 2: Wire into `http-adapter.ts`**

In `src/channels/http/http-adapter.ts`:

(a) Add the import near the other route imports (after line 37 `import { autonomyRoutes } ...`):
```typescript
import { registryRoutes } from './routes/registry.js';
```

(b) Add to `HttpAdapterConfig` (after `autonomyService?` on line 60):
```typescript
  registryService?: import('../../registry/registry-service.js').RegistryService;
```

(c) Add `/api/registry` to the bearer-token bypass list (the `routeUrl.startsWith(...)` chain at lines 157–162). After the `/api/autonomy` line add:
```typescript
        routeUrl.startsWith('/api/registry') ||
```

(d) Register the routes (after the autonomy registration block ending ~line 298):
```typescript
    if (webAppBootstrapSecret && this.config.registryService) {
      await this.app.register(registryRoutes, {
        registryService: this.config.registryService,
        webAppBootstrapSecret,
        sessions,
      });
    }
```
(`sessions` is the `SessionStore` already in scope where autonomyRoutes is registered — confirm by reading the surrounding lines; reuse the same variable.)

- [ ] **Step 3: Write the failing routes integration test**

Create `tests/integration/registry-routes.test.ts`:

```typescript
// End-to-end-ish test of the registry routes via a real Fastify instance + RegistryService
// over a real RegistryRepo. Requires DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registryRoutes } from '../../src/channels/http/routes/registry.js';
import { RegistryRepo } from '../../src/registry/registry-repo.js';
import { RegistryService } from '../../src/registry/registry-service.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const SECRET = 'test-bootstrap-secret';

describeIf('registry routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM skill_registry LIMIT 0');
    const skillRepo = new RegistryRepo(pool, 'skill_registry');
    const agentRepo = new RegistryRepo(pool, 'agent_registry');
    const svc = new RegistryService(skillRepo, agentRepo,
      [{ name: 'alpha', metadata: { name: 'alpha', description: 'A', version: '1.0.0' } }],
      []);
    app = Fastify();
    await app.register(cookie);
    // Minimal session store stub: empty map → forces header-secret auth path.
    await app.register(registryRoutes, { registryService: svc, webAppBootstrapSecret: SECRET, sessions: new Map() as never });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await pool.end(); });
  beforeEach(async () => { await pool.query('DELETE FROM skill_registry'); });

  const hdr = { 'x-web-bootstrap-secret': SECRET };

  it('401s without the secret', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/registry/skills' });
    expect(res.statusCode).toBe(401);
  });

  it('lists a discovered-but-uninstalled skill', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/registry/skills', headers: hdr });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { skills: Array<{ name: string; state: string }> };
    expect(body.skills.find(s => s.name === 'alpha')?.state).toBe('uninstalled');
  });

  it('install-enable flips it to enabled', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/registry/skills/alpha/install-enable', headers: hdr });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { entry: { state: string } }).entry.state).toBe('enabled');
  });

  it('400s installing an unknown (not-on-disk) skill', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/registry/skills/nope/install', headers: hdr });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 4: Run the routes test to verify it fails, then passes**

Run: `pnpm --prefix $WT exec vitest run tests/integration/registry-routes.test.ts`
Expected first: FAIL (module missing) → after Steps 1–2 are in place, PASS.

> If `sessions: new Map()` causes an `assertSecret` type/runtime issue, inspect `src/channels/http/session-auth.ts` for the `SessionStore` shape and substitute a minimal conforming stub. The header-secret path must not depend on the session store.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --prefix $WT run typecheck
git -C $WT add src/channels/http/routes/registry.ts src/channels/http/http-adapter.ts tests/integration/registry-routes.test.ts
git -C $WT commit -m "feat: /api/registry routes + adapter wiring (#541)"
```

---

## Task 10: One-shot prod backfill script

**Files:**
- Create: `scripts/backfill-registry-enable-all.ts`
- Modify: `package.json` (add `backfill:registry` script)

- [ ] **Step 1: Write the script**

Create `scripts/backfill-registry-enable-all.ts`:

```typescript
// TODO(remove-after-541): one-shot migration for the EXISTING production deployment.
// Enrolls every on-disk skill/agent as ENABLED so upgrade preserves today's behavior
// (everything that was auto-loaded stays loaded). Fresh installs do NOT run this — they
// rely on config/registry-defaults.yaml. Idempotent: re-running only adds missing rows.
// Delete this script and its package.json entry after the production backfill is done.
//
// Run: pnpm backfill:registry

import * as path from 'node:path';
import { createPool } from '../src/db/connection.js';
import { createLogger } from '../src/logger.js';
import { discoverSkillManifests } from '../src/skills/loader.js';
import { discoverAgentManifests } from '../src/agents/loader.js';
import { RegistryRepo } from '../src/registry/registry-repo.js';

async function main(): Promise<void> {
  const logger = createLogger('info');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const pool = createPool(databaseUrl, logger);
  try {
    const skillsDir = path.resolve(import.meta.dirname, '../skills');
    const agentsDir = path.resolve(import.meta.dirname, '../agents');

    const skillRepo = new RegistryRepo(pool, 'skill_registry');
    const agentRepo = new RegistryRepo(pool, 'agent_registry');

    let skillsEnrolled = 0, skillsSkipped = 0;
    for (const disc of discoverSkillManifests(skillsDir)) {
      if (disc.metadata === null) {
        logger.warn({ skill: disc.name, error: disc.error }, 'skipping skill with unparseable manifest');
        continue;
      }
      const existing = await skillRepo.getRow(disc.name);
      if (existing?.enabled) { skillsSkipped++; continue; }
      await skillRepo.install(disc.name, 'backfill');
      await skillRepo.enable(disc.name, 'backfill');
      skillsEnrolled++;
    }

    let agentsEnrolled = 0, agentsSkipped = 0;
    for (const disc of discoverAgentManifests(agentsDir)) {
      if (disc.config === null) {
        logger.warn({ agent: disc.name, error: disc.error }, 'skipping agent with unparseable config');
        continue;
      }
      const existing = await agentRepo.getRow(disc.name);
      if (existing?.enabled) { agentsSkipped++; continue; }
      await agentRepo.install(disc.name, 'backfill');
      await agentRepo.enable(disc.name, 'backfill');
      agentsEnrolled++;
    }

    logger.info({ skillsEnrolled, skillsSkipped, agentsEnrolled, agentsSkipped }, 'registry backfill complete');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console — standalone script, pino not guaranteed flushed on throw
  console.error('backfill failed:', err);
  process.exit(1);
});
```

> If the lint rule forbids `console.error` even here, replace the `.catch` body with a `createLogger('error').fatal(...)` call followed by `process.exit(1)`.

- [ ] **Step 2: Add the package.json script**

In `package.json` `"scripts"`, after the `"seed-vault"` line (line 30), add:
```json
    "backfill:registry": "tsx --env-file=.env scripts/backfill-registry-enable-all.ts"
```
(Add a trailing comma to the `seed-vault` line so JSON stays valid.)

- [ ] **Step 3: Typecheck + dry-run against the dev DB**

Run: `pnpm --prefix $WT run typecheck`
Run: `pnpm --prefix $WT run backfill:registry`
Expected: logs `registry backfill complete` with non-zero `skillsEnrolled`/`agentsEnrolled` on first run; a second run shows them mostly `skipped` (idempotent).

- [ ] **Step 4: Commit**

```bash
git -C $WT add scripts/backfill-registry-enable-all.ts package.json
git -C $WT commit -m "chore: one-shot registry backfill script for prod (#541)"
```

---

## Task 11: Console — Skills & Agents settings sections

**Files:**
- Modify: `apps/console/src/pages/SettingsPage.tsx` (export `SettingsLayout`; add two `SETTINGS_SECTIONS` entries)
- Create: `apps/console/src/pages/RegistrySettings.tsx` (`SkillsPage`, `AgentsPage`)
- Modify: `apps/console/src/router.tsx` (lazy imports + two child routes)

- [ ] **Step 1: Export `SettingsLayout` and add nav entries**

In `apps/console/src/pages/SettingsPage.tsx`:

(a) Change `const SETTINGS_SECTIONS = [...]` (lines 320–323) to:
```typescript
const SETTINGS_SECTIONS = [
  { id: 'autonomy',  label: 'Autonomy',  href: '/settings/autonomy' },
  { id: 'skills',    label: 'Skills',    href: '/settings/skills' },
  { id: 'agents',    label: 'Agents',    href: '/settings/agents' },
  { id: 'workspace', label: 'Workspace', href: '/settings/workspace' },
];
```

(b) Change `function SettingsLayout(` (line 330) to `export function SettingsLayout(` so the new page file can reuse the shell.

- [ ] **Step 2: Create the registry settings page**

Create `apps/console/src/pages/RegistrySettings.tsx`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { SettingsLayout } from './SettingsPage';
import { apiFetch } from '../api';

// ── Types (mirror src/registry/types.ts RegistryEntry) ──────────────────────────
type DerivedState = 'uninstalled' | 'installed' | 'enabled' | 'ghost';
interface ManifestMetadata {
  name: string; description: string; version: string;
  actionRisk?: string | number; sensitivity?: string; capabilities?: string[];
  role?: string; modelTier?: string;
}
interface RegistryEntry {
  name: string; kind: 'skill' | 'agent'; state: DerivedState;
  metadata: ManifestMetadata | null; manifestError?: string;
  installedAt: string | null; installedBy: string | null;
  enabledAt: string | null; enabledBy: string | null;
}

// Map each state to one of the existing .status-pill modifier classes (app.css) so
// no new CSS is needed: enabled→green(confirmed), installed→amber(provisional),
// ghost→red(blocked), uninstalled→neutral(no modifier).
const STATE_PILL: Record<DerivedState, string> = {
  enabled: 'confirmed', installed: 'provisional', ghost: 'blocked', uninstalled: '',
};

async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try { const d = await res.json() as { error?: string }; if (d.error) return d.error; } catch { /* fall through */ }
  }
  return `HTTP ${res.status}`;
}

// ── Detail drawer ───────────────────────────────────────────────────────────────
function RegistryDrawer({ entry, kindPath, onClose, onChanged }: {
  entry: RegistryEntry; kindPath: 'skills' | 'agents'; onClose: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(async (method: 'POST' | 'DELETE', suffix: string) => {
    setBusy(true); setErr(null);
    try {
      const res = await apiFetch(`/api/registry/${kindPath}/${encodeURIComponent(entry.name)}${suffix}`, { method });
      if (!res.ok) throw new Error(await errorMessage(res));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally { setBusy(false); }
  }, [entry.name, kindPath, onChanged]);

  const confirmUninstall = () => {
    if (window.confirm(`Uninstall "${entry.name}"? This removes its registry row.`)) void act('DELETE', '');
  };

  return (
    <div className="drawer">
      <div className="drawer-header">
        <h3>{entry.name}</h3>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
      </div>
      <div className="drawer-body">
        <p className="settings-page-sub">Enabling or disabling takes effect on the next restart.</p>
        {entry.manifestError && <p className="autonomy-error">Manifest error: {entry.manifestError}</p>}
        {err && <p className="autonomy-error">{err}</p>}

        <div className="form-field"><label>State</label>
          <span className={`status-pill ${STATE_PILL[entry.state]}`}>{entry.state}</span></div>
        {entry.metadata && <>
          <div className="form-field"><label>Description</label><div>{entry.metadata.description}</div></div>
          <div className="form-field"><label>Version</label><div>{entry.metadata.version}</div></div>
          {entry.kind === 'skill' && <div className="form-field"><label>Action risk</label><div>{String(entry.metadata.actionRisk ?? '—')}</div></div>}
          {entry.kind === 'agent' && <div className="form-field"><label>Role / model</label><div>{entry.metadata.role ?? '—'} / {entry.metadata.modelTier ?? '—'}</div></div>}
          {entry.metadata.capabilities && <div className="form-field"><label>Capabilities</label><div>{entry.metadata.capabilities.join(', ') || '—'}</div></div>}
        </>}
        <div className="form-field"><label>Installed</label><div>{entry.installedAt ? `${entry.installedAt} by ${entry.installedBy}` : '—'}</div></div>
        <div className="form-field"><label>Enabled</label><div>{entry.enabledAt ? `${entry.enabledAt} by ${entry.enabledBy}` : '—'}</div></div>
      </div>
      <div className="drawer-footer">
        {entry.state === 'uninstalled' && <>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act('POST', '/install')}>Install</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('POST', '/install-enable')}>Install &amp; enable</button>
        </>}
        {entry.state === 'installed' && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('POST', '/enable')}>Enable</button>
        )}
        {entry.state === 'enabled' && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act('POST', '/disable')}>Disable</button>
        )}
        {entry.state !== 'uninstalled' && (
          <button type="button" className="btn btn-destructive" disabled={busy} onClick={confirmUninstall}>Uninstall</button>
        )}
      </div>
    </div>
  );
}

// ── Section (table + drawer) ─────────────────────────────────────────────────────
function RegistrySection({ kind }: { kind: 'skill' | 'agent' }) {
  const kindPath = kind === 'skill' ? 'skills' : 'agents';
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [selected, setSelected] = useState<RegistryEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/registry/${kindPath}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as Record<string, RegistryEntry[]>;
      const list = data[kindPath] ?? [];
      setEntries(list);
      // Keep the drawer in sync with the freshly-loaded state.
      setSelected(prev => prev ? list.find(e => e.name === prev.name) ?? null : null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, [kindPath]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">{kind === 'skill' ? 'Skills' : 'Agents'}</h2>
        <p className="settings-page-sub">
          Install, enable, and disable {kind === 'skill' ? 'skills' : 'agents'}. Changes take effect on the next restart.
        </p>
      </div>
      {loadError && <p className="autonomy-error">{loadError}</p>}
      <div className="records-layout">
        <table className="records-table">
          <thead><tr><th>Name</th><th>State</th><th>Version</th></tr></thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.name} onClick={() => setSelected(e)} style={{ cursor: 'pointer' }}>
                <td>{e.name}{e.manifestError ? ' ⚠' : ''}</td>
                <td><span className={`status-pill ${STATE_PILL[e.state]}`}>{e.state}{e.state === 'ghost' ? ' ⚠' : ''}</span></td>
                <td>{e.metadata?.version ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {selected && (
          <RegistryDrawer
            entry={selected}
            kindPath={kindPath}
            onClose={() => setSelected(null)}
            onChanged={() => { void load(); }}
          />
        )}
      </div>
    </>
  );
}

export function SkillsPage() {
  return <SettingsLayout activeSection="skills"><RegistrySection kind="skill" /></SettingsLayout>;
}
export function AgentsPage() {
  return <SettingsLayout activeSection="agents"><RegistrySection kind="agent" /></SettingsLayout>;
}
```

> If `.btn-destructive` is not an existing class, check `apps/console/src/styles/app.css` for the destructive button class (the Contacts delete button uses one) and substitute its name.

- [ ] **Step 3: Add routes**

In `apps/console/src/router.tsx`:

(a) After the `WorkspacePage` lazy import (line 19), add:
```typescript
const SkillsPage = lazy(() =>
  import('./pages/RegistrySettings').then(m => ({ default: m.SkillsPage })),
);
const AgentsPage = lazy(() =>
  import('./pages/RegistrySettings').then(m => ({ default: m.AgentsPage })),
);
```

(b) After `workspaceRoute` (line 104), add:
```typescript
const skillsSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/skills',
  component: SkillsPage,
});

const agentsSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/agents',
  component: AgentsPage,
});
```

(c) Update the `settingsRoute.addChildren([...])` call (line 149) to:
```typescript
    settingsRoute.addChildren([autonomyRoute, workspaceRoute, skillsSettingsRoute, agentsSettingsRoute]),
```

- [ ] **Step 4: Typecheck the console + build**

Run: `pnpm --prefix $WT/apps/console run build` (or the console's typecheck script if present: check `apps/console/package.json`)
Expected: build succeeds, no TS errors.

- [ ] **Step 5: Manual smoke (optional but recommended)**

Run the dev stack (`pnpm --prefix $WT run dev`), open the console, go to Settings → Skills. Confirm: uninstalled skills show an Install button in the drawer; Install & enable flips the pill to `enabled`; Disable returns it to `installed`. Stop the stack when done.

- [ ] **Step 6: Commit**

```bash
git -C $WT add apps/console/src/pages/SettingsPage.tsx apps/console/src/pages/RegistrySettings.tsx apps/console/src/router.tsx
git -C $WT commit -m "feat: Skills & Agents management under Workspace Settings (#541)"
```

---

## Task 12: CHANGELOG + ADR

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/adr/NNNN-skill-agent-registry.md`
- Modify: `docs/adr/README.md`

- [ ] **Step 1: Add CHANGELOG entries**

In `CHANGELOG.md` under `## [Unreleased]`, add:
```markdown
### Added
- **Skill/Agent registry** — DB-gated install/enable lifecycle for skills and agents (`skill_registry`/`agent_registry` tables, startup reconciliation of a trusted core set, one-shot prod backfill). Only enabled items load at runtime. (#541)
- **Skills & Agents settings** — manage install/enable/disable state from Workspace Settings. (#541)

### Changed
- **Skill/agent loading** — now gated on the registry; only enabled items are registered. `skill.json` and agent YAML schemas gain optional, inert `install`/`uninstall` blocks (**public API surface**). `allowed_callers` validation now treats all discovered agents (enabled or disabled) as known. (#541)
```

- [ ] **Step 2: Find the next ADR number**

Run: `ls $WT/docs/adr/`
Expected: numbered ADR files. Use the next free `NNNN`.

- [ ] **Step 3: Write the ADR**

Create `docs/adr/NNNN-skill-agent-registry.md` using `docs/adr/template.md` as the structure. Content essentials:
- **Context:** Filesystem auto-load was all-or-nothing; no staging, no disable-without-deploy, no install-time bootstrap, and (security) any shipped skill became active immediately.
- **Decision:** A DB-gated install/enable lifecycle. State is *derived* (on-disk × row), not stored. The fresh-install core set lives in a trusted in-repo `config/registry-defaults.yaml` — NOT in manifests — so an uploaded skill can't self-enable. Enforcement is restart-based (hot-reload deferred).
- **Consequences:** Adds a reconciliation step + two tables; existing prod migrated by a throwaway script; install/uninstall manifest blocks reserved for secrets (PR2) and config (PR3); a disabled-but-pinned skill is silently dropped from an agent's toolset (warn-logged).

- [ ] **Step 4: Add the ADR index row**

In `docs/adr/README.md`, add a row for the new ADR following the existing table format.

- [ ] **Step 5: Commit**

```bash
git -C $WT add CHANGELOG.md docs/adr/
git -C $WT commit -m "docs: changelog + ADR for skill/agent registry (#541)"
```

---

## Task 13: Full verification

- [ ] **Step 1: Typecheck**

Run: `pnpm --prefix $WT run typecheck`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `pnpm --prefix $WT run lint`
Expected: no errors in the new files (`src/registry/**`, `scripts/backfill-registry-enable-all.ts`, route module).

- [ ] **Step 3: Run the full test suite**

Run: `pnpm --prefix $WT migrate`
Run: `pnpm --prefix $WT test`
Expected: PASS. New suites: `registry-service`, `reconcile`, `loader` (skills+agents), `registry-repo` (integration), `registry-routes` (integration). Integration suites run only when `DATABASE_URL` is set.

- [ ] **Step 4: Migration prefix re-check (pre-merge)**

Run: `ls $WT/src/db/migrations/ | sort`
Expected: every prefix unique; `051` is the registry migration. If a concurrently-merged branch took `051`, renumber this migration to the next free slot and re-run `pnpm --prefix $WT migrate`.

- [ ] **Step 5: Boot once more on a backfilled DB**

Run: `pnpm --prefix $WT run backfill:registry` (enables everything on the dev DB)
Run: `pnpm --prefix $WT run local`
Expected: `Skills loaded` count equals the full on-disk skill count (parity with pre-registry behavior); no ghosts; HTTP server listens. Stop the process.

---

## Notes for the implementer

- **Build order matters:** Task 9 adds `registryService?` to `HttpAdapterConfig`; Task 8 Step 7 references it. If you do Task 8 before Task 9, expect one transient type error on the `new HttpAdapter({ ..., registryService })` line until Task 9 lands — that's fine, just don't commit a failing typecheck. Doing Task 9 immediately after Task 8 (before the Task 8 commit's typecheck) is cleanest.
- **`actor` identity:** everything writes `'web-app'`, `'reconciliation'`, `'backfill'`, or `'system'`. There is no per-user identity in the console yet (matches the autonomy routes).
- **Don't touch MCP loading** (`loadMcpServers`) — out of scope; MCP tools keep loading unchanged.
- **Restart semantics:** enable/disable change the DB only. The running registries are not mutated. The UI says so; don't add hot-reload.
- **Core set:** finalize `config/registry-defaults.yaml` to the real minimal set before merge (Task 8 Step 1).
- **Disabled pinned skills are already handled** — no task needed. `SkillRegistry.toToolDefinitions` silently skips unregistered names (`registry.ts:107`), and the existing bootstrap loop (`src/index.ts:1404-1411`) already warn-logs `Pinned skill not found in registry; skipping tool definition`. A disabled skill is simply not registered, so it falls through both paths exactly as the spec's knock-on requires.
