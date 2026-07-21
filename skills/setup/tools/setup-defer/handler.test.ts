// skills/setup-defer/handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SetupDeferHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import type { Logger } from '../../../../src/logger.js';

// ── EntityMemory mock helpers ────────────────────────────────────────────────
//
// ConfigStore.get() calls:
//   1. findEntities('config:setup_wizard') → returns anchor node(s)
//   2. getFacts(anchor.id) → returns fact nodes
//   It finds the fact whose label === 'deferrals' and reads properties.value.
//
// ConfigStore.set() calls:
//   1. findEntities('config:setup_wizard') → find or create anchor
//   2. storeFact({ entityNodeId, label: 'deferrals', properties: { key, value, namespace }, ... })

type MinimalEntityMemory = Pick<EntityMemory, 'findEntities' | 'getFacts' | 'storeFact' | 'createEntity'>;

/**
 * Build a minimal EntityMemory double seeded with an optional pre-existing
 * deferrals value. Mirrors the pattern used by ceo-inbox-list handler tests.
 */
function makeEntityMemory(existingDeferrals?: string): MinimalEntityMemory {
  const anchorNode = {
    id: 'anchor-1',
    label: 'config:setup_wizard',
    type: 'concept' as const,
    properties: { category: 'config', namespace: 'setup_wizard' },
    aliases: [],
    temporal: { lastConfirmedAt: new Date(), confidence: 0.7, decayClass: 'permanent', source: 'system:config-store' },
    sensitivity: 'internal' as const,
  };

  const factNode =
    existingDeferrals !== undefined
      ? {
          id: 'fact-1',
          label: 'deferrals',
          properties: { key: 'deferrals', value: existingDeferrals, namespace: 'setup_wizard' },
          type: 'fact' as const,
          aliases: [],
          temporal: { lastConfirmedAt: new Date(), confidence: 0.9, decayClass: 'permanent', source: 'system:config-store' },
          sensitivity: 'internal' as const,
        }
      : undefined;

  return {
    findEntities: vi.fn().mockResolvedValue([anchorNode]),
    getFacts: vi.fn().mockResolvedValue(factNode ? [factNode] : []),
    storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'created' }),
    createEntity: vi.fn().mockResolvedValue({ entity: anchorNode, created: false }),
  };
}

/** Build a ToolContext with the given input and optional pre-seeded store data. */
function makeCtx(input: Record<string, unknown>, existingDeferrals?: string): ToolContext {
  return {
    input,
    entityMemory: makeEntityMemory(existingDeferrals) as unknown as EntityMemory,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    secret: vi.fn(),
  } as unknown as ToolContext;
}

const handler = new SetupDeferHandler();

describe('setup-defer', () => {
  it('defers a task that was not deferred', async () => {
    // No pre-existing deferrals — getFacts returns []
    const ctx = makeCtx({ task_id: 'email', action: 'defer' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { success: true; data: { deferred: string[] } }).data.deferred).toEqual(['email']);
  });

  it('defers a task only once (idempotent)', async () => {
    // Pre-seed with 'email' already deferred
    const existing = JSON.stringify(['email']);
    const ctx = makeCtx({ task_id: 'email', action: 'defer' }, existing);
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { deferred: string[] } }).data;
    expect(data.deferred).toEqual(['email']); // no duplicate
  });

  it('resumes a deferred task', async () => {
    const existing = JSON.stringify(['email', 'signal']);
    const ctx = makeCtx({ task_id: 'email', action: 'resume' }, existing);
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { deferred: string[] } }).data;
    expect(data.deferred).toEqual(['signal']);
  });

  it('returns error when task_id is missing', async () => {
    const ctx = makeCtx({ action: 'defer' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('returns error when action is invalid', async () => {
    const ctx = makeCtx({ task_id: 'email', action: 'snooze' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('normalizes whitespace in task_id — " email " stores and returns as "email"', async () => {
    const ctx = makeCtx({ task_id: ' email ', action: 'defer' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { deferred: string[]; task_id: string } }).data;
    expect(data.task_id).toBe('email');
    expect(data.deferred).toEqual(['email']);
  });

  it('returns error for an unknown task_id not in the catalog', async () => {
    const ctx = makeCtx({ task_id: 'nonexistent_task', action: 'defer' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('reports failure (not a false success) when the config write soft-rejects', async () => {
    // ConfigStore.set soft-rejects (stored:false) on a storeFact dedup conflict without throwing
    // (#1438). The deferral change never persisted, so returning success would be a lie — the CEO
    // must get a retryable failure instead.
    const mem = makeEntityMemory() as unknown as { storeFact: ReturnType<typeof vi.fn> };
    mem.storeFact.mockResolvedValue({ stored: false, action: 'conflict' });
    const ctx = {
      input: { task_id: 'email', action: 'defer' },
      entityMemory: mem as unknown as EntityMemory,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    } as unknown as ToolContext;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/retry/i);
  });

  it('returns error when entityMemory is absent', async () => {
    const ctx = {
      input: { task_id: 'email', action: 'defer' },
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as unknown as ToolContext;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });
});
