// Integration test for multi-turn research conversations (issue #611).
//
// Verifies the full stateless multi-turn pattern:
//   1. Coordinator delegates research task to research-analyst
//   2. Research-analyst returns STATUS: NEEDS_CLARIFICATION (partial findings + question)
//   3. Coordinator sends clarifying question to CEO via Signal with context_bridge
//   4. CEO replies → [ACTIVE OUTBOUND CONTEXT] block injected by dispatcher
//   5. Coordinator releases context bridge entry, re-delegates with CEO's direction
//   6. Research-analyst resumes and returns final answer
//   7. Coordinator synthesizes final response
//
// Uses the same in-memory setup as multi-agent-delegation.test.ts — real bus, registry,
// execution layer, and delegate handler; only the LLM providers and send skills are mocked.

import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { DelegateHandler } from '../../skills/delegate/handler.js';
import type { LLMProvider, Message } from '../../src/agents/llm/provider.js';
import type { SkillManifest, SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createAgentTask } from '../../src/bus/events.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const MOCK_PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

// The TASK_CONTEXT the research-analyst embeds in its clarification response.
// Contains the original task and the memory key the analyst stored partial state under.
const TASK_CONTEXT =
  'ORIGINAL_TASK: Research the best AI acquisition targets in enterprise software | MEMORY_KEY: research-scratchpad: AI acquisition targets Q2 2026';

// Simulated [ACTIVE OUTBOUND CONTEXT] block that the dispatcher would inject when
// the CEO replies to the coordinator's Signal message. Includes the task_context
// metadata the coordinator stored when it called signal-send with context_bridge.
const ACTIVE_OUTBOUND_CONTEXT_BLOCK = `[ACTIVE OUTBOUND CONTEXT — messages you've sent that may receive replies]
---
entry_id: test-bridge-entry-001
[sent 3 minutes ago via signal, on behalf of coordinator, expires in 23h]
preview: "Working on your acquisition research. One question: which angle matters most..."
expected reply: CEO's direction on the research question
delegation: research-analyst clarification pending
context: {"task_context":"${TASK_CONTEXT}"}
---`;

// Shared delegate skill manifest — used by both test cases to avoid duplication.
const DELEGATE_MANIFEST: SkillManifest = {
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

describe('Research-analyst multi-turn clarification (issue #611)', () => {
  it('routes clarification → CEO question → re-delegation → final synthesis', async () => {
    // ── 1. Registries ───────────────────────────────────────────────────────

    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    agentRegistry.register('research-analyst', {
      role: 'specialist',
      description: 'Research and analysis',
    });

    // Mock signal-send: captures what the coordinator sends, returns success.
    // In production this would send a real Signal message and register an outbound
    // context entry in Postgres. Here we skip both and simulate the injection manually.
    let signalSendCallCount = 0;
    let capturedSignalMessage = '';
    let capturedContextBridge: Record<string, unknown> = {};
    const mockSignalSend: SkillHandler = {
      async execute(ctx: SkillContext): Promise<SkillResult> {
        signalSendCallCount++;
        const input = ctx.input as Record<string, unknown>;
        capturedSignalMessage = (input.message as string) ?? '';
        capturedContextBridge = JSON.parse((input.context_bridge as string) ?? '{}') as Record<string, unknown>;
        return { success: true, data: { delivered_to: '+15551234567', channel: 'signal' } };
      },
    };

    // Mock context-bridge-release: captures the entry_id the coordinator releases.
    let releasedEntryId: string | undefined;
    const mockContextBridgeRelease: SkillHandler = {
      async execute(ctx: SkillContext): Promise<SkillResult> {
        releasedEntryId = (ctx.input as Record<string, unknown>).entry_id as string;
        return { success: true, data: {} };
      },
    };

    const skillRegistry = new SkillRegistry();
    skillRegistry.register(DELEGATE_MANIFEST, new DelegateHandler());

    const signalSendManifest: SkillManifest = {
      name: 'signal-send',
      description: 'Send a Signal message',
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'medium',
      capabilities: [],  // no outboundGateway/outboundContext — mocked entirely
      inputs: { recipient: 'string?', message: 'string', context_bridge: 'string?' },
      outputs: { delivered_to: 'string', channel: 'string' },
      permissions: [],
      secrets: [],
      timeout: 30000,
    };
    skillRegistry.register(signalSendManifest, mockSignalSend);

    const contextBridgeReleaseManifest: SkillManifest = {
      name: 'context-bridge-release',
      description: 'Release an outbound context bridge entry',
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'low',
      capabilities: [],  // no outboundContext — mocked entirely
      inputs: { entry_id: 'string' },
      outputs: {},
      permissions: [],
      secrets: [],
      timeout: 5000,
    };
    skillRegistry.register(contextBridgeReleaseManifest, mockContextBridgeRelease);

    // ── 2. Bus and execution layer ──────────────────────────────────────────

    const bus = new EventBus(logger);
    const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

    // ── 3. Coordinator mock LLM — 6 scripted responses ─────────────────────
    //
    //  Phase 1 (initial research task):
    //    Call 1: delegate research task to research-analyst
    //    Call 2: after NEEDS_CLARIFICATION result, send clarifying question via signal-send
    //    Call 3: after signal-send success, acknowledge to CEO that we're waiting
    //
    //  Phase 2 (CEO's reply with ACTIVE OUTBOUND CONTEXT):
    //    Call 4: release the context bridge entry
    //    Call 5: re-delegate to research-analyst with CEO's direction
    //    Call 6: synthesize the final research result

    let coordinatorCalls = 0;
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator',
      chat: async ({ messages }: { messages: Message[] }) => {
        coordinatorCalls++;
        const messageJson = JSON.stringify(messages);

        switch (coordinatorCalls) {
          case 1:
            return {
              type: 'tool_use' as const,
              toolCalls: [{
                id: 'call-1',
                name: 'delegate',
                input: {
                  agent: 'research-analyst',
                  task: 'Research the best AI acquisition targets in enterprise software — produce a shortlist.',
                  conversation_id: 'research-conv-001',
                },
              }],
              usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          case 2: {
            // Verify the coordinator received the clarification response as a tool_result
            expect(messageJson).toContain('NEEDS_CLARIFICATION');
            return {
              type: 'tool_use' as const,
              toolCalls: [{
                id: 'call-2',
                name: 'signal-send',
                input: {
                  recipient: '+15551234567',
                  message: "Working on your acquisition research. I've found several candidates, but wanted to check: which angle matters most to you — valuation, key talent, or technology fit?",
                  context_bridge: JSON.stringify({
                    agent_id: 'coordinator',
                    delegation_hint: 'research-analyst clarification pending',
                    expected_reply: "CEO's direction on which evaluation angle to prioritize",
                    metadata: { task_context: TASK_CONTEXT },
                    expires_in_hours: 24,
                  }),
                },
              }],
              usage: { inputTokens: 150, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };
          }

          case 3:
            // Acknowledge to the original caller that we're waiting on CEO input
            return {
              type: 'text' as const,
              content: "I'm on it — just sent you a quick question on Signal to make sure the research goes in the right direction. I'll follow up once you reply.",
              usage: { inputTokens: 180, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          case 4: {
            // Verify the coordinator can see the ACTIVE OUTBOUND CONTEXT block
            expect(messageJson).toContain('ACTIVE OUTBOUND CONTEXT');
            expect(messageJson).toContain('research-analyst clarification pending');
            return {
              type: 'tool_use' as const,
              toolCalls: [{
                id: 'call-4',
                name: 'context-bridge-release',
                input: { entry_id: 'test-bridge-entry-001' },
              }],
              usage: { inputTokens: 220, outputTokens: 30, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };
          }

          case 5:
            // Re-delegate to research-analyst with the CEO's direction + TASK_CONTEXT
            return {
              type: 'tool_use' as const,
              toolCalls: [{
                id: 'call-5',
                name: 'delegate',
                input: {
                  agent: 'research-analyst',
                  task: `You are resuming a research task. The CEO has provided the direction you needed.\n\n${TASK_CONTEXT}\n\nCEO's direction: Focus on technology fit — we need AI capabilities we can integrate into our platform.\n\nContinue the research from where you left off.`,
                  conversation_id: 'research-conv-001',
                },
              }],
              usage: { inputTokens: 260, outputTokens: 110, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          case 6:
            // Synthesize the final research result in the coordinator's own voice
            return {
              type: 'text' as const,
              content: "Here's the acquisition shortlist, focused on technology fit: DataStream AI (strong NLP pipeline compatible with our APIs), Synthex (computer vision we don't have), and NeuralBase (enterprise ML infrastructure). DataStream looks most strategic given your platform roadmap.",
              usage: { inputTokens: 310, outputTokens: 120, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          default:
            throw new Error(`Unexpected coordinator LLM call #${coordinatorCalls}`);
        }
      },
    };

    // ── 4. Research-analyst mock LLM — 2 scripted responses ────────────────
    //
    //  Call 1: returns a structured NEEDS_CLARIFICATION response (partial findings
    //          stored in memory, needs CEO to pick the research angle)
    //  Call 2: returns the final research result after receiving CEO's direction

    let specialistCalls = 0;
    const specialistProvider: LLMProvider = {
      id: 'mock-specialist',
      chat: async () => {
        specialistCalls++;
        switch (specialistCalls) {
          case 1:
            return {
              type: 'text' as const,
              content: [
                'STATUS: NEEDS_CLARIFICATION',
                'QUESTION: Which angle matters most for evaluating these targets — valuation multiples, key talent retention, or technology integration fit with our platform?',
                'PARTIAL_FINDINGS: Found 4 active enterprise AI acquisition targets in Q2 2026: DataStream AI, Synthex, NeuralBase, and Cortex Systems. Each has distinct strengths across valuation, talent density, and technology compatibility.',
                `TASK_CONTEXT: ${TASK_CONTEXT}`,
              ].join('\n'),
              usage: { inputTokens: 80, outputTokens: 60, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          case 2:
            // Resumed — returns the final analysis focused on technology fit
            return {
              type: 'text' as const,
              content: 'Top targets by technology fit: 1) DataStream AI — advanced NLP pipeline compatible with platform APIs; 2) Synthex — computer vision capabilities not currently in-house; 3) NeuralBase — enterprise ML infrastructure that could replace the current stack. DataStream AI is the strongest strategic fit given the platform roadmap.',
              usage: { inputTokens: 130, outputTokens: 90, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          default:
            throw new Error(`Unexpected specialist LLM call #${specialistCalls}`);
        }
      },
    };

    // ── 5. Create agent runtimes ────────────────────────────────────────────

    const coordinatorToolDefs = skillRegistry.toToolDefinitions([
      'delegate',
      'signal-send',
      'context-bridge-release',
    ]);

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a coordinator.',
      provider: coordinatorProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['delegate', 'signal-send', 'context-bridge-release'],
      skillToolDefs: coordinatorToolDefs,
    });
    coordinator.register();

    const specialist = new AgentRuntime({
      agentId: 'research-analyst',
      systemPrompt: 'You are a research analyst.',
      provider: specialistProvider,
      bus,
      logger,
    });
    specialist.register();

    // ── 6. Collect coordinator responses ────────────────────────────────────

    const coordinatorResponses: string[] = [];
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
        coordinatorResponses.push(event.payload.content);
      }
    });

    // ── 7. Phase 1: initial research task ───────────────────────────────────
    //
    // The coordinator processes this task, hits a NEEDS_CLARIFICATION mid-delegation,
    // sends a Signal message to the CEO with context_bridge, and responds to the
    // original caller acknowledging it's waiting for CEO input.

    const task1 = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'ceo-conv-001',
      channelId: 'signal',
      senderId: 'test-ceo',
      content: 'Research the best AI acquisition targets for us — I want a shortlist.',
      parentEventId: 'inbound-event-001',
    });
    await bus.publish('dispatch', task1);

    // Verify the coordinator sent the clarifying question to the CEO
    expect(signalSendCallCount).toBe(1);
    expect(capturedSignalMessage).toContain('angle matters most');
    expect(capturedContextBridge.delegation_hint).toBe('research-analyst clarification pending');
    expect(capturedContextBridge.expires_in_hours).toBe(24);
    const capturedMetadata = capturedContextBridge.metadata as Record<string, unknown>;
    expect(capturedMetadata.task_context).toBe(TASK_CONTEXT);

    // Coordinator responded to the original caller acknowledging the pending question
    expect(coordinatorResponses).toHaveLength(1);
    expect(coordinatorResponses[0]!).toContain('question on Signal');

    // ── 8. Phase 2: CEO's Signal reply ─────────────────────────────────────
    //
    // In production, the dispatcher prepends the [ACTIVE OUTBOUND CONTEXT] block
    // to every inbound message when there are active context bridge entries.
    // We simulate that injection by prepending the block to the task content manually.

    const ceoReplyContent = [
      ACTIVE_OUTBOUND_CONTEXT_BLOCK,
      '',
      'Focus on technology fit — we need AI capabilities we can integrate into our platform.',
    ].join('\n');

    const task2 = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'ceo-conv-001',
      channelId: 'signal',
      senderId: 'test-ceo',
      content: ceoReplyContent,
      parentEventId: 'inbound-event-002',
    });
    await bus.publish('dispatch', task2);

    // ── 9. Assertions ───────────────────────────────────────────────────────

    // Full call count — no extra or missing turns
    expect(coordinatorCalls).toBe(6);
    expect(specialistCalls).toBe(2);

    // Context bridge was released with the correct entry_id from the ACTIVE OUTBOUND CONTEXT block
    expect(releasedEntryId).toBe('test-bridge-entry-001');

    // Final coordinator response synthesizes the research result
    expect(coordinatorResponses).toHaveLength(2);
    expect(coordinatorResponses[1]!).toContain('DataStream');
    expect(coordinatorResponses[1]!).toContain('technology fit');
  });

  it('one-shot research tasks still work as before (backward compatible)', async () => {
    // Regression guard: when the specialist returns a normal text response
    // (no STATUS: NEEDS_CLARIFICATION), the coordinator synthesizes it directly.
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research and analysis' });

    const skillRegistry = new SkillRegistry();
    skillRegistry.register(DELEGATE_MANIFEST, new DelegateHandler());

    const bus = new EventBus(logger);
    const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

    let coordinatorCalls = 0;
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator-oneshot',
      chat: async () => {
        coordinatorCalls++;
        if (coordinatorCalls === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{
              id: 'call-1',
              name: 'delegate',
              input: { agent: 'research-analyst', task: 'Research battery storage companies', conversation_id: 'conv-123' },
            }],
            usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            provenance: MOCK_PROVENANCE,
          };
        }
        return {
          type: 'text' as const,
          content: 'Battery storage is led by QuantumCell, FluxEnergy, and IonDrive — all Series B or later.',
          usage: { inputTokens: 200, outputTokens: 60, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      },
    };

    let specialistCalls = 0;
    const specialistProvider: LLMProvider = {
      id: 'mock-specialist-oneshot',
      chat: async () => {
        specialistCalls++;
        return {
          type: 'text' as const,
          content: 'Top battery storage companies: QuantumCell, FluxEnergy, IonDrive.',
          usage: { inputTokens: 50, outputTokens: 30, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      },
    };

    const toolDefs = skillRegistry.toToolDefinitions(['delegate']);

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a coordinator.',
      provider: coordinatorProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['delegate'],
      skillToolDefs: toolDefs,
    });
    coordinator.register();

    const specialist = new AgentRuntime({
      agentId: 'research-analyst',
      systemPrompt: 'You are a research analyst.',
      provider: specialistProvider,
      bus,
      logger,
    });
    specialist.register();

    let finalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
        finalResponse = event.payload.content;
      }
    });

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'ceo-conv-002',
      channelId: 'signal',
      senderId: 'test-ceo',
      content: 'Research battery storage companies.',
      parentEventId: 'inbound-event-003',
    });
    await bus.publish('dispatch', task);

    expect(coordinatorCalls).toBe(2);
    expect(specialistCalls).toBe(1);
    expect(finalResponse).toContain('QuantumCell');
  });
});
