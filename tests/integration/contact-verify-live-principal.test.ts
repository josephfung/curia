// contact-verify-live-principal.test.ts — the principal verifies an unverified address by
// asking for it (#2515).
//
// Wires the real bus, agent runtimes, execution layer, delegate and contact-link-identity,
// with in-memory contacts and working memory. The coordinator delegates to the contacts
// specialist, which re-states the address, the way the 2026-11-05 prod request ran. The
// address comes from the principal's own message, read back through working memory. Mock
// LLMs only; no database.
import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { IdentifierSourceIndex } from '../../src/agents/identifier-source-index.js';
import { ToolRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { ContactService } from '../../src/contacts/contact-service.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { DelegateHandler } from '../../skills/delegate/handler.js';
import { ContactLinkIdentityHandler } from '../../skills/contacts/tools/contact-link-identity/handler.js';
import linkIdentityManifest from '../../skills/contacts/tools/contact-link-identity/tool.json' with { type: 'json' };
import { createAgentTask } from '../../src/bus/events.js';
import type { AgentResponseEvent, BusEvent } from '../../src/bus/events.js';
import type { LLMProvider, Message, ContentBlock } from '../../src/agents/llm/provider.js';
import type { ToolManifest } from '../../src/skills/types.js';

const logger = pino({ level: 'silent' });
const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' } as const;
const USAGE = { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const ADDRESS = 'office@acme.example';

const principalOriginator = {
  contactId: 'ceo-1',
  systemRole: 'principal' as const,
  channel: 'http',
  initiatedAt: '2026-11-05T15:00:00.000Z',
  tier: 'principal' as const,
};

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
function scriptedProvider(id: string, toolName: string, input: () => Record<string, unknown>): LLMProvider {
  return {
    id,
    chat: async ({ messages }: { messages: Message[] }) => {
      const hasResult = messages.some(m => Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === 'tool_result'));
      if (!hasResult) {
        return { type: 'tool_use' as const, toolCalls: [{ id: `${id}-call`, name: toolName, input: input() }], usage: USAGE, provenance: PROVENANCE };
      }
      return { type: 'text' as const, content: `${id} saw: ${lastToolResult(messages)}`, usage: USAGE, provenance: PROVENANCE };
    },
  };
}

async function setup() {
  const contactService = ContactService.createInMemory();
  const acme = await contactService.createContact({ displayName: 'Acme Office', source: 'agent_called' });
  // Found on the organization's website weeks earlier: on file, unverified.
  await contactService.linkIdentity({
    contactId: acme.id, channel: 'email', channelIdentifier: ADDRESS, source: 'agent_called', verified: false,
  });

  const agentRegistry = new AgentRegistry();
  agentRegistry.register('coordinator', { role: 'coordinator', description: 'Coordinator' });
  agentRegistry.register('contacts', { role: 'specialist', description: 'Contacts' });

  const tools = new ToolRegistry();
  tools.register(
    {
      name: 'delegate', description: 'delegate', version: '1.0.0', sensitivity: 'normal', action_risk: 'none',
      capabilities: ['bus', 'agentRegistry'], inputs: { agent: 'string', task: 'string' }, outputs: {},
      permissions: [], secrets: [], timeout: 120_000,
    },
    new DelegateHandler(),
  );
  tools.register(linkIdentityManifest as ToolManifest, new ContactLinkIdentityHandler());

  const bus = new EventBus(logger);
  const executionLayer = new ExecutionLayer(tools, logger, { bus, agentRegistry, contactService });
  const memory = WorkingMemory.createInMemory();
  // Isolated from the process-wide index, so no other test's sources leak in.
  const identifierSourceIndex = new IdentifierSourceIndex();

  new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are a coordinator.',
    provider: scriptedProvider('coordinator', 'delegate', () => ({ agent: 'contacts', task: 'Verify the Acme Office address' })),
    bus,
    logger,
    executionLayer,
    memory,
    identifierSourceIndex,
    pinnedTools: ['delegate'],
    skillToolDefs: tools.toToolDefinitions(['delegate']),
  }).register();
  new AgentRuntime({
    agentId: 'contacts',
    systemPrompt: 'You are the contacts specialist.',
    provider: scriptedProvider('contacts', 'contact-link-identity', () => ({ contact_id: acme.id, channel: 'email', identifier: ADDRESS })),
    bus,
    logger,
    executionLayer,
    memory,
    identifierSourceIndex,
    pinnedTools: ['contact-link-identity'],
    skillToolDefs: tools.toToolDefinitions(['contact-link-identity']),
  }).register();

  const reply = (agentId: string, conversationId: string) => new Promise<AgentResponseEvent>((resolve) => {
    bus.subscribe('agent.response', 'system', async (event: BusEvent) => {
      const response = event as AgentResponseEvent;
      if (response.payload.agentId === agentId && response.payload.conversationId === conversationId) resolve(response);
    });
  });

  const isVerified = async (): Promise<boolean> =>
    (await contactService.getContactWithIdentities(acme.id))!.identities[0]!.verified;

  return { bus, reply, isVerified };
}

describe('contact-link-identity: a live principal instruction verifies an address on file (#2515)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  /** The principal's message, as the dispatcher hands it to the coordinator. */
  async function principalAsks(conversationId: string, extra: { liveTurn?: boolean; metadata?: Record<string, unknown> } = {}) {
    const replied = ctx.reply('coordinator', conversationId);
    await ctx.bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId,
      channelId: 'http',
      senderId: 'ceo-1',
      content: `Can you verify the Acme contact as ${ADDRESS}, then try creating the draft again`,
      metadata: { originator: principalOriginator, ...extra.metadata },
      ...(extra.liveTurn !== undefined ? { liveTurn: extra.liveTurn } : {}),
      parentEventId: `inbound-${conversationId}`,
    }));
    return replied;
  }

  it('verifies it when the principal asks in a live turn, through a synchronous delegation', async () => {
    const reply = await principalAsks('web:live', { liveTurn: true });
    expect(reply.payload.content).toContain('already_linked');
    expect(reply.payload.content).not.toContain('vouch');
    expect(await ctx.isVerified()).toBe(true);
  });

  it('refuses the same request from a woken principal-lineage task, leaving it unverified', async () => {
    // A wake never carries liveTurn; set it anyway, so the wake itself is what refuses.
    const reply = await principalAsks('web:woken', { liveTurn: true, metadata: { wakeContext: { derived: false } } });
    expect(reply.payload.content).toContain('only the principal can vouch for it');
    expect(await ctx.isVerified()).toBe(false);
  });

  it('refuses a bullpen-routed request to the contacts specialist, leaving it unverified', async () => {
    const replied = ctx.reply('contacts', 'bullpen:thread-1');
    await ctx.bus.publish('dispatch', createAgentTask({
      agentId: 'contacts',
      conversationId: 'bullpen:thread-1',
      channelId: 'internal',
      senderId: 'coordinator',
      content: `The principal asked to verify the Acme contact as ${ADDRESS}`,
      metadata: { originator: principalOriginator, taskOrigin: 'bullpen' },
      parentEventId: 'bullpen-1',
    }));
    const reply = await replied;
    expect(reply.payload.content).toContain('only the principal can vouch for it');
    expect(await ctx.isVerified()).toBe(false);
  });
});
