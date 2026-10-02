import { describe, it, expect, vi } from 'vitest';
import { ContextBridgeReleaseHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { TaskRepo } from '../../../../src/db/task-repo.js';
import pino from 'pino';
import { AgentRegistry } from '../../../../src/agents/agent-registry.js';

const handler = new ContextBridgeReleaseHandler();
const TASK_ID = '00000000-0000-4000-8000-000000000001';
const ENTRY_ID = '00000000-0000-4000-8000-000000000002';

/** The roster ownership is resolved against (#1972). */
const agentRegistry = new AgentRegistry();
agentRegistry.register('coordinator', { role: 'coordinator', description: 'router' });
agentRegistry.register('ceo-inbox', { role: 'specialist', description: 'inbox' });
agentRegistry.register('calendar', { role: 'specialist', description: 'calendar' });
agentRegistry.register('research-analyst', { role: 'specialist', description: 'research' });

function makeCtx(input: Record<string, unknown>, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input,
    agentRegistry,
    secret: vi.fn((name: string) => { throw new Error(`Missing secret: ${name}`); }),
    log: pino({ level: 'silent' }),
    outboundContext: {
      register: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
      releaseEntry: vi.fn().mockResolvedValue(undefined),
      getEntry: vi.fn().mockResolvedValue(null),
      clearBySubjects: vi.fn(),
      markExchangeOpen: vi.fn(),
      releaseUnlessKeptOpen: vi.fn(),
      defaultExpiryHours: 6,
      explicitExpiryHours: 24,
      defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
    },
    ...overrides,
  } as unknown as ToolContext;
}

describe('ContextBridgeReleaseHandler', () => {
  it('calls releaseEntry with the provided entry_id', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
  });

  it('rejects a bare slug before querying and names the context block', async () => {
    const slug = 'review-possible-duplicate-jim-miller-josephine-miller';
    const ctx = makeCtx({ entry_id: slug });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(slug);
      expect(result.error).toContain('[ACTIVE OUTBOUND CONTEXT]');
      expect(result.error).toMatch(/nothing to release/);
      expect(result.error).not.toMatch(/invalid input syntax|22P02|postgres/i);
    }
    expect(ctx.outboundContext!.getEntry).not.toHaveBeenCalled();
    expect(ctx.outboundContext!.releaseEntry).not.toHaveBeenCalled();
  });

  it('rejects a composite dedup key that merely contains UUIDs', async () => {
    const composite =
      'dedup:43b23faa-064b-496a-917a-b250f1f3e0e3:4a682c1d-1111-4222-8333-b250f1f3e0e3';
    const ctx = makeCtx({ entry_id: composite });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(composite);
      expect(result.error).toContain('[ACTIVE OUTBOUND CONTEXT]');
      expect(result.error).toMatch(/not an entry_id/);
      expect(result.error).not.toMatch(/invalid input syntax|22P02|postgres/i);
    }
    expect(ctx.outboundContext!.getEntry).not.toHaveBeenCalled();
    expect(ctx.outboundContext!.releaseEntry).not.toHaveBeenCalled();
  });

  it('returns not-found for a valid UUID with no active entry', async () => {
    const unknownId = '592797c3-064b-496a-917a-b250f1f3e0e3';
    const ctx = makeCtx({ entry_id: unknownId, reply: 'July 26 to Aug 22' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('outbound context entry not found or already released');
    }
    expect(ctx.outboundContext!.getEntry).toHaveBeenCalledWith(unknownId);
    expect(ctx.outboundContext!.releaseEntry).not.toHaveBeenCalled();
  });

  it('returns error when entry_id is missing', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/entry_id/);
    }
  });

  it('returns error when outboundContext capability is missing', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID });
    (ctx as unknown as Record<string, unknown>).outboundContext = undefined;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outboundContext/);
    }
  });

  it('returns error when releaseEntry throws', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID });
    (ctx.outboundContext!.releaseEntry as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB error'),
    );

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Failed to release/);
    }
  });

  it('persists task-wake reply and releases when reply is provided for a binding', async () => {
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue({ id: TASK_ID, status: 'waiting', owner: 'ceo' }),
      updateTask: vi.fn().mockResolvedValue({ id: TASK_ID }),
    } as unknown as TaskRepo;

    const ctx = makeCtx(
      { entry_id: ENTRY_ID, reply: 'July 26 to Aug 22' },
      {
        taskRepo,
        outboundContext: {
          register: vi.fn(),
          release: vi.fn(),
          releaseEntry: vi.fn().mockResolvedValue(undefined),
          getEntry: vi.fn().mockResolvedValue({
            id: ENTRY_ID,
            metadata: { bind_reply: true, task_id: TASK_ID },
          }),
          clearBySubjects: vi.fn(),
          markExchangeOpen: vi.fn(),
          releaseUnlessKeptOpen: vi.fn(),
          defaultExpiryHours: 6,
          explicitExpiryHours: 24,
          defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
        },
      },
    );

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(taskRepo.updateTask).toHaveBeenCalled();
    expect(ctx.outboundContext!.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
  });

  it('ignores reply on non-task-wake entries and releases normally', async () => {
    const logDebug = vi.fn();
    const ctx = makeCtx(
      { entry_id: ENTRY_ID, reply: 'some reply' },
      {
        log: pino({ level: 'silent' }),
        outboundContext: {
          register: vi.fn(),
          release: vi.fn(),
          releaseEntry: vi.fn().mockResolvedValue(undefined),
          getEntry: vi.fn().mockResolvedValue({
            id: ENTRY_ID,
            metadata: { subject: 'standup' },
          }),
          clearBySubjects: vi.fn(),
          markExchangeOpen: vi.fn(),
          releaseUnlessKeptOpen: vi.fn(),
          defaultExpiryHours: 6,
          explicitExpiryHours: 24,
          defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
        },
      },
    );
    ctx.log.debug = logDebug;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
    expect(logDebug).toHaveBeenCalledWith(
      { entryId: ENTRY_ID },
      'reply ignored — entry is not a task-wake binding',
    );
  });

  describe('entries owned by a specialist (#1972)', () => {
    /** ctx whose active entry carries `delegationHint` / `metadata`, invoked as `agentId`. */
    function ownedCtx(agentId: string, entry: { delegationHint: string | null; metadata?: Record<string, unknown> | null }) {
      const ctx = makeCtx({ entry_id: ENTRY_ID }, { agentId });
      (ctx.outboundContext!.getEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: ENTRY_ID, metadata: null, ...entry,
      });
      return ctx;
    }

    it('refuses the coordinator and tells it to pass the entry to delegate instead', async () => {
      const ctx = ownedCtx('coordinator', { delegationHint: 'ceo-inbox' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('ceo-inbox');
        expect(result.error).toContain('outbound_entry_id');
      }
      expect(ctx.outboundContext!.releaseEntry).not.toHaveBeenCalled();
    });

    it('refuses on the clarification-pending form too', async () => {
      const ctx = ownedCtx('coordinator', {
        delegationHint: 'research-analyst clarification pending',
        metadata: { resume_token: 'tok' },
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      expect(ctx.outboundContext!.releaseEntry).not.toHaveBeenCalled();
    });

    it('lets the owning specialist release its own entry', async () => {
      const ctx = ownedCtx('ceo-inbox', { delegationHint: 'ceo-inbox' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(ctx.outboundContext!.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
    });

    it('treats a legacy free-text hint as unowned, so the coordinator can still release it', async () => {
      // Rows registered before #1972 normalized hints live up to 72h.
      const ctx = ownedCtx('coordinator', { delegationHint: 'Delegate replies to ceo-inbox' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(ctx.outboundContext!.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
    });

    it('fails closed without the agent registry instead of skipping the ownership check', async () => {
      const ctx = ownedCtx('coordinator', { delegationHint: 'ceo-inbox' });
      (ctx as unknown as Record<string, unknown>).agentRegistry = undefined;
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      expect(ctx.outboundContext!.releaseEntry).not.toHaveBeenCalled();
    });

    it('still lets the coordinator release an entry with no hint', async () => {
      const ctx = ownedCtx('coordinator', { delegationHint: null });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(ctx.outboundContext!.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
    });

    it('still lets the coordinator release a hinted task-wake binding', async () => {
      // Task-wake bindings are the coordinator's to close: it judges whether the
      // principal answered the woken task's question (#1299).
      const ctx = ownedCtx('coordinator', {
        delegationHint: 'ceo-inbox',
        metadata: { bind_reply: true, task_id: TASK_ID },
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(ctx.outboundContext!.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
    });
  });

  it('returns error when reply is provided for a task-wake binding but taskRepo is missing', async () => {
    const ctx = makeCtx(
      { entry_id: ENTRY_ID, reply: 'answer' },
      {
        outboundContext: {
          register: vi.fn(),
          release: vi.fn(),
          releaseEntry: vi.fn(),
          getEntry: vi.fn().mockResolvedValue({
            id: ENTRY_ID,
            metadata: { bind_reply: true, task_id: TASK_ID },
          }),
          clearBySubjects: vi.fn(),
          markExchangeOpen: vi.fn(),
          releaseUnlessKeptOpen: vi.fn(),
          defaultExpiryHours: 6,
          explicitExpiryHours: 24,
          defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
        },
      },
    );

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect(ctx.outboundContext!.releaseEntry).not.toHaveBeenCalled();
  });
});
