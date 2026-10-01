import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask } from '../../../src/bus/events.js';
import type { LLMProvider, ToolDefinition } from '../../../src/agents/llm/provider.js';
import { createLogger } from '../../../src/logger.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';

const MOCK_PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

const CONFIRMED_SENDER_CONTEXT = {
  resolved: true as const,
  contactId: 'test-contact-id',
  displayName: 'Test User',
  role: null,
  systemRole: null,
  tier: 'known' as const,
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
  contactConfidence: 1.0,
};

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    input_schema: { type: 'object', properties: {}, required: [] },
  };
}

const ALL_TOOLS = ['signal-send', 'skill-activate', 'task-complete', 'task-update', 'scheduler-report'].map(tool);

describe('AgentRuntime toolAllowlist (#1951)', () => {
  it('offers only the allowlisted tools and refuses a side-effect call', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    bus.subscribe('agent.response', 'dispatch', () => {});

    const toolNamesSeen: string[][] = [];
    let call = 0;
    const provider: LLMProvider = {
      id: 'mock',
      chat: async (params) => {
        call += 1;
        toolNamesSeen.push((params.tools ?? []).map((item) => item.name));
        if (call === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{ id: 'call-send', name: 'signal-send', input: { to: '+1555', message: 'again' } }],
            usage: { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            provenance: MOCK_PROVENANCE,
          };
        }
        return {
          type: 'text' as const,
          content: 'Marked the task done.',
          usage: { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      },
    };

    const invoke = vi.fn();
    const execution = {
      invoke,
      getToolDefinitions: vi.fn((names: string[]) => ALL_TOOLS.filter((item) => names.includes(item.name))),
    } as unknown as ExecutionLayer;

    const agent = new AgentRuntime({
      agentId: 'meeting-debrief',
      systemPrompt: 'You are an assistant.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      executionLayer: execution,
      skillToolDefs: ALL_TOOLS,
    });
    agent.register();

    await bus.publish('dispatch', createAgentTask({
      agentId: 'meeting-debrief',
      conversationId: 'scheduler:job-1:run-1',
      channelId: 'scheduler',
      senderId: 'scheduler',
      content: 'Task is still open after this run. Do not repeat the task\'s actions.',
      syntheticTurn: true,
      toolAllowlist: ['task-complete', 'task-update'],
      senderContext: CONFIRMED_SENDER_CONTEXT,
      parentEventId: 'parent-allowlist',
    }));

    expect(toolNamesSeen[0]).toEqual(['task-complete', 'task-update']);
    expect(toolNamesSeen[1]).toEqual(['task-complete', 'task-update']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not expand the tool list when skill-activate is called on an allowlisted turn', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    bus.subscribe('agent.response', 'dispatch', () => {});

    const toolNamesSeen: string[][] = [];
    let call = 0;
    const provider: LLMProvider = {
      id: 'mock',
      chat: async (params) => {
        call += 1;
        toolNamesSeen.push((params.tools ?? []).map((item) => item.name));
        if (call === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{ id: 'call-act', name: 'skill-activate', input: { skill: 'signal' } }],
            usage: { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            provenance: MOCK_PROVENANCE,
          };
        }
        return {
          type: 'text' as const,
          content: 'Done.',
          usage: { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      },
    };

    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: {
        _curia_protocol: 'skill_activation',
        skill: 'signal',
        tools: ['signal-send'],
        skippedTools: [],
        instructions: 'Send a message.',
        instructionsLoaded: true,
      },
    });
    const execution = {
      invoke,
      getToolDefinitions: vi.fn((names: string[]) => ALL_TOOLS.filter((item) => names.includes(item.name))),
    } as unknown as ExecutionLayer;

    const agent = new AgentRuntime({
      agentId: 'meeting-debrief',
      systemPrompt: 'You are an assistant.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      executionLayer: execution,
      skillToolDefs: ALL_TOOLS,
    });
    agent.register();

    await bus.publish('dispatch', createAgentTask({
      agentId: 'meeting-debrief',
      conversationId: 'scheduler:job-1:run-1',
      channelId: 'scheduler',
      senderId: 'scheduler',
      content: 'Dispose the task.',
      toolAllowlist: ['task-complete', 'task-update', 'skill-activate'],
      senderContext: CONFIRMED_SENDER_CONTEXT,
      parentEventId: 'parent-allowlist-2',
    }));

    expect(invoke).toHaveBeenCalledWith(
      'skill-activate',
      { skill: 'signal' },
      expect.anything(),
      expect.anything(),
    );
    expect(toolNamesSeen[1]?.slice().sort()).toEqual(['skill-activate', 'task-complete', 'task-update']);
    expect(toolNamesSeen[1]).not.toContain('signal-send');
  });
});
