// handler.test.ts — knowledge-writing-config skill unit tests.
//
// All KG calls are mocked — no real Postgres or entity memory needed.
// Focus: input validation paths and the store/retrieve contract.

import { describe, it, expect, vi } from 'vitest';
import { KnowledgeWritingConfigHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import pino from 'pino';

// Minimal mock entity memory — returns empty state unless overridden per test.
function makeEntityMemory(overrides: Partial<ReturnType<typeof makeEntityMemory>> = {}) {
  return {
    findEntities: vi.fn().mockResolvedValue([]),
    createEntity: vi.fn().mockResolvedValue({ entity: { id: 'anchor-1' } }),
    storeFact: vi.fn().mockResolvedValue(undefined),
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

describe('KnowledgeWritingConfigHandler', () => {
  const handler = new KnowledgeWritingConfigHandler();

  // ── Action validation ────────────────────────────────────────────────────

  it('returns error when action is missing', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/action/i);
  });

  it('returns error when action is an unknown value', async () => {
    const result = await handler.execute(makeCtx({ action: 'delete' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/action/i);
  });

  it('returns error when entityMemory is not available', async () => {
    const result = await handler.execute(makeCtx({ action: 'retrieve' }, null));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/knowledge graph/i);
  });

  // ── Store: input validation ──────────────────────────────────────────────

  it('returns error when field is missing on store', async () => {
    const result = await handler.execute(makeCtx({ action: 'store', value: 'https://example.com' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/field/i);
  });

  it('returns error when value is missing on store', async () => {
    const result = await handler.execute(makeCtx({ action: 'store', field: 'writing_guide_url' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/value/i);
  });

  it('returns error when field exceeds 200 characters', async () => {
    const result = await handler.execute(
      makeCtx({ action: 'store', field: 'x'.repeat(201), value: 'https://example.com' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/field/i);
  });

  it('returns error when value exceeds 2000 characters', async () => {
    const result = await handler.execute(
      makeCtx({ action: 'store', field: 'writing_guide_url', value: 'x'.repeat(2001) }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/value/i);
  });

  // ── Store: success ───────────────────────────────────────────────────────

  it('creates anchor and stores fact on first store call', async () => {
    const mem = makeEntityMemory();
    const ctx = makeCtx({ action: 'store', field: 'writing_guide_url', value: 'https://docs.example.com/guide' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { stored: boolean; field: string };
      expect(data.stored).toBe(true);
      expect(data.field).toBe('writing_guide_url');
    }

    // findEntities called to look for existing anchor
    expect(mem.findEntities).toHaveBeenCalledWith('writing-config');
    // createEntity called because findEntities returned []
    expect(mem.createEntity).toHaveBeenCalledOnce();
    // storeFact called with permanent decay and correct field/value
    expect(mem.storeFact).toHaveBeenCalledOnce();
    const storeCall = mem.storeFact.mock.calls[0][0];
    expect(storeCall.label).toBe('writing_guide_url');
    expect(storeCall.properties.value).toBe('https://docs.example.com/guide');
    expect(storeCall.decayClass).toBe('permanent');
  });

  it('reuses existing anchor when one already exists', async () => {
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-existing' }]),
    });
    const ctx = makeCtx({ action: 'store', field: 'essays_index_url', value: 'https://docs.example.com/index' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    // createEntity should NOT be called — anchor already exists
    expect(mem.createEntity).not.toHaveBeenCalled();
    expect(mem.storeFact).toHaveBeenCalledOnce();
    expect(mem.storeFact.mock.calls[0][0].entityNodeId).toBe('anchor-existing');
  });

  // ── Retrieve ─────────────────────────────────────────────────────────────

  it('returns empty config with guidance message when no anchor node exists', async () => {
    const ctx = makeCtx({ action: 'retrieve' }); // default mem: findEntities returns []

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { config: unknown[]; message: string };
      expect(data.config).toHaveLength(0);
      expect(data.message).toMatch(/ask the ceo/i);
    }
  });

  it('returns stored config values on retrieve', async () => {
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        {
          id: 'fact-1',
          label: 'writing_guide_url',
          properties: { field: 'writing_guide_url', value: 'https://docs.example.com/guide' },
        },
        {
          id: 'fact-2',
          label: 'essays_index_url',
          properties: { field: 'essays_index_url', value: 'https://docs.example.com/index' },
        },
      ]),
    });
    const ctx = makeCtx({ action: 'retrieve' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { config: Array<{ field: string; value: string }> };
      expect(data.config).toHaveLength(2);
      expect(data.config).toContainEqual({ field: 'writing_guide_url', value: 'https://docs.example.com/guide' });
      expect(data.config).toContainEqual({ field: 'essays_index_url', value: 'https://docs.example.com/index' });
    }
  });

  it('falls back to label when properties.field is absent on retrieve', async () => {
    const mem = makeEntityMemory({
      findEntities: vi.fn().mockResolvedValue([{ id: 'anchor-1' }]),
      getFacts: vi.fn().mockResolvedValue([
        // Simulates a fact written without an explicit field property
        { id: 'fact-3', label: 'legacy_field', properties: { value: 'some-value' } },
      ]),
    });
    const ctx = makeCtx({ action: 'retrieve' }, mem);

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { config: Array<{ field: string; value: string }> };
      expect(data.config[0]!.field).toBe('legacy_field');
    }
  });
});
