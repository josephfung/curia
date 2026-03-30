import { describe, it, expect, vi } from 'vitest';
import { KnowledgeCompanyOverviewHandler } from '../../../skills/knowledge-company-overview/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';

import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

/** Stub EntityMemory with in-memory storage. */
function makeEntityMemory() {
  const entities = new Map<string, { id: string; label: string; properties: Record<string, unknown> }>();
  const facts = new Map<string, Array<{ id: string; label: string; properties: Record<string, unknown>; temporal: { lastConfirmedAt: Date; confidence: number; decayClass: string; source: string; createdAt: Date } }>>();
  let nextId = 1;

  return {
    findEntities: vi.fn(async (label: string) => {
      const matches: Array<{ id: string; label: string; properties: Record<string, unknown> }> = [];
      for (const e of entities.values()) {
        if (e.label.toLowerCase() === label.toLowerCase()) {
          matches.push(e);
        }
      }
      return matches;
    }),
    createEntity: vi.fn(async (opts: { type: string; label: string; properties: Record<string, unknown>; source: string }) => {
      const id = `entity-${nextId++}`;
      const entity = { id, label: opts.label, properties: opts.properties };
      entities.set(id, entity);
      facts.set(id, []);
      return entity;
    }),
    storeFact: vi.fn(async (opts: { entityNodeId: string; label: string; properties: Record<string, unknown>; confidence: number; decayClass: string; source: string }) => {
      const entityFacts = facts.get(opts.entityNodeId) ?? [];
      const existing = entityFacts.find((f) => f.label === opts.label);
      if (existing) {
        existing.properties = opts.properties;
        existing.temporal.lastConfirmedAt = new Date();
        return { stored: true, nodeId: existing.id };
      }
      const factId = `fact-${nextId++}`;
      const now = new Date();
      entityFacts.push({
        id: factId,
        label: opts.label,
        properties: opts.properties,
        temporal: { lastConfirmedAt: now, confidence: opts.confidence, decayClass: opts.decayClass, source: opts.source, createdAt: now },
      });
      facts.set(opts.entityNodeId, entityFacts);
      return { stored: true, nodeId: factId };
    }),
    getFacts: vi.fn(async (entityNodeId: string) => {
      return facts.get(entityNodeId) ?? [];
    }),
  };
}

describe('KnowledgeCompanyOverviewHandler', () => {
  const handler = new KnowledgeCompanyOverviewHandler();

  describe('action validation', () => {
    it('rejects missing action', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx({}, { entityMemory: em as never }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('action');
    });

    it('rejects invalid action', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx({ action: 'delete' }, { entityMemory: em as never }));
      expect(result.success).toBe(false);
    });
  });

  describe('entityMemory requirement', () => {
    it('rejects when entityMemory is not available', async () => {
      const result = await handler.execute(makeCtx({ action: 'store', field: 'name', value: 'Acme' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('Knowledge graph');
    });
  });

  describe('store', () => {
    it('rejects when field is missing', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx(
        { action: 'store', value: 'Acme Inc.' },
        { entityMemory: em as never },
      ));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('field');
    });

    it('rejects when value is missing', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx(
        { action: 'store', field: 'legal_name' },
        { entityMemory: em as never },
      ));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('value');
    });

    it('stores a fact and creates anchor on first store', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx(
        { action: 'store', field: 'legal_name', value: 'Acme Corporation' },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { stored: boolean; field: string };
        expect(data.stored).toBe(true);
        expect(data.field).toBe('legal_name');
      }
      expect(em.createEntity).toHaveBeenCalledTimes(1);
      expect(em.storeFact).toHaveBeenCalledTimes(1);
    });

    it('reuses existing anchor on subsequent stores', async () => {
      const em = makeEntityMemory();
      await handler.execute(makeCtx(
        { action: 'store', field: 'legal_name', value: 'Acme Corporation' },
        { entityMemory: em as never },
      ));
      await handler.execute(makeCtx(
        { action: 'store', field: 'address', value: '123 Main St' },
        { entityMemory: em as never },
      ));

      // Anchor should only be created once
      expect(em.createEntity).toHaveBeenCalledTimes(1);
      expect(em.storeFact).toHaveBeenCalledTimes(2);
    });
  });

  describe('retrieve', () => {
    it('returns empty list when no facts stored', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx(
        { action: 'retrieve' },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { facts: unknown[] };
        expect(data.facts).toHaveLength(0);
      }
    });

    it('retrieves stored facts', async () => {
      const em = makeEntityMemory();
      // Store two facts
      await handler.execute(makeCtx(
        { action: 'store', field: 'legal_name', value: 'Acme Corporation' },
        { entityMemory: em as never },
      ));
      await handler.execute(makeCtx(
        { action: 'store', field: 'address', value: '123 Main St, Toronto' },
        { entityMemory: em as never },
      ));

      const result = await handler.execute(makeCtx(
        { action: 'retrieve' },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { facts: Array<{ field: string; value: string }> };
        expect(data.facts).toHaveLength(2);
        const fields = data.facts.map((f) => f.field);
        expect(fields).toContain('legal_name');
        expect(fields).toContain('address');
      }
    });
  });

  describe('error handling', () => {
    it('handles storeFact errors gracefully', async () => {
      const em = makeEntityMemory();
      em.storeFact.mockRejectedValueOnce(new Error('DB connection lost'));

      // First need to create anchor
      em.createEntity.mockResolvedValueOnce({ id: 'e-1', label: 'company-overview', properties: {} });

      const result = await handler.execute(makeCtx(
        { action: 'store', field: 'legal_name', value: 'Acme' },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('DB connection lost');
      }
    });
  });
});
