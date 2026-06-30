import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBus } from '../bus/bus.js';
import type { ExecutionLayer } from '../skills/execution.js';
import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import { createTaskCompleted } from '../bus/events.js';
import type { TaskRow } from '../db/queries/tasks.js';
import {
  DeliverableKgPromotionSubscriber,
  isKgPromotionDisabled,
  promoteDeliverableToKg,
  resolveKgPromotionConfig,
} from './deliverable-kg-promotion.js';

const PARENT_ID = '00000000-0000-4000-8000-00000000aa01';
const CHILD_DELIVERABLE = '00000000-0000-4000-8000-00000000bb01';
const CHILD_WORKLOG = '00000000-0000-4000-8000-00000000bb02';

function makeParent(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: PARENT_ID,
    agentId: 'coordinator',
    sourceAgentId: 'coordinator',
    conversationId: 'conv-1',
    title: 'Kickoff plan',
    description: null,
    status: 'done',
    progress: {
      plan: {
        steps: [
          { id: 'worklog', taskId: CHILD_WORKLOG },
          { id: 'deliverable', taskId: CHILD_DELIVERABLE },
        ],
        deliverableStepId: 'deliverable',
        done: 2,
        total: 2,
        next: 'Done',
      },
    },
    errorBudget: {},
    intentAnchor: '',
    owner: '',
    waitingOnContactId: null,
    waitingOnText: null,
    parentTaskId: null,
    blockedByTaskId: null,
    priority: 0,
    dueAt: null,
    source: 'agent',
    createdBy: 'agent',
    tags: [],
    originator: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

describe('deliverable-kg-promotion (#1241)', () => {
  it('resolveKgPromotionConfig applies defaults', () => {
    expect(resolveKgPromotionConfig()).toEqual({
      enabled: true,
      maxFacts: 50,
      maxRelationships: 50,
    });
    expect(resolveKgPromotionConfig({ enabled: false, maxFacts: 10 })).toEqual({
      enabled: false,
      maxFacts: 10,
      maxRelationships: 50,
    });
  });

  it('isKgPromotionDisabled respects global and per-task flags', () => {
    const config = resolveKgPromotionConfig();
    expect(isKgPromotionDisabled({ errorBudget: {} }, config)).toBe(false);
    expect(isKgPromotionDisabled({ errorBudget: { kg_promotion: false } }, config)).toBe(true);
    expect(isKgPromotionDisabled({ errorBudget: {} }, { ...config, enabled: false })).toBe(true);
  });

  it('promotes deliverable text with caps and archives workspace docs', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { extracted: 2, confirmed: 1 } })
      .mockResolvedValueOnce({ success: true, data: { stored: 3, redirected: 0 } });
    const executionLayer = { invoke } as unknown as ExecutionLayer;
    const archiveProjectWorkspaceDocs = vi.fn().mockResolvedValue(2);
    const workingDocsRepo = { archiveProjectWorkspaceDocs } as unknown as WorkingDocsRepo;
    const getTask = vi.fn(async (id: string) => {
      if (id === CHILD_DELIVERABLE) {
        return {
          ...makeParent(),
          id: CHILD_DELIVERABLE,
          title: 'Synthesis',
          progress: { notes: [{ at: 't', note: 'Final curated deliverable' }] },
        };
      }
      if (id === CHILD_WORKLOG) {
        return {
          ...makeParent(),
          id: CHILD_WORKLOG,
          title: 'Findings',
          errorBudget: { resumable: true },
          progress: { notes: [{ at: 't', note: '1300 row worklog' }] },
        };
      }
      return null;
    });
    const taskRepo = {
      getTask,
      resolveProjectRootTaskId: vi.fn().mockResolvedValue(PARENT_ID),
    } as unknown as TaskRepo;

    const result = await promoteDeliverableToKg({
      task: makeParent(),
      parentEventId: 'evt-parent',
      taskRepo,
      workingDocsRepo,
      executionLayer,
      config: resolveKgPromotionConfig({ maxFacts: 5, maxRelationships: 7 }),
      logger: makeLogger(),
    });

    expect(result.promoted).toBe(true);
    expect(result.factsStored).toBe(3);
    expect(result.relationshipsStored).toBe(3);
    expect(result.archivedDocs).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]![1]).toMatchObject({
      text: 'Final curated deliverable',
      max_stored: 7,
    });
    expect(invoke.mock.calls[1]![1]).toMatchObject({
      text: 'Final curated deliverable',
      max_stored: 5,
    });
    expect(archiveProjectWorkspaceDocs).toHaveBeenCalledWith(PARENT_ID);
  });

  it('is non-fatal when extraction skills fail', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('relationships blew up'))
      .mockResolvedValueOnce({ success: false, error: 'facts failed' });
    const executionLayer = { invoke } as unknown as ExecutionLayer;
    const archiveProjectWorkspaceDocs = vi.fn().mockResolvedValue(1);
    const workingDocsRepo = { archiveProjectWorkspaceDocs } as unknown as WorkingDocsRepo;
    const getTask = vi.fn(async (id: string) => {
      if (id === CHILD_DELIVERABLE) {
        return {
          ...makeParent(),
          id: CHILD_DELIVERABLE,
          progress: { notes: [{ at: 't', note: 'Deliverable text' }] },
        };
      }
      return null;
    });
    const taskRepo = {
      getTask,
      resolveProjectRootTaskId: vi.fn().mockResolvedValue(PARENT_ID),
    } as unknown as TaskRepo;
    const logger = makeLogger();

    const result = await promoteDeliverableToKg({
      task: makeParent(),
      parentEventId: 'evt-parent',
      taskRepo,
      workingDocsRepo,
      executionLayer,
      config: resolveKgPromotionConfig(),
      logger,
    });

    expect(result.promoted).toBe(true);
    expect(result.errors).toHaveLength(2);
    expect(archiveProjectWorkspaceDocs).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('skips promotion when disabled via error_budget but still archives workspace docs', async () => {
    const invoke = vi.fn();
    const archiveProjectWorkspaceDocs = vi.fn().mockResolvedValue(2);
    const result = await promoteDeliverableToKg({
      task: makeParent({ errorBudget: { kg_promotion: false } }),
      parentEventId: 'evt-parent',
      taskRepo: {
        getTask: vi.fn(),
        resolveProjectRootTaskId: vi.fn().mockResolvedValue(PARENT_ID),
      } as unknown as TaskRepo,
      workingDocsRepo: { archiveProjectWorkspaceDocs } as unknown as WorkingDocsRepo,
      executionLayer: { invoke } as unknown as ExecutionLayer,
      config: resolveKgPromotionConfig(),
      logger: makeLogger(),
    });
    expect(result).toEqual({ promoted: false, reason: 'disabled', archivedDocs: 2 });
    expect(invoke).not.toHaveBeenCalled();
    expect(archiveProjectWorkspaceDocs).toHaveBeenCalledWith(PARENT_ID);
  });

  describe('DeliverableKgPromotionSubscriber', () => {
    let subscribeHandlers: Map<string, (event: unknown) => Promise<void>>;

    beforeEach(() => {
      subscribeHandlers = new Map();
    });

    it('runs promotion on task.completed for planned parents', async () => {
      const bus = {
        subscribe: vi.fn((eventType: string, _layer: string, handler: (e: unknown) => Promise<void>) => {
          subscribeHandlers.set(eventType, handler);
        }),
      } as unknown as EventBus;
      const invoke = vi.fn()
        .mockResolvedValueOnce({ success: true, data: { extracted: 0, confirmed: 0 } })
        .mockResolvedValueOnce({ success: true, data: { stored: 0, redirected: 0 } });
      const getTask = vi.fn(async (id: string) => {
        if (id === PARENT_ID) return makeParent();
        if (id === CHILD_DELIVERABLE) {
          return {
            ...makeParent(),
            id: CHILD_DELIVERABLE,
            progress: { notes: [{ at: 't', note: 'Done' }] },
          };
        }
        return null;
      });
      const taskRepo = {
        getTask,
        resolveProjectRootTaskId: vi.fn().mockResolvedValue(PARENT_ID),
      } as unknown as TaskRepo;
      const workingDocsRepo = {
        archiveProjectWorkspaceDocs: vi.fn().mockResolvedValue(0),
      } as unknown as WorkingDocsRepo;

      const subscriber = new DeliverableKgPromotionSubscriber({
        bus,
        taskRepo,
        workingDocsRepo,
        executionLayer: { invoke } as unknown as ExecutionLayer,
        config: resolveKgPromotionConfig(),
        logger: makeLogger(),
      });
      subscriber.start();

      const handler = subscribeHandlers.get('task.completed');
      expect(handler).toBeDefined();
      await handler!(createTaskCompleted({ taskId: PARENT_ID, completionNote: 'Done', agentId: 'coordinator' }));

      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledTimes(2);
      });
    });

    it('ignores task.completed without a plan block', async () => {
      const bus = {
        subscribe: vi.fn((eventType: string, _layer: string, handler: (e: unknown) => Promise<void>) => {
          subscribeHandlers.set(eventType, handler);
        }),
      } as unknown as EventBus;
      const invoke = vi.fn();
      const getTask = vi.fn().mockResolvedValue({
        ...makeParent(),
        progress: {},
      });
      const subscriber = new DeliverableKgPromotionSubscriber({
        bus,
        taskRepo: { getTask } as unknown as TaskRepo,
        workingDocsRepo: { archiveProjectWorkspaceDocs: vi.fn() } as unknown as WorkingDocsRepo,
        executionLayer: { invoke } as unknown as ExecutionLayer,
        config: resolveKgPromotionConfig(),
        logger: makeLogger(),
      });
      subscriber.start();
      await subscribeHandlers.get('task.completed')!(
        createTaskCompleted({ taskId: PARENT_ID, completionNote: 'Done', agentId: 'coordinator' }),
      );
      expect(invoke).not.toHaveBeenCalled();
    });
  });
});
