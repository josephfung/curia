import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { TaskRecordReplyHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { TaskRepo } from '../../src/db/task-repo.js';
import type { OutboundContextCapability } from '../../src/dispatch/outbound-context.js';

const silentLog = pino({ level: 'silent' });
const TASK_ID = '00000000-0000-4000-8000-000000000001';
const ENTRY_ID = '00000000-0000-4000-8000-000000000002';

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    input: {},
    secret: () => 'unused',
    log: silentLog,
    agentId: 'coordinator',
    ...overrides,
  } as unknown as SkillContext;
}

describe('TaskRecordReplyHandler', () => {
  let taskRepo: TaskRepo;
  let outboundContext: OutboundContextCapability;

  beforeEach(() => {
    taskRepo = {
      getTask: vi.fn().mockResolvedValue({ id: TASK_ID, status: 'waiting', owner: 'ceo' }),
      updateTask: vi.fn().mockResolvedValue({ id: TASK_ID }),
    } as unknown as TaskRepo;
    outboundContext = {
      getEntry: vi.fn().mockResolvedValue({
        id: ENTRY_ID,
        metadata: { bind_reply: true, task_id: TASK_ID },
      }),
      releaseEntry: vi.fn().mockResolvedValue(undefined),
      register: vi.fn(),
      release: vi.fn(),
      clearBySubjects: vi.fn(),
      defaultExpiryHours: 6,
      explicitExpiryHours: 24,
    };
  });

  it('records reply and releases the binding', async () => {
    const result = await new TaskRecordReplyHandler().execute(makeCtx({
      input: { task_id: TASK_ID, entry_id: ENTRY_ID, reply: 'July 26 to Aug 22' },
      taskRepo,
      outboundContext,
    }));

    expect(result.success).toBe(true);
    expect(taskRepo.updateTask).toHaveBeenCalled();
    expect(outboundContext.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
  });

  it('rejects when entry task_id does not match', async () => {
    (outboundContext.getEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: ENTRY_ID,
      metadata: { bind_reply: true, task_id: '00000000-0000-4000-8000-000000009999' },
    });

    const result = await new TaskRecordReplyHandler().execute(makeCtx({
      input: { task_id: TASK_ID, entry_id: ENTRY_ID, reply: 'answer' },
      taskRepo,
      outboundContext,
    }));

    expect(result.success).toBe(false);
    expect(taskRepo.updateTask).not.toHaveBeenCalled();
    expect(outboundContext.releaseEntry).not.toHaveBeenCalled();
  });
});
