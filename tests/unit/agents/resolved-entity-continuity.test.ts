// Regression for #1818: a contact resolved by delegation in turn 1 must still
// be available, refreshed from the contact row, when turn 3 composes an
// external message. Working memory only keeps user/assistant text.

import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type ContextBudgetEvent } from '../../../src/bus/events.js';
import type { LLMProvider, Message } from '../../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import { ConversationEntityState } from '../../../src/entity-context/conversation-entities.js';
import { describeUnresolvedIdentity, RESOLVED_ENTITIES_TIER, type ResolvedEntityCard } from '../../../src/agents/resolved-entities.js';

const XIAOPU = '11111111-1111-4111-8111-111111111111';

const PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

const USAGE = { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

const SENDER = {
  resolved: true as const,
  contactId: 'principal-contact',
  displayName: 'Joseph Fung',
  role: null,
  systemRole: 'principal' as const,
  tier: 'principal' as const,
  kind: 'person' as const,
  verified: true,
  kgNodeId: null,
  knowledgeSummary: '',
  authorization: {
    allowed: [] as string[],
    denied: [] as string[],
    escalate: [] as string[],
    channelTrust: 'high' as const,
    trustBlocked: [] as string[],
  },
  contactConfidence: 1,
};

function text(content: string) {
  return { type: 'text' as const, content, usage: USAGE, provenance: PROVENANCE };
}

function tool(name: string, input: Record<string, unknown>) {
  return {
    type: 'tool_use' as const,
    toolCalls: [{ id: `call-${name}`, name, input }],
    usage: USAGE,
    provenance: PROVENANCE,
  };
}

function resolvedBlock(messages: Message[]): string | undefined {
  return messages.find(m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('<resolved_entities>'))?.content as string | undefined;
}

describe('resolved entity continuity (#1818)', () => {
  it('refreshes a contact resolved in turn 1 into the external message composed in turn 3', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const memory = WorkingMemory.createInMemory();
    let current: ResolvedEntityCard = {
      contactId: XIAOPU,
      displayName: 'Xiaopu Fung',
      preferredName: null,
      role: 'Spouse',
      organization: null,
      primaryEmail: 'xiaopu@example.com',
      primaryPhone: '+15555550100',
    };
    const entities = ConversationEntityState.createInMemory(
      { get: (id) => (id === XIAOPU ? current : undefined) },
      ['Joseph Fung'],
    );

    const budgets: ContextBudgetEvent[] = [];
    bus.subscribe('context.budget', 'system', (event) => {
      budgets.push(event as ContextBudgetEvent);
    });
    bus.subscribe('agent.response', 'dispatch', () => {});

    let phase: 1 | 2 | 3 = 1;
    let callsInPhase = 0;
    const seenBlocks: Array<string | undefined> = [];
    let composedBody = '';

    const provider: LLMProvider = {
      id: 'mock',
      chat: async ({ messages }) => {
        callsInPhase++;
        if (phase === 1) {
          if (callsInPhase === 1) return tool('delegate', { agent: 'contacts', task: 'Brief me on Xiaopu' });
          return text('Noted.');
        }
        if (phase === 2) {
          seenBlocks.push(resolvedBlock(messages));
          return text('Nothing on the calendar tomorrow.');
        }
        if (callsInPhase === 1) {
          const block = resolvedBlock(messages);
          seenBlocks.push(block);
          const name = block?.match(/name="([^"]+)"/)?.[1] ?? 'Xiaopu (last name to be confirmed)';
          composedBody = `He and ${name} would like to attend.\n- Joseph Fung — joseph@example.com\n- ${name}`;
          return tool('email-send', {
            to: 'dani@wrcf.ca',
            subject: 'Registration',
            body: composedBody,
          });
        }
        return text('Sent the registration note.');
      },
    };

    const execution = {
      invoke: vi.fn(async (name: string, input: Record<string, unknown>) => {
        if (name === 'delegate') {
          return {
            success: true,
            data: {
              response: 'Xiaopu Fung — spouse, on file.',
              agent: 'contacts',
              resolvedContactIds: [XIAOPU],
            },
          };
        }
        if (name === 'email-send') {
          composedBody = String(input['body']);
          return { success: true, data: { message_id: 'msg-1' } };
        }
        return { success: true, data: {} };
      }),
    } as unknown as ExecutionLayer;

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are the coordinator.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      memory,
      executionLayer: execution,
      conversationEntities: entities,
    });
    runtime.register();

    const task = (content: string) => createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-xiaopu',
      channelId: 'signal',
      senderId: '+15555550123',
      content,
      senderContext: SENDER,
      parentEventId: 'parent-1',
    });

    await bus.publish('dispatch', task('Brief me on Xiaopu — I need their full name before I register them.'));
    expect(execution.invoke).toHaveBeenCalledWith(
      'delegate',
      expect.objectContaining({ agent: 'contacts' }),
      expect.anything(),
      expect.anything(),
    );

    phase = 2;
    callsInPhase = 0;
    await bus.publish('dispatch', task('What is on my calendar tomorrow?'));

    // The contact row changed after turn 2. Turn 3 must show the new name,
    // not the wording captured when the specialist answered.
    current = { ...current, displayName: 'Xiaopu Chen', primaryEmail: 'chen@example.com' };

    phase = 3;
    callsInPhase = 0;
    await bus.publish('dispatch', task('Email dani@wrcf.ca and register us.'));

    const turn2Block = seenBlocks[0];
    const turn3Block = seenBlocks[1];
    expect(turn2Block).toContain('name="Xiaopu Fung"');
    expect(turn3Block).toContain('name="Xiaopu Chen"');
    expect(turn3Block).toContain('email="chen@example.com"');
    expect(turn3Block).not.toContain('Xiaopu Fung');

    expect(composedBody).toContain('Xiaopu Chen');
    expect(composedBody).not.toContain('last name to be confirmed');
    expect(describeUnresolvedIdentity(composedBody, ['Joseph Fung', 'Xiaopu Chen'])).toBeNull();

    const history = await memory.getHistory('conv-xiaopu', 'coordinator');
    expect(history.map(turn => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(history.some(turn => turn.content.includes('<resolved_entities>'))).toBe(false);

    const turn3Budget = budgets[2]!;
    const tier = turn3Budget.payload.tiers.find(entry => entry.name === RESOLVED_ENTITIES_TIER);
    expect(tier).toMatchObject({ name: RESOLVED_ENTITIES_TIER, included: true });
    expect(tier!.estimatedTokens).toBeGreaterThan(0);
    expect(tier!.estimatedTokens).toBeLessThan(2_000);
  });
});
