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
import { TempFileStore } from './temp-file-store.js';
import type { SkillHandler, SkillManifest, SkillResult, SkillContext } from './types.js';
import type { EventBus } from '../bus/bus.js';
import type { OutboundGateway } from './outbound-gateway.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { AutonomyService, AutonomyConfig } from '../autonomy/autonomy-service.js';
import type { SecretsService } from '../secrets/secrets-service.js';
import type { ApprovalTriggerService, ApprovalRequestResult } from '../autonomy/approval-trigger.js';

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

/** Build a stub AutonomyService that returns a fixed config. */
function makeAutonomyService(score: number): AutonomyService {
  const config: AutonomyConfig = {
    score,
    band: score >= 90 ? 'full' : score >= 80 ? 'spot-check' : score >= 70 ? 'approval-required' : score >= 60 ? 'draft-only' : 'restricted',
    updatedAt: new Date(),
    updatedBy: 'test',
  };
  return {
    getConfig: vi.fn().mockResolvedValue(config),
  } as unknown as AutonomyService;
}

/** Build a manifest with a specific action_risk. */
function makeRiskyManifest(name: string, actionRisk: 'none' | 'low' | 'medium' | 'high' | 'critical'): SkillManifest {
  return {
    name,
    description: `${name} description`,
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: actionRisk,
    inputs: {},
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 5000,
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
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
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
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
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
      execute: vi.fn(async (): Promise<SkillResult> => ({ success: true, data: 'ok' })),
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

  it('injects writeTempFile for skills declaring tempFileStore capability', async () => {
    // Use a temp dir under /tmp so TempFileStore.init() can create it without
    // needing the production /run/curia-tempfiles mount to be present.
    const tempFileStore = new TempFileStore({
      dir: `/tmp/curia-test-tempfiles-${Date.now()}`,
      sweepIntervalMs: 0, // Disable auto-sweep so the test doesn't leave timers running
    });
    await tempFileStore.init();

    const registry = new SkillRegistry();
    let capturedCtx: SkillContext | undefined;
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
        capturedCtx = ctx;
        return { success: true, data: 'ok' };
      }),
    };
    registry.register(makeCapManifest('upload-attachment', ['tempFileStore']), handler);

    const layer = new ExecutionLayer(registry, logger, { tempFileStore });

    await layer.invoke('upload-attachment', {});

    // writeTempFile should be injected as a callable closure — not the raw store
    expect(typeof capturedCtx?.writeTempFile).toBe('function');

    await tempFileStore.shutdown();
  });

  it('does NOT inject writeTempFile for skills without tempFileStore capability', async () => {
    // Wire a real TempFileStore into the layer but register the skill WITHOUT the capability.
    // This proves the gate is enforced — not just that nothing was wired.
    const gatingStore = new TempFileStore({
      dir: `/tmp/curia-test-tempfiles-gate-${Date.now()}`,
      sweepIntervalMs: 0,
    });
    await gatingStore.init();

    const registry = new SkillRegistry();
    let capturedCtx: SkillContext | undefined;
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
        capturedCtx = ctx;
        return { success: true, data: 'ok' };
      }),
    };
    // Register with empty capabilities — no tempFileStore declared
    registry.register(makeCapManifest('search-docs', []), handler);

    // ExecutionLayer HAS tempFileStore, but skill did not declare the capability
    const layer = new ExecutionLayer(registry, logger, { tempFileStore: gatingStore });

    await layer.invoke('search-docs', {});

    // writeTempFile must be absent — undeclared capabilities must not leak into ctx
    expect(capturedCtx?.writeTempFile).toBeUndefined();

    await gatingStore.shutdown();
  });
});

// ---------------------------------------------------------------------------
// taskMetadata pass-through
// ---------------------------------------------------------------------------

describe('taskMetadata pass-through', () => {
  it('passes taskMetadata to the skill context', async () => {
    const registry = new SkillRegistry();
    const layer = new ExecutionLayer(registry, logger);

    let capturedCtx: SkillContext | undefined;
    const capturingHandler: SkillHandler = {
      async execute(ctx) { capturedCtx = ctx; return { success: true, data: 'ok' }; },
    };

    // Register a test skill with the capturing handler
    registry.register(
      {
        name: 'test-meta',
        description: '',
        version: '1.0.0',
        sensitivity: 'normal',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        permissions: [],
        secrets: [],
        timeout: 5000,
      },
      capturingHandler,
    );

    await layer.invoke('test-meta', {}, undefined, {
      taskMetadata: { someFlag: true, extra: 'value' },
    });

    expect(capturedCtx?.taskMetadata).toEqual({ someFlag: true, extra: 'value' });
  });

  it('leaves taskMetadata undefined when options omit it', async () => {
    const registry = new SkillRegistry();
    const layer = new ExecutionLayer(registry, logger);

    let capturedCtx: SkillContext | undefined;
    const capturingHandler: SkillHandler = {
      async execute(ctx) { capturedCtx = ctx; return { success: true, data: 'ok' }; },
    };

    registry.register(
      {
        name: 'test-meta-absent',
        description: '',
        version: '1.0.0',
        sensitivity: 'normal',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        permissions: [],
        secrets: [],
        timeout: 5000,
      },
      capturingHandler,
    );

    await layer.invoke('test-meta-absent', {}, undefined, {});

    expect(capturedCtx?.taskMetadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Autonomy gates
// ---------------------------------------------------------------------------

describe('autonomy gates', () => {
  it('blocks skill when score is below action_risk threshold', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('should not run');
    registry.register(makeRiskyManifest('send-email', 'medium'), handler); // requires 70

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65), // below 70
      bus: mockBus,
    });

    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('autonomy');
      expect(result.error).toContain('70');
    }
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('allows skill when score meets action_risk threshold', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    registry.register(makeRiskyManifest('send-email', 'medium'), handler); // requires 70

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(75), // above 70
    });

    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(true);
  });

  it('always allows action_risk: none regardless of score', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    registry.register(makeRiskyManifest('search-docs', 'none'), handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(10), // very low
    });

    const result = await layer.invoke('search-docs', {});

    expect(result.success).toBe(true);
  });

  it('blocks all non-none skills when score < 60 (full restriction)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('should not run');
    registry.register(makeRiskyManifest('store-fact', 'low'), handler); // requires 60

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(55), // below 60
      bus: mockBus,
    });

    const result = await layer.invoke('store-fact', {});

    expect(result.success).toBe(false);
    if (!result.success) {
      // Gate A now uses buildGateError — message includes score and set-autonomy reference
      expect(result.error).toContain('55');
      expect(result.error).toContain('set-autonomy');
    }
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('emits autonomy.skill_blocked event when skill is blocked', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
    });

    await layer.invoke('send-email', {});

    expect(mockBus.publish).toHaveBeenCalledWith(
      'execution',
      expect.objectContaining({
        type: 'autonomy.skill_blocked',
        payload: expect.objectContaining({
          skillName: 'send-email',
          currentScore: 65,
          requiredScore: 70,
        }),
      }),
    );
  });

  it('skips gate when autonomyService is not wired (fail-open)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    registry.register(makeRiskyManifest('send-email', 'medium'), handler);

    // No autonomyService — gate should be skipped
    const layer = new ExecutionLayer(registry, logger);

    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(true);
  });

  it('exempts elevated skills from autonomy gate (prevents set-autonomy deadlock)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('score updated');
    const elevatedManifest: SkillManifest = {
      ...makeRiskyManifest('set-autonomy', 'high'), // requires 80
      sensitivity: 'elevated',
    };
    registry.register(elevatedManifest, handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65), // well below 80
    });

    // Must provide principal-originated taskMetadata for elevated skills —
    // the gate now checks originator.systemRole, not caller.role.
    const result = await layer.invoke('set-autonomy', { score: 90 }, {
      contactId: 'primary-user',
      role: 'ceo',
      channel: 'cli',
    }, {
      taskMetadata: {
        originator: {
          contactId: 'primary-user',
          systemRole: 'principal' as const,
          channel: 'cli',
          initiatedAt: new Date().toISOString(),
        },
      },
    });

    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('fails open when getConfig throws (DB error)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    registry.register(makeRiskyManifest('send-email', 'medium'), handler);

    const throwingService = {
      getConfig: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as AutonomyService;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: throwingService,
    });

    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('skips gate when getConfig returns null (pre-migration)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    registry.register(makeRiskyManifest('send-email', 'medium'), handler);

    const nullService = {
      getConfig: vi.fn().mockResolvedValue(null),
    } as unknown as AutonomyService;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: nullService,
    });

    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(true);
  });

  it('skips gates A and B when task is principal-originated (Gate B territory)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    // calendar-create-event uses action_risk: 'high' → requires score 80. Score 74 would normally block.
    registry.register(makeRiskyManifest('calendar-create-event', 'high'), handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(74),
    });

    const result = await layer.invoke('calendar-create-event', {}, undefined, {
      taskMetadata: {
        originator: {
          contactId: 'ceo-contact-id',
          systemRole: 'principal' as const,
          channel: 'email',
          initiatedAt: new Date().toISOString(),
        },
      },
    });

    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('skips gates A and B when task is principal-originated (Gate A territory)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    // score 50 triggers Gate A (< 60 blocks all non-none) and Gate B (50 < 70 threshold for medium) —
    // principal should bypass both
    registry.register(makeRiskyManifest('send-email', 'medium'), handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(50),
    });

    const result = await layer.invoke('send-email', {}, undefined, {
      taskMetadata: {
        originator: {
          contactId: 'ceo-contact-id',
          systemRole: 'principal' as const,
          channel: 'email',
          initiatedAt: new Date().toISOString(),
        },
      },
    });

    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('does NOT bypass gates for agent-originated tasks', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('should not run');
    registry.register(makeRiskyManifest('calendar-create-event', 'high'), handler); // requires 80

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(74), // below 80 — should block non-principal
      bus: mockBus,
    });

    const result = await layer.invoke('calendar-create-event', {}, undefined, {
      taskMetadata: {
        originator: {
          contactId: 'agent-contact-id',
          systemRole: 'agent' as const,
          channel: 'internal',
          initiatedAt: new Date().toISOString(),
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Gate B fired — error should reference the autonomy score and the required threshold (80)
      expect(result.error).toContain('autonomy');
      expect(result.error).toContain('80');
    }
    expect(handler.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// humanApproved bypass tests
// ---------------------------------------------------------------------------

describe('humanApproved on InvokeOptions', () => {
  it('skips autonomy gates when humanApproved is true', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('approved result');
    registry.register(makeRiskyManifest('calendar-create-event', 'high'), handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65), // well below any threshold
    });

    const result = await layer.invoke('calendar-create-event', {}, undefined, {
      humanApproved: true,
    });

    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('still enforces elevated-skill gate when humanApproved is true', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('should not run');
    // Make a manifest with sensitivity: 'elevated' — the elevated gate is NOT bypassed
    const manifest: SkillManifest = {
      ...makeRiskyManifest('approve-action', 'high'),
      sensitivity: 'elevated',
    };
    registry.register(manifest, handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
    });

    // humanApproved but no CEO caller context — elevated gate should still block
    const result = await layer.invoke('approve-action', {}, undefined, {
      humanApproved: true,
    });

    expect(result.success).toBe(false);
    expect(handler.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Approval trigger on gate block tests
// ---------------------------------------------------------------------------

function makeApprovalTrigger(result: ApprovalRequestResult): ApprovalTriggerService {
  return {
    request: vi.fn().mockResolvedValue(result),
  } as unknown as ApprovalTriggerService;
}

describe('approval trigger on gate block', () => {
  it('Gate B calls trigger and enriches error with shortRef when notification sent', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: true, shortRef: 'email-1', notificationSent: true });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      approvalTrigger: trigger,
    });

    const result = await layer.invoke('send-email', { to: 'a@b.com' }, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('email-1');
      expect(result.error).toContain('approval request has been sent');
    }
    expect(trigger.request).toHaveBeenCalledOnce();
  });

  it('Gate A calls trigger and enriches error with shortRef', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('store-fact', 'low'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: true, shortRef: 'mem-1', notificationSent: true });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(55), // triggers Gate A (< 60)
      bus: mockBus,
      approvalTrigger: trigger,
    });

    const result = await layer.invoke('store-fact', { label: 'test' }, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('mem-1');
      expect(result.error).toContain('approval request has been sent');
    }
    expect(trigger.request).toHaveBeenCalledOnce();
  });

  it('returns duplicate message when trigger finds existing pending row', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: false, reason: 'duplicate', existingShortRef: 'email-1' });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      approvalTrigger: trigger,
    });

    const result = await layer.invoke('send-email', { to: 'a@b.com' }, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('already pending');
      expect(result.error).toContain('email-1');
    }
  });

  it('includes notification failure note when notificationSent is false', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: true, shortRef: 'email-1', notificationSent: false });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      approvalTrigger: trigger,
    });

    const result = await layer.invoke('send-email', {}, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('notification could not be delivered');
    }
  });

  it('falls back to existing error when trigger is not wired', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      // No approvalTrigger
    });

    const result = await layer.invoke('send-email', {}, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Original message — no approval ref
      expect(result.error).toContain('set-autonomy');
      expect(result.error).not.toContain('approval request');
    }
  });

  it('falls back to existing error when taskEventId is missing (Gate B path)', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: true, shortRef: 'email-1', notificationSent: true });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      approvalTrigger: trigger,
    });

    // No taskEventId in options
    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('set-autonomy');
    }
    expect(trigger.request).not.toHaveBeenCalled();
  });

  it('falls back to existing error when taskEventId is missing (Gate A path)', async () => {
    // Gate A triggers when score < 60 and action_risk !== 'none'
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('store-fact', 'low'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: true, shortRef: 'mem-1', notificationSent: true });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(55), // below 60 — Gate A triggers
      bus: mockBus,
      approvalTrigger: trigger,
    });

    // No taskEventId — trigger should not be called
    const result = await layer.invoke('store-fact', { label: 'test' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('set-autonomy');
    }
    expect(trigger.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// allowed_callers gate
// ---------------------------------------------------------------------------

describe('allowed_callers gate', () => {
  it('blocks invocation when agentId is not in allowed_callers', async () => {
    const registry = new SkillRegistry();
    const manifest = { ...makeManifest('restricted-skill'), allowed_callers: ['coordinator'] };
    registry.register(manifest, makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    const result = await layer.invoke('restricted-skill', { query: 'test' }, undefined, {
      agentId: 'research-analyst',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('restricted');
      expect(result.error).toContain('coordinator');
    }
  });

  it('allows invocation when agentId is in allowed_callers', async () => {
    const registry = new SkillRegistry();
    const manifest = { ...makeManifest('restricted-skill'), allowed_callers: ['coordinator'] };
    registry.register(manifest, makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    const result = await layer.invoke('restricted-skill', { query: 'test' }, undefined, {
      agentId: 'coordinator',
    });

    expect(result.success).toBe(true);
  });

  it('allows any agent when allowed_callers is undefined', async () => {
    const registry = new SkillRegistry();
    registry.register(makeManifest('open-skill'), makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    const result = await layer.invoke('open-skill', { query: 'test' }, undefined, {
      agentId: 'any-agent',
    });

    expect(result.success).toBe(true);
  });

  it('allows any agent when allowed_callers is empty array', async () => {
    const registry = new SkillRegistry();
    const manifest = { ...makeManifest('open-skill'), allowed_callers: [] as string[] };
    registry.register(manifest, makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    const result = await layer.invoke('open-skill', { query: 'test' }, undefined, {
      agentId: 'any-agent',
    });

    expect(result.success).toBe(true);
  });

  it('falls back to "system" when agentId is undefined (checkpoint processor path)', async () => {
    const registry = new SkillRegistry();
    const manifest = { ...makeManifest('system-skill'), allowed_callers: ['system'] };
    registry.register(manifest, makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    // No options → agentId is undefined → falls back to 'system'
    const result = await layer.invoke('system-skill', { query: 'test' });

    expect(result.success).toBe(true);
  });

  it('skips allowed_callers check when humanApproved is set (CEO-authorized re-execution)', async () => {
    const registry = new SkillRegistry();
    const manifest = { ...makeManifest('restricted-skill'), allowed_callers: ['coordinator'] };
    registry.register(manifest, makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    // research-analyst is NOT in allowed_callers, but humanApproved bypasses the gate
    const result = await layer.invoke('restricted-skill', { query: 'test' }, undefined, {
      agentId: 'research-analyst',
      humanApproved: true,
    });

    expect(result.success).toBe(true);
  });

  it('blocks system invocation when "system" is not in allowed_callers', async () => {
    const registry = new SkillRegistry();
    const manifest = { ...makeManifest('agent-only'), allowed_callers: ['coordinator'] };
    registry.register(manifest, makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    // No options → falls back to 'system', which is not in the list
    const result = await layer.invoke('agent-only', { query: 'test' });

    expect(result.success).toBe(false);
  });

  it('allows CEO-approved re-execution with no agentId (approve-action path)', async () => {
    const registry = new SkillRegistry();
    // Mirrors a governance skill restricted to coordinator only
    const manifest = { ...makeManifest('governance-skill'), allowed_callers: ['coordinator'] };
    registry.register(manifest, makeHandler('ok'));
    const layer = new ExecutionLayer(registry, logger);

    // approve-action re-invokes with humanApproved: true but no agentId — this is
    // the real code path used when a CEO approves a held governance action.
    // Without humanApproved, no-agentId falls back to 'system' which is not in
    // allowed_callers and would be blocked. With humanApproved, the gate is bypassed.
    const result = await layer.invoke('governance-skill', { query: 'test' }, undefined, {
      humanApproved: true,
      // agentId deliberately omitted — matches approve-action handler behaviour
    });

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// skillSearch filtering by allowed_callers
// ---------------------------------------------------------------------------

describe('skillSearch filters by allowed_callers', () => {
  it('hides skills whose allowed_callers excludes the querying agent', async () => {
    const registry = new SkillRegistry();

    // Open skill — no allowed_callers
    registry.register(makeManifest('public-skill'), makeHandler('ok'));

    // Restricted skill — coordinator only. Name must contain 'skill' so the
    // search query matches it — otherwise the assertion passes trivially because
    // the skill doesn't match the query, not because the filter excluded it.
    const restricted = { ...makeManifest('restricted-skill'), allowed_callers: ['coordinator'] };
    registry.register(restricted, makeHandler('ok'));

    // Searcher skill — has skillSearch capability, called by research-analyst
    const searcher = {
      ...makeManifest('searcher'),
      capabilities: ['skillSearch'],
    };
    const searchResults: Array<{ name: string }> = [];
    const searcherHandler: SkillHandler = {
      execute: async (ctx: SkillContext) => {
        const results = ctx.skillSearch!('skill');
        searchResults.push(...results);
        return { success: true, data: results };
      },
    };
    registry.register(searcher, searcherHandler);

    const layer = new ExecutionLayer(registry, logger);

    await layer.invoke('searcher', {}, undefined, { agentId: 'research-analyst' });

    // research-analyst should see public-skill but NOT coordinator-only
    const names = searchResults.map(r => r.name);
    expect(names).toContain('public-skill');
    expect(names).not.toContain('restricted-skill');
  });
});

// ---------------------------------------------------------------------------
// secret resolution: vault-first with env fallback + audit source tag
// ---------------------------------------------------------------------------
describe('ctx.secret resolution', () => {
  // Manifest that declares a secret and a handler that reads it.
  function makeSecretManifest(name: string, secretKey: string): SkillManifest {
    return { ...makeManifest(name), secrets: [secretKey] };
  }
  function makeSecretReadingHandler(secretKey: string): { handler: SkillHandler; read: () => string | undefined } {
    let read: string | undefined;
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
        read = (ctx as SkillContext).secret(secretKey);
        return { success: true, data: 'ok' };
      }),
    };
    return { handler, read: () => read };
  }
  // publish must return a resolved promise — the closure calls .catch() on it.
  function makeBus(): EventBus {
    return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
  }

  it('reads from the vault when present and tags source=vault', async () => {
    const registry = new SkillRegistry();
    const { handler, read } = makeSecretReadingHandler('tavily_api_key');
    registry.register(makeSecretManifest('vault-skill', 'tavily_api_key'), handler);
    const secretsService = { get: vi.fn().mockResolvedValue('from-vault') } as unknown as SecretsService;
    const bus = makeBus();
    const layer = new ExecutionLayer(registry, logger, { bus, secretsService });

    const result = await layer.invoke('vault-skill', {}, undefined, { agentId: 'agent-1' });

    expect(result.success).toBe(true);
    expect(read()).toBe('from-vault');
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[1]).find(e => e.type === 'secret.accessed');
    expect(event.payload.source).toBe('vault');
  });

  it('falls back to env when the vault has no entry and tags source=env', async () => {
    const registry = new SkillRegistry();
    const { handler, read } = makeSecretReadingHandler('tavily_api_key');
    registry.register(makeSecretManifest('env-skill', 'tavily_api_key'), handler);
    const secretsService = { get: vi.fn().mockResolvedValue(null) } as unknown as SecretsService;
    const bus = makeBus();
    process.env.TAVILY_API_KEY = 'from-env';
    try {
      const layer = new ExecutionLayer(registry, logger, { bus, secretsService });
      const result = await layer.invoke('env-skill', {});
      expect(result.success).toBe(true);
      expect(read()).toBe('from-env');
      const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
        .map(c => c[1]).find(e => e.type === 'secret.accessed');
      expect(event.payload.source).toBe('env');
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it('works with no secretsService wired (env-only, current behavior)', async () => {
    const registry = new SkillRegistry();
    const { handler, read } = makeSecretReadingHandler('tavily_api_key');
    registry.register(makeSecretManifest('legacy-skill', 'tavily_api_key'), handler);
    process.env.TAVILY_API_KEY = 'legacy-env';
    try {
      const layer = new ExecutionLayer(registry, logger, { bus: makeBus() });
      const result = await layer.invoke('legacy-skill', {});
      expect(result.success).toBe(true);
      expect(read()).toBe('legacy-env');
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it('throws (in-handler) when an undeclared secret is requested', async () => {
    const registry = new SkillRegistry();
    let caught: string | undefined;
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
        try { (ctx as SkillContext).secret('not_declared'); }
        catch (e) { caught = (e as Error).message; }
        return { success: true, data: 'ok' };
      }),
    };
    registry.register(makeSecretManifest('decl-skill', 'tavily_api_key'), handler);
    const layer = new ExecutionLayer(registry, logger, { bus: makeBus() });
    await layer.invoke('decl-skill', {});
    expect(caught).toMatch(/not declared in the manifest/);
  });

  it('throws (in-handler) when a declared secret is set nowhere', async () => {
    const registry = new SkillRegistry();
    let caught: string | undefined;
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx): Promise<SkillResult> => {
        try { (ctx as SkillContext).secret('tavily_api_key'); }
        catch (e) { caught = (e as Error).message; }
        return { success: true, data: 'ok' };
      }),
    };
    registry.register(makeSecretManifest('missing-skill', 'tavily_api_key'), handler);
    const secretsService = { get: vi.fn().mockResolvedValue(null) } as unknown as SecretsService;
    delete process.env.TAVILY_API_KEY;
    const layer = new ExecutionLayer(registry, logger, { bus: makeBus(), secretsService });
    await layer.invoke('missing-skill', {});
    expect(caught).toMatch(/declared but not set/);
  });
});
