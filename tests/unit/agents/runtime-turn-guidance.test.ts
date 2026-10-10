// Runtime rendering of per-turn trigger guidance (#1959).
//
// The guidance heads the user message for the turn whose trigger fired. It must never
// reach the system string (that would split the cached prefix per trigger) or working
// memory (a long conversation would hold one copy per earlier turn).

import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import type { LLMProvider, Message } from '../../../src/agents/llm/provider.js';
import { renderTurnGuidance, TURN_GUIDANCE_HEADER } from '../../../src/agents/prompts/turn-guidance.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';

const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' } as const;

function capturingProvider(): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  return {
    id: 'mock',
    chat: vi.fn(async () => ({
      type: 'text' as const,
      content: 'Done.',
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      provenance: PROVENANCE,
    })),
  };
}

async function runTurn(payload: { content: string; turnGuidance?: unknown; channelId?: string; toolAllowlist?: string[] }) {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  bus.subscribe('agent.response', 'dispatch', () => {});
  const provider = capturingProvider();
  const memory = WorkingMemory.createInMemory();
  new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are the coordinator.',
    provider,
    resolvedModel: 'mock-model',
    bus,
    logger,
    memory,
  }).register();
  await bus.publish('dispatch', createAgentTask({
    agentId: 'coordinator',
    conversationId: 'conv-guidance',
    channelId: payload.channelId ?? 'cli',
    senderId: 'principal',
    content: payload.content,
    ...(payload.toolAllowlist && { toolAllowlist: payload.toolAllowlist }),
    // Cast: the runtime must cope with whatever crossed the bus, not only valid keys.
    ...(payload.turnGuidance !== undefined && {
      turnGuidance: payload.turnGuidance as Parameters<typeof createAgentTask>[0]['turnGuidance'],
    }),
    parentEventId: 'parent-guidance',
  }));
  const messages = provider.chat.mock.calls[0]![0].messages as Message[];
  const history = await memory.getHistory('conv-guidance', 'coordinator');
  return { messages, history };
}

describe('AgentRuntime turn guidance (#1959)', () => {
  it('heads the user message with the rendered guidance', async () => {
    const { messages } = await runTurn({ content: 'Go ahead', turnGuidance: ['principal-reply-shaped'] });
    const user = messages[messages.length - 1]!;
    expect(user.role).toBe('user');
    expect(user.content).toBe(`${renderTurnGuidance(['principal-reply-shaped'])}\n\nGo ahead`);
  });

  it('keeps it out of every system message', async () => {
    const { messages } = await runTurn({ content: 'Go ahead', turnGuidance: ['principal-reply-shaped'] });
    for (const m of messages.filter((msg) => msg.role === 'system')) {
      expect(m.content).not.toContain(TURN_GUIDANCE_HEADER);
    }
  });

  it('stores only the task content in working memory', async () => {
    const { history } = await runTurn({ content: 'Go ahead', turnGuidance: ['principal-reply-shaped', 'email-etiquette'] });
    expect(history[0]).toEqual({ role: 'user', content: 'Go ahead' });
  });

  it('leaves the user message untouched without guidance, or with only unknown keys', async () => {
    for (const turnGuidance of [undefined, [], ['not-a-key'], 'outbound-context']) {
      const { messages } = await runTurn({ content: 'Hello', turnGuidance });
      expect(messages[messages.length - 1]!.content).toBe('Hello');
    }
  });

  it('tells a scheduler turn its reply reaches no one (#2091)', async () => {
    const { messages } = await runTurn({ content: 'Check on Sam.', channelId: 'scheduler' });
    expect(messages[messages.length - 1]!.content).toBe(`${renderTurnGuidance(['scheduler-delivery'])}\n\nCheck on Sam.`);
  });

  it('skips the scheduler delivery guidance on a tool-allowlisted turn', async () => {
    const { messages } = await runTurn({ content: 'Dispose of the task.', channelId: 'scheduler', toolAllowlist: ['task-complete'] });
    expect(messages[messages.length - 1]!.content).toBe('Dispose of the task.');
  });
});
