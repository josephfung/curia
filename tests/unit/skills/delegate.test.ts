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
      expect(result.error).toContain('infrastructure');
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
});
