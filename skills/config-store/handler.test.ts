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
  entityMemory: ReturnType<typeof makeEntityMemory> | null | undefined,
  input: Record<string, unknown>,
): SkillContext {
  return {
    input,
    entityMemory: entityMemory === null ? undefined : (entityMemory ?? makeEntityMemory()),
    log: pino({ level: 'silent' }),
  } as unknown as SkillContext;
}

describe('ConfigStoreHandler', () => {
  // ── Action validation ────────────────────────────────────────────────────

  it('returns error when action is missing', async () => {
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(makeCtx(undefined, {}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/action/i);
  });

  it('returns error when action is unrecognised', async () => {
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(makeCtx(undefined, { action: 'delete' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/action/i);
  });

  it('returns error when entityMemory is not available', async () => {
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(makeCtx(null, { action: 'retrieve', namespace: 'x' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/knowledge graph/i);
  });

  // ── Store: input validation ──────────────────────────────────────────────

  it('returns error when namespace is missing on store', async () => {
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(makeCtx(undefined, { action: 'store', key: 'k', value: 'v' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/namespace/i);
  });

  it('returns error when key is missing on store', async () => {
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(makeCtx(undefined, { action: 'store', namespace: 'ns', value: 'v' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/key/i);
  });

  it('returns error when value is missing on store', async () => {
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(makeCtx(undefined, { action: 'store', namespace: 'ns', key: 'k' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/value/i);
  });

  it('returns error when namespace exceeds 100 characters', async () => {
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(
      makeCtx(undefined, { action: 'store', namespace: 'x'.repeat(101), key: 'k', value: 'v' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/namespace/i);
  });

  it('returns error when key exceeds 200 characters', async () => {
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(
      makeCtx(undefined, { action: 'store', namespace: 'ns', key: 'k'.repeat(201), value: 'v' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/key/i);
  });

  it('returns error when value exceeds 2000 characters', async () => {
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(
      makeCtx(undefined, { action: 'store', namespace: 'ns', key: 'k', value: 'v'.repeat(2001) }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/value/i);
  });

  // ── Store: success ───────────────────────────────────────────────────────

  it('creates anchor + registers namespace in meta-index on first store', async () => {
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory();
    const ctx = makeCtx(mem, { action: 'store', namespace: 'writing_config', key: 'writing_guide_url', value: 'https://docs.example.com' });

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
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn()
        .mockResolvedValueOnce([{ id: 'anchor-existing' }]) // anchor lookup
        .mockResolvedValueOnce([{ id: 'index-existing' }]), // index lookup
    });
    const ctx = makeCtx(mem, { action: 'store', namespace: 'travel', key: 'aeroplan', value: 'AC123456' });

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
    const handler = new ConfigStoreHandler();
    const result = await handler.execute(makeCtx(undefined, { action: 'retrieve' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/namespace/i);
  });

  // ── Retrieve: single key ─────────────────────────────────────────────────

  it('returns found:true and value when key exists', async () => {
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'f1', label: 'writing_guide_url', properties: { key: 'writing_guide_url', value: 'https://docs.example.com', namespace: 'writing_config' } },
      ]),
    });
    const ctx = makeCtx(mem, { action: 'retrieve', namespace: 'writing_config', key: 'writing_guide_url' });

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
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'f1', label: 'other_key', properties: { key: 'other_key', value: 'other_value', namespace: 'writing_config' } },
      ]),
    });
    const ctx = makeCtx(mem, { action: 'retrieve', namespace: 'writing_config', key: 'missing_key' });

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
    const handler = new ConfigStoreHandler();
    const ctx = makeCtx(undefined, { action: 'retrieve', namespace: 'nonexistent', key: 'some_key' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { found: boolean };
      expect(data.found).toBe(false);
    }
  });

  // ── Retrieve: all keys in namespace ──────────────────────────────────────

  it('returns all entries when namespace exists and no key specified', async () => {
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'f1', label: 'writing_guide_url', properties: { key: 'writing_guide_url', value: 'https://docs.example.com/guide', namespace: 'writing_config' } },
        { id: 'f2', label: 'essays_index_url', properties: { key: 'essays_index_url', value: 'https://docs.example.com/index', namespace: 'writing_config' } },
      ]),
    });
    const ctx = makeCtx(mem, { action: 'retrieve', namespace: 'writing_config' });

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
    const handler = new ConfigStoreHandler();
    const ctx = makeCtx(undefined, { action: 'retrieve', namespace: 'nonexistent' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { entries: unknown[]; message: string };
      expect(data.entries).toHaveLength(0);
      expect(data.message).toMatch(/nonexistent/);
    }
  });

  it('falls back to label as key when properties.key is absent (legacy compat)', async () => {
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'f1', label: 'legacy_field', properties: { value: 'some-value' } },
      ]),
    });
    const ctx = makeCtx(mem, { action: 'retrieve', namespace: 'ns' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { entries: Array<{ key: string; value: string }> };
      expect(data.entries[0]!.key).toBe('legacy_field');
    }
  });

  // ── list_namespaces ───────────────────────────────────────────────────────

  it('returns all registered namespaces from the meta-index', async () => {
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'index-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        { id: 'nf1', label: 'writing_config', properties: { namespace: 'writing_config' } },
        { id: 'nf2', label: 'travel', properties: { namespace: 'travel' } },
      ]),
    });
    const ctx = makeCtx(mem, { action: 'list_namespaces' });

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
    const handler = new ConfigStoreHandler();
    const ctx = makeCtx(undefined, { action: 'list_namespaces' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { namespaces: string[] };
      expect(data.namespaces).toHaveLength(0);
    }
  });
});
