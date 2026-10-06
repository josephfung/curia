// A timed-out delegation must not be queued again. A brief that never dispatched must be.

import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import type { TaskRepo } from '../../../src/db/task-repo.js';
import { createLogger } from '../../../src/logger.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';
import type { ToolResult } from '../../../src/skills/types.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import { DEFAULT_DEFERRED_WAKE_MS } from '../../../src/agents/deferred-delegation.js';

const PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

const ORIGINATOR: TaskOriginator = {
  contactId: 'contact-1',
  systemRole: 'principal',
  channel: 'signal',
  initiatedAt: '2026-09-24T00:00:00.000Z',
  tier: 'principal',
};

const DELEGATE_TOOL = {
  name: 'delegate',
  description: 'Delegate',
  input_schema: {
    type: 'object' as const,
    properties: { agent: { type: 'string' }, task: { type: 'string' } },
    required: ['agent', 'task'],
  },
};

function providerReturning(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  seen?: unknown[][],
): LLMProvider {
  let callCount = 0;
  return {
    id: 'mock',
    chat: async (params: { messages: unknown[] }) => {
      callCount += 1;
      seen?.push(params.messages);
      if (callCount === 1) {
        return {
          type: 'tool_use' as const,
          toolCalls,
          usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: PROVENANCE,
        };
      }
      return {
        type: 'text' as const,
        content: 'Told the user.',
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: PROVENANCE,
      };
    },
  };
}

function timeoutData(agent: string): ToolResult {
  return {
    success: true,
    data: {
      agent,
      failed: true,
      reason: 'timeout',
      retryable: false,
      possibly_succeeded: true,
      message: `Specialist '${agent}' did not respond within the delegate wait window — the task may still be running`,
      delegate_event_id: 'delegate-timeout',
      delegate_conversation_id: 'delegate-conv',
      wait_timeout_ms: 1000,
    },
  };
}

function inFlightData(agent: string): ToolResult {
  return {
    success: true,
    data: {
      agent,
      in_flight: true,
      blocked: true,
      reason: 'already_in_flight',
      retryable: false,
      delegate_event_id: 'delegate-open',
      open_handle_age_ms: 10,
      message: `Specialist '${agent}' is already working on an open request in this conversation.`,
    },
  };
}

async function runTurn(opts: {
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  invoke: ExecutionLayer['invoke'];
  metadata?: Record<string, unknown>;
  defaultDelegateTimeoutMs?: number;
  lateDeliveryTtlMinutes?: number;
  lateDeliverySweepIntervalMinutes?: number;
  agentRegistry?: AgentRegistry;
  /** Make the task insert throw, as a database outage would. */
  createTaskFails?: boolean;
}): Promise<{
  createTask: ReturnType<typeof vi.fn>;
  toolResultData: () => Record<string, unknown>;
  auditedDelegateData: () => Record<string, unknown>;
}> {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  const createTask = vi.fn(async () => {
    if (opts.createTaskFails) throw new Error('db down');
    return { id: 'task-queued' };
  });
  const seen: unknown[][] = [];
  // The tool.result audit events, as the audit logger would record them.
  const audited: Array<{ toolName: string; result: { success: boolean; data?: unknown } }> = [];
  bus.subscribe('tool.result', 'system', async (event) => {
    audited.push((event as unknown as { payload: (typeof audited)[number] }).payload);
  });
  const taskRepo = { createTask } as unknown as TaskRepo;
  const execution = { invoke: vi.fn(opts.invoke) } as unknown as ExecutionLayer;
  const runtime = new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are the coordinator.',
    provider: providerReturning(opts.toolCalls, seen),
    resolvedModel: 'mock-model',
    bus,
    logger,
    executionLayer: execution,
    taskRepo,
    skillToolDefs: [DELEGATE_TOOL],
    ...(opts.defaultDelegateTimeoutMs !== undefined && {
      defaultDelegateTimeoutMs: opts.defaultDelegateTimeoutMs,
    }),
    ...(opts.lateDeliveryTtlMinutes !== undefined && {
      lateDeliveryTtlMinutes: opts.lateDeliveryTtlMinutes,
    }),
    ...(opts.lateDeliverySweepIntervalMinutes !== undefined && {
      lateDeliverySweepIntervalMinutes: opts.lateDeliverySweepIntervalMinutes,
    }),
    ...(opts.agentRegistry !== undefined && { agentRegistry: opts.agentRegistry }),
  });
  runtime.register();
  await bus.publish('dispatch', createAgentTask({
    agentId: 'coordinator',
    conversationId: 'signal:+15551212',
    channelId: 'signal',
    senderId: '+15551212',
    content: 'Book the meetings',
    metadata: opts.metadata ?? { originator: ORIGINATOR },
    parentEventId: 'inbound-1',
  }));
  // The first tool result the model was sent back, as data.
  const toolResultData = (): Record<string, unknown> => {
    const followUp = JSON.stringify(seen[1] ?? []);
    const m = /\{\\"agent\\".*?\\"in_flight\\".*?\}/.exec(followUp);
    if (!m) throw new Error(`no in-flight tool result in the follow-up call: ${followUp.slice(0, 500)}`);
    return JSON.parse(JSON.parse(`"${m[0]}"`)) as Record<string, unknown>;
  };
  const auditedDelegateData = (): Record<string, unknown> => {
    const delegate = audited.find(a => a.toolName === 'delegate');
    if (!delegate) throw new Error('no tool.result audit event for delegate');
    return delegate.result.data as Record<string, unknown>;
  };
  return { createTask, toolResultData, auditedDelegateData };
}

describe('runtime deferred delegation (#1893)', () => {
  it('does not queue a retry when the delegation timed out', async () => {
    const { createTask } = await runTurn({
      toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Book Monday' } }],
      invoke: async (name) => {
        if (name === 'task-create') return { success: true, data: { task_id: 'review-1' } };
        return timeoutData('calendar');
      },
    });

    expect(createTask).not.toHaveBeenCalled();
  });

  it('queues an already_in_flight brief on the originating conversation', async () => {
    const { createTask } = await runTurn({
      toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Book Tuesday' } }],
      invoke: async () => inFlightData('calendar'),
    });

    expect(createTask).toHaveBeenCalledOnce();
    const params = createTask.mock.calls[0]![0] as {
      description: string;
      originator: TaskOriginator;
      wakePayload: { delegationRetry: { conversationId: string; brief: string; attempt: number } };
    };
    expect(params.description).toBe('Book Tuesday');
    expect(params.originator).toEqual(ORIGINATOR);
    expect(params.wakePayload.delegationRetry.conversationId).toBe('signal:+15551212');
    expect(params.wakePayload.delegationRetry.brief).toBe('Book Tuesday');
    expect(params.wakePayload.delegationRetry.attempt).toBe(1);
  });

  // #1958 review: the model is told whether the brief was really saved, so it never
  // promises a queued run the platform did not record.
  it('tells the model the in-flight brief was queued', async () => {
    const { toolResultData } = await runTurn({
      toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Book Tuesday' } }],
      invoke: async () => inFlightData('calendar'),
    });
    expect(toolResultData()['queued']).toBe(true);
  });

  // #1958 review: the audit trail records the result the model acted on, not an earlier copy.
  it.each([
    ['queued', {}, true],
    ['not queued', { createTaskFails: true }, false],
  ])('records the same queued outcome on the tool.result audit event (%s)', async (_label, extra, expected) => {
    const { toolResultData, auditedDelegateData } = await runTurn({
      toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Book Tuesday' } }],
      invoke: async () => inFlightData('calendar'),
      ...extra,
    });
    expect(auditedDelegateData()['queued']).toBe(expected);
    expect(toolResultData()['queued']).toBe(expected);
  });

  it.each([
    ['the retry cap is reached', { metadata: { originator: ORIGINATOR, delegationRetry: { attempt: 3, targetAgent: 'calendar' } } }],
    ['the task insert fails', { createTaskFails: true }],
  ])('tells the model the brief was not queued when %s', async (_label, extra) => {
    const { toolResultData } = await runTurn({
      toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Book Tuesday' } }],
      invoke: async () => inFlightData('calendar'),
      ...extra,
    });
    expect(toolResultData()['queued']).toBe(false);
  });

  it('queues a skipped later brief and not the one that timed out', async () => {
    const { createTask } = await runTurn({
      toolCalls: [
        { id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Book Monday' } },
        { id: 'call-2', name: 'delegate', input: { agent: 'calendar', task: 'Book Tuesday' } },
      ],
      invoke: async (name) => {
        if (name === 'task-create') return { success: true, data: { task_id: 'review-1' } };
        return timeoutData('calendar');
      },
    });

    expect(createTask).toHaveBeenCalledOnce();
    const params = createTask.mock.calls[0]![0] as { description: string };
    expect(params.description).toBe('Book Tuesday');
  });

  it('stops queueing once the retry cap is reached', async () => {
    const { createTask } = await runTurn({
      toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Book Tuesday' } }],
      invoke: async () => inFlightData('calendar'),
      metadata: {
        originator: ORIGINATOR,
        delegationRetry: { attempt: 3, targetAgent: 'calendar' },
      },
    });

    expect(createTask).not.toHaveBeenCalled();
  });

  it('uses the handler floor when no delegate wait is configured (#1857)', async () => {
    const before = Date.now();
    const { createTask } = await runTurn({
      toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Book Tuesday' } }],
      invoke: async () => inFlightData('calendar'),
    });

    const params = createTask.mock.calls[0]![0] as { wakeAt: Date };
    expect(params.wakeAt.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_DEFERRED_WAKE_MS);
    expect(params.wakeAt.getTime()).toBeLessThan(before + DEFAULT_DEFERRED_WAKE_MS + 5_000);
  });

  it('does not wake earlier than the configured delegate wait', async () => {
    const before = Date.now();
    const { createTask } = await runTurn({
      toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Book Tuesday' } }],
      invoke: async () => inFlightData('calendar'),
      defaultDelegateTimeoutMs: 240_000,
    });

    const params = createTask.mock.calls[0]![0] as { wakeAt: Date };
    expect(params.wakeAt.getTime()).toBeGreaterThanOrEqual(before + 240_000);
    expect(params.wakeAt.getTime()).toBeLessThan(before + 240_000 + 5_000);
  });

  it('does not let a short specialist pull a later retry below the configured wait', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('research', {
      role: 'specialist',
      description: 'Research',
      expectedDurationSeconds: 30,
    });
    agentRegistry.register('calendar', { role: 'specialist', description: 'Calendar' });
    const before = Date.now();
    const { createTask } = await runTurn({
      toolCalls: [
        { id: 'call-1', name: 'delegate', input: { agent: 'research', task: 'Look up the venue' } },
        { id: 'call-2', name: 'delegate', input: { agent: 'calendar', task: 'Reserve the room' } },
      ],
      invoke: async (name) => {
        if (name === 'task-create') return { success: true, data: { task_id: 'review-1' } };
        return timeoutData('research');
      },
      defaultDelegateTimeoutMs: 240_000,
      agentRegistry,
    });

    expect(createTask).toHaveBeenCalledOnce();
    const params = createTask.mock.calls[0]![0] as { description: string; wakeAt: Date };
    expect(params.description).toBe('Reserve the room');
    expect(params.wakeAt.getTime()).toBeGreaterThanOrEqual(before + 240_000);
    expect(params.wakeAt.getTime()).toBeLessThan(before + 240_000 + 5_000);
  });

  it('wakes a pending-handle block after the handle expires, not on the delegate wait', async () => {
    const before = Date.now();
    const expiresAt = new Date(before + 50 * 60_000);
    const { createTask } = await runTurn({
      toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Reserve the room' } }],
      invoke: async () => ({
        success: true,
        data: {
          agent: 'calendar',
          in_flight: true,
          blocked: true,
          reason: 'already_in_flight',
          retryable: false,
          delegate_event_id: 'delegate-open',
          open_handle_age_ms: 10 * 60_000,
          handle_status: 'pending',
          handle_expires_at: expiresAt.toISOString(),
          message: "Specialist 'calendar' is already working on an open request in this conversation.",
        },
      }),
      defaultDelegateTimeoutMs: 240_000,
      lateDeliveryTtlMinutes: 60,
      lateDeliverySweepIntervalMinutes: 5,
    });

    const params = createTask.mock.calls[0]![0] as { wakeAt: Date };
    const expected = expiresAt.getTime() + 5 * 60_000;
    expect(params.wakeAt.getTime()).toBeGreaterThanOrEqual(expected - 1_000);
    expect(params.wakeAt.getTime()).toBeLessThan(expected + 5_000);
    expect(params.wakeAt.getTime()).toBeGreaterThan(before + 240_000);
  });

  it('wakes a same-specialist skip after the late-delivery window, not the delegate wait', async () => {
    const before = Date.now();
    const { createTask } = await runTurn({
      toolCalls: [
        { id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Reserve the first room' } },
        { id: 'call-2', name: 'delegate', input: { agent: 'calendar', task: 'Reserve the second room' } },
      ],
      invoke: async (name) => {
        if (name === 'task-create') return { success: true, data: { task_id: 'review-1' } };
        return timeoutData('calendar');
      },
      defaultDelegateTimeoutMs: 240_000,
      lateDeliveryTtlMinutes: 60,
      lateDeliverySweepIntervalMinutes: 5,
    });

    expect(createTask).toHaveBeenCalledOnce();
    const params = createTask.mock.calls[0]![0] as { description: string; wakeAt: Date };
    expect(params.description).toBe('Reserve the second room');
    expect(params.wakeAt.getTime()).toBeGreaterThanOrEqual(before + 65 * 60_000 - 1_000);
    expect(params.wakeAt.getTime()).toBeLessThan(before + 65 * 60_000 + 5_000);
  });

  it('uses the delegate wait when a specialist reports timeout and no handle was opened', async () => {
    const before = Date.now();
    const reported = timeoutData('calendar');
    if (reported.success) {
      const data = reported.data as Record<string, unknown>;
      delete data['delegate_event_id'];
      delete data['delegate_conversation_id'];
      delete data['wait_timeout_ms'];
    }
    const { createTask } = await runTurn({
      toolCalls: [
        { id: 'call-1', name: 'delegate', input: { agent: 'calendar', task: 'Reserve the first room' } },
        { id: 'call-2', name: 'delegate', input: { agent: 'calendar', task: 'Reserve the second room' } },
      ],
      invoke: async (name) => {
        if (name === 'task-create') return { success: true, data: { task_id: 'review-1' } };
        return reported;
      },
      defaultDelegateTimeoutMs: 240_000,
      lateDeliveryTtlMinutes: 60,
      lateDeliverySweepIntervalMinutes: 5,
    });

    expect(createTask).toHaveBeenCalledOnce();
    const params = createTask.mock.calls[0]![0] as { description: string; wakeAt: Date };
    expect(params.description).toBe('Reserve the second room');
    expect(params.wakeAt.getTime()).toBeGreaterThanOrEqual(before + 240_000);
    expect(params.wakeAt.getTime()).toBeLessThan(before + 240_000 + 5_000);
  });
});
