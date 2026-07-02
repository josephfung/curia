// src/dispatch/task-wake-reply.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import {
  buildTaskWakeAutoBridge,
  isTaskWakeReplyBinding,
  recordTaskWakeReply,
  TASK_WAKE_BIND_REPLY_KEY,
  TASK_WAKE_REPLY_TTL_HOURS,
  TASK_WAKE_TASK_ID_KEY,
} from './task-wake-reply.js';
import type { OutboundContextRow } from './outbound-context.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { OutboundContextCapability } from './outbound-context.js';

const logger = pino({ level: 'silent' });
const TASK_ID = '00000000-0000-4000-8000-000000000001';
const ENTRY_ID = '00000000-0000-4000-8000-000000000002';

function makeEntry(overrides: Partial<OutboundContextRow> = {}): OutboundContextRow {
  return {
    id: ENTRY_ID,
    conversationId: 'scheduler:job:run',
    channelId: 'signal',
    agentId: 'coordinator',
    contentPreview: 'What are the confirmed camp dates?',
    expectedReply: "CEO's reply to: What are the confirmed camp dates?",
    delegationHint: null,
    metadata: {
      [TASK_WAKE_BIND_REPLY_KEY]: true,
      [TASK_WAKE_TASK_ID_KEY]: TASK_ID,
    },
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    released: false,
    ...overrides,
  };
}

describe('task-wake-reply', () => {
  describe('isTaskWakeReplyBinding', () => {
    it('returns true for bind_reply metadata with task_id', () => {
      expect(isTaskWakeReplyBinding({ bind_reply: true, task_id: 't1' })).toBe(true);
    });

    it('returns false when bind_reply or task_id is missing', () => {
      expect(isTaskWakeReplyBinding({ task_id: 't1' })).toBe(false);
      expect(isTaskWakeReplyBinding({ bind_reply: true })).toBe(false);
      expect(isTaskWakeReplyBinding(null)).toBe(false);
    });
  });

  describe('buildTaskWakeAutoBridge', () => {
    it('includes expected reply, metadata, and long TTL without delegation hint', () => {
      const bridge = buildTaskWakeAutoBridge({
        taskId: 'f9e9a0d9',
        agentId: 'coordinator',
        messageContent: 'Please confirm the camp session dates.',
      });

      expect(bridge.agent_id).toBe('coordinator');
      expect(bridge.delegation_hint).toBeUndefined();
      expect(bridge.expected_reply).toContain('camp session dates');
      expect(bridge.metadata).toEqual({ bind_reply: true, task_id: 'f9e9a0d9' });
      expect(bridge.expires_in_hours).toBe(TASK_WAKE_REPLY_TTL_HOURS);
    });
  });

  describe('recordTaskWakeReply', () => {
    let taskRepo: TaskRepo;
    let outboundContext: OutboundContextCapability;

    beforeEach(() => {
      taskRepo = {
        getTask: vi.fn().mockResolvedValue({
          id: TASK_ID,
          status: 'waiting',
          owner: 'ceo',
        }),
        updateTask: vi.fn().mockResolvedValue({ id: TASK_ID }),
      } as unknown as TaskRepo;
      outboundContext = {
        getEntry: vi.fn(),
        releaseEntry: vi.fn().mockResolvedValue(undefined),
        register: vi.fn(),
        release: vi.fn(),
        clearBySubjects: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
      };
    });

    it('records CEO reply using task_id from entry metadata and releases', async () => {
      const result = await recordTaskWakeReply({
        reply: 'Four weeks, July 26 to August 22.',
        entryId: ENTRY_ID,
        entry: makeEntry(),
        taskRepo,
        outboundContext,
        logger,
      });

      expect(result).toEqual({ persisted: true, taskId: TASK_ID, entryId: ENTRY_ID });
      expect(taskRepo.updateTask).toHaveBeenCalledWith(
        TASK_ID,
        expect.objectContaining({
          progressNote: expect.stringContaining('Four weeks'),
          owner: 'curia',
          status: 'in_progress',
        }),
        'coordinator',
      );
      expect(outboundContext.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
    });

    it('rejects entries without task-wake binding metadata', async () => {
      const result = await recordTaskWakeReply({
        reply: 'Yes',
        entryId: ENTRY_ID,
        entry: makeEntry({ metadata: { subject: 'standup' } }),
        taskRepo,
        outboundContext,
        logger,
      });

      expect(result.persisted).toBe(false);
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
    });

    it('releases the entry and does not persist when the bound task no longer exists', async () => {
      (taskRepo.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await recordTaskWakeReply({
        reply: 'Some answer',
        entryId: ENTRY_ID,
        entry: makeEntry(),
        taskRepo,
        outboundContext,
        logger,
      });

      expect(result.persisted).toBe(false);
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
      expect(outboundContext.releaseEntry).toHaveBeenCalledWith(ENTRY_ID);
    });

    it('returns persisted: false when the repo throws', async () => {
      (taskRepo.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
      const result = await recordTaskWakeReply({
        reply: 'Some answer',
        entryId: ENTRY_ID,
        entry: makeEntry(),
        taskRepo,
        outboundContext,
        logger,
      });

      expect(result.persisted).toBe(false);
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
      expect(outboundContext.releaseEntry).not.toHaveBeenCalled();
    });
  });
});
