// The runtime hands each tool call an identifierSources lookup (#2061, ADR-047): source-tool
// results indexed under the task's root conversation, plus the messages people sent there.
import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import type { ExecutionLayer, InvokeOptions } from '../../../src/skills/execution.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import { IdentifierSourceIndex } from '../../../src/agents/identifier-source-index.js';
import type { IdentifierSources } from '../../../src/contacts/identifier-provenance.js';

const MOCK_PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock_000' } as const;
const USAGE = { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** An LLM that makes one tool call per round, then answers with text. */
function scriptedProvider(calls: Array<{ name: string; input: Record<string, unknown> }>): LLMProvider {
  let round = 0;
  return {
    id: 'mock',
    chat: async () => {
      const call = calls[round];
      round++;
      if (call) {
        return { type: 'tool_use' as const, toolCalls: [{ id: `call-${round}`, ...call }], usage: USAGE, provenance: MOCK_PROVENANCE };
      }
      return { type: 'text' as const, content: 'done', usage: USAGE, provenance: MOCK_PROVENANCE };
    },
  };
}

const toolDef = (name: string) => ({ name, description: name, input_schema: { type: 'object' as const, properties: {}, required: [] as string[] } });

async function runTask(opts: {
  agentId: string;
  conversationId: string;
  channelId: string;
  content: string;
  metadata?: Record<string, unknown>;
  calls: Array<{ name: string; input: Record<string, unknown> }>;
  results?: Record<string, unknown>;
  memory?: WorkingMemory;
}): Promise<{ sourcesFor: (tool: string) => IdentifierSources; warn: ReturnType<typeof vi.spyOn> }> {
  const logger = createLogger('error');
  const warn = vi.spyOn(logger, 'warn');
  const bus = new EventBus(logger);
  const seen = new Map<string, IdentifierSources>();
  const executionLayer = {
    invoke: vi.fn(async (name: string, _input: unknown, _caller: unknown, options?: InvokeOptions) => {
      if (options?.identifierSources) seen.set(name, options.identifierSources);
      return { success: true, data: opts.results?.[name] ?? 'ok' };
    }),
    isProvenanceSource: (name: string) => name === 'web-fetch',
  } as unknown as ExecutionLayer;

  const runtime = new AgentRuntime({
    agentId: opts.agentId,
    systemPrompt: 'You are an assistant.',
    provider: scriptedProvider(opts.calls),
    resolvedModel: 'mock-model',
    bus,
    logger,
    executionLayer,
    memory: opts.memory,
    identifierSourceIndex: new IdentifierSourceIndex(),
    pinnedTools: opts.calls.map((c) => c.name),
    skillToolDefs: opts.calls.map((c) => toolDef(c.name)),
  });
  runtime.register();

  await bus.publish('dispatch', createAgentTask({
    agentId: opts.agentId,
    conversationId: opts.conversationId,
    channelId: opts.channelId,
    senderId: 'user',
    content: opts.content,
    parentEventId: 'inbound-1',
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  }));

  return {
    sourcesFor: (tool) => {
      const sources = seen.get(tool);
      if (!sources) throw new Error(`${tool} was not invoked with identifierSources`);
      return sources;
    },
    warn,
  };
}

describe('runtime identifier sources (#2061)', () => {
  it('counts an address in an earlier source-tool result', async () => {
    const { sourcesFor } = await runTask({
      agentId: 'coordinator',
      conversationId: 'conv-web',
      channelId: 'cli',
      content: 'Find the venue booking address and add it',
      calls: [
        { name: 'web-fetch', input: { url: 'https://venue.example' } },
        { name: 'contact-create', input: {} },
      ],
      results: { 'web-fetch': 'Bookings: events@venue.example' },
    });
    const sources = sourcesFor('contact-create');
    await expect(sources.has('email', 'events@venue.example')).resolves.toBe(true);
    await expect(sources.has('email', 'event@venue.example')).resolves.toBe(false);
  });

  it('does not count a result from a tool that is not a source', async () => {
    const { sourcesFor } = await runTask({
      agentId: 'coordinator',
      conversationId: 'conv-delegate',
      channelId: 'cli',
      content: 'Ask research for the venue address and add it',
      calls: [
        { name: 'delegate', input: {} },
        { name: 'contact-create', input: {} },
      ],
      results: { delegate: 'The address is events@venue.example' },
    });
    await expect(sourcesFor('contact-create').has('email', 'events@venue.example')).resolves.toBe(false);
  });

  it('counts an address the person wrote in the current message', async () => {
    const memory = WorkingMemory.createInMemory();
    const { sourcesFor } = await runTask({
      agentId: 'coordinator',
      conversationId: 'conv-stated',
      channelId: 'cli',
      content: 'Email Dana at dana.whitfield@newco.example and say hi',
      calls: [{ name: 'contact-create', input: {} }],
      memory,
    });
    const sources = sourcesFor('contact-create');
    await expect(sources.has('email', 'dana.whitfield@newco.example')).resolves.toBe(true);
    await expect(sources.has('email', 'dana.whitfeld@newco.example')).resolves.toBe(false);
  });

  it('lets a delegated specialist use the person messages and source reads of the origin conversation', async () => {
    const memory = WorkingMemory.createInMemory();
    await memory.addTurn('origin-conv', 'coordinator', { role: 'user', content: 'email sam@venue-co.com about Friday' }, { channelId: 'cli' });
    const index = new IdentifierSourceIndex();
    index.record('origin-conv', 'Front desk: +1 416 555 0100');

    const logger = createLogger('error');
    const bus = new EventBus(logger);
    let sources: IdentifierSources | undefined;
    const executionLayer = {
      invoke: vi.fn(async (_name: string, _input: unknown, _caller: unknown, options?: InvokeOptions) => {
        sources = options?.identifierSources;
        return { success: true, data: 'ok' };
      }),
      isProvenanceSource: () => false,
    } as unknown as ExecutionLayer;
    const runtime = new AgentRuntime({
      agentId: 'contacts',
      systemPrompt: 'You manage contacts.',
      provider: scriptedProvider([{ name: 'contact-create', input: {} }]),
      resolvedModel: 'mock-model',
      bus,
      logger,
      executionLayer,
      memory,
      identifierSourceIndex: index,
      pinnedTools: ['contact-create'],
      skillToolDefs: [toolDef('contact-create')],
    });
    runtime.register();
    await bus.publish('dispatch', createAgentTask({
      agentId: 'contacts',
      conversationId: 'delegate-1',
      channelId: 'internal',
      senderId: 'coordinator',
      // The brief is model-written: an address only here must not count.
      content: 'Add Sam (sam@venue-co.com) and Lee (lee@venue-co.com)',
      parentEventId: 'inbound-1',
      metadata: { delegationOrigin: { conversationId: 'origin-conv', agentId: 'coordinator', channelId: 'cli' } },
    }));

    expect(sources).toBeDefined();
    await expect(sources!.has('email', 'sam@venue-co.com')).resolves.toBe(true);
    await expect(sources!.has('phone', '+14165550100')).resolves.toBe(true);
    await expect(sources!.has('email', 'lee@venue-co.com')).resolves.toBe(false);
  });

  it('treats a failed person-turn read as not found and logs it', async () => {
    const memory = WorkingMemory.createInMemory();
    vi.spyOn(memory, 'getPersonTurns').mockRejectedValue(new Error('db down'));
    const { sourcesFor, warn } = await runTask({
      agentId: 'coordinator',
      conversationId: 'conv-db-down',
      channelId: 'cli',
      content: 'Email Dana at dana.whitfield@newco.example',
      calls: [{ name: 'contact-create', input: {} }],
      memory,
    });
    await expect(sourcesFor('contact-create').has('email', 'dana.whitfield@newco.example')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('identifier provenance'));
  });
});
