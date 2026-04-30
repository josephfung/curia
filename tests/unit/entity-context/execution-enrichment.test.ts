// tests/unit/entity-context/execution-enrichment.test.ts
//
// Unit tests for the execution layer entity_enrichment pre-enrichment feature.
// Verifies that when a manifest declares entity_enrichment, the execution layer
// assembles EntityContext and injects it into ctx.entityContext before calling
// the handler.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { SkillRegistry } from '../../../src/skills/registry.js';
import type { SkillManifest, SkillHandler, SkillContext } from '../../../src/skills/types.js';
import type { EntityContextAssembler } from '../../../src/entity-context/assembler.js';
import type { EntityContext } from '../../../src/entity-context/types.js';

const logger = pino({ level: 'silent' });

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'test-skill',
    description: 'A test skill',
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: 'none',
    inputs: {},
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 5000,
    ...overrides,
  };
}

const sampleEntityContext: EntityContext = {
  entityId: 'node-1',
  entityType: 'person',
  label: 'Jenna Smith',
  contact: { contactId: 'contact-1', displayName: 'Jenna Smith', role: null },
  facts: [{ label: 'timezone', value: 'America/Vancouver', category: 'scheduling', confidence: 0.9, lastConfirmedAt: '2026-01-01T00:00:00.000Z' }],
  connectedAccounts: [{ type: 'calendar', label: 'Work Calendar', serviceId: 'cal-abc', isPrimary: true, readOnly: false, metadata: {} }],
  relationships: [],
};

function makeMockAssembler(result: Awaited<ReturnType<EntityContextAssembler['assembleMany']>>): EntityContextAssembler {
  return {
    assembleMany: vi.fn().mockResolvedValue(result),
    assembleOne: vi.fn(),
    clearCacheForEntity: vi.fn(),
  } as unknown as EntityContextAssembler;
}

describe('ExecutionLayer — entity_enrichment', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it('injects ctx.entityContext when manifest declares entity_enrichment', async () => {
    let capturedCtx: SkillContext | undefined;

    const handler: SkillHandler = {
      execute: async (ctx) => {
        capturedCtx = ctx;
        return { success: true, data: 'ok' };
      },
    };

    const manifest = makeManifest({
      entity_enrichment: { param: 'contacts', default: 'caller' },
    });
    registry.register(manifest, handler);

    const assembler = makeMockAssembler({ entities: [sampleEntityContext], unresolved: [] });
    const execution = new ExecutionLayer(registry, logger, {
      entityContextAssembler: assembler,
    });

    await execution.invoke('test-skill', { contacts: ['contact-1'] });

    expect(capturedCtx?.entityContext).toBeDefined();
    expect(capturedCtx?.entityContext).toHaveLength(1);
    expect(capturedCtx?.entityContext?.[0]?.entityId).toBe('node-1');
    expect(vi.mocked(assembler.assembleMany)).toHaveBeenCalledWith(['contact-1'], { includeRelationships: true });
  });

  it('uses caller contactId as default when param is empty and default=caller', async () => {
    let capturedCtx: SkillContext | undefined;

    const handler: SkillHandler = {
      execute: async (ctx) => {
        capturedCtx = ctx;
        return { success: true, data: 'ok' };
      },
    };

    const manifest = makeManifest({
      entity_enrichment: { param: 'contacts', default: 'caller' },
    });
    registry.register(manifest, handler);

    const assembler = makeMockAssembler({ entities: [sampleEntityContext], unresolved: [] });
    const execution = new ExecutionLayer(registry, logger, {
      entityContextAssembler: assembler,
    });

    const caller = { contactId: 'caller-contact', role: 'ceo', channel: 'cli' };
    // No 'contacts' in input — should fall back to caller.contactId
    await execution.invoke('test-skill', {}, caller);

    expect(vi.mocked(assembler.assembleMany)).toHaveBeenCalledWith(['caller-contact'], { includeRelationships: true });
    expect(capturedCtx?.entityContext).toHaveLength(1);
  });

  it('uses agentContactId as default when default=agent', async () => {
    let capturedCtx: SkillContext | undefined;

    const handler: SkillHandler = {
      execute: async (ctx) => {
        capturedCtx = ctx;
        return { success: true, data: 'ok' };
      },
    };

    const manifest = makeManifest({
      entity_enrichment: { param: 'contacts', default: 'agent' },
    });
    registry.register(manifest, handler);

    const assembler = makeMockAssembler({ entities: [sampleEntityContext], unresolved: [] });
    const execution = new ExecutionLayer(registry, logger, {
      entityContextAssembler: assembler,
      agentContactId: 'agent-contact-id',
    });

    // No 'contacts' in input — should fall back to agentContactId
    await execution.invoke('test-skill', {});

    expect(vi.mocked(assembler.assembleMany)).toHaveBeenCalledWith(['agent-contact-id'], { includeRelationships: true });
    expect(capturedCtx?.entityContext).toBeDefined();
  });

  it('skips pre-enrichment when no assembler is configured', async () => {
    let capturedCtx: SkillContext | undefined;

    const handler: SkillHandler = {
      execute: async (ctx) => {
        capturedCtx = ctx;
        return { success: true, data: 'ok' };
      },
    };

    const manifest = makeManifest({
      entity_enrichment: { param: 'contacts', default: 'caller' },
    });
    registry.register(manifest, handler);

    // No assembler passed to ExecutionLayer
    const execution = new ExecutionLayer(registry, logger);
    await execution.invoke('test-skill', { contacts: ['contact-1'] });

    // Handler still runs but ctx.entityContext is not populated
    expect(capturedCtx?.entityContext).toBeUndefined();
  });

  it('does not call assembler when skill has no entity_enrichment declaration', async () => {
    const handler: SkillHandler = {
      execute: async () => ({ success: true, data: 'ok' }),
    };

    // No entity_enrichment in manifest
    registry.register(makeManifest(), handler);

    const assembler = makeMockAssembler({ entities: [], unresolved: [] });
    const execution = new ExecutionLayer(registry, logger, {
      entityContextAssembler: assembler,
    });

    await execution.invoke('test-skill', { contacts: ['contact-1'] });

    expect(vi.mocked(assembler.assembleMany)).not.toHaveBeenCalled();
  });

  it('continues handler invocation when assembler throws (non-fatal)', async () => {
    let handlerCalled = false;

    const handler: SkillHandler = {
      execute: async () => {
        handlerCalled = true;
        return { success: true, data: 'ok' };
      },
    };

    const manifest = makeManifest({
      entity_enrichment: { param: 'contacts', default: 'caller' },
    });
    registry.register(manifest, handler);

    const flakyAssembler = {
      assembleMany: vi.fn().mockRejectedValue(new Error('DB timeout')),
      assembleOne: vi.fn(),
      clearCacheForEntity: vi.fn(),
    } as unknown as EntityContextAssembler;

    const execution = new ExecutionLayer(registry, logger, {
      entityContextAssembler: flakyAssembler,
    });

    const caller = { contactId: 'caller-contact', role: 'ceo', channel: 'cli' };
    const result = await execution.invoke('test-skill', {}, caller);

    // Handler still runs despite assembler failure
    expect(handlerCalled).toBe(true);
    expect(result.success).toBe(true);
  });

  it('includes unresolved IDs in a debug log but does not fail the skill', async () => {
    const handler: SkillHandler = {
      execute: async () => ({ success: true, data: 'ok' }),
    };

    const manifest = makeManifest({
      entity_enrichment: { param: 'contacts', default: 'caller' },
    });
    registry.register(manifest, handler);

    const assembler = makeMockAssembler({
      entities: [],
      unresolved: ['ghost-id'],
    });
    const execution = new ExecutionLayer(registry, logger, {
      entityContextAssembler: assembler,
    });

    const result = await execution.invoke('test-skill', { contacts: ['ghost-id'] });
    // Skill should still succeed even if the entity wasn't found
    expect(result.success).toBe(true);
  });

  it('exposes agentContactId on ctx for all skills', async () => {
    let capturedCtx: SkillContext | undefined;

    const handler: SkillHandler = {
      execute: async (ctx) => {
        capturedCtx = ctx;
        return { success: true, data: 'ok' };
      },
    };
    registry.register(makeManifest(), handler);

    const execution = new ExecutionLayer(registry, logger, {
      agentContactId: 'agent-123',
    });
    await execution.invoke('test-skill', {});

    expect(capturedCtx?.agentContactId).toBe('agent-123');
  });
});
