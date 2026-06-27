import { describe, it, expect } from 'vitest';
import { DelegateHandler } from '../../../skills/delegate/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import { EventBus } from '../../../src/bus/bus.js';

import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets needed'); },
    log: logger,
    ...overrides,
  };
}

describe('DelegateHandler', () => {
  const handler = new DelegateHandler();

  it('returns failure when bus is not available', async () => {
    const result = await handler.execute(makeCtx({ agent: 'research-analyst', task: 'do something' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('capabilities');
    }
  });

  it('returns failure when target agent does not exist', async () => {
    const agentRegistry = new AgentRegistry();
    const bus = new EventBus(logger);
    const result = await handler.execute(makeCtx(
      { agent: 'nonexistent', task: 'do something' },
      { bus, agentRegistry },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found');
    }
  });

  it('returns failure when trying to delegate to coordinator', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    const bus = new EventBus(logger);
    const result = await handler.execute(makeCtx(
      { agent: 'coordinator', task: 'do something' },
      { bus, agentRegistry },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cannot delegate to the coordinator');
    }
  });

  it('returns failure for missing required inputs', async () => {
    const agentRegistry = new AgentRegistry();
    const bus = new EventBus(logger);
    const result = await handler.execute(makeCtx(
      { agent: 'research-analyst' },
      { bus, agentRegistry },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('task');
    }
  });

  it('uses timeout_ms when provided as a valid positive integer', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research' });
    const bus = new EventBus(logger);

    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type === 'agent.task' && event.payload.agentId === 'research-analyst') {
        const { createAgentResponse } = await import('../../../src/bus/events.js');
        const response = createAgentResponse({
          agentId: 'research-analyst',
          conversationId: event.payload.conversationId,
          content: 'Done',
          parentEventId: event.id,
        });
        await bus.publish('agent', response);
      }
    });

    // Should succeed with an explicit timeout_ms of 5 minutes (300000ms)
    const result = await handler.execute(makeCtx(
      { agent: 'research-analyst', task: 'Long task', timeout_ms: 300000 },
      { bus, agentRegistry },
    ));
    expect(result.success).toBe(true);
  });

  it('falls back to default timeout when timeout_ms is invalid', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research' });
    const bus = new EventBus(logger);

    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type === 'agent.task' && event.payload.agentId === 'research-analyst') {
        const { createAgentResponse } = await import('../../../src/bus/events.js');
        const response = createAgentResponse({
          agentId: 'research-analyst',
          conversationId: event.payload.conversationId,
          content: 'Done',
          parentEventId: event.id,
        });
        await bus.publish('agent', response);
      }
    });

    // Invalid values (0, negative, non-integer) should fall back to default and still succeed
    for (const badTimeout of [0, -1, 1.5, NaN, Infinity, 'not-a-number', null]) {
      const result = await handler.execute(makeCtx(
        { agent: 'research-analyst', task: 'Task', timeout_ms: badTimeout },
        { bus, agentRegistry },
      ));
      expect(result.success).toBe(true);
    }
  });

  it('returns structured failure when specialist responds with isError and structured reason (#1170)', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research' });
    const bus = new EventBus(logger);

    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type === 'agent.task' && event.payload.agentId === 'research-analyst') {
        const { createAgentResponse } = await import('../../../src/bus/events.js');
        const response = createAgentResponse({
          agentId: 'research-analyst',
          conversationId: event.payload.conversationId,
          content: "I'm sorry, I was unable to process that request. Please try again.",
          isError: true,
          errorType: 'BUDGET_EXCEEDED',
          reason: 'maxTurns',
          retryable: false,
          parentEventId: event.id,
        });
        await bus.publish('agent', response);
      }
    });

    const result = await handler.execute(makeCtx(
      { agent: 'research-analyst', task: 'Research AI training costs', conversation_id: 'conv-2' },
      { bus, agentRegistry },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        agent: string;
        failed: boolean;
        reason: string;
        retryable: boolean;
        errorType: string;
        message: string;
      };
      expect(data.failed).toBe(true);
      expect(data.agent).toBe('research-analyst');
      expect(data.reason).toBe('maxTurns');
      expect(data.retryable).toBe(false);
      expect(data.errorType).toBe('BUDGET_EXCEEDED');
      expect(data.message).toContain('turn budget');
      expect(data.message).not.toContain('did not respond');
      expect(data.message).not.toContain('encountered an error');
    }
  });

  it('returns failure when specialist responds with isError: true', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research' });
    const bus = new EventBus(logger);

    // Simulate the runtime's sendErrorResponse path — isError: true means the specialist
    // hit an unrecoverable failure (context overflow, budget exhaustion, etc.)
    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type === 'agent.task' && event.payload.agentId === 'research-analyst') {
        const { createAgentResponse } = await import('../../../src/bus/events.js');
        const response = createAgentResponse({
          agentId: 'research-analyst',
          conversationId: event.payload.conversationId,
          content: "I'm sorry, I was unable to process that request. Please try again.",
          isError: true,
          parentEventId: event.id,
        });
        await bus.publish('agent', response);
      }
    });

    const result = await handler.execute(makeCtx(
      { agent: 'research-analyst', task: 'Research AI training costs', conversation_id: 'conv-2' },
      { bus, agentRegistry },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('encountered an error');
    }
  });

  it('propagates runtime BUDGET_EXCEEDED(maxTurns) to delegate result (#1170)', async () => {
    const { AgentRuntime } = await import('../../../src/agents/runtime.js');
    const { vi } = await import('vitest');
    type LLMProvider = import('../../../src/agents/llm/provider.js').LLMProvider;
    type ExecutionLayer = import('../../../src/skills/execution.js').ExecutionLayer;

    const bus = new EventBus(logger);
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research' });

    let callId = 0;
    const alwaysToolUseProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(async () => ({
        type: 'tool_use' as const,
        toolCalls: [{ id: `call-${callId++}`, name: 'web-fetch', input: {} }],
        usage: { inputTokens: 50, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: {
          requestedModel: 'mock-model',
          actualModel: 'mock-model',
          providerRequestId: 'msg_mock_budget',
        },
      })),
    };

    const mockExecution = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: 'ok' }),
    } as unknown as ExecutionLayer;

    const toolDef = {
      name: 'web-fetch',
      description: 'Fetch',
      input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
    };

    const specialist = new AgentRuntime({
      agentId: 'research-analyst',
      systemPrompt: 'You are a research analyst.',
      provider: alwaysToolUseProvider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      executionLayer: mockExecution,
      skillToolDefs: [toolDef],
      errorBudget: { maxTurns: 3, maxConsecutiveErrors: 10 },
    });
    specialist.register();

    // Dispatch subscriber required so agent.response publish is permitted
    bus.subscribe('agent.response', 'dispatch', () => {});

    const result = await handler.execute(makeCtx(
      { agent: 'research-analyst', task: 'Post to Bluesky', conversation_id: 'conv-budget-delegate' },
      { bus, agentRegistry },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        agent: string;
        failed: boolean;
        reason: string;
        retryable: boolean;
      };
      expect(data.failed).toBe(true);
      expect(data.agent).toBe('research-analyst');
      expect(data.reason).toBe('maxTurns');
      expect(data.retryable).toBe(false);
    }
  });

  it('delegates to specialist and returns its response', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research' });
    const bus = new EventBus(logger);

    // Register a mock specialist that responds to agent.task
    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type === 'agent.task' && event.payload.agentId === 'research-analyst') {
        const { createAgentResponse } = await import('../../../src/bus/events.js');
        const response = createAgentResponse({
          agentId: 'research-analyst',
          conversationId: event.payload.conversationId,
          content: 'Here are the research findings: ...',
          parentEventId: event.id,
        });
        await bus.publish('agent', response);
      }
    });

    const result = await handler.execute(makeCtx(
      { agent: 'research-analyst', task: 'Research the latest AI trends', conversation_id: 'conv-1' },
      { bus, agentRegistry },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { response: string; agent: string };
      expect(data.agent).toBe('research-analyst');
      expect(data.response).toContain('research findings');
    }
  });

  it('forwards originator from taskMetadata into the specialist task metadata', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research' });
    const bus = new EventBus(logger);

    const originator = {
      contactId: 'ceo-contact-id',
      systemRole: 'principal' as const,
      channel: 'email',
      initiatedAt: '2026-05-01T10:00:00.000Z',
    };

    let capturedMetadata: Record<string, unknown> | undefined;
    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type === 'agent.task' && event.payload.agentId === 'research-analyst') {
        capturedMetadata = event.payload.metadata as Record<string, unknown> | undefined;
        const { createAgentResponse } = await import('../../../src/bus/events.js');
        await bus.publish('agent', createAgentResponse({
          agentId: 'research-analyst',
          conversationId: event.payload.conversationId,
          content: 'Done',
          parentEventId: event.id,
        }));
      }
    });

    const result = await handler.execute(makeCtx(
      { agent: 'research-analyst', task: 'Research AI trends' },
      { bus, agentRegistry, taskMetadata: { originator } },
    ));

    expect(result.success).toBe(true);
    expect(capturedMetadata?.originator).toEqual(originator);
  });

  it('includes delegationOrigin but no originator when parent task has no originator (#995)', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research' });
    const bus = new EventBus(logger);

    let capturedMetadata: Record<string, unknown> | undefined;
    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type === 'agent.task' && event.payload.agentId === 'research-analyst') {
        capturedMetadata = event.payload.metadata as Record<string, unknown> | undefined;
        const { createAgentResponse } = await import('../../../src/bus/events.js');
        await bus.publish('agent', createAgentResponse({
          agentId: 'research-analyst',
          conversationId: event.payload.conversationId,
          content: 'Done',
          parentEventId: event.id,
        }));
      }
    });

    await handler.execute(makeCtx(
      { agent: 'research-analyst', task: 'Research AI trends' },
      { bus, agentRegistry },
    ));

    // Since #995, delegate always sets delegationOrigin so the specialist's capture links can
    // re-enter the coordinator on redeem. originator is absent (no parent originator to forward).
    expect(capturedMetadata).toMatchObject({
      delegationOrigin: { originalTask: 'Research AI trends' },
    });
    expect(capturedMetadata).not.toHaveProperty('originator');
  });
});
