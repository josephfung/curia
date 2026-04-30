import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { DelegateHandler } from '../../skills/delegate/handler.js';
import type { LLMProvider, Message, ContentBlock } from '../../src/agents/llm/provider.js';
import type { SkillManifest } from '../../src/skills/types.js';
import { createAgentTask } from '../../src/bus/events.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// Observation-mode preamble used in both tests — mirrors the format the coordinator
// sends when delegating to email-triage (see email-triage.yaml system_prompt).
const OBSERVATION_PREAMBLE = `[OBSERVATION MODE — monitored inbox]
Message ID: msg-abc123
Account: ceo-inbox

--- Original message ---
From: investor@example.com
Subject: Quick call today?
Body: Hey, can we jump on a call today to discuss the board situation? It's urgent.`;

describe('Email-triage delegation integration', () => {
  // Shared setup: delegate skill manifest registered in both tests
  function buildDelegateManifest(): SkillManifest {
    return {
      name: 'delegate',
      description: 'Delegate a task to a specialist agent',
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'none',
      capabilities: ['bus', 'agentRegistry'],
      inputs: { agent: 'string', task: 'string', conversation_id: 'string?' },
      outputs: { response: 'string', agent: 'string' },
      permissions: [],
      secrets: [],
      timeout: 120000,
    };
  }

  it('Coordinator delegates to email-triage and echoes classification', async () => {
    // 1. Set up agent registry with coordinator and email-triage specialist
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    agentRegistry.register('email-triage', { role: 'specialist', description: 'Email triage specialist' });

    const skillRegistry = new SkillRegistry();
    skillRegistry.register(buildDelegateManifest(), new DelegateHandler());

    // 2. Set up bus and execution layer
    const bus = new EventBus(logger);
    const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

    // 3. Capture what the coordinator passes to the delegate skill
    const capturedDelegateInput: { agent: string; task: string } = { agent: '', task: '' };

    // 4. Mock Coordinator LLM:
    //    - Turn 1: delegates to email-triage with the observation-mode preamble
    //    - Turn 2: echoes the classification from the specialist's response
    let coordinatorCalls = 0;
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator',
      chat: async ({ messages }: { messages: Message[] }) => {
        coordinatorCalls++;
        if (coordinatorCalls === 1) {
          // Delegate to email-triage with the full observation-mode preamble
          const delegateTask = OBSERVATION_PREAMBLE;
          capturedDelegateInput.agent = 'email-triage';
          capturedDelegateInput.task = delegateTask;
          return {
            type: 'tool_use' as const,
            toolCalls: [{
              id: 'call-delegate-1',
              name: 'delegate',
              input: {
                agent: 'email-triage',
                task: delegateTask,
                conversation_id: 'test-conv-triage',
              },
            }],
            usage: { inputTokens: 150, outputTokens: 60 },
          };
        }
        // Turn 2: specialist responded — echo the classification keyword.
        // Check that the tool result is in the message history to confirm delegation worked.
        const hasToolResult = messages.some(m =>
          Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === 'tool_result'),
        );
        return {
          type: 'text' as const,
          content: `Email triage result${hasToolResult ? ' (delegation successful)' : ''}: Classification: URGENT`,
          usage: { inputTokens: 250, outputTokens: 70 },
        };
      },
    };

    // 5. Mock email-triage specialist LLM: returns a structured triage response
    let triageSpecialistCalls = 0;
    const triageSpecialistProvider: LLMProvider = {
      id: 'mock-email-triage',
      chat: async () => {
        triageSpecialistCalls++;
        return {
          type: 'text' as const,
          // Structured response format per email-triage.yaml system_prompt requirements
          content: [
            'Classification: URGENT',
            'Rationale: Investor is requesting an urgent call about the board situation — time-sensitive, from a known contact, CEO decision required.',
            'Actions taken: Opened bullpen thread mentioning coordinator.',
          ].join('\n'),
          usage: { inputTokens: 80, outputTokens: 40 },
        };
      },
    };

    // 6. Create both agent runtimes
    const toolDefs = skillRegistry.toToolDefinitions(['delegate']);

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a coordinator. You delegate email triage work to the email-triage specialist.',
      provider: coordinatorProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['delegate'],
      skillToolDefs: toolDefs,
    });
    coordinator.register();

    const triageSpecialist = new AgentRuntime({
      agentId: 'email-triage',
      systemPrompt: 'You are the email triage specialist.',
      provider: triageSpecialistProvider,
      bus,
      logger,
    });
    triageSpecialist.register();

    // 7. Capture the coordinator's final response
    let coordinatorFinalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
        coordinatorFinalResponse = event.payload.content;
      }
    });

    // 8. Publish the observation-mode task to the coordinator
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'test-conv-triage',
      channelId: 'email',
      senderId: 'channel-layer',
      content: OBSERVATION_PREAMBLE,
      parentEventId: 'test-inbound-email-1',
    });
    await bus.publish('dispatch', task);

    // 9. Verify the full delegation chain
    expect(coordinatorCalls).toBe(2);
    expect(triageSpecialistCalls).toBe(1);
    expect(capturedDelegateInput.agent).toBe('email-triage');
    // The delegate task must carry the message context so the specialist can look it up
    expect(capturedDelegateInput.task).toContain('msg-abc123');
    expect(capturedDelegateInput.task).toContain('ceo-inbox');
    // Coordinator must echo the classification back in its final response
    expect(coordinatorFinalResponse).toContain('Classification: URGENT');
  });

  it('Coordinator falls back gracefully when email-triage is not registered', async () => {
    // 1. Set up agent registry with coordinator only — email-triage NOT registered
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    // email-triage intentionally omitted to simulate missing specialist

    const skillRegistry = new SkillRegistry();
    skillRegistry.register(buildDelegateManifest(), new DelegateHandler());

    // 2. Set up bus and execution layer
    const bus = new EventBus(logger);
    const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

    // 3. Mock Coordinator LLM:
    //    - Turn 1: attempts to delegate to email-triage (will fail — not registered)
    //    - Turn 2: receives the error in tool_result, falls back to self-classification
    let coordinatorCalls = 0;
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator-fallback',
      chat: async ({ messages }: { messages: Message[] }) => {
        coordinatorCalls++;
        if (coordinatorCalls === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{
              id: 'call-delegate-fallback',
              name: 'delegate',
              input: {
                agent: 'email-triage',
                task: OBSERVATION_PREAMBLE,
                conversation_id: 'test-conv-fallback',
              },
            }],
            usage: { inputTokens: 150, outputTokens: 60 },
          };
        }
        // Turn 2: delegate skill returned an error — fall back to coordinator self-classification.
        // Verify the tool_result carrying the error is present in the conversation history.
        const hasErrorResult = messages.some(m =>
          Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === 'tool_result'),
        );
        return {
          type: 'text' as const,
          content: `Unable to delegate to email-triage${hasErrorResult ? ' (specialist unavailable)' : ''}. Falling back to coordinator classification: Classification: LEAVE FOR CEO`,
          usage: { inputTokens: 200, outputTokens: 50 },
        };
      },
    };

    // 4. Create coordinator runtime — no email-triage runtime, since the agent isn't registered
    const toolDefs = skillRegistry.toToolDefinitions(['delegate']);

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a coordinator. You delegate email triage work to the email-triage specialist.',
      provider: coordinatorProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['delegate'],
      skillToolDefs: toolDefs,
    });
    coordinator.register();

    // 5. Capture the coordinator's final response
    let coordinatorFinalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
        coordinatorFinalResponse = event.payload.content;
      }
    });

    // 6. Publish the observation-mode task to the coordinator
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'test-conv-fallback',
      channelId: 'email',
      senderId: 'channel-layer',
      content: OBSERVATION_PREAMBLE,
      parentEventId: 'test-inbound-email-2',
    });
    await bus.publish('dispatch', task);

    // 7. Verify fallback behavior:
    //    - Coordinator still makes exactly 2 LLM calls (delegate attempt + fallback synthesis)
    //    - Coordinator falls back to LEAVE FOR CEO when specialist is unavailable
    expect(coordinatorCalls).toBe(2);
    expect(coordinatorFinalResponse).toContain('Classification: LEAVE FOR CEO');
  });
});
