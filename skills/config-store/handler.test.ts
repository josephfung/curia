// skills/config-store/handler.test.ts
//
// Mocked KG calls cover input validation, store (create + reuse anchor, meta-index),
// retrieve (single key, all keys, missing namespace/key), list_namespaces.
// The "exact-key semantics (real validator)" suite wires a real in-memory
// EntityMemory + MemoryValidator so storeFact runs the production dedup path (#2252).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigStoreHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import pino from 'pino';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { mailboxView } from '../_shared/principal-mailboxes-test-helpers.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function makeEntityMemory(overrides: Record<string, unknown> = {}) {
  return {
    findEntities: vi.fn().mockResolvedValue([]),
    createEntity: vi.fn().mockResolvedValue({ entity: { id: 'node-1' }, created: true }),
    storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'created', nodeId: 'fact-1' }),
    getFacts: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeCtx(
  entityMemory: ReturnType<typeof makeEntityMemory> | null | undefined,
  input: Record<string, unknown>,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    input,
    entityMemory: entityMemory === null ? undefined : (entityMemory ?? makeEntityMemory()),
    log: pino({ level: 'silent' }),
    ...overrides,
  } as unknown as ToolContext;
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
      const data = result.data as { stored: boolean; action: string; namespace: string; key: string };
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');
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
    const valueFact = mem.storeFact.mock.calls[0]![0];
    expect(valueFact.label).toBe('writing_guide_url');
    expect(valueFact.properties.value).toBe('https://docs.example.com');
    expect(valueFact.properties.namespace).toBe('writing_config');
    expect(valueFact.properties.exact_key).toBe(true);
    expect(valueFact.decayClass).toBe('permanent');
    expect(valueFact.exactKey).toBe(true);

    // Verify the namespace registration fact (also exactKey)
    const nsFact = mem.storeFact.mock.calls[1]![0];
    expect(nsFact.label).toBe('writing_config');
    expect(nsFact.properties.namespace).toBe('writing_config');
    expect(nsFact.properties.key).toBe('writing_config');
    expect(nsFact.exactKey).toBe(true);
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
    expect(mem.storeFact.mock.calls[0]![0].entityNodeId).toBe('anchor-existing');
  });

  it('surfaces stored:false and action when storeFact rejects the write', async () => {
    // Regression: storeFact previously returned stored:true unconditionally, masking
    // cases where the entity-memory validator silently rejected or rate-limited the write.
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn()
        .mockResolvedValueOnce([{ id: 'anchor-existing' }])
        .mockResolvedValueOnce([{ id: 'index-existing' }]),
      storeFact: vi.fn().mockResolvedValue({ stored: false, action: 'auto_rejected' }),
    });
    const ctx = makeCtx(mem, { action: 'store', namespace: 'travel', key: 'aeroplan', value: 'AC123456' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { stored: boolean; action: string; namespace: string; key: string };
      expect(data.stored).toBe(false);
      expect(data.action).toBe('auto_rejected');
      expect(data.namespace).toBe('travel');
      expect(data.key).toBe('aeroplan');
    }
    // storeFact called only once (the value write) — namespace registration must be
    // skipped when the value write was rejected, otherwise list_namespaces would
    // advertise a namespace with no stored config values (phantom namespace).
    expect(mem.storeFact).toHaveBeenCalledTimes(1);
  });

  it('uses memoryWriteSource as the storeFact source when available', async () => {
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn()
        .mockResolvedValueOnce([{ id: 'anchor-existing' }]) // anchor lookup
        .mockResolvedValueOnce([{ id: 'index-existing' }]), // index lookup
    });
    const memoryWriteSource = 'agent:ceo-inbox/task:task-123/channel:http';
    const ctx = makeCtx(
      mem,
      { action: 'store', namespace: 'ceo_inbox', key: 'rules', value: '[]' },
      { memoryWriteSource },
    );

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    // Both storeFact calls (value + namespace registration) should use memoryWriteSource
    expect(mem.storeFact).toHaveBeenCalledTimes(2);
    expect(mem.storeFact.mock.calls[0]![0].source).toBe(memoryWriteSource);
    expect(mem.storeFact.mock.calls[1]![0].source).toBe(memoryWriteSource);
  });

  it('falls back to skill:config-store when memoryWriteSource is not set', async () => {
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn()
        .mockResolvedValueOnce([{ id: 'anchor-existing' }])
        .mockResolvedValueOnce([{ id: 'index-existing' }]),
    });
    // No memoryWriteSource on context — simulates test / CLI invocations
    const ctx = makeCtx(mem, { action: 'store', namespace: 'ns', key: 'k', value: 'v' });

    await handler.execute(ctx);

    expect(mem.storeFact.mock.calls[0]![0].source).toBe('skill:config-store');
  });

  it('skips namespace registration when namespace is already in the meta-index', async () => {
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn()
        .mockResolvedValueOnce([{ id: 'anchor-existing' }]) // anchor lookup
        .mockResolvedValueOnce([{ id: 'index-existing' }]), // index lookup
      // getFacts returns the namespace already registered in the index
      getFacts: vi.fn().mockResolvedValue([
        { id: 'nf1', label: 'travel', properties: { key: 'travel', namespace: 'travel' } },
      ]),
    });
    const ctx = makeCtx(mem, { action: 'store', namespace: 'travel', key: 'aeroplan', value: 'AC123456' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    // storeFact called once — for the value fact only; namespace already registered, skipped
    expect(mem.storeFact).toHaveBeenCalledTimes(1);
    expect(mem.storeFact.mock.calls[0]![0].entityNodeId).toBe('anchor-existing');
    expect(mem.storeFact.mock.calls[0]![0].label).toBe('aeroplan');
  });

  it('re-registers a namespace whose index fact was corrupted by semantic merge', async () => {
    // Old bug left {label:'travel_detection', properties:{namespace:'travel_detection_v2'}}.
    // A label-only guard would skip registering travel_detection forever.
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn()
        .mockResolvedValueOnce([{ id: 'anchor-existing' }])
        .mockResolvedValueOnce([{ id: 'index-existing' }]),
      getFacts: vi.fn().mockResolvedValue([
        {
          id: 'nf1',
          label: 'travel_detection',
          properties: { namespace: 'travel_detection_v2' },
        },
      ]),
    });
    const ctx = makeCtx(mem, {
      action: 'store',
      namespace: 'travel_detection',
      key: 'k',
      value: 'v',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    // Value fact + namespace registration (corrupted label must not block).
    expect(mem.storeFact).toHaveBeenCalledTimes(2);
    expect(mem.storeFact.mock.calls[1]![0].label).toBe('travel_detection');
    expect(mem.storeFact.mock.calls[1]![0].properties.key).toBe('travel_detection');
    expect(mem.storeFact.mock.calls[1]![0].exactKey).toBe(true);
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

  it('returns found:true via properties.key when label diverged (historical semantic merge)', async () => {
    // After a semantic merge, label may still be the first key while properties.key
    // holds the last write. Retrieve matches properties.key only (#2252).
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        {
          id: 'f1',
          label: 'sheet_id.2025',
          properties: { key: 'sheet_id.2026', value: 'real-sheet-id', namespace: 't2125' },
        },
      ]),
    });
    const ctx = makeCtx(mem, { action: 'retrieve', namespace: 't2125', key: 'sheet_id.2026' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { found: boolean; key: string; value: string };
      expect(data.found).toBe(true);
      expect(data.key).toBe('sheet_id.2026');
      expect(data.value).toBe('real-sheet-id');
    }
  });

  it('does not return a fact whose properties.key differs from the requested key (even if label matches)', async () => {
    // Acceptance: retrieve by key never returns a fact with a different properties.key.
    // Label-first matching previously returned the merged value for the original key.
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        {
          id: 'f1',
          label: 'processed_event_ids_1',
          properties: {
            key: 'processed_event_ids_3',
            value: '["only-third"]',
            namespace: 'travel_detection',
          },
        },
      ]),
    });
    const ctx = makeCtx(mem, {
      action: 'retrieve',
      namespace: 'travel_detection',
      key: 'processed_event_ids_1',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { found: boolean; key: string };
      expect(data.found).toBe(false);
      expect(data.key).toBe('processed_event_ids_1');
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

  it('falls back to label when properties.key is absent (legacy single-key retrieve)', async () => {
    const handler = new ConfigStoreHandler();
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        {
          id: 'f1',
          label: 'writing_guide_url',
          properties: { value: 'https://docs.example.com' },
          temporal: { lastConfirmedAt: new Date('2026-01-01T00:00:00Z') },
        },
      ]),
    });
    const ctx = makeCtx(mem, { action: 'retrieve', namespace: 'writing_config', key: 'writing_guide_url' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { found: boolean; value: string };
      expect(data.found).toBe(true);
      expect(data.value).toBe('https://docs.example.com');
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

describe('ConfigStoreHandler exact-key semantics (real validator)', () => {
  let entityMemory: EntityMemory;
  let handler: ConfigStoreHandler;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());
    handler = new ConfigStoreHandler();
  });

  function ctx(input: Record<string, unknown>): ToolContext {
    return {
      input,
      entityMemory,
      log: pino({ level: 'silent' }),
      memoryWriteSource: 'agent:test/task:exact-key/channel:cli',
    } as unknown as ToolContext;
  }

  it('stores foo_1, foo_2, foo_3 as three facts and retrieves each value', async () => {
    // Acceptance: distinct suffix keys stay separate through the real storeFact path.
    for (const [key, value] of [
      ['foo_1', 'one'],
      ['foo_2', 'two'],
      ['foo_3', 'three'],
    ] as const) {
      const storeResult = await handler.execute(
        ctx({ action: 'store', namespace: 'travel_detection', key, value }),
      );
      expect(storeResult.success).toBe(true);
      if (storeResult.success) {
        const data = storeResult.data as { stored: boolean; action: string };
        expect(data.stored).toBe(true);
        expect(data.action).toBe('created');
      }
    }

    for (const [key, value] of [
      ['foo_1', 'one'],
      ['foo_2', 'two'],
      ['foo_3', 'three'],
    ] as const) {
      const retrieveResult = await handler.execute(
        ctx({ action: 'retrieve', namespace: 'travel_detection', key }),
      );
      expect(retrieveResult.success).toBe(true);
      if (retrieveResult.success) {
        const data = retrieveResult.data as { found: boolean; value: string };
        expect(data.found).toBe(true);
        expect(data.value).toBe(value);
      }
    }

    const anchors = await entityMemory.findEntities('config:travel_detection');
    expect(anchors).toHaveLength(1);
    const facts = await entityMemory.getFacts(anchors[0]!.id);
    // Value facts only (meta-index is a separate anchor); three keys → three facts.
    expect(facts.filter((f) => typeof f.properties.key === 'string')).toHaveLength(3);
  });

  it('stores the same key twice as an in-place update (no duplicate fact)', async () => {
    const first = await handler.execute(
      ctx({ action: 'store', namespace: 'ns', key: 'aeroplan', value: 'AC1' }),
    );
    expect(first.success).toBe(true);
    if (first.success) {
      expect((first.data as { action: string }).action).toBe('created');
    }

    const second = await handler.execute(
      ctx({ action: 'store', namespace: 'ns', key: 'aeroplan', value: 'AC2' }),
    );
    expect(second.success).toBe(true);
    if (second.success) {
      const data = second.data as { stored: boolean; action: string };
      expect(data.stored).toBe(true);
      expect(data.action).toBe('updated');
    }

    const retrieveResult = await handler.execute(
      ctx({ action: 'retrieve', namespace: 'ns', key: 'aeroplan' }),
    );
    expect(retrieveResult.success).toBe(true);
    if (retrieveResult.success) {
      expect((retrieveResult.data as { value: string }).value).toBe('AC2');
    }

    const anchors = await entityMemory.findEntities('config:ns');
    const facts = await entityMemory.getFacts(anchors[0]!.id);
    expect(facts.filter((f) => f.properties.key === 'aeroplan')).toHaveLength(1);
  });

  it('keeps recurring-instance keys as separate facts', async () => {
    const keyA = 'seen:04ncurue_20260921T213000Z';
    const keyB = 'seen:04ncurue_20261019T213000Z';

    await handler.execute(ctx({ action: 'store', namespace: 'debrief', key: keyA, value: '1' }));
    await handler.execute(ctx({ action: 'store', namespace: 'debrief', key: keyB, value: '1' }));

    const a = await handler.execute(ctx({ action: 'retrieve', namespace: 'debrief', key: keyA }));
    const b = await handler.execute(ctx({ action: 'retrieve', namespace: 'debrief', key: keyB }));
    expect(a.success && (a.data as { found: boolean }).found).toBe(true);
    expect(b.success && (b.data as { found: boolean }).found).toBe(true);

    const anchors = await entityMemory.findEntities('config:debrief');
    const facts = await entityMemory.getFacts(anchors[0]!.id);
    expect(facts.map((f) => f.properties.key).sort()).toEqual([keyA, keyB].sort());
  });
});

// #2475 SF5/B1: ceo_inbox/sending is keyed by live mailbox id; the tool names the live ones.
describe('ConfigStoreHandler — ceo_inbox/sending', () => {
  // The list-only directory (M0): ids, labels, triage starts. No clients.
  const directory = (views: ReturnType<typeof mailboxView>[]): NonNullable<ToolContext['mailboxDirectory']> =>
    ({ list: async () => views.map(({ id, label, triageStartAt }) => ({ id, label, triageStartAt })) });
  const two = directory([mailboxView('work', 'Work', 'w@example.com', true), mailboxView('personal', 'Personal', 'p@example.com')]);
  const store = (value: string, mailboxDirectory: ToolContext['mailboxDirectory'] = two, em = makeEntityMemory()) =>
    new ConfigStoreHandler().execute(makeCtx(em, { action: 'store', namespace: 'ceo_inbox', key: 'sending', value }, { mailboxDirectory }));

  it('refuses a key that is not a live mailbox, naming the live ids and labels, and stores nothing', async () => {
    const em = makeEntityMemory();
    const r = await store('{"wrk":"routine"}', two, em);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain('Not a connected mailbox: wrk');
      expect(r.error).toContain('work (Work), personal (Personal)');
    }
    expect(em.storeFact).not.toHaveBeenCalled();
  });

  it('checks a case or whitespace variant of the namespace and key the same way, and stores the normal form', async () => {
    for (const [namespace, key] of [['CEO_INBOX', 'sending'], [' Ceo_Inbox ', ' SENDING ']] as const) {
      const em = makeEntityMemory();
      const r = await new ConfigStoreHandler().execute(makeCtx(em, { action: 'store', namespace, key, value: '{"wrk":"routine"}' }, { mailboxDirectory: two }));
      expect(r.success, `${namespace}/${key}`).toBe(false);
      if (!r.success) expect(r.error).toContain('Not a connected mailbox: wrk');
      expect(em.storeFact).not.toHaveBeenCalled();
    }
    const em = makeEntityMemory();
    const ok = await new ConfigStoreHandler().execute(makeCtx(em, { action: 'store', namespace: 'CEO_INBOX', key: 'Sending', value: '{"work":"routine"}' }, { mailboxDirectory: two }));
    expect(ok).toMatchObject({ success: true, data: { namespace: 'ceo_inbox', key: 'sending' } });
  });

  it('refuses a legacy default key once there are two mailboxes, saying it no longer applies (M2)', async () => {
    const r = await store('{"default":"routine"}');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain('"default" no longer applies; set a level per mailbox id');
      expect(r.error).not.toContain('Not a connected mailbox');
    }
  });

  it('with no mailbox connected says there is nothing to set (M3)', async () => {
    const r = await store('{"work":"routine"}', directory([]));
    expect(r).toEqual({ success: false, error: 'No principal mailbox is connected yet, so there is nothing to set a sending level for. Nothing was stored.' });
  });

  it('declares only the list-only directory, never the mailbox clients (M0)', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, 'tool.json'), 'utf8')) as { capabilities?: string[]; optional_capabilities?: string[] };
    expect(manifest.optional_capabilities).toEqual(['mailboxDirectory']);
    expect([...(manifest.capabilities ?? []), ...(manifest.optional_capabilities ?? [])]).not.toContain('principalMailboxes');
  });

  it('stores a valid per-mailbox value and returns the live mailboxes', async () => {
    const r = await store('{"work":"routine","personal":"on_request"}');
    expect(r).toMatchObject({ success: true, data: { stored: true, mailboxes: [{ id: 'work', label: 'Work' }, { id: 'personal', label: 'Personal' }] } });
  });

  it('refuses the write when the mailbox list cannot be read (nothing stored)', async () => {
    const broken: ToolContext['mailboxDirectory'] = { list: async () => { throw new Error('db down'); } };
    const em = makeEntityMemory();
    const r = await store('{"work":"routine"}', broken, em);
    expect(r.success).toBe(false);
    expect(em.storeFact).not.toHaveBeenCalled();
  });

  it('a read of the key names the live mailboxes', async () => {
    const r = await new ConfigStoreHandler().execute(makeCtx(undefined, { action: 'retrieve', namespace: 'ceo_inbox', key: 'sending' }, { mailboxDirectory: two }));
    expect(r).toMatchObject({ success: true, data: { found: false, mailboxes: [{ id: 'work', label: 'Work' }, { id: 'personal', label: 'Personal' }] } });
  });

  it('other keys are untouched by the check', async () => {
    const r = await new ConfigStoreHandler().execute(makeCtx(undefined, { action: 'store', namespace: 'ceo_inbox', key: 'decision_tagging', value: '{"enabled":true}' }, { mailboxDirectory: two }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).not.toHaveProperty('mailboxes');
  });
});

// #2475 R65: code-owned triage / sent-observe / voice-learning state is refused; the cadence key
// `triage` itself is validated against the live mailboxes.
describe('ConfigStoreHandler — code-owned ceo_inbox state and the triage cadence (R65)', () => {
  const directory: NonNullable<ToolContext['mailboxDirectory']> = {
    list: async () => [mailboxView('work', 'Work', 'w@example.com', true), mailboxView('personal', 'Personal', 'p@example.com')]
      .map(({ id, label, triageStartAt }) => ({ id, label, triageStartAt })),
  };
  const store = (key: string, value: string, em = makeEntityMemory(), namespace = 'ceo_inbox') =>
    new ConfigStoreHandler().execute(makeCtx(em, { action: 'store', namespace, key, value }, { mailboxDirectory: directory }));

  it.each([
    'triage.batches.2026-11-12', 'triage.work.draining', 'triage.work.last_drained_at',
    'sent_observe.work.last_seen_at', 'sent_observe.matched_draft_ids', 'voice_learn.proposal',
  ])('refuses %s and stores nothing', async (key) => {
    const em = makeEntityMemory();
    const r = await store(key, '0', em);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('state Curia keeps itself');
    expect(em.storeFact).not.toHaveBeenCalled();
  });

  it('leaves the same key names in other namespaces alone', async () => {
    expect((await store('triage.notes', 'x', makeEntityMemory(), 'my_notes')).success).toBe(true);
  });

  it('stores a valid cadence keyed by live mailbox ids', async () => {
    expect((await store('triage', '{"work":"every 30m 08:00-18:00 weekdays","personal":"daily 08:00"}')).success).toBe(true);
  });

  it.each([
    ['not JSON', 'hourly'],
    ['an unknown mailbox', '{"wrk":"hourly"}'],
    ['an invalid cadence', '{"work":"every 7m"}'],
    ['a non-string cadence', '{"work":15}'],
  ])('refuses %s and stores nothing', async (_what, value) => {
    const em = makeEntityMemory();
    const r = await store('triage', value, em);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('Nothing was stored');
    expect(em.storeFact).not.toHaveBeenCalled();
  });
});
