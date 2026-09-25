// A retry wake that cannot be read back must not be written.

import { describe, it, expect, vi } from 'vitest';
import { DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS } from '../../../src/agents/delegate-timeout.js';
import {
  DEFAULT_DEFERRED_WAKE_MS,
  enqueueUndispatchedDelegation,
  pendingHandleWakeDelayMs,
} from '../../../src/agents/deferred-delegation.js';
import type { TaskRepo } from '../../../src/db/task-repo.js';
import { createLogger } from '../../../src/logger.js';

describe('DEFAULT_DEFERRED_WAKE_MS', () => {
  it('matches the handler fallback so an unset wait cannot wake early (#1857)', () => {
    expect(DEFAULT_DEFERRED_WAKE_MS).toBe(DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS);
  });
});

describe('enqueueUndispatchedDelegation', () => {
  it('refuses a wake whose channel or sender would not survive the fire-time read', async () => {
    const createTask = vi.fn();
    const taskRepo = { createTask } as unknown as TaskRepo;
    const result = await enqueueUndispatchedDelegation({
      taskRepo,
      logger: createLogger('error'),
      originAgentId: 'coordinator',
      originConversationId: 'signal:+15551212',
      originChannelId: '',
      originSenderId: '',
      targetAgent: 'calendar',
      brief: 'Reserve the room',
      wakeAt: new Date(Date.now() + 60_000),
      attempt: 1,
    });

    expect(result).toBe('unavailable');
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('pendingHandleWakeDelayMs', () => {
  const now = Date.parse('2026-09-24T00:00:00.000Z');

  it('waits out the blocking row and one sweep, not the delegate wait', () => {
    const expiresAt = new Date(now + 50 * 60_000);
    expect(pendingHandleWakeDelayMs({
      now,
      expiresAt,
      ttlMinutes: 60,
      sweepIntervalMs: 5 * 60_000,
    })).toBe(55 * 60_000);
  });

  it('uses the timeout subscriber expiry when the pending row is not written yet', () => {
    // max(60 min ttl, 2 × 40 min wait) + one 5 min sweep. ttl minus age would be shorter.
    expect(pendingHandleWakeDelayMs({
      now,
      ttlMinutes: 60,
      waitTimeoutMs: 40 * 60_000,
      sweepIntervalMs: 5 * 60_000,
    })).toBe(85 * 60_000);
  });
});
