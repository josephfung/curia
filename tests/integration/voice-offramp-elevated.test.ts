// voice-offramp-elevated.test.ts — principal-directed elevated actions from a live call (#2495).
//
// Wires the real bus, agent runtimes, execution layer, async-offramp and delegate. The
// coordinator delegates to a contacts specialist, which calls an elevated contact-set-tier,
// the way the prod failure ran. Mock LLMs only; no database.
//
// The same wiring carries a send from the principal's mailbox (#2474): the coordinator
// delegates to ceo-inbox, whose ceo-inbox-send-draft must reach the gateway as
// principal-directed only while the call's live-turn grant holds.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { ToolRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { DelegateHandler } from '../../skills/delegate/handler.js';
import { AsyncOfframpHandler, resetAsyncOfframpDedupForTests } from '../../skills/async-offramp/handler.js';
import { CeoInboxSendDraftHandler } from '../../skills/ceo-inbox/tools/ceo-inbox-send-draft/handler.js';
import { isPrincipalDirectedMailboxSend, type SendAuthorityInput } from '../../src/skills/principal-send/authority.js';
import { PRINCIPAL_SEND_REFUSALS, type OutboundGateway, type PrincipalDraftSendResult } from '../../src/skills/outbound-gateway.js';
import { createAgentTask } from '../../src/bus/events.js';
import type { AgentResponseEvent, BusEvent } from '../../src/bus/events.js';
import type { LLMProvider, Message, ContentBlock } from '../../src/agents/llm/provider.js';
import type { ToolHandler, ToolManifest } from '../../src/skills/types.js';
import {
  activeLiveTurnGrantCountForTests,
  issueLiveTurnGrant,
  resetLiveTurnGrantsForTests,
} from '../../src/autonomy/live-turn-grants.js';

const logger = pino({ level: 'silent' });
const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' } as const;
const USAGE = { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

const principalOriginator = {
  contactId: 'ceo-1',
  systemRole: 'principal' as const,
  channel: 'voice',
  initiatedAt: '2026-11-06T12:00:00.000Z',
};

function manifest(overrides: Partial<ToolManifest> & Pick<ToolManifest, 'name'>): ToolManifest {
  return {
    description: overrides.name,
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: 'none',
    inputs: {},
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 120_000,
    ...overrides,
  };
}

function lastToolResult(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]!.content;
    if (!Array.isArray(content)) continue;
    const block = content.find((b: ContentBlock) => b.type === 'tool_result') as { content?: unknown } | undefined;
    if (block) return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
  }
  return '';
}

/** First call runs one tool, second replies with what the tool said. */
function scriptedProvider(id: string, toolName: string, input: Record<string, unknown>): LLMProvider {
  return {
    id,
    chat: async ({ messages }: { messages: Message[] }) => {
      const hasResult = messages.some(m => Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === 'tool_result'));
      if (!hasResult) {
        return { type: 'tool_use' as const, toolCalls: [{ id: `${id}-call`, name: toolName, input }], usage: USAGE, provenance: PROVENANCE };
      }
      return { type: 'text' as const, content: `${id} saw: ${lastToolResult(messages)}`, usage: USAGE, provenance: PROVENANCE };
    },
  };
}

/**
 * The gateway's principal-mailbox entry point, reduced to the authority decision it makes: a
 * principal-directed call sends, anything else is refused as not requested (PR 1).
 */
function principalSendGateway() {
  const directed: boolean[] = [];
  const sendPrincipalDraft = vi.fn(async (_draftId: string, options: { authority: SendAuthorityInput }): Promise<PrincipalDraftSendResult> => {
    const isDirected = isPrincipalDirectedMailboxSend(options.authority);
    directed.push(isDirected);
    return isDirected
      ? { success: true, messageId: 'sent-1', to: ['client@example.com'], subject: 'Re: Plans' }
      : { success: false, leftAsDraft: true, refusal: 'not_requested', blockedReason: PRINCIPAL_SEND_REFUSALS.not_requested };
  });
  return { gateway: { sendPrincipalDraft } as unknown as OutboundGateway, sendPrincipalDraft, directed };
}

const sendDraftManifest = JSON.parse(readFileSync(
  path.join(import.meta.dirname, '../../skills/ceo-inbox/tools/ceo-inbox-send-draft/tool.json'), 'utf-8',
)) as ToolManifest;

interface Specialist {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  brief: string;
}

const CONTACTS: Specialist = {
  id: 'contacts', tool: 'contact-set-tier', input: { contact_id: 'spam-1', tier: 'blocked' }, brief: 'Block the spam contact',
};
const CEO_INBOX: Specialist = {
  id: 'ceo-inbox', tool: 'ceo-inbox-send-draft', input: { draft_id: 'draft-1' }, brief: 'Send the reply draft to the client',
};

function setup(specialist: Specialist = CONTACTS) {
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('coordinator', { role: 'coordinator', description: 'Coordinator' });
  agentRegistry.register(specialist.id, { role: 'specialist', description: specialist.id });

  const tools = new ToolRegistry();
  tools.register(
    manifest({ name: 'delegate', capabilities: ['bus', 'agentRegistry'], inputs: { agent: 'string', task: 'string' } }),
    new DelegateHandler(),
  );
  tools.register(
    manifest({ name: 'async-offramp', action_risk: 'low', capabilities: ['bus'], allowed_callers: ['coordinator'] }),
    new AsyncOfframpHandler(),
  );
  const setTier = vi.fn<ToolHandler['execute']>(async () => ({ success: true, data: 'tier set to blocked' }));
  tools.register(manifest({ name: 'contact-set-tier', sensitivity: 'elevated', action_risk: 'low' }), { execute: setTier });
  tools.register(sendDraftManifest, new CeoInboxSendDraftHandler());
  const mailbox = principalSendGateway();

  const request = vi.fn(async (_opts: Record<string, unknown>) => ({ created: true as const, rowId: 1, shortRef: 'ref12345', approvalNumber: 4 }));
  const bus = new EventBus(logger);
  const executionLayer = new ExecutionLayer(tools, logger, {
    bus, agentRegistry, approvalTrigger: { request } as never, outboundGateway: mailbox.gateway,
    // ceo-inbox-send-draft declares principalMailboxes (#2475); the gateway stub locates the
    // draft, so the view is only there to satisfy the capability.
    principalMailboxes: { forSkills: () => ({}) } as never,
  });

  new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are a coordinator.',
    provider: scriptedProvider('coordinator', 'delegate', { agent: specialist.id, task: specialist.brief }),
    bus,
    logger,
    executionLayer,
    pinnedTools: ['delegate'],
    skillToolDefs: tools.toToolDefinitions(['delegate']),
  }).register();
  new AgentRuntime({
    agentId: specialist.id,
    systemPrompt: `You are the ${specialist.id} specialist.`,
    provider: scriptedProvider(specialist.id, specialist.tool, specialist.input),
    bus,
    logger,
    executionLayer,
    pinnedTools: [specialist.tool],
    skillToolDefs: tools.toToolDefinitions([specialist.tool]),
  }).register();

  const offramp = (mode: 'now' | 'after_call', liveTurn = true) =>
    executionLayer.invoke('async-offramp', { brief: specialist.brief, mode }, { contactId: 'ceo-1', role: 'ceo', channel: 'voice' }, {
      agentId: 'coordinator',
      channelId: 'voice',
      conversationId: 'voice:session-1',
      taskEventId: 'session-1',
      liveTurn,
      taskMetadata: { originator: principalOriginator, voiceSessionId: 'session-1' },
    });

  const coordinatorReply = () => new Promise<AgentResponseEvent>((resolve) => {
    bus.subscribe('agent.response', 'system', async (event: BusEvent) => {
      const response = event as AgentResponseEvent;
      if (response.payload.agentId === 'coordinator' && response.payload.conversationId.startsWith('voice-offramp:')) resolve(response);
    });
  });

  return { bus, setTier, request, offramp, coordinatorReply, mailbox };
}

describe('voice off-ramp: principal-directed elevated actions (#2495)', () => {
  beforeEach(() => {
    resetAsyncOfframpDedupForTests();
    resetLiveTurnGrantsForTests();
  });

  it('runs an elevated tool the principal directs on a connected call (mode now)', async () => {
    const { setTier, request, offramp } = setup();
    const result = await offramp('now');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ completed: true });
    expect(setTier).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    // The wait returned, so nothing is live any more.
    expect(activeLiveTurnGrantCountForTests()).toBe(0);
  });

  it('files a confirmation instead of running the tool for an after_call hand-off', async () => {
    const { setTier, request, offramp, coordinatorReply } = setup();
    const replied = coordinatorReply();
    const result = await offramp('after_call');
    expect(result.success).toBe(true);
    const reply = await replied;
    expect(setTier).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toMatchObject({ toolName: 'contact-set-tier', input: { contact_id: 'spam-1', tier: 'blocked' } });
    expect(reply.payload.content).toContain('confirmation');
    expect(reply.payload.content).not.toContain('requires a live principal turn');
  });

  it('files a confirmation once the call has ended, even for a now hand-off', async () => {
    const { bus, setTier, request, coordinatorReply } = setup();
    // The hand-off's grant, ended by the call hanging up before the coordinator picked it up.
    const grant = issueLiveTurnGrant({ voiceSessionId: 'session-1', ttlMs: 60_000 });
    grant.revoke();
    const replied = coordinatorReply();
    await bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'voice-offramp:ended',
      channelId: 'internal',
      senderId: 'ceo-1',
      content: 'Block the spam contact',
      metadata: { voiceOfframp: true, originator: principalOriginator },
      liveTurn: true,
      liveTurnGrantId: grant.id,
      parentEventId: 'session-1',
    }));
    await replied;
    expect(setTier).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  // #1126 regression: a woken task from the off-ramp's lineage keeps failing the gate, and
  // files nothing, even if it somehow carried a live grant.
  it('still refuses a heartbeat-woken task from the off-ramp lineage', async () => {
    const { bus, setTier, request } = setup();
    const grant = issueLiveTurnGrant({ voiceSessionId: 'session-1', ttlMs: 60_000 });
    const specialistReply = new Promise<AgentResponseEvent>((resolve) => {
      bus.subscribe('agent.response', 'system', async (event: BusEvent) => {
        const response = event as AgentResponseEvent;
        if (response.payload.agentId === 'contacts') resolve(response);
      });
    });
    await bus.publish('dispatch', createAgentTask({
      agentId: 'contacts',
      conversationId: 'woken-1',
      channelId: 'internal',
      senderId: 'scheduler',
      content: 'Block the spam contact',
      metadata: { originator: principalOriginator, wakeContext: { derived: true } },
      liveTurn: true,
      liveTurnGrantId: grant.id,
      parentEventId: 'wake-1',
    }));
    const reply = await specialistReply;
    expect(setTier).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(reply.payload.content).toContain('live principal turn');
  });
});

describe('voice off-ramp: a send from the principal\'s mailbox (#2474)', () => {
  beforeEach(() => {
    resetAsyncOfframpDedupForTests();
    resetLiveTurnGrantsForTests();
  });

  it('a voice turn delegating to ceo-inbox reaches ceo-inbox-send-draft as principal-directed', async () => {
    const { request, offramp, mailbox } = setup(CEO_INBOX);
    const result = await offramp('now');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ completed: true });
    expect(mailbox.sendPrincipalDraft).toHaveBeenCalledOnce();
    expect(mailbox.sendPrincipalDraft.mock.calls[0]![0]).toBe('draft-1');
    expect(mailbox.directed).toEqual([true]);
    expect(request).not.toHaveBeenCalled();
  });

  it('an async off-ramp whose live-turn grant lapsed reaches it as not principal-directed', async () => {
    const { request, offramp, coordinatorReply, mailbox } = setup(CEO_INBOX);
    const replied = coordinatorReply();
    const result = await offramp('after_call');
    expect(result.success).toBe(true);
    const reply = await replied;
    expect(mailbox.sendPrincipalDraft).toHaveBeenCalledOnce();
    expect(mailbox.directed).toEqual([false]);
    // Refused, not queued: no approval request, and the refusal reaches the coordinator.
    expect(request).not.toHaveBeenCalled();
    expect(reply.payload.content).toContain('Nothing was sent');
  });
});
