# Console Skill Bundle Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator enable and disable skill bundles from `/tools`, with member tools nested under their bundle, and flag any bundle that an enabled agent pins but which is not itself enabled.

**Architecture:** The backend already exposes `GET /api/registry/skills` and the four state-change routes for `kind: 'skill'`. Three gaps are filled: bundle *membership* and *pin consumers* are propagated into the API payload (they are dropped today during discovery mapping); a new `BundleCascadeRepo` performs the cross-table enable/disable in one transaction; and the console merges skills + tools + agents into a single parent/child row model. HTTP routes are unchanged.

**Tech Stack:** TypeScript (ESM, Node 24+), Fastify, Postgres via `pg`, React 19 + TanStack Router (console), Vitest.

**Spec:** https://github.com/josephfung/curia/issues/1724 — read the issue before starting; every acceptance criterion below traces to it.

## Global Constraints

- ESM only — `.js` extensions on all relative imports; no `require()`.
- No `any`. Cast through `unknown` when narrowing `Record<string, unknown>` to a typed interface.
- Array element access (`arr[0]`, `mock.calls[0]`) is `T | undefined` under strict null checks — use `!` when the element is guaranteed, or destructure with a guard.
- Parameterized SQL only. Table names are compile-time literals selected via a map, never runtime concatenation (`registry-repo.ts` pattern).
- No empty `catch {}`. Every catch logs, audits, and propagates.
- No `console.log` — pino only (backend). The console app is exempt; it has no pino.
- Skills return `{ success: true, data }` / `{ success: false, error }` — never throw. (Not exercised here; no skill handlers change.)
- Run `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-bundle-registry run typecheck` before every commit touching `.ts`.
- Commit with `-s` (DCO sign-off). No `Co-Authored-By`. No Claude/AI attribution anywhere.
- Do **not** bump `package.json` version — that happens only at release.
- `CHANGELOG.md` must be updated under `## [Unreleased]` before the PR; max 15 words after the em-dash.

## Working directory

All commands run from the worktree:
`/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-bundle-registry`

Use `pnpm -C <worktree>` (never `--prefix`) and `git -C <worktree>`.

---

### Task 1: Propagate bundle membership and pin consumers into the registry API

Today `ManifestMetadata` carries only name/description/version for skills, so the API cannot say which tools a bundle contains or which agents pin it. `SkillDiscovery.metadata.tools` already holds the resolved member list — it is simply dropped in the `index.ts` mapping.

**Files:**
- Modify: `src/registry/types.ts:25-39` (add two fields to `ManifestMetadata`)
- Modify: `src/index.ts:2354-2366` (skill discovery mapping)
- Test: `src/registry/registry-service.test.ts`

**Interfaces:**
- Consumes: `SkillDiscovery.metadata.tools: string[]` from `src/skills/skill-types.ts:64-75`; `AgentConfig.pinned_skills?: string[]` from `src/agents/loader.ts:31`.
- Produces: `ManifestMetadata.tools?: string[]` (bundle members, skills only) and `ManifestMetadata.pinnedBy?: string[]` (agent names pinning this bundle, skills only). Task 3 reads `tools`; Tasks 4–6 read both.

- [ ] **Step 1: Write the failing test**

Append to `src/registry/registry-service.test.ts`:

```ts
describe('RegistryService.list — skill bundle metadata', () => {
  it('surfaces member tools and pin consumers for a bundle', async () => {
    const skillRepo = new FakeRepo();
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo,
      [{
        name: 'ceo-inbox',
        metadata: {
          name: 'ceo-inbox',
          description: 'CEO inbox tools',
          version: '0.1.0',
          tools: ['ceo-inbox-list', 'ceo-inbox-read'],
          pinnedBy: ['ceo-inbox'],
        },
      }],
    );

    const entries = await svc.list('skill');
    const bundle = entries.find(e => e.name === 'ceo-inbox');

    expect(bundle?.metadata?.tools).toEqual(['ceo-inbox-list', 'ceo-inbox-read']);
    expect(bundle?.metadata?.pinnedBy).toEqual(['ceo-inbox']);
  });

  it('reports members for a bundle that is not installed', async () => {
    // The whole point: a disabled bundle is never in SkillRegistry, so membership
    // must come from on-disk discovery. An empty skillRepo = uninstalled.
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, new FakeRepo(),
      [{
        name: 'ceo-inbox',
        metadata: {
          name: 'ceo-inbox', description: 'd', version: '0.1.0',
          tools: ['ceo-inbox-list'], pinnedBy: [],
        },
      }],
    );

    const bundle = (await svc.list('skill')).find(e => e.name === 'ceo-inbox');
    expect(bundle?.state).toBe('uninstalled');
    expect(bundle?.metadata?.tools).toEqual(['ceo-inbox-list']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C <worktree> exec vitest run src/registry/registry-service.test.ts -t "skill bundle metadata"`
Expected: FAIL — TypeScript rejects `tools` / `pinnedBy` as unknown properties on `ManifestMetadata`.

- [ ] **Step 3: Add the fields to `ManifestMetadata`**

In `src/registry/types.ts`, inside the `// skills` block of `ManifestMetadata`:

```ts
  /** Member tool names for a SKILL.md bundle. Sourced from on-disk discovery, NOT
   *  SkillRegistry — a bundle that is disabled is never registered, so SkillRegistry
   *  cannot report its members. Skills only; undefined for tools and agents. */
  tools?: string[];
  /** Names of agents whose `pinned_skills` reference this bundle. Static, read from
   *  agent manifests on disk. The console cross-references each agent's own enabled
   *  state (via /api/registry/agents) to decide which combinations are broken. */
  pinnedBy?: string[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C <worktree> exec vitest run src/registry/registry-service.test.ts -t "skill bundle metadata"`
Expected: PASS (both cases).

- [ ] **Step 5: Populate the fields at bootstrap**

In `src/index.ts`, immediately before the `const registryService = new RegistryService(` call (~line 2335), build the pin index:

```ts
  // Which agents pin each skill bundle. Read from agent manifests on disk so the
  // registry UI can flag a bundle that an agent depends on but which is not enabled —
  // the condition that silently stripped ceo-inbox's 14 tools for a month (#1724).
  const pinnedByBundle = new Map<string, string[]>();
  for (const agent of agentDiscovery) {
    for (const pin of agent.config?.pinned_skills ?? []) {
      const list = pinnedByBundle.get(pin);
      if (list) list.push(agent.name);
      else pinnedByBundle.set(pin, [agent.name]);
    }
  }
```

Then extend the `skillBundleDiscovery.map(...)` metadata object (~line 2356) so it reads:

```ts
    skillBundleDiscovery.map(d => ({
      name: d.name,
      metadata: d.metadata
        ? {
            name: d.metadata.name,
            description: d.metadata.description,
            version: d.metadata.version,
            tools: d.metadata.tools,
            pinnedBy: pinnedByBundle.get(d.name) ?? [],
          }
        : null,
      error: d.error,
    })),
```

- [ ] **Step 6: Typecheck and run the registry suite**

Run: `pnpm -C <worktree> run typecheck`
Then: `pnpm -C <worktree> exec vitest run src/registry/`
Expected: typecheck clean; all registry tests pass.

- [ ] **Step 7: Commit**

```bash
git -C <worktree> add src/registry/types.ts src/index.ts src/registry/registry-service.test.ts
git -C <worktree> commit -s -m "feat(registry): surface bundle members and pin consumers in the API

Bundle membership comes from on-disk discovery rather than SkillRegistry so a
disabled bundle still reports its tools. Refs #1724"
```

---

### Task 2: Transactional cross-table cascade repo

Enabling a bundle must write `skill_registry` and every member's `tool_registry` row atomically. `RegistryRepo` is deliberately one-instance-per-table, so the cross-table write goes in its own focused module rather than distorting that contract.

**Files:**
- Create: `src/registry/bundle-cascade-repo.ts`
- Create: `src/registry/bundle-cascade-repo.test.ts`
- Modify: `src/registry/types.ts` (add `IBundleCascadeRepo`)

**Interfaces:**
- Consumes: `DbPool` / `DbPoolClient` from `src/db/connection.ts:9-10`; the `BEGIN`/`COMMIT`/`ROLLBACK` pattern from `src/memory/bullpen.ts:202-224`.
- Produces:
  ```ts
  interface IBundleCascadeRepo {
    enableBundle(bundle: string, tools: string[], actor: string): Promise<void>;
    disableBundle(bundle: string, tools: string[], actor: string): Promise<void>;
  }
  ```
  Task 3 injects this into `RegistryService`.

- [ ] **Step 1: Write the failing test**

Create `src/registry/bundle-cascade-repo.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { BundleCascadeRepo } from './bundle-cascade-repo.js';
import type { DbPool } from '../db/connection.js';

// Minimal fake pool: records every query text so we can assert transaction shape.
function fakePool(failOn?: string) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql.trim().split('\n')[0]!.trim());
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as DbPool;
  return { pool, client, queries };
}

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

describe('BundleCascadeRepo.enableBundle', () => {
  it('writes the bundle and every member tool inside one transaction', async () => {
    const { pool, client, queries } = fakePool();
    const repo = new BundleCascadeRepo(pool, logger as never);

    await repo.enableBundle('ceo-inbox', ['ceo-inbox-list', 'ceo-inbox-read'], 'web-app');

    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
    // one skill_registry upsert + one tool_registry upsert per member
    expect(queries.filter(q => q.includes('skill_registry'))).toHaveLength(1);
    expect(queries.filter(q => q.includes('tool_registry'))).toHaveLength(2);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back and rethrows when a member write fails', async () => {
    const { pool, client, queries } = fakePool('tool_registry');
    const repo = new BundleCascadeRepo(pool, logger as never);

    await expect(
      repo.enableBundle('ceo-inbox', ['ceo-inbox-list'], 'web-app'),
    ).rejects.toThrow('boom');

    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('BundleCascadeRepo.disableBundle', () => {
  it('disables the bundle and every member tool in one transaction', async () => {
    const { pool, queries } = fakePool();
    const repo = new BundleCascadeRepo(pool, logger as never);

    await repo.disableBundle('ceo-inbox', ['ceo-inbox-list'], 'web-app');

    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C <worktree> exec vitest run src/registry/bundle-cascade-repo.test.ts`
Expected: FAIL — cannot resolve `./bundle-cascade-repo.js`.

- [ ] **Step 3: Add the interface to `types.ts`**

```ts
/** Cross-table bundle operations. Separate from IRegistryRepo, which is deliberately
 *  one-instance-per-table; enabling a bundle must write skill_registry and every
 *  member's tool_registry row in a single transaction (#1724). */
export interface IBundleCascadeRepo {
  enableBundle(bundle: string, tools: string[], actor: string): Promise<void>;
  disableBundle(bundle: string, tools: string[], actor: string): Promise<void>;
}
```

- [ ] **Step 4: Write the implementation**

Create `src/registry/bundle-cascade-repo.ts`:

```ts
// bundle-cascade-repo.ts — atomic enable/disable of a skill bundle together with its
// member tools. RegistryRepo is one-instance-per-table by design; a bundle cascade
// spans skill_registry and tool_registry, so it lives here and owns its transaction.
//
// A half-applied cascade is worse than the current state: it would leave a bundle
// enabled with some members off, which is exactly the partial state the UI is meant
// to make impossible. Hence BEGIN/COMMIT with an explicit ROLLBACK on any failure.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { IBundleCascadeRepo } from './types.js';

// Upsert-then-enable in one statement. ON CONFLICT covers the case where the row
// already exists (installed but disabled) — the common path for a bundle that shipped
// disabled. Table names are compile-time literals; all values are parameterized.
const ENABLE_SKILL = `
  INSERT INTO skill_registry (name, enabled, installed_by, enabled_at, enabled_by)
  VALUES ($1, true, $2, now(), $2)
  ON CONFLICT (name) DO UPDATE
    SET enabled = true, enabled_at = now(), enabled_by = $2`;

const ENABLE_TOOL = `
  INSERT INTO tool_registry (name, enabled, installed_by, enabled_at, enabled_by)
  VALUES ($1, true, $2, now(), $2)
  ON CONFLICT (name) DO UPDATE
    SET enabled = true, enabled_at = now(), enabled_by = $2`;

const DISABLE_SKILL = `
  UPDATE skill_registry SET enabled = false, enabled_at = NULL, enabled_by = NULL
  WHERE name = $1`;

const DISABLE_TOOL = `
  UPDATE tool_registry SET enabled = false, enabled_at = NULL, enabled_by = NULL
  WHERE name = $1`;

export class BundleCascadeRepo implements IBundleCascadeRepo {
  constructor(private readonly pool: DbPool, private readonly logger: Logger) {}

  async enableBundle(bundle: string, tools: string[], actor: string): Promise<void> {
    await this.run('enable', bundle, tools, actor, ENABLE_SKILL, ENABLE_TOOL);
  }

  async disableBundle(bundle: string, tools: string[], actor: string): Promise<void> {
    await this.run('disable', bundle, tools, actor, DISABLE_SKILL, DISABLE_TOOL);
  }

  private async run(
    op: 'enable' | 'disable',
    bundle: string,
    tools: string[],
    actor: string,
    bundleSql: string,
    toolSql: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Disable takes only the name; enable also records the actor.
      await client.query(bundleSql, op === 'enable' ? [bundle, actor] : [bundle]);
      for (const tool of tools) {
        await client.query(toolSql, op === 'enable' ? [tool, actor] : [tool]);
      }
      await client.query('COMMIT');
    } catch (err) {
      this.logger.error({ err, bundle, tools, op }, `Bundle ${op} cascade failed; rolling back`);
      // Guard the ROLLBACK itself — if the connection dropped it may throw, and that
      // must not mask the original error.
      await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
        this.logger.error({ rollbackErr, bundle, op }, 'ROLLBACK failed after cascade error');
      });
      throw err;
    } finally {
      client.release();
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -C <worktree> exec vitest run src/registry/bundle-cascade-repo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm -C <worktree> run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git -C <worktree> add src/registry/bundle-cascade-repo.ts src/registry/bundle-cascade-repo.test.ts src/registry/types.ts
git -C <worktree> commit -s -m "feat(registry): add transactional bundle cascade repo

Enabling or disabling a bundle writes skill_registry and every member's
tool_registry row in one transaction. Refs #1724"
```

---

### Task 3: Cascade on `RegistryService.enable` / `disable` for `kind: 'skill'`

**Files:**
- Modify: `src/registry/registry-service.ts:22-29` (constructor), `:157-180` (enable/disable)
- Modify: `src/index.ts` (wire `BundleCascadeRepo`)
- Test: `src/registry/registry-service.test.ts`

**Interfaces:**
- Consumes: `IBundleCascadeRepo` (Task 2); `ManifestMetadata.tools` (Task 1).
- Produces: `RegistryService` constructor gains an 8th parameter `cascade?: IBundleCascadeRepo`. `enable('skill', …)` / `disable('skill', …)` route through it. Signatures otherwise unchanged — routes need no edit.

- [ ] **Step 1: Write the failing test**

Append to `src/registry/registry-service.test.ts`:

```ts
class FakeCascade implements IBundleCascadeRepo {
  enabled: Array<{ bundle: string; tools: string[] }> = [];
  disabled: Array<{ bundle: string; tools: string[] }> = [];
  async enableBundle(bundle: string, tools: string[]) { this.enabled.push({ bundle, tools }); }
  async disableBundle(bundle: string, tools: string[]) { this.disabled.push({ bundle, tools }); }
}

describe('RegistryService — bundle cascade', () => {
  const bundleDisc = [{
    name: 'ceo-inbox',
    metadata: {
      name: 'ceo-inbox', description: 'd', version: '0.1.0',
      tools: ['ceo-inbox-list', 'ceo-inbox-read'], pinnedBy: ['ceo-inbox'],
    },
  }];

  it('enable cascades the bundle and its member tools', async () => {
    const skillRepo = new FakeRepo();
    await skillRepo.install('ceo-inbox', 'test');
    const cascade = new FakeCascade();
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo, bundleDisc, cascade,
    );

    await svc.enable('skill', 'ceo-inbox', 'web-app');

    expect(cascade.enabled).toEqual([
      { bundle: 'ceo-inbox', tools: ['ceo-inbox-list', 'ceo-inbox-read'] },
    ]);
  });

  it('disable cascades the bundle and its member tools', async () => {
    const skillRepo = new FakeRepo();
    await skillRepo.install('ceo-inbox', 'test');
    const cascade = new FakeCascade();
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo, bundleDisc, cascade,
    );

    await svc.disable('skill', 'ceo-inbox', 'web-app');

    expect(cascade.disabled).toEqual([
      { bundle: 'ceo-inbox', tools: ['ceo-inbox-list', 'ceo-inbox-read'] },
    ]);
  });

  it('refuses a bundle enable when no cascade repo is wired', async () => {
    // Fail loudly rather than silently writing only skill_registry and leaving the
    // member tools untouched — a partial enable is the bug this feature exists to stop.
    const skillRepo = new FakeRepo();
    await skillRepo.install('ceo-inbox', 'test');
    const svc = new RegistryService(
      new FakeRepo(), new FakeRepo(), [], [], undefined, skillRepo, bundleDisc,
    );

    await expect(svc.enable('skill', 'ceo-inbox', 'web-app'))
      .rejects.toThrow(/cascade repo not configured/i);
  });

  it('leaves tool and agent enable on the single-table path', async () => {
    const toolRepo = new FakeRepo();
    await toolRepo.install('bullpen', 'test');
    const cascade = new FakeCascade();
    const svc = new RegistryService(
      toolRepo, new FakeRepo(), [disc('bullpen')], [], undefined, new FakeRepo(), [], cascade,
    );

    await svc.enable('tool', 'bullpen', 'web-app');

    expect(cascade.enabled).toEqual([]);
    expect((await toolRepo.getRow('bullpen'))?.enabled).toBe(true);
  });
});
```

Add `IBundleCascadeRepo` to the existing type-only import at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C <worktree> exec vitest run src/registry/registry-service.test.ts -t "bundle cascade"`
Expected: FAIL — constructor takes 7 parameters, not 8.

- [ ] **Step 3: Implement the cascade**

In `src/registry/registry-service.ts`, add to the import block:

```ts
import type {
  IRegistryRepo, RegistryKind, RegistryEntry, Discovery, SecretsLister, IBundleCascadeRepo,
} from './types.js';
```

Add the constructor parameter after `skillDiscovery`:

```ts
    private skillDiscovery: Discovery[] = [],
    // Cross-table cascade for bundle enable/disable. Required for kind='skill';
    // absent is a wiring error, not a fallback (see bundleTools()).
    private readonly cascade?: IBundleCascadeRepo,
```

Add a private helper next to `discovery()`:

```ts
  /** Member tools of a bundle, from on-disk discovery. Empty array for a bundle whose
   *  manifest failed to parse — cascading nothing is correct there, the bundle row
   *  still flips and the broken manifest is already surfaced as `manifestError`. */
  private bundleTools(name: string): string[] {
    return this.skillDiscovery.find(d => d.name === name)?.metadata?.tools ?? [];
  }

  private requireCascade(name: string): IBundleCascadeRepo {
    if (!this.cascade) {
      throw new Error(
        `RegistryService: bundle cascade repo not configured; refusing to change '${name}' ` +
        `without cascading its member tools`,
      );
    }
    return this.cascade;
  }
```

Replace the body of `enable`:

```ts
  async enable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    // Re-check at enable time too: secrets could have been deleted since install, and
    // enable is the moment the item actually goes live on the next restart.
    await this.assertSecretsConfigured(kind, name);
    const row = await this.repo(kind).getRow(name);
    if (!row) throw new RegistryGuardError(`Cannot enable '${name}': not installed. Install it first.`);
    if (kind === 'skill') {
      // Bundle + members in one transaction — the bundle is the unit of control (#1724).
      await this.requireCascade(name).enableBundle(name, this.bundleTools(name), actor);
    } else {
      await this.repo(kind).enable(name, actor);
    }
    return this.entry(kind, name);
  }
```

Replace the body of `disable`:

```ts
  async disable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    const row = await this.repo(kind).getRow(name);
    if (!row) throw new RegistryGuardError(`Cannot disable '${name}': no registry row.`);
    if (kind === 'skill') {
      await this.requireCascade(name).disableBundle(name, this.bundleTools(name), actor);
    } else {
      await this.repo(kind).disable(name, actor);
    }
    return this.entry(kind, name);
  }
```

Also update `installAndEnable` so the install-enable route cascades too:

```ts
  async installAndEnable(kind: RegistryKind, name: string, actor: string): Promise<RegistryEntry> {
    this.assertInstallable(kind, name);
    await this.assertSecretsConfigured(kind, name);
    await this.repo(kind).install(name, actor);
    if (kind === 'skill') {
      await this.requireCascade(name).enableBundle(name, this.bundleTools(name), actor);
    } else {
      await this.repo(kind).enable(name, actor);
    }
    return this.entry(kind, name);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C <worktree> exec vitest run src/registry/`
Expected: PASS — including the pre-existing tests, which construct the service without a cascade and only exercise tool/agent kinds.

- [ ] **Step 5: Wire the real repo at bootstrap**

In `src/index.ts`, add the import alongside the other registry imports:

```ts
import { BundleCascadeRepo } from './registry/bundle-cascade-repo.js';
```

Then pass it as the final `RegistryService` argument, after the `skillBundleDiscovery.map(...)` block:

```ts
    new BundleCascadeRepo(pool, logger),
```

- [ ] **Step 6: Typecheck and run the full unit suite**

Run: `pnpm -C <worktree> run typecheck`
Then: `pnpm -C <worktree> exec vitest run src/`
Expected: typecheck clean; suite green.

- [ ] **Step 7: Commit**

```bash
git -C <worktree> add src/registry/registry-service.ts src/registry/registry-service.test.ts src/index.ts
git -C <worktree> commit -s -m "feat(registry): cascade bundle enable/disable to member tools

Bundle becomes the unit of control; a missing cascade repo throws rather than
writing a partial state. Refs #1724"
```

---

### Task 4: Console — merged row model

The console currently renders one flat `RegistryEntry[]`. It needs a tree: bundles as parents with their members nested, standalone tools flat, plus each agent's enabled state so unresolved pins can be flagged.

**Files:**
- Modify: `apps/console/src/pages/RegistrySettings.tsx:8-35` (types), `:452-490` (load)

**Interfaces:**
- Consumes: `GET /api/registry/skills`, `/tools`, `/agents` — each returns `{ [kindPath]: RegistryEntry[] }`.
- Produces:
  ```ts
  type RowKind = 'bundle' | 'tool';
  interface Row {
    entry: RegistryEntry;
    rowKind: RowKind;
    members: RegistryEntry[];      // bundle only; [] for tools
    pinnedBy: string[];            // bundle only
    unresolvedFor: string[];       // enabled agents pinning a non-enabled bundle
  }
  ```
  Tasks 5 and 6 render `Row[]`.

- [ ] **Step 1: Extend the local types**

In `RegistrySettings.tsx`, widen `RegistryEntry.kind` and add the two metadata fields:

```ts
interface ManifestMetadata {
  // …existing fields unchanged…
  /** Member tool names — skill bundles only. */
  tools?: string[];
  /** Agents whose pinned_skills reference this bundle — skill bundles only. */
  pinnedBy?: string[];
}

interface RegistryEntry {
  name: string;
  kind: 'tool' | 'agent' | 'skill';
  // …rest unchanged…
}
```

Add the row model directly below `RegistryEntry`:

```ts
type RowKind = 'bundle' | 'tool';

/** One top-level row in the merged /tools view. A bundle carries its members
 *  (rendered read-only underneath); a standalone tool carries none. */
interface Row {
  entry: RegistryEntry;
  rowKind: RowKind;
  members: RegistryEntry[];
  pinnedBy: string[];
  /** Enabled agents that pin this bundle while it is not enabled. Non-empty = broken:
   *  those agents boot with the bundle's tools missing from their function list. */
  unresolvedFor: string[];
}
```

- [ ] **Step 2: Write the failing test for the row builder**

Create `apps/console/src/pages/registry-rows.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRows } from './registry-rows.js';
import type { RegistryEntry } from './registry-rows.js';

const entry = (name: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  name, kind: 'tool', state: 'enabled', metadata: null,
  installedAt: null, installedBy: null, enabledAt: null, enabledBy: null, ...over,
});

const bundle = (name: string, tools: string[], pinnedBy: string[], state: RegistryEntry['state']) =>
  entry(name, {
    kind: 'skill', state,
    metadata: { name, description: 'd', version: '1.0.0', tools, pinnedBy },
  });

describe('buildRows', () => {
  it('nests member tools under their bundle and leaves standalone tools flat', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list'], [], 'enabled')],
      [entry('ceo-inbox-list'), entry('bullpen')],
      [],
    );

    expect(rows.map(r => r.entry.name)).toEqual(['ceo-inbox', 'bullpen']);
    expect(rows[0]!.rowKind).toBe('bundle');
    expect(rows[0]!.members.map(m => m.name)).toEqual(['ceo-inbox-list']);
    expect(rows[1]!.rowKind).toBe('tool');
    expect(rows[1]!.members).toEqual([]);
  });

  it('flags a non-enabled bundle pinned by an enabled agent', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list'], ['ceo-inbox'], 'installed')],
      [entry('ceo-inbox-list')],
      [entry('ceo-inbox', { kind: 'agent', state: 'enabled' })],
    );

    expect(rows[0]!.unresolvedFor).toEqual(['ceo-inbox']);
  });

  it('does not flag when the pinning agent is itself disabled', () => {
    const rows = buildRows(
      [bundle('learning', ['learn-x'], ['digest'], 'installed')],
      [entry('learn-x')],
      [entry('digest', { kind: 'agent', state: 'installed' })],
    );

    expect(rows[0]!.unresolvedFor).toEqual([]);
  });

  it('shows members for a bundle that is not installed', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list', 'ceo-inbox-read'], [], 'uninstalled')],
      [entry('ceo-inbox-list'), entry('ceo-inbox-read')],
      [],
    );

    expect(rows[0]!.members).toHaveLength(2);
  });

  it('keeps a member tool out of the flat list even when its bundle is absent from disk', () => {
    // Ghost bundle: DB row with no manifest, so metadata (and membership) is null.
    // The member must still appear somewhere — as a standalone row, not vanish.
    const rows = buildRows(
      [entry('ghost-bundle', { kind: 'skill', state: 'ghost', metadata: null })],
      [entry('orphan-tool')],
      [],
    );

    expect(rows.map(r => r.entry.name)).toEqual(['ghost-bundle', 'orphan-tool']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -C <worktree> exec vitest run apps/console/src/pages/registry-rows.test.ts`
Expected: FAIL — cannot resolve `./registry-rows.js`.

- [ ] **Step 4: Implement the row builder**

Create `apps/console/src/pages/registry-rows.ts`. Move the `DerivedState`, `ManifestMetadata`, `RegistryEntry`, `RowKind` and `Row` declarations here and export them, so both the page and the test share one definition:

```ts
// registry-rows.ts — merges the three registry endpoints into the /tools row model.
// Extracted from RegistrySettings.tsx so the tree-building and unresolved-pin logic
// can be unit tested without rendering the page.

export type DerivedState = 'uninstalled' | 'installed' | 'enabled' | 'ghost';

export interface ManifestMetadata {
  name: string;
  description: string;
  version: string;
  actionRisk?: string | number;
  sensitivity?: string;
  capabilities?: string[];
  role?: string;
  modelTier?: string;
  requiresSecrets?: string[];
  tools?: string[];
  pinnedBy?: string[];
}

export interface RegistryEntry {
  name: string;
  kind: 'tool' | 'agent' | 'skill';
  state: DerivedState;
  metadata: ManifestMetadata | null;
  manifestError?: string;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

export type RowKind = 'bundle' | 'tool';

export interface Row {
  entry: RegistryEntry;
  rowKind: RowKind;
  members: RegistryEntry[];
  pinnedBy: string[];
  unresolvedFor: string[];
}

/**
 * Build the merged row list: every bundle first (in the order returned), then any
 * tool not claimed by a bundle.
 *
 * A tool is "claimed" only when a bundle's on-disk manifest lists it. A ghost bundle
 * has no manifest, so its former members fall back to standalone rows rather than
 * disappearing from the page entirely.
 */
export function buildRows(
  skills: RegistryEntry[],
  tools: RegistryEntry[],
  agents: RegistryEntry[],
): Row[] {
  const toolByName = new Map(tools.map(t => [t.name, t]));
  const enabledAgents = new Set(agents.filter(a => a.state === 'enabled').map(a => a.name));
  const claimed = new Set<string>();

  const bundleRows: Row[] = skills.map(entry => {
    const memberNames = entry.metadata?.tools ?? [];
    const members: RegistryEntry[] = [];
    for (const name of memberNames) {
      const tool = toolByName.get(name);
      claimed.add(name);
      // A member declared in the manifest but missing from tool_registry discovery is
      // still worth showing — render it as uninstalled rather than dropping it.
      members.push(tool ?? {
        name, kind: 'tool', state: 'uninstalled', metadata: null,
        installedAt: null, installedBy: null, enabledAt: null, enabledBy: null,
      });
    }
    const pinnedBy = entry.metadata?.pinnedBy ?? [];
    return {
      entry,
      rowKind: 'bundle',
      members,
      pinnedBy,
      unresolvedFor: entry.state === 'enabled'
        ? []
        : pinnedBy.filter(a => enabledAgents.has(a)),
    };
  });

  const toolRows: Row[] = tools
    .filter(t => !claimed.has(t.name))
    .map(entry => ({ entry, rowKind: 'tool', members: [], pinnedBy: [], unresolvedFor: [] }));

  return [...bundleRows, ...toolRows];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -C <worktree> exec vitest run apps/console/src/pages/registry-rows.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Point the page at the shared types and load all three endpoints**

In `RegistrySettings.tsx`, delete the now-duplicated local type declarations and import them:

```ts
import { buildRows, type RegistryEntry, type DerivedState, type Row } from './registry-rows.js';
```

Replace the `load` callback for the tool kind so it fetches all three in parallel. Agents keep their existing single-fetch path:

```ts
  const load = useCallback(async () => {
    try {
      if (kind === 'agent') {
        const res = await apiFetch('/api/registry/agents');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { agents?: RegistryEntry[] };
        const list = data.agents ?? [];
        setEntries(list);
        setRows(list.map(e => ({
          entry: e, rowKind: 'tool' as const, members: [], pinnedBy: [], unresolvedFor: [],
        })));
        setLoadError(null);
        setSelected(prev => (prev ? list.find(e => e.name === prev.name) ?? null : null));
        return;
      }

      // /tools merges three endpoints: bundles, tools, and agents (agents only so an
      // unresolved pin can be flagged against agents that are actually enabled).
      const [skillsRes, toolsRes, agentsRes] = await Promise.all([
        apiFetch('/api/registry/skills'),
        apiFetch('/api/registry/tools'),
        apiFetch('/api/registry/agents'),
      ]);
      for (const res of [skillsRes, toolsRes, agentsRes]) {
        if (!res.ok) throw new Error(await errorMessage(res));
      }
      const skills = (await skillsRes.json() as { skills?: RegistryEntry[] }).skills ?? [];
      const tools = (await toolsRes.json() as { tools?: RegistryEntry[] }).tools ?? [];
      const agents = (await agentsRes.json() as { agents?: RegistryEntry[] }).agents ?? [];

      const built = buildRows(skills, tools, agents);
      setRows(built);
      // `entries` stays the flat list the search/sort/filter/pagination code already uses.
      setEntries(built.map(r => r.entry));
      setLoadError(null);
      setSelected(prev =>
        prev ? built.map(r => r.entry).find(e => e.name === prev.name) ?? null : null,
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, [kind]);
```

Add the backing state next to `entries`:

```ts
  const [rows, setRows] = useState<Row[]>([]);
```

And a lookup so the render can find a row for a paged entry:

```ts
  const rowByName = useMemo(() => new Map(rows.map(r => [r.entry.name, r])), [rows]);
```

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm -C <worktree> run typecheck`
Expected: clean.

```bash
git -C <worktree> add apps/console/src/pages/registry-rows.ts apps/console/src/pages/registry-rows.test.ts apps/console/src/pages/RegistrySettings.tsx
git -C <worktree> commit -s -m "feat(console): merge bundles, tools and agents into one row model

Extracts the tree-building and unresolved-pin logic so it is unit testable.
Refs #1724"
```

---

### Task 5: Console — render bundles, members, type pill and unresolved-pin state

**Files:**
- Modify: `apps/console/src/pages/RegistrySettings.tsx` (table header + body, ~`:596-670`)

**Interfaces:**
- Consumes: `Row` and `rowByName` from Task 4.
- Produces: no new exports. Adds `expanded: Set<string>` local state.

- [ ] **Step 1: Add expand state**

```ts
  // Bundle rows collapse by default — a bundle with 14 members would otherwise
  // dominate the first page.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((name: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);
```

- [ ] **Step 2: Add a Type column to the header**

Insert immediately after the Name `<th>`, for the tool kind only:

```tsx
                          {kind === 'tool' && <th>Type</th>}
```

Bump the empty-state `colSpan`:

```ts
  const colCount = kind === 'agent' ? 4 : 7;
```

- [ ] **Step 3: Replace the table body rows**

```tsx
                        {pageRows.map(e => {
                          const row = rowByName.get(e.name);
                          const isBundle = row?.rowKind === 'bundle';
                          const isOpen = expanded.has(e.name);
                          const broken = (row?.unresolvedFor.length ?? 0) > 0;
                          return (
                            <Fragment key={e.name}>
                              <tr
                                className={selected?.name === e.name ? 'active' : undefined}
                                onClick={() => setSelected(e)}
                                style={{ cursor: 'pointer' }}
                              >
                                <td>
                                  {isBundle && (
                                    <button
                                      type="button"
                                      aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${e.name}`}
                                      aria-expanded={isOpen}
                                      onClick={ev => { ev.stopPropagation(); toggleExpanded(e.name); }}
                                      style={{
                                        background: 'none', border: 'none', cursor: 'pointer',
                                        padding: '0 6px 0 0', color: 'inherit', font: 'inherit',
                                      }}
                                    >
                                      {isOpen ? '▾' : '▸'}
                                    </button>
                                  )}
                                  {e.name}{e.manifestError ? ' ⚠' : ''}
                                </td>
                                {kind === 'tool' && (
                                  <td>
                                    <span className="status-pill">
                                      {isBundle ? 'bundle' : 'tool'}
                                    </span>
                                  </td>
                                )}
                                <td>
                                  <span className={`status-pill ${STATE_PILL[e.state]}`}>
                                    {e.state}{e.state === 'ghost' ? ' ⚠' : ''}
                                  </span>
                                </td>
                                {kind === 'agent' ? (
                                  <td>{e.metadata?.modelTier ?? '—'}</td>
                                ) : (
                                  <>
                                    <td>{e.metadata?.actionRisk != null ? String(e.metadata.actionRisk) : '—'}</td>
                                    <td>{e.metadata?.sensitivity ?? '—'}</td>
                                    <td>
                                      {broken ? (
                                        <span
                                          className="status-pill blocked"
                                          title={
                                            `${row!.unresolvedFor.join(', ')} pin${row!.unresolvedFor.length === 1 ? 's' : ''} ` +
                                            `this bundle. It is not enabled, so ${row!.members.length} ` +
                                            `tool${row!.members.length === 1 ? '' : 's'} are missing from ` +
                                            `${row!.unresolvedFor.length === 1 ? 'that agent' : 'those agents'}' function list.`
                                          }
                                        >
                                          ⚠ {row!.unresolvedFor.join(', ')}
                                        </span>
                                      ) : (
                                        row?.pinnedBy.length ? row.pinnedBy.join(', ') : '—'
                                      )}
                                    </td>
                                  </>
                                )}
                                <td>{e.metadata?.version ?? '—'}</td>
                              </tr>
                              {isBundle && isOpen && row!.members.map(m => (
                                <tr key={`${e.name}:${m.name}`} style={{ opacity: 0.75 }}>
                                  <td style={{ paddingLeft: 28 }}>{m.name}</td>
                                  <td />
                                  <td>
                                    <span className={`status-pill ${STATE_PILL[m.state]}`}>{m.state}</span>
                                  </td>
                                  <td colSpan={3} style={{ fontSize: 12, color: 'var(--app-fg-muted)' }}>
                                    managed by {e.name}
                                  </td>
                                  <td>{m.metadata?.version ?? '—'}</td>
                                </tr>
                              ))}
                            </Fragment>
                          );
                        })}
```

Add a "Pinned by" `<th>` after Sensitivity in the tool-kind header block:

```tsx
                              <th>Pinned by</th>
```

Import `Fragment`:

```ts
import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
```

- [ ] **Step 4: Typecheck and build the console**

Run: `pnpm -C <worktree> run typecheck`
Then: `pnpm -C <worktree> --filter @curia/console run build`
Expected: both clean. (If the console package name differs, read it from `apps/console/package.json` and use that.)

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add apps/console/src/pages/RegistrySettings.tsx
git -C <worktree> commit -s -m "feat(console): render bundles with nested members and pin warnings

Bundle rows expand to show read-only members; a bundle pinned by an enabled
agent but not itself enabled renders as blocked. Refs #1724"
```

---

### Task 6: Console — disable confirmation, and docs

Disabling a bundle strips its member tools. Some of those tools are pinned individually by other agents (`T2125-expense-tracker` pins `ceo-inbox-download-attachment` and `ceo-inbox-search`), so the operator must see who is affected before confirming.

**Files:**
- Modify: `apps/console/src/pages/RegistrySettings.tsx` (`RegistryDrawer`, ~`:130-250`)
- Modify: `CHANGELOG.md`
- Test: `apps/console/src/pages/registry-rows.test.ts`

**Interfaces:**
- Consumes: `Row.members`, and agent entries' `metadata.pinnedBy`-equivalent (agents pin *tools* directly, so this needs a second index).
- Produces: `collateralPins(row, agents): Array<{ tool: string; agents: string[] }>` exported from `registry-rows.ts`.

- [ ] **Step 1: Write the failing test**

Append to `registry-rows.test.ts`:

```ts
import { collateralPins } from './registry-rows.js';

describe('collateralPins', () => {
  const row = {
    entry: bundle('ceo-inbox', ['ceo-inbox-search', 'ceo-inbox-list'], [], 'enabled'),
    rowKind: 'bundle' as const,
    members: [entry('ceo-inbox-search'), entry('ceo-inbox-list')],
    pinnedBy: [],
    unresolvedFor: [],
  };

  it('reports member tools pinned individually by other agents', () => {
    const agents = [
      entry('T2125-expense-tracker', {
        kind: 'agent', state: 'enabled',
        metadata: { name: 'T2125-expense-tracker', description: 'd', version: '1.0.0',
          pinnedTools: ['ceo-inbox-search'] },
      }),
    ];

    expect(collateralPins(row, agents)).toEqual([
      { tool: 'ceo-inbox-search', agents: ['T2125-expense-tracker'] },
    ]);
  });

  it('ignores the bundle owner itself and returns nothing when no one else pins a member', () => {
    expect(collateralPins(row, [])).toEqual([]);
  });
});
```

Note: this reuses `entry` and `bundle` helpers already defined at the top of the file.

- [ ] **Step 2: Extend the API so agents report their pinned names**

`collateralPins` needs to know what each agent pins. Do **not** reuse `ManifestMetadata.tools` for this — on a skill it means "bundle members", and overloading it to mean "raw pins" on an agent makes every future reader check which kind they're holding. Add a distinct field.

In `src/registry/types.ts`, in the `// agents` block of `ManifestMetadata`:

```ts
  /** Raw `pinned_skills` for an agent — a mix of bundle names and first-class tool
   *  pins (ADR-032). Distinct from `tools`, which means bundle membership on a skill.
   *  The console uses this to warn before a bundle disable strips a tool that some
   *  other agent pins directly. Agents only. */
  pinnedTools?: string[];
```

In `src/index.ts`, add it to the `agentDiscovery.map(...)` metadata object (~line 2340):

```ts
            role: d.config.role,
            modelTier: d.config.model?.tier,
            pinnedTools: d.config.pinned_skills ?? [],
```

Mirror the field in `apps/console/src/pages/registry-rows.ts`'s `ManifestMetadata` (add `pinnedTools?: string[];` beside `pinnedBy`).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -C <worktree> exec vitest run apps/console/src/pages/registry-rows.test.ts -t collateralPins`
Expected: FAIL — `collateralPins` is not exported.

- [ ] **Step 4: Implement `collateralPins`**

Append to `apps/console/src/pages/registry-rows.ts`:

```ts
/**
 * Member tools of `row` that some agent pins directly, by tool name.
 *
 * Disabling a bundle cascades to its members, which would strip those tools from an
 * agent that never asked for the bundle at all. The operator sees this list before
 * confirming. Only enabled agents count — a disabled agent loses nothing.
 */
export function collateralPins(
  row: Row,
  agents: RegistryEntry[],
): Array<{ tool: string; agents: string[] }> {
  const memberNames = new Set(row.members.map(m => m.name));
  const byTool = new Map<string, string[]>();

  for (const agent of agents) {
    if (agent.state !== 'enabled') continue;
    for (const pin of agent.metadata?.pinnedTools ?? []) {
      if (!memberNames.has(pin)) continue;
      const list = byTool.get(pin);
      if (list) list.push(agent.name);
      else byTool.set(pin, [agent.name]);
    }
  }

  return [...byTool.entries()].map(([tool, names]) => ({ tool, agents: names }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -C <worktree> exec vitest run apps/console/src/pages/registry-rows.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Wire the confirmation into the drawer**

`RegistryDrawer` needs the row and the agent list. Add two props (`row?: Row`, `agents: RegistryEntry[]`) and pass them from the render site. Before performing a `disable` on a bundle, gate on a confirm:

```tsx
  const confirmDisable = useCallback((): boolean => {
    if (row?.rowKind !== 'bundle') return true;
    const collateral = collateralPins(row, agents);
    const lines = [
      `Disable the "${entry.name}" bundle?`,
      '',
      `This also disables ${row.members.length} member tool${row.members.length === 1 ? '' : 's'}.`,
    ];
    if (collateral.length > 0) {
      lines.push(
        '',
        'These member tools are pinned directly by other agents, which will lose them:',
        ...collateral.map(c => `  • ${c.tool} — ${c.agents.join(', ')}`),
      );
    }
    lines.push('', 'Takes effect on the next restart.');
    return window.confirm(lines.join('\n'));
  }, [row, agents, entry.name]);
```

Call it at the top of the disable branch of the existing action handler; return early when it yields `false`.

- [ ] **Step 7: Typecheck, build, run the full suite**

Run: `pnpm -C <worktree> run typecheck`
Then: `pnpm -C <worktree> exec vitest run`
Then: `pnpm -C <worktree> --filter @curia/console run build`
Expected: all clean.

- [ ] **Step 8: Confirm the restart notice covers bundles**

The drawer already renders "Enabling or disabling takes effect on the next restart."
(`RegistrySettings.tsx:219`). Bundles use the same drawer, so this needs verification, not
new code: open a bundle row's drawer and confirm the notice is present. If it is gated on
`kind`, remove the gate so it shows for bundles too.

- [ ] **Step 9: Update CHANGELOG**

Add under `## [Unreleased]` → `### Added`:

```markdown
- **Skill bundle registry UI** — `/tools` now enables/disables bundles and flags unresolved agent pins. (#1724)
```

- [ ] **Step 10: Commit**

```bash
git -C <worktree> add apps/console/src/pages/ src/index.ts CHANGELOG.md
git -C <worktree> commit -s -m "feat(console): confirm bundle disable when members are pinned elsewhere

Warns which agents lose a directly-pinned tool before cascading a disable.
Refs #1724"
```

---

## Manual verification against prod-like state

After Task 6, confirm the acceptance criteria that only show up with real data:

1. Run the app locally against the dev DB (see `reference_run_curia_antfarm_locally`).
2. With no `ceo-inbox` row in `skill_registry`, open `/tools`. Expect: a `ceo-inbox` row typed `bundle`, state `uninstalled`, and a red `⚠ ceo-inbox` in **Pinned by** whose tooltip names the 14 missing tools.
3. Expand it. Expect 14 member rows, read-only, even though the bundle is not installed.
4. Enable it from the drawer. Expect `skill_registry` to gain an enabled `ceo-inbox` row and all 14 `tool_registry` rows to be enabled, in one transaction.
5. Restart. Expect no `unresolvedPins` error in the boot log for `ceo-inbox`, and `Agent tools configured` to include all 14 tools.
6. Confirm `diagnostics` and `learning` render the same way.

---

## Out of scope

Tracked separately, do not touch in this PR:

- Pin-resolution behaviour itself (`src/skills/pin-resolution.ts`).
- Tightening `ExecutionLayer.invoke()` so an agent cannot call a tool it was never given.
- The `last_run_summary` feedback loop.
