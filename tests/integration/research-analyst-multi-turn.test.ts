// Integration test for multi-turn research conversations (issue #611).
//
// Verifies the full request-clarification protocol:
//   1. Coordinator delegates research task to research-analyst
//   2. Research-analyst calls request-clarification skill
//   3. Runtime short-circuits and emits a deterministic JSON response
//   4. DelegateHandler detects the protocol and returns typed result to coordinator
//   5. Coordinator sends clarifying question to CEO via Signal with context_bridge
//   6. CEO replies → [ACTIVE OUTBOUND CONTEXT] block injected by dispatcher
//   7. Coordinator re-delegates with resume_token (DelegateHandler constructs task brief)
//   8. Research-analyst resumes and returns final answer
//   9. Coordinator synthesizes final response
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
import { RequestClarificationHandler } from '../../skills/request-clarification/handler.js';
import type { LLMProvider, Message, ContentBlock } from '../../src/agents/llm/provider.js';
import type { SkillManifest, SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createAgentTask } from '../../src/bus/events.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const MOCK_PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

// Shared delegate skill manifest — used by both test cases to avoid duplication.
const DELEGATE_MANIFEST: SkillManifest = {
  name: 'delegate',
  description: 'Delegate a task to a specialist agent',
  version: '1.0.0',
  sensitivity: 'normal',
  action_risk: 'none',
  capabilities: ['bus', 'agentRegistry'],
  inputs: { agent: 'string', task: 'string', conversation_id: 'string?', resume_token: 'string?' },
  outputs: { response: 'string', agent: 'string', needs_clarification: 'boolean?', question: 'string?', context: 'string?', resume_token: 'string?' },
  permissions: [],
  secrets: [],
  timeout: 120000,
};

const REQUEST_CLARIFICATION_MANIFEST: SkillManifest = {
  name: 'request-clarification',
  description: 'Request clarification from the CEO',
  version: '1.0.0',
  sensitivity: 'normal',
  action_risk: 'none',
  capabilities: [],
  inputs: { question: 'string', context: 'string' },
  outputs: { _curia_protocol: 'string', question: 'string', context: 'string' },
  permissions: [],
  secrets: [],
  timeout: 5000,
};

/** Extract the resume_token from the delegate tool result in the message history. */
function extractResumeTokenFromMessages(messages: Message[]): string {
  // Walk backward to find the most recent tool_result from a delegate call
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_result' && typeof (block as Record<string, unknown>).content === 'string') {
          try {
            const parsed = JSON.parse((block as Record<string, unknown>).content as string) as Record<string, unknown>;
            if (parsed.needs_clarification === true && typeof parsed.resume_token === 'string') {
              return parsed.resume_token as string;
            }
          } catch {
            // Not JSON — skip
          }
        }
      }
    }
  }
  throw new Error('Could not find resume_token in message history');
}

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
    let signalSendCallCount = 0;
    let capturedSignalMessage = '';
    let capturedContextBridge: Record<string, unknown> = {};
    const mockSignalSend: SkillHandler = {
      async execute(ctx: SkillContext): Promise<SkillResult> {
        signalSendCallCount++;
        const input = ctx.input as Record<string, unknown>;
        capturedSignalMessage = (input.message as string) ?? '';
        const rawBridge = input.context_bridge as string | undefined;
        if (!rawBridge) throw new Error('mockSignalSend: context_bridge was not provided by the coordinator');
        capturedContextBridge = JSON.parse(rawBridge) as Record<string, unknown>;
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
    skillRegistry.register(REQUEST_CLARIFICATION_MANIFEST, new RequestClarificationHandler());

    const signalSendManifest: SkillManifest = {
      name: 'signal-send',
      description: 'Send a Signal message',
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'medium',
      capabilities: [],
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
      capabilities: [],
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
    //    Call 2: after needs_clarification result, send question via signal-send
    //    Call 3: after signal-send success, acknowledge to CEO that we're waiting
    //
    //  Phase 2 (CEO's reply with ACTIVE OUTBOUND CONTEXT):
    //    Call 4: release the context bridge entry
    //    Call 5: re-delegate to research-analyst with resume_token
    //    Call 6: synthesize the final research result

    let coordinatorCalls = 0;
    // Captured from coordinator call 2 so phase 2 can construct the
    // ACTIVE_OUTBOUND_CONTEXT block with the actual runtime-generated token.
    let capturedResumeToken = '';

    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator',
      chat: async ({ messages }: { messages: Message[] }) => {
        coordinatorCalls++;

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
            // The delegate tool result should contain the typed clarification fields.
            // Extract the resume_token so we can include it in the context_bridge.
            capturedResumeToken = extractResumeTokenFromMessages(messages);
            expect(capturedResumeToken).toBeTruthy();

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
                    metadata: { resume_token: capturedResumeToken },
                    expires_in_hours: 24,
                  }),
                },
              }],
              usage: { inputTokens: 150, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };
          }

          case 3:
            return {
              type: 'text' as const,
              content: "I'm on it — just sent you a quick question on Signal to make sure the research goes in the right direction. I'll follow up once you reply.",
              usage: { inputTokens: 180, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          case 4: {
            // Verify the coordinator can see the ACTIVE OUTBOUND CONTEXT block
            const messageJson = JSON.stringify(messages);
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
            // Re-delegate with resume_token — DelegateHandler constructs the full task brief
            return {
              type: 'tool_use' as const,
              toolCalls: [{
                id: 'call-5',
                name: 'delegate',
                input: {
                  agent: 'research-analyst',
                  task: "Focus on technology fit — we need AI capabilities we can integrate into our platform.",
                  conversation_id: 'research-conv-001',
                  resume_token: capturedResumeToken,
                },
              }],
              usage: { inputTokens: 260, outputTokens: 110, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          case 6:
            return {
              type: 'text' as const,
              content: "Here's the acquisition shortlist, focused on technology fit: DataStream AI (strong NLP pipeline compatible with our APIs), Synthex (computer vision we don't have), and NeuralBase (enterprise ML infrastructure). DataStream looks most strategic given your platform roadmap.",
              usage: { inputTokens: 310, outputTokens: 120, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          default:
            expect(coordinatorCalls, 'Unexpected coordinator LLM call').toBeLessThanOrEqual(6);
            throw new Error(`Unexpected coordinator LLM call #${coordinatorCalls}`);
        }
      },
    };

    // ── 4. Research-analyst mock LLM — 2 scripted responses ────────────────
    //
    //  Call 1: calls request-clarification tool (runtime short-circuits;
    //          no second LLM call needed — the runtime emits the response)
    //  Call 2: returns the final research result after receiving CEO's direction
    //          via the DelegateHandler's constructed task brief

    let specialistCalls = 0;
    let specialistReceivedTaskContent = '';
    const specialistProvider: LLMProvider = {
      id: 'mock-specialist',
      chat: async ({ messages }: { messages: Message[] }) => {
        specialistCalls++;
        switch (specialistCalls) {
          case 1:
            // Call request-clarification — runtime will short-circuit after this
            return {
              type: 'tool_use' as const,
              toolCalls: [{
                id: 'specialist-call-1',
                name: 'request-clarification',
                input: {
                  question: 'Which angle matters most for evaluating these targets — valuation multiples, key talent retention, or technology integration fit with our platform?',
                  context: 'Found 4 active enterprise AI acquisition targets in Q2 2026: DataStream AI, Synthex, NeuralBase, and Cortex Systems. Each has distinct strengths across valuation, talent density, and technology compatibility.',
                },
              }],
              usage: { inputTokens: 80, outputTokens: 60, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };

          case 2: {
            // Capture the task content the specialist received — this is the
            // DelegateHandler's constructed task brief from the resume_token.
            const userMessages = messages.filter(m => m.role === 'user');
            const lastUserMsg = userMessages[userMessages.length - 1]!;
            specialistReceivedTaskContent = typeof lastUserMsg.content === 'string'
              ? lastUserMsg.content
              : JSON.stringify(lastUserMsg.content);

            return {
              type: 'text' as const,
              content: 'Top targets by technology fit: 1) DataStream AI — advanced NLP pipeline compatible with platform APIs; 2) Synthex — computer vision capabilities not currently in-house; 3) NeuralBase — enterprise ML infrastructure that could replace the current stack. DataStream AI is the strongest strategic fit given the platform roadmap.',
              usage: { inputTokens: 130, outputTokens: 90, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };
          }

          default:
            expect(specialistCalls, 'Unexpected specialist LLM call').toBeLessThanOrEqual(2);
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

    // The specialist needs an execution layer to call request-clarification.
    const specialistToolDefs = skillRegistry.toToolDefinitions(['request-clarification']);
    const specialist = new AgentRuntime({
      agentId: 'research-analyst',
      systemPrompt: 'You are a research analyst.',
      provider: specialistProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['request-clarification'],
      skillToolDefs: specialistToolDefs,
    });
    specialist.register();

    // ── 6. Collect coordinator responses ────────────────────────────────────

    const coordinatorResponses: string[] = [];
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator' && !event.payload.isError) {
        coordinatorResponses.push(event.payload.content);
      }
    });

    // ── 7. Phase 1: initial research task ───────────────────────────────────

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
    expect(capturedMetadata.resume_token).toBe(capturedResumeToken);

    // Coordinator responded to the original caller acknowledging the pending question
    expect(coordinatorResponses).toHaveLength(1);
    expect(coordinatorResponses[0]!).toContain('question on Signal');

    // ── 8. Phase 2: CEO's Signal reply ─────────────────────────────────────

    const activeOutboundContextBlock = [
      "[ACTIVE OUTBOUND CONTEXT — messages you've sent that may receive replies]",
      '---',
      'entry_id: test-bridge-entry-001',
      '[sent 3 minutes ago via signal, on behalf of coordinator, expires in 23h]',
      'preview: "Working on your acquisition research. One question: which angle matters most..."',
      "expected reply: CEO's direction on the research question",
      'delegation: research-analyst clarification pending',
      `context: ${JSON.stringify({ resume_token: capturedResumeToken })}`,
      '---',
    ].join('\n');

    const ceoReplyContent = [
      activeOutboundContextBlock,
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
    // Specialist is called only twice: once for clarification (short-circuited),
    // once for the final analysis. NO extra LLM call after request-clarification.
    expect(specialistCalls).toBe(2);

    // Context bridge was released with the correct entry_id
    expect(releasedEntryId).toBe('test-bridge-entry-001');

    // The specialist's resume task brief contains the original task and CEO's direction
    // (constructed by DelegateHandler from the resume_token, not by LLM prompt text)
    expect(specialistReceivedTaskContent).toContain('Original Task');
    expect(specialistReceivedTaskContent).toContain('AI acquisition targets');
    expect(specialistReceivedTaskContent).toContain("CEO's Direction");
    expect(specialistReceivedTaskContent).toContain('technology fit');

    // Final coordinator response synthesizes the research result
    expect(coordinatorResponses).toHaveLength(2);
    expect(coordinatorResponses[1]!).toContain('DataStream');
    expect(coordinatorResponses[1]!).toContain('technology fit');
  });

  it('one-shot research tasks still work as before (backward compatible)', async () => {
    // Regression guard: when the specialist returns a normal text response
    // (no request-clarification call), the coordinator synthesizes it directly.
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
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator' && !event.payload.isError) {
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
