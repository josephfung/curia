import { describe, it, expect, vi } from 'vitest';
import { ContextBridgeReleaseHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { TaskRepo } from '../../src/db/task-repo.js';
import pino from 'pino';

const handler = new ContextBridgeReleaseHandler();
const TASK_ID = '00000000-0000-4000-8000-000000000001';
const ENTRY_ID = '00000000-0000-4000-8000-000000000002';

function makeCtx(input: Record<string, unknown>, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input,
    secret: vi.fn((name: string) => { throw new Error(`Missing secret: ${name}`); }),
    log: pino({ level: 'silent' }),
    outboundContext: {
      register: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
      releaseEntry: vi.fn().mockResolvedValue(undefined),
      getEntry: vi.fn().mockResolvedValue(null),
      clearBySubjects: vi.fn(),
      defaultExpiryHours: 6,
      explicitExpiryHours: 24,
    },
    ...overrides,
  } as unknown as ToolContext;
}

describe('ContextBridgeReleaseHandler', () => {
  it('calls releaseEntry with the provided entry_id', async () => {
    const ctx = makeCtx({ entry_id: 'abc-123' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.releaseEntry).toHaveBeenCalledWith('abc-123');
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
    const ctx = makeCtx({ entry_id: 'abc-123' });
    (ctx as unknown as Record<string, unknown>).outboundContext = undefined;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outboundContext/);
    }
  });

  it('returns error when releaseEntry throws', async () => {
    const ctx = makeCtx({ entry_id: 'abc-123' });
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
          defaultExpiryHours: 6,
          explicitExpiryHours: 24,
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
          defaultExpiryHours: 6,
          explicitExpiryHours: 24,
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
          defaultExpiryHours: 6,
          explicitExpiryHours: 24,
        },
      },
    );

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect(ctx.outboundContext!.releaseEntry).not.toHaveBeenCalled();
  });
});
