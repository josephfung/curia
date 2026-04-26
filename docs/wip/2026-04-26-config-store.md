# Config Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `config-store` skill so any agent can persist namespaced key-value configuration in the KG without a bespoke `knowledge-*` skill.

**Architecture:** A single `SkillHandler` with three actions (`store`, `retrieve`, `list_namespaces`). Each namespace gets its own KG anchor node (`config:{namespace}`). A meta-index node (`config-store-index`) tracks registered namespaces for cheap `list_namespaces` reads. All values use `decayClass: permanent` — config is stable by design.

**Tech Stack:** TypeScript/ESM, Vitest, pino, `ctx.entityMemory` (KG write/read path already used by all `knowledge-*` skills).

---

## Worktrees

| Work | Worktree | Branch |
|---|---|---|
| Tasks 1–6 (core skill) | `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store` | `feat/config-store` |
| Task 7 (PR #356 cleanup) | `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-image-generate` | `feat/image-generate` |
| Task 8 (essay-editor update) | `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-essay-editor` | `feat/essay-editor` |

---

## Task 1: Skill manifest

**Files:**
- Create: `skills/config-store/skill.json`

- [ ] **Step 1: Create the manifest**

```json
{
  "name": "config-store",
  "description": "Store or retrieve agent configuration in the knowledge graph. Use 'store' to save a key-value pair under a namespace (e.g. namespace='writing_config', key='writing_guide_url'). Use 'retrieve' to read one key or all keys in a namespace. Use 'list_namespaces' to see which namespaces have been written to. Values are permanent — use this for deploy-agnostic config the CEO provides once via chat.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "inputs": {
    "action": "string (store | retrieve | list_namespaces)",
    "namespace": "string? (required for store and retrieve — logical grouping, e.g. 'writing_config', 'travel')",
    "key": "string? (required for store, optional for retrieve — the config key, e.g. 'writing_guide_url')",
    "value": "string? (required for store — the config value)"
  },
  "outputs": {
    "stored": "boolean? (true when a value was persisted)",
    "namespace": "string? (the namespace operated on)",
    "key": "string? (the key operated on)",
    "found": "boolean? (for retrieve-single — whether the key exists)",
    "value": "string? (for retrieve-single — the stored value)",
    "entries": "array? (for retrieve-all — list of {key, value} objects)",
    "namespaces": "array? (for list_namespaces — list of namespace strings)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000,
  "capabilities": [
    "entityMemory"
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store add skills/config-store/skill.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store commit -m "feat: add config-store skill manifest"
```

---

## Task 2: Failing tests

**Files:**
- Create: `skills/config-store/handler.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// skills/config-store/handler.test.ts
//
// All KG calls are mocked. No Postgres or real entityMemory needed.
// Tests cover: input validation, store (create + reuse anchor, meta-index),
// retrieve (single key, all keys, missing namespace/key), list_namespaces.

import { describe, it, expect, vi } from 'vitest';
import { ConfigStoreHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import pino from 'pino';

function makeEntityMemory(overrides: Record<string, unknown> = {}) {
  return {
    findEntities: vi.fn().mockResolvedValue([]),
    createEntity: vi.fn().mockResolvedValue({ entity: { id: 'node-1' }, created: true }),
    storeFact: vi.fn().mockResolvedValue({ stored: true, nodeId: 'fact-1' }),
    getFacts: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeCtx(
  input: Record<string, unknown>,
  entityMemory?: ReturnType<typeof makeEntityMemory> | null,
): SkillContext {
  return {
    input,
    entityMemory: entityMemory === null ? undefined : (entityMemory ?? makeEntityMemory()),
    log: pino({ level: 'silent' }),
  } as unknown as SkillContext;
}

describe('ConfigStoreHandler', () => {
  const handler = new ConfigStoreHandler();

  // ── Action validation ────────────────────────────────────────────────────

  it('returns error when action is missing', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/action/i);
  });

  it('returns error when action is unrecognised', async () => {
    const result = await handler.execute(makeCtx({ action: 'delete' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/action/i);
  });

  it('returns error when entityMemory is not available', async () => {
    const result = await handler.execute(makeCtx({ action: 'retrieve', namespace: 'x' }, null));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/knowledge graph/i);
  });

  // ── Store: input validation ──────────────────────────────────────────────

  it('returns error when namespace is missing on store', async () => {
    const result = await handler.execute(makeCtx({ action: 'store', key: 'k', value: 'v' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/namespace/i);
  });

  it('returns error when key is missing on store', async () => {
    const result = await handler.execute(makeCtx({ action: 'store', namespace: 'ns', value: 'v' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/key/i);
  });

  it('returns error when value is missing on store', async () => {
    const result = await handler.execute(makeCtx({ action: 'store', namespace: 'ns', key: 'k' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/value/i);
  });

  it('returns error when namespace exceeds 100 characters', async () => {
    const result = await handler.execute(
      makeCtx({ action: 'store', namespace: 'x'.repeat(101), key: 'k', value: 'v' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/namespace/i);
  });

  it('returns error when key exceeds 200 characters', async () => {
    const result = await handler.execute(
      makeCtx({ action: 'store', namespace: 'ns', key: 'k'.repeat(201), value: 'v' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/key/i);
  });

  it('returns error when value exceeds 2000 characters', async () => {
    const result = await handler.execute(
      makeCtx({ action: 'store', namespace: 'ns', key: 'k', value: 'v'.repeat(2001) }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/value/i);
  });

  // ── Store: success ───────────────────────────────────────────────────────

  it('creates anchor + registers namespace in meta-index on first store', async () => {
    const mem = makeEntityMemory();
    const ctx = makeCtx({ action: 'store', namespace: 'writing_config', key: 'writing_guide_url', value: 'https://docs.example.com' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { stored: boolean; namespace: string; key: string };
      expect(data.stored).toBe(true);
      expect(data.namespace).toBe('writing_config');
      expect(data.key).toBe('writing_guide_url');
    }

    // Anchor and index: findEntities called for both anchor + index
    expect(mem.findEntities).toHaveBeenCalledWith('config:writing_config');
    expect(mem.findEntities).toHaveBeenCalledWith('config-store-index');
    // Both created since findEntities returned []
    expect(mem.createEntity).toHaveBeenCalledTimes(2);
    // storeFact called twice: once for the value, once for the namespace registration
    expect(mem.storeFact).toHaveBeenCalledTimes(2);

    // Verify the value fact
    const valueFact = mem.storeFact.mock.calls[0][0];
    expect(valueFact.label).toBe('writing_guide_url');
    expect(valueFact.properties.value).toBe('https://docs.example.com');
    expect(valueFact.properties.namespace).toBe('writing_config');
    expect(valueFact.decayClass).toBe('permanent');

    // Verify the namespace registration fact
    const nsFact = mem.storeFact.mock.calls[1][0];
    expect(nsFact.label).toBe('writing_config');
    expect(nsFact.properties.namespace).toBe('writing_config');
    expect(nsFact.decayClass).toBe('permanent');
  });

  it('reuses existing anchor when one already exists', async () => {
    const mem = makeEntityMemory({
      findEntities: vi.fn()
        .mockResolvedValueOnce([{ id: 'anchor-existing' }]) // anchor lookup
        .mockResolvedValueOnce([{ id: 'index-existing' }]), // index lookup
    });
    const ctx = makeCtx({ action: 'store', namespace: 'travel', key: 'aeroplan', value: 'AC123456' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    // createEntity not called — both anchor and index already exist
    expect(mem.createEntity).not.toHaveBeenCalled();
    // storeFact still called for value + namespace registration
    expect(mem.storeFact).toHaveBeenCalledTimes(2);
    expect(mem.storeFact.mock.calls[0][0].entityNodeId).toBe('anchor-existing');
  });

  // ── Retrieve: input validation ───────────────────────────────────────────

  it('returns error when namespace is missing on retrieve', async () => {
    const result = await handler.execute(makeCtx({ action: 'retrieve' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/namespace/i);
  });

  // ── Retrieve: single key ─────────────────────────────────────────────────

  it('returns found:true and value when key exists', async () => {
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'f1', label: 'writing_guide_url', properties: { key: 'writing_guide_url', value: 'https://docs.example.com', namespace: 'writing_config' } },
      ]),
    });
    const ctx = makeCtx({ action: 'retrieve', namespace: 'writing_config', key: 'writing_guide_url' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { found: boolean; key: string; value: string };
      expect(data.found).toBe(true);
      expect(data.key).toBe('writing_guide_url');
      expect(data.value).toBe('https://docs.example.com');
    }
  });

  it('returns found:false when key does not exist in namespace', async () => {
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'f1', label: 'other_key', properties: { key: 'other_key', value: 'other_value', namespace: 'writing_config' } },
      ]),
    });
    const ctx = makeCtx({ action: 'retrieve', namespace: 'writing_config', key: 'missing_key' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { found: boolean; key: string };
      expect(data.found).toBe(false);
      expect(data.key).toBe('missing_key');
    }
  });

  it('returns found:false when namespace does not exist (single-key retrieve)', async () => {
    // findEntities returns [] — namespace anchor doesn't exist yet
    const ctx = makeCtx({ action: 'retrieve', namespace: 'nonexistent', key: 'some_key' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { found: boolean };
      expect(data.found).toBe(false);
    }
  });

  // ── Retrieve: all keys in namespace ──────────────────────────────────────

  it('returns all entries when namespace exists and no key specified', async () => {
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'f1', label: 'writing_guide_url', properties: { key: 'writing_guide_url', value: 'https://docs.example.com/guide', namespace: 'writing_config' } },
        { id: 'f2', label: 'essays_index_url', properties: { key: 'essays_index_url', value: 'https://docs.example.com/index', namespace: 'writing_config' } },
      ]),
    });
    const ctx = makeCtx({ action: 'retrieve', namespace: 'writing_config' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { entries: Array<{ key: string; value: string }> };
      expect(data.entries).toHaveLength(2);
      expect(data.entries).toContainEqual({ key: 'writing_guide_url', value: 'https://docs.example.com/guide' });
      expect(data.entries).toContainEqual({ key: 'essays_index_url', value: 'https://docs.example.com/index' });
    }
  });

  it('returns empty entries with message when namespace does not exist (all-keys retrieve)', async () => {
    // default mem: findEntities returns []
    const ctx = makeCtx({ action: 'retrieve', namespace: 'nonexistent' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { entries: unknown[]; message: string };
      expect(data.entries).toHaveLength(0);
      expect(data.message).toMatch(/nonexistent/);
    }
  });

  it('falls back to label as key when properties.key is absent (legacy compat)', async () => {
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'f1', label: 'legacy_field', properties: { value: 'some-value' } },
      ]),
    });
    const ctx = makeCtx({ action: 'retrieve', namespace: 'ns' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { entries: Array<{ key: string; value: string }> };
      expect(data.entries[0]!.key).toBe('legacy_field');
    }
  });

  // ── list_namespaces ───────────────────────────────────────────────────────

  it('returns all registered namespaces from the meta-index', async () => {
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'index-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'nf1', label: 'writing_config', properties: { namespace: 'writing_config' } },
        { id: 'nf2', label: 'travel', properties: { namespace: 'travel' } },
      ]),
    });
    const ctx = makeCtx({ action: 'list_namespaces' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { namespaces: string[] };
      expect(data.namespaces).toContain('writing_config');
      expect(data.namespaces).toContain('travel');
    }
  });

  it('returns empty namespaces array when nothing stored yet', async () => {
    // default mem: findEntities returns []
    const ctx = makeCtx({ action: 'list_namespaces' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { namespaces: string[] };
      expect(data.namespaces).toHaveLength(0);
    }
  });
});
```

- [ ] **Step 2: Run tests — confirm they all fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store run test -- --reporter=verbose skills/config-store/handler.test.ts 2>&1 | tail -20
```

Expected: all tests fail with "Cannot find module './handler.js'"

- [ ] **Step 3: Commit failing tests**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store add skills/config-store/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store commit -m "test: add failing tests for config-store handler"
```

---

## Task 3: Handler implementation

**Files:**
- Create: `skills/config-store/handler.ts`

- [ ] **Step 1: Create the handler**

```typescript
// skills/config-store/handler.ts
//
// Generic key-value configuration store backed by the knowledge graph.
//
// KG storage model:
//   Namespace anchor: type=concept, label="config:{namespace}"
//     properties: { category: 'config', namespace }
//   Per-key facts on the anchor:
//     label=key, properties: { key, value, namespace }, decayClass=permanent
//   Meta-index anchor: type=concept, label="config-store-index"
//     Per-namespace facts: label=namespace, properties: { namespace }, decayClass=permanent
//
// The meta-index lets list_namespaces run as a single KG read rather than a
// label-scan across all entities.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const INDEX_LABEL = 'config-store-index';

function anchorLabel(namespace: string): string {
  return `config:${namespace}`;
}

export class ConfigStoreHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { action } = ctx.input as { action?: string };

    if (!action || !['store', 'retrieve', 'list_namespaces'].includes(action)) {
      return {
        success: false,
        error: "Missing or invalid 'action' — must be 'store', 'retrieve', or 'list_namespaces'",
      };
    }

    if (!ctx.entityMemory) {
      return { success: false, error: 'Knowledge graph not available — cannot access config store' };
    }

    if (action === 'store') return this.store(ctx);
    if (action === 'retrieve') return this.retrieve(ctx);
    return this.listNamespaces(ctx);
  }

  private async store(ctx: SkillContext): Promise<SkillResult> {
    const { namespace, key, value } = ctx.input as {
      namespace?: string;
      key?: string;
      value?: string;
    };

    if (!namespace || typeof namespace !== 'string') {
      return { success: false, error: 'Missing required input: namespace' };
    }
    if (!key || typeof key !== 'string') {
      return { success: false, error: 'Missing required input: key' };
    }
    if (!value || typeof value !== 'string') {
      return { success: false, error: 'Missing required input: value' };
    }
    if (namespace.length > 100) {
      return { success: false, error: 'namespace must be 100 characters or fewer' };
    }
    if (key.length > 200) {
      return { success: false, error: 'key must be 200 characters or fewer' };
    }
    if (value.length > 2000) {
      return { success: false, error: 'value must be 2000 characters or fewer' };
    }

    try {
      const anchor = await this.findOrCreateAnchor(ctx, namespace);

      await ctx.entityMemory!.storeFact({
        entityNodeId: anchor.id,
        label: key,
        properties: { key, value, namespace },
        confidence: 1.0,
        // Config values are permanent — stable URLs / IDs the CEO provides once
        decayClass: 'permanent',
        source: 'skill:config-store',
      });

      // Register the namespace in the meta-index so list_namespaces can find it
      await this.registerNamespace(ctx, namespace);

      ctx.log.info({ namespace, key }, 'Stored config value');
      return { success: true, data: { stored: true, namespace, key } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, namespace, key }, 'Failed to store config value');
      return { success: false, error: `Failed to store: ${message}` };
    }
  }

  private async retrieve(ctx: SkillContext): Promise<SkillResult> {
    const { namespace, key } = ctx.input as { namespace?: string; key?: string };

    if (!namespace || typeof namespace !== 'string') {
      return { success: false, error: 'Missing required input: namespace' };
    }

    try {
      const anchors = await ctx.entityMemory!.findEntities(anchorLabel(namespace));

      if (anchors.length === 0) {
        // Namespace has never been written to
        if (key) {
          return { success: true, data: { found: false, key } };
        }
        return {
          success: true,
          data: {
            entries: [],
            message: `No config stored in namespace '${namespace}' yet.`,
          },
        };
      }

      // Collect facts across all anchor nodes for this namespace. Multiple anchors
      // can exist if findOrCreateAnchor races (same pattern as knowledge-company-overview).
      const allFacts = await Promise.all(anchors.map((a) => ctx.entityMemory!.getFacts(a.id)));
      const facts = allFacts.flat();

      if (key) {
        const fact = facts.find((f) => f.label === key);
        if (!fact) {
          return { success: true, data: { found: false, key } };
        }
        return {
          success: true,
          data: {
            found: true,
            key,
            value: fact.properties.value as string,
          },
        };
      }

      const entries = facts.map((f) => ({
        // Fall back to label if properties.key is absent (forward-compat for hand-crafted nodes)
        key: (f.properties.key as string | undefined) ?? f.label,
        value: f.properties.value as string,
      }));

      ctx.log.info({ namespace, entryCount: entries.length }, 'Retrieved config entries');
      return { success: true, data: { entries } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, namespace }, 'Failed to retrieve config');
      return { success: false, error: `Failed to retrieve: ${message}` };
    }
  }

  private async listNamespaces(ctx: SkillContext): Promise<SkillResult> {
    try {
      const indexNodes = await ctx.entityMemory!.findEntities(INDEX_LABEL);

      if (indexNodes.length === 0) {
        return { success: true, data: { namespaces: [] } };
      }

      const allFacts = await Promise.all(indexNodes.map((n) => ctx.entityMemory!.getFacts(n.id)));
      const namespaces = allFacts.flat().map(
        (f) => (f.properties.namespace as string | undefined) ?? f.label,
      );

      ctx.log.info({ namespaceCount: namespaces.length }, 'Listed config namespaces');
      return { success: true, data: { namespaces } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to list namespaces');
      return { success: false, error: `Failed to list namespaces: ${message}` };
    }
  }

  private async findOrCreateAnchor(ctx: SkillContext, namespace: string) {
    const label = anchorLabel(namespace);
    const existing = await ctx.entityMemory!.findEntities(label);
    if (existing.length > 0) return existing[0]!;

    const { entity } = await ctx.entityMemory!.createEntity({
      type: 'concept',
      label,
      properties: { category: 'config', namespace },
      source: 'skill:config-store',
    });
    return entity;
  }

  private async registerNamespace(ctx: SkillContext, namespace: string): Promise<void> {
    const indexNodes = await ctx.entityMemory!.findEntities(INDEX_LABEL);

    let indexNodeId: string;
    if (indexNodes.length === 0) {
      const { entity } = await ctx.entityMemory!.createEntity({
        type: 'concept',
        label: INDEX_LABEL,
        properties: { category: 'config-meta' },
        source: 'skill:config-store',
      });
      indexNodeId = entity.id;
    } else {
      indexNodeId = indexNodes[0]!.id;
    }

    await ctx.entityMemory!.storeFact({
      entityNodeId: indexNodeId,
      label: namespace,
      properties: { namespace },
      confidence: 1.0,
      decayClass: 'permanent',
      source: 'skill:config-store',
    });
  }
}
```

- [ ] **Step 2: Run tests — confirm they all pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store run test -- --reporter=verbose skills/config-store/handler.test.ts 2>&1 | tail -30
```

Expected: all tests pass (17 tests)

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store add skills/config-store/handler.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store commit -m "feat: implement config-store handler"
```

---

## Task 4: Wire coordinator

**Files:**
- Modify: `agents/coordinator.yaml` (line 430)

- [ ] **Step 1: Add `config-store` to coordinator's pinned_skills**

In `agents/coordinator.yaml`, find the knowledge skills block (around line 427) and add `config-store` after `knowledge-loyalty-programs`:

```yaml
  - knowledge-company-overview
  - knowledge-meeting-links
  - knowledge-travel-preferences
  - knowledge-loyalty-programs
  - config-store
  - context-for-email
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store add agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store commit -m "feat: pin config-store on coordinator"
```

---

## Task 5: Documentation updates

**Files:**
- Modify: `docs/specs/03-skills-and-execution.md`
- Modify: `docs/dev/adding-an-agent.md`
- Modify: `docs/dev/adding-a-skill.md`

### 5a — Skills spec

- [ ] **Step 1: Add config-store to the Built-in Skills list**

In `docs/specs/03-skills-and-execution.md`, find the line:

```
- Knowledge skills (`knowledge-company-overview`, `knowledge-meeting-links`, etc.) — structured KG queries
```

Replace with:

```
- Knowledge skills (`knowledge-company-overview`, `knowledge-meeting-links`, etc.) — structured KG queries (legacy pattern — use `config-store` for new agents)
- `config-store` — generic namespaced key-value store for persistent agent configuration; backs writing-config, travel preferences, and any future per-agent config needs
```

- [ ] **Step 2: Add config-store to the Implementation Status table**

Find the line:
```
| Built-in skill: `memory-query` | Not Done |
```

Add immediately above it:
```
| Built-in skill: `config-store` (generic namespaced agent config store) | Done — `skills/config-store/` |
```

### 5b — Adding an agent guide

- [ ] **Step 3: Add config-store to the skills table**

In `docs/dev/adding-an-agent.md`, find the Knowledge row in the skills table:

```
| **Knowledge** | `knowledge-company-overview`, `knowledge-meeting-links`, `knowledge-travel-preferences`, `knowledge-loyalty-programs` |
```

Replace with:

```
| **Knowledge** | `knowledge-company-overview`, `knowledge-meeting-links`, `knowledge-travel-preferences`, `knowledge-loyalty-programs` (legacy — see Config below) |
| **Config** | `config-store` — generic key-value agent config; namespace-scoped, KG-backed, permanent decay |
```

- [ ] **Step 4: Add a config-store guidance section**

In `docs/dev/adding-an-agent.md`, find the `#### Specialists don't own outbound comms` section. Insert a new section immediately **before** it:

```markdown
#### Using `config-store` for persistent agent config

If your agent needs to store configuration values that persist across runs — URLs, account
numbers, preferences, or any other settings the CEO provides once via chat — pin
`config-store` and use it directly. Do not write a new `knowledge-*` skill.

```yaml
pinned_skills:
  - config-store
```

**Namespace:** pick a short, stable string owned by your agent (e.g. `travel` for a travel
coordinator, `writing_config` for an essay editor). Bake it into your system prompt.

**Store** (coordinator does this when CEO provides a value via chat):
```
config-store { action: "store", namespace: "writing_config", key: "writing_guide_url", value: "https://..." }
```

**Retrieve** (agent does this at the start of each run):
```
config-store { action: "retrieve", namespace: "writing_config", key: "writing_guide_url" }
# → { found: true, value: "https://..." }

config-store { action: "retrieve", namespace: "writing_config" }
# → { entries: [{ key: "writing_guide_url", value: "..." }, ...] }
```

The values are stored with `decayClass: permanent` — they persist across Curia restarts
and are not subject to KG decay.

```

### 5c — Adding a skill guide

- [ ] **Step 5: Add a note to adding-a-skill.md**

In `docs/dev/adding-a-skill.md`, find the `## Checklist Before Opening a PR` section. Insert a new section immediately **before** it:

```markdown
## Don't write a new `knowledge-*` skill for config

If your agent needs to store values that persist across runs (URLs, account numbers,
preferences), use the existing `config-store` skill instead of writing a new
`knowledge-<domain>` skill.

The `knowledge-*` skills (`knowledge-company-overview`, `knowledge-meeting-links`, etc.)
are a legacy pattern — each is near-identical boilerplate for storing namespaced facts in
the KG. `config-store` replaces this pattern with a single generic skill.

See [Adding an Agent — Using config-store](adding-an-agent.md#using-config-store-for-persistent-agent-config) for the usage pattern.

```

- [ ] **Step 6: Commit all doc changes together**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store add docs/specs/03-skills-and-execution.md docs/dev/adding-an-agent.md docs/dev/adding-a-skill.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store commit -m "docs: document config-store in skill spec and dev guides"
```

---

## Task 6: CHANGELOG and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Read the current CHANGELOG `[Unreleased]` section**

```bash
grep -n "Unreleased\|### Added\|### Fixed" /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store/CHANGELOG.md | head -10
```

- [ ] **Step 2: Add entry under `[Unreleased] → ### Added`**

If there is no `### Added` section under `[Unreleased]`, add it. Then add:

```markdown
- **`config-store` skill** — Generic namespaced key-value configuration store backed by the knowledge graph. Agents declare a namespace in their system prompt (`writing_config`, `travel`, etc.) and call `store`/`retrieve`/`list_namespaces` without needing a bespoke `knowledge-*` skill. Values use permanent decay class. Supersedes the per-domain `knowledge-*` pattern for new agents; existing `knowledge-*` skills are unchanged (cleanup tracked in #357).
```

- [ ] **Step 3: Bump version in `package.json`**

Read current version:
```bash
grep '"version"' /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store/package.json
```

`config-store` is a new skill → minor bump. Current main-branch version is `0.20.1` → bump to `0.21.0`.

> **Note:** `feat/image-generate` is also open and bumped to `0.20.2`. Whichever PR merges second will need to re-check the version. If `image-generate` merges first (making main `0.20.2`), bump this PR to `0.21.0`. If this PR merges first, `image-generate` needs to re-bump from `0.20.1` to `0.21.1`.

Change `"version"` in `package.json`:
```json
  "version": "0.21.0",
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-config-store commit -m "chore: bump version to 0.21.0 for config-store skill"
```

---

## Task 7: PR #356 cleanup — remove `knowledge-writing-config`

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-image-generate`
**Branch:** `feat/image-generate`

This task removes `knowledge-writing-config` from PR #356 before it merges, since `config-store` is now the canonical pattern.

- [ ] **Step 1: Delete the knowledge-writing-config skill directory**

```bash
rm -rf /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-image-generate/skills/knowledge-writing-config
```

- [ ] **Step 2: Remove from coordinator.yaml pinned_skills**

In `agents/coordinator.yaml`, remove the line:
```yaml
  - knowledge-writing-config
```

- [ ] **Step 3: Remove from CHANGELOG.md**

In `CHANGELOG.md`, remove the bullet:
```
- **`knowledge-writing-config` skill** — Store and retrieve writing workflow configuration ...
```

- [ ] **Step 4: Remove from docs/specs/03-skills-and-execution.md**

Remove the line added in the image-generate PR:
```
- **`knowledge-writing-config`** in the Knowledge skills description
```

And remove from the Implementation Status table:
```
| Built-in skill: `knowledge-writing-config` (writing workflow config via KG) | Done — `skills/knowledge-writing-config/`; closes #356 |
```

- [ ] **Step 5: Verify tests still pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-image-generate run test -- --reporter=verbose skills/image-generate/handler.test.ts 2>&1 | tail -10
```

Expected: 16 tests pass.

- [ ] **Step 6: Commit and force-push**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-image-generate add -A
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-image-generate commit -m "chore: remove knowledge-writing-config — superseded by config-store"
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-image-generate push --force-with-lease origin feat/image-generate
```

---

## Task 8: Update essay-editor to use config-store

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-essay-editor`
**Branch:** `feat/essay-editor`

- [ ] **Step 1: Update pinned_skills — replace knowledge-writing-config with config-store**

In `custom/agents/essay-editor.yaml`, in the `pinned_skills` block, replace:
```yaml
  - knowledge-writing-config
```
with:
```yaml
  - config-store
```

- [ ] **Step 2: Update the Persistent Resources section**

Find:
```
  At the start of every run, call knowledge-writing-config with action: "retrieve"
  to load your working URLs. The CEO provides these once via chat; they are stored
  in the knowledge graph and available across all runs without restarting Curia.

  Expected fields in the config:
  - writing_guide_url — the Google Doc URL for the Writing Guide
  - essays_index_url  — the Google Doc URL for the Essays Index

  If either URL is missing from the config, add a note to the final summary:
  "writing_guide_url not configured — ask the CEO to provide it" (or essays_index_url).
  Proceed with the steps that do not require the missing resource.
```

Replace with:
```
  At the start of every run, call config-store with action: "retrieve",
  namespace: "writing_config" to load your working URLs. The CEO provides these
  once via chat; they are stored in the knowledge graph and available across all
  runs without restarting Curia.

  Expected keys in the config (retrieve with namespace: "writing_config"):
  - writing_guide_url — the Google Doc URL for the Writing Guide
  - essays_index_url  — the Google Doc URL for the Essays Index

  If either key is missing (found: false or absent from entries), add a note to
  the final summary: "writing_guide_url not configured — ask the CEO to provide it"
  (or essays_index_url). Proceed with the steps that do not require the missing resource.
```

- [ ] **Step 3: Update Step 1 of the pipeline**

Find:
```
  ### Step 1: Load context
  Call knowledge-writing-config with action: "retrieve". Extract writing_guide_url
  and essays_index_url from the returned config array. Then use workspace-mcp to
  read both Google Docs and hold their content in context for the rest of the run.
```

Replace with:
```
  ### Step 1: Load context
  Call config-store with action: "retrieve", namespace: "writing_config". Extract
  writing_guide_url and essays_index_url from the returned entries array. Then use
  workspace-mcp to read both Google Docs and hold their content in context for the
  rest of the run.
```

- [ ] **Step 4: Update the Graceful Degradation section**

Find:
```
  - If knowledge-writing-config retrieve fails or returns no URLs: note missing URLs
    in the summary and proceed with the steps that do not require them.
```

Replace with:
```
  - If config-store retrieve fails or returns no URLs: note missing URLs in the
    summary and proceed with the steps that do not require them.
```

- [ ] **Step 5: Commit and push**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-essay-editor add custom/agents/essay-editor.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-essay-editor commit -m "feat: replace knowledge-writing-config with config-store in essay-editor"
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-deploy-essay-editor push origin feat/essay-editor
```
