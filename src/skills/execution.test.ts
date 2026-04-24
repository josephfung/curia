// execution.test.ts — unit tests for ExecutionLayer.getToolDefinitions and the
// discover → invoke round-trip introduced in spec §03 / issue #291.
//
// These tests verify that:
//   1. getToolDefinitions delegates to the registry and returns correct schemas
//   2. Unknown skill names are silently skipped
//   3. Skills returned by skill-registry can have their tool defs retrieved and
//      then be invoked — the full discover → call path works end-to-end with mocks
//   4. Capability-gated service injection: only declared services reach ctx

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { SkillRegistry } from './registry.js';
import { ExecutionLayer } from './execution.js';
import type { SkillHandler, SkillManifest } from './types.js';
import type { EventBus } from '../bus/bus.js';
import type { OutboundGateway } from './outbound-gateway.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';

const logger = pino({ level: 'silent' });

/** Minimal manifest for a normal read-only skill. */
function makeManifest(name: string, description = `${name} description`): SkillManifest {
  return {
    name,
    description,
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: 'none',
    inputs: { query: 'string (search term)' },
    outputs: { result: 'string' },
    permissions: [],
    secrets: [],
    timeout: 5000,
  };
}

/** Handler that always returns success with the given data. */
function makeHandler(data: unknown): SkillHandler {
  return {
    execute: vi.fn().mockResolvedValue({ success: true, data }),
  };
}

// ---------------------------------------------------------------------------
// getToolDefinitions
// ---------------------------------------------------------------------------

describe('ExecutionLayer.getToolDefinitions', () => {
  it('returns tool definitions for registered skills', () => {
    const registry = new SkillRegistry();
    registry.register(makeManifest('search-docs', 'Search Google Docs'), makeHandler('ok'));
    registry.register(makeManifest('search-drive', 'Search Google Drive'), makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    const defs = layer.getToolDefinitions(['search-docs', 'search-drive']);

    expect(defs).toHaveLength(2);
    expect(defs.map(d => d.name)).toEqual(['search-docs', 'search-drive']);
    expect(defs[0]!.description).toBe('Search Google Docs');
    expect(defs[0]!.input_schema.type).toBe('object');
    expect(defs[0]!.input_schema.properties).toHaveProperty('query');
  });

  it('silently skips unknown skill names', () => {
    const registry = new SkillRegistry();
    registry.register(makeManifest('real-skill'), makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    const defs = layer.getToolDefinitions(['real-skill', 'does-not-exist']);

    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('real-skill');
  });

  it('returns an empty array when no names match', () => {
    const registry = new SkillRegistry();
    const layer = new ExecutionLayer(registry, logger);

    const defs = layer.getToolDefinitions(['ghost-skill']);

    expect(defs).toEqual([]);
  });

  it('passes MCP input schema through directly', () => {
    const registry = new SkillRegistry();
    const mcpSchema = {
      type: 'object' as const,
      properties: { fileId: { type: 'string', description: 'The Drive file ID' } },
      required: ['fileId'],
    };
    registry.register(makeManifest('get-file'), makeHandler('ok'), mcpSchema);
    const layer = new ExecutionLayer(registry, logger);

    const defs = layer.getToolDefinitions(['get-file']);

    expect(defs).toHaveLength(1);
    expect(defs[0]!.input_schema).toEqual(mcpSchema);
  });
});

// ---------------------------------------------------------------------------
// Discover → invoke round-trip
// ---------------------------------------------------------------------------

describe('discover → invoke round-trip', () => {
  it('skills surfaced by skill-registry can be retrieved via getToolDefinitions then invoked', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler({ content: 'document content' });
    registry.register(makeManifest('get_doc_content', 'Get the content of a Google Doc'), handler);

    const layer = new ExecutionLayer(registry, logger);

    // Step 1: simulate what skill-registry returns for this skill
    const discoveredSkills = [{ name: 'get_doc_content', description: 'Get the content of a Google Doc' }];

    // Step 2: runtime calls getToolDefinitions with the discovered names
    const defs = layer.getToolDefinitions(discoveredSkills.map(s => s.name));
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('get_doc_content');

    // Step 3: LLM uses the tool def to call the skill — invoke it
    const result = await layer.invoke('get_doc_content', { query: 'budget doc' });

    expect(result.success).toBe(true);
    expect((result as { success: true; data: unknown }).data).toEqual({ content: 'document content' });
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('skills not in pinned list but discoverable are accessible after getToolDefinitions', () => {
    const registry = new SkillRegistry();
    // Register several skills — only one is "pinned" (in the initial tool list)
    registry.register(makeManifest('pinned-skill'), makeHandler('pinned'));
    registry.register(makeManifest('search_drive_files', 'Search Drive'), makeHandler('found'));
    registry.register(makeManifest('get_doc_content', 'Get Doc'), makeHandler('doc'));

    const pinnedDefs = registry.toToolDefinitions(['pinned-skill']);
    expect(pinnedDefs).toHaveLength(1);

    const layer = new ExecutionLayer(registry, logger);

    // skill-registry discovers the non-pinned skills
    const discovered = [
      { name: 'search_drive_files' },
      { name: 'get_doc_content' },
    ];

    // getToolDefinitions produces the full schemas for them
    const newDefs = layer.getToolDefinitions(discovered.map(s => s.name));
    expect(newDefs).toHaveLength(2);
    expect(newDefs.map(d => d.name)).toEqual(['search_drive_files', 'get_doc_content']);

    // Combined list matches what the runtime would produce for the next LLM call
    const expandedDefs = [...pinnedDefs, ...newDefs];
    expect(expandedDefs).toHaveLength(3);
    expect(expandedDefs.map(d => d.name)).toContain('search_drive_files');
    expect(expandedDefs.map(d => d.name)).toContain('get_doc_content');
  });
});

// ---------------------------------------------------------------------------
// Capability-gated service injection
// ---------------------------------------------------------------------------

describe('capability-gated service injection', () => {
  /** Manifest that declares specific capabilities. */
  function makeCapManifest(name: string, capabilities: string[]): SkillManifest {
    return {
      name,
      description: `${name} description`,
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'none',
      inputs: {},
      outputs: {},
      permissions: [],
      secrets: [],
      timeout: 5000,
      capabilities,
    };
  }

  it('injects only declared capabilities into context', async () => {
    const registry = new SkillRegistry();
    // Handler captures the context it received so we can inspect it
    let capturedCtx: Record<string, unknown> = {};
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx) => {
        capturedCtx = ctx as unknown as Record<string, unknown>;
        return { success: true, data: 'ok' };
      }),
    };
    registry.register(makeCapManifest('outbound-only', ['outboundGateway']), handler);

    const mockGateway = { send: vi.fn() } as unknown as OutboundGateway;
    const mockBus = { publish: vi.fn() } as unknown as EventBus;
    const mockScheduler = { createJob: vi.fn() } as unknown as SchedulerService;

    const layer = new ExecutionLayer(registry, logger, {
      outboundGateway: mockGateway,
      bus: mockBus,
      schedulerService: mockScheduler,
    });

    await layer.invoke('outbound-only', {});

    // Should have outboundGateway — it was declared
    expect(capturedCtx.outboundGateway).toBe(mockGateway);
    // Should NOT have bus or schedulerService — not declared in capabilities
    expect(capturedCtx.bus).toBeUndefined();
    expect(capturedCtx.schedulerService).toBeUndefined();
  });

  it('injects no privileged services when capabilities is empty', async () => {
    const registry = new SkillRegistry();
    let capturedCtx: Record<string, unknown> = {};
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx) => {
        capturedCtx = ctx as unknown as Record<string, unknown>;
        return { success: true, data: 'ok' };
      }),
    };
    registry.register(makeCapManifest('no-caps', []), handler);

    const mockBus = { publish: vi.fn() } as unknown as EventBus;
    const mockGateway = { send: vi.fn() } as unknown as OutboundGateway;

    const layer = new ExecutionLayer(registry, logger, {
      bus: mockBus,
      outboundGateway: mockGateway,
    });

    await layer.invoke('no-caps', {});

    // No privileged services should be injected — capabilities is empty
    expect(capturedCtx.bus).toBeUndefined();
    expect(capturedCtx.outboundGateway).toBeUndefined();
  });

  it('returns skill error when declared capability is not available on ExecutionLayer', async () => {
    const registry = new SkillRegistry();
    const handler: SkillHandler = {
      execute: vi.fn(async () => ({ success: true, data: 'ok' })),
    };
    registry.register(makeCapManifest('needs-scheduler', ['schedulerService']), handler);

    // ExecutionLayer constructed WITHOUT schedulerService
    const layer = new ExecutionLayer(registry, logger);

    const result = await layer.invoke('needs-scheduler', {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('schedulerService');
    }
    // Handler should NOT have been called — fail-closed
    expect(handler.execute).not.toHaveBeenCalled();
  });
});
