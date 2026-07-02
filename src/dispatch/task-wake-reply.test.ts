// src/dispatch/task-wake-reply.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import {
  buildTaskWakeAutoBridge,
  isTaskWakeReplyBinding,
  persistInboundTaskWakeReply,
  TASK_WAKE_BIND_REPLY_KEY,
  TASK_WAKE_DELEGATION_HINT,
  TASK_WAKE_REPLY_TTL_HOURS,
  TASK_WAKE_TASK_ID_KEY,
} from './task-wake-reply.js';
import type { OutboundContextRow } from './outbound-context.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { OutboundContextService } from './outbound-context.js';

const logger = pino({ level: 'silent' });

function makeEntry(overrides: Partial<OutboundContextRow> = {}): OutboundContextRow {
  return {
    id: 'entry-1',
    conversationId: 'scheduler:job:run',
    channelId: 'signal',
    agentId: 'coordinator',
    contentPreview: 'What are the confirmed camp dates?',
    expectedReply: "CEO's reply to: What are the confirmed camp dates?",
    delegationHint: TASK_WAKE_DELEGATION_HINT,
    metadata: {
      [TASK_WAKE_BIND_REPLY_KEY]: true,
      [TASK_WAKE_TASK_ID_KEY]: 'task-abc',
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
    it('includes delegation hint, expected reply, metadata, and long TTL', () => {
      const bridge = buildTaskWakeAutoBridge({
        taskId: 'f9e9a0d9',
        agentId: 'coordinator',
        messageContent: 'Please confirm the camp session dates.',
      });

      expect(bridge.agent_id).toBe('coordinator');
      expect(bridge.delegation_hint).toBe(TASK_WAKE_DELEGATION_HINT);
      expect(bridge.expected_reply).toContain('camp session dates');
      expect(bridge.metadata).toEqual({ bind_reply: true, task_id: 'f9e9a0d9' });
      expect(bridge.expires_in_hours).toBe(TASK_WAKE_REPLY_TTL_HOURS);
    });
  });

  describe('persistInboundTaskWakeReply', () => {
    let taskRepo: TaskRepo;
    let outboundContextService: OutboundContextService;

    beforeEach(() => {
      taskRepo = {
        getTask: vi.fn().mockResolvedValue({
          id: 'task-abc',
          status: 'waiting',
          owner: 'ceo',
        }),
        updateTask: vi.fn().mockResolvedValue({ id: 'task-abc' }),
      } as unknown as TaskRepo;
      outboundContextService = {
        release: vi.fn().mockResolvedValue(undefined),
      } as unknown as OutboundContextService;
    });

    it('no-ops for non-principal senders', async () => {
      const result = await persistInboundTaskWakeReply({
        principalReply: 'July 26 to August 22',
        activeEntries: [makeEntry()],
        taskRepo,
        outboundContextService,
        logger,
        isPrincipal: false,
      });

      expect(result.persisted).toBe(false);
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
    });

    it('persists CEO reply to bound task and releases the outbound entry', async () => {
      const result = await persistInboundTaskWakeReply({
        principalReply: 'Four weeks, July 26 to August 22.',
        activeEntries: [makeEntry()],
        taskRepo,
        outboundContextService,
        logger,
        isPrincipal: true,
      });

      expect(result).toEqual({ persisted: true, taskId: 'task-abc', entryId: 'entry-1' });
      expect(taskRepo.updateTask).toHaveBeenCalledWith(
        'task-abc',
        expect.objectContaining({
          progressNote: expect.stringContaining('Four weeks'),
          owner: 'curia',
          status: 'in_progress',
        }),
        'coordinator',
      );
      expect(outboundContextService.release).toHaveBeenCalledWith('entry-1');
    });

    it('ignores entries without task-wake binding metadata', async () => {
      const result = await persistInboundTaskWakeReply({
        principalReply: 'Yes',
        activeEntries: [makeEntry({ metadata: { subject: 'standup' } })],
        taskRepo,
        outboundContextService,
        logger,
        isPrincipal: true,
      });

      expect(result.persisted).toBe(false);
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
    });
  });
});
