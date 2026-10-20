// Runtime rendering of per-turn trigger guidance (#1959).
//
// The guidance heads the user message for the turn whose trigger fired. It must never
// reach the system string (that would split the cached prefix per trigger) or working
// memory (a long conversation would hold one copy per earlier turn).

import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import type { LLMProvider, Message } from '../../../src/agents/llm/provider.js';
import { renderTurnGuidance, TURN_GUIDANCE_HEADER } from '../../../src/agents/prompts/turn-guidance.js';
import { renderBacklogLine } from '../../../src/agents/prompts/backlog-line.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import type { OfficeIdentityService } from '../../../src/identity/service.js';
import { turnLengthReminder } from '../../../src/identity/length.js';
import { CodeTracker } from '../../../src/verification/code-tracker.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';
import type { Verification } from '../../../src/verification/types.js';

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

async function runTurn(payload: {
  content: string;
  turnGuidance?: unknown;
  principalBacklog?: unknown;
  channelId?: string;
  toolAllowlist?: string[];
  /** The office identity's Detail setting; absent means the agent has no identity service. */
  verbosity?: number;
  verification?: VerificationRuntime;
}) {
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
    ...(payload.verification && { verification: payload.verification }),
    ...(payload.verbosity !== undefined && {
      officeIdentityService: {
        get: () => ({ tone: { style: 'Dry.', verbosity: payload.verbosity } }),
      } as unknown as OfficeIdentityService,
    }),
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
    ...(payload.principalBacklog !== undefined && {
      principalBacklog: payload.principalBacklog as Parameters<typeof createAgentTask>[0]['principalBacklog'],
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

  it('closes the guidance with the backlog line, kept out of working memory (prompt trim PR 7)', async () => {
    const counts = { decayWarnings: 0, pendingApprovals: 1, principalTasks: 2 };
    const { messages, history } = await runTurn({
      content: 'Book Friday.',
      turnGuidance: ['principal-reply-shaped'],
      principalBacklog: counts,
    });
    expect(messages[messages.length - 1]!.content)
      .toBe(`${renderTurnGuidance(['principal-reply-shaped'], renderBacklogLine(counts))}\n\nBook Friday.`);
    expect(history[0]).toEqual({ role: 'user', content: 'Book Friday.' });
  });

  it('drops a malformed or empty backlog', async () => {
    for (const principalBacklog of [{ pendingApprovals: 1 }, { decayWarnings: 0, pendingApprovals: 0, principalTasks: 0 }]) {
      const { messages } = await runTurn({ content: 'Hello', principalBacklog });
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

describe('AgentRuntime verification-code-received guidance (#2017)', () => {
  const row = (over: Partial<Verification>): Verification => ({
    id: 'ver-1', purpose: 'sign_in', kind: 'code', delivery: 'sms', site: 'example-insurer.ca',
    pageDomain: 'example-insurer.ca', browserSessionId: 's-1', taskId: null, conversationId: null,
    status: 'pending', requestedAt: new Date(), expiresAt: new Date(Date.now() + 600_000), resolvedAt: null,
    metadata: {}, ...over,
  });
  function runtimeWith(rows: Verification[], trackedFor: string[]): VerificationRuntime {
    const tracker = new CodeTracker({ ttlMinutesAfterClose: 120 });
    for (const id of trackedFor) tracker.register(id, 'example-insurer.ca', '482913');
    return { tracker, listActive: vi.fn(async () => rows) } as unknown as VerificationRuntime;
  }
  const guidanceOf = (messages: Message[]) => {
    const content = String(messages[messages.length - 1]!.content);
    return content.slice(0, content.lastIndexOf('\n\n'));
  };

  it('names the site, session and verification the code is for, never the digits', async () => {
    const { messages } = await runTurn({
      content: '482913 — once you are in, send me the notice',
      turnGuidance: ['principal-reply-shaped', 'verification-code-received'],
      verification: runtimeWith(
        [row({}), row({ id: 'ver-mail', delivery: 'email', site: 'other.example' }), row({ id: 'ver-untracked', site: 'third.example' })],
        ['ver-1', 'ver-mail'],
      ),
    });
    const guidance = guidanceOf(messages);
    expect(guidance).toContain("The principal's message contains the sign-in code for example-insurer.ca.");
    expect(guidance).toContain('Enter it now in session s-1 (verification ver-1)');
    expect(guidance).toMatch(/don't ask for it again/);
    expect(guidance).not.toContain('other.example');
    expect(guidance).not.toContain('third.example');
    expect(guidance).not.toMatch(/\d{4,}/);
  });

  it('falls back to a generic line when the lookup fails or names nothing', async () => {
    for (const verification of [
      runtimeWith([], []),
      { tracker: new CodeTracker({ ttlMinutesAfterClose: 120 }), listActive: vi.fn(async () => { throw new Error('db down'); }) } as unknown as VerificationRuntime,
      undefined,
    ]) {
      const { messages } = await runTurn({
        content: '482913',
        turnGuidance: ['verification-code-received'],
        ...(verification && { verification }),
      });
      const guidance = guidanceOf(messages);
      expect(guidance).toMatch(/message contains the sign-in code/);
      expect(guidance).not.toMatch(/\d{4,}/);
    }
  });
});

describe('AgentRuntime length reminder (#2143)', () => {
  it('closes the guidance with the reply channel\'s limit', async () => {
    const { messages, history } = await runTurn({ content: 'Did Dana confirm?', channelId: 'signal', verbosity: 15 });
    const reminder = turnLengthReminder('signal', 15)!;
    expect(messages[messages.length - 1]!.content).toBe(`${renderTurnGuidance([], null, reminder)}\n\nDid Dana confirm?`);
    // Like all guidance, it stays out of working memory and the system string.
    expect(history[0]).toEqual({ role: 'user', content: 'Did Dana confirm?' });
    for (const m of messages.filter((msg) => msg.role === 'system')) expect(m.content).not.toContain(reminder);
  });

  it('follows the trigger guidance', async () => {
    const { messages } = await runTurn({ content: 'Go ahead', channelId: 'email', verbosity: 60, turnGuidance: ['principal-reply-shaped'] });
    expect(messages[messages.length - 1]!.content)
      .toBe(`${renderTurnGuidance(['principal-reply-shaped'], null, turnLengthReminder('email', 60))}\n\nGo ahead`);
  });

  it('adds nothing on a channel with no length row, a scheduler turn, or an agent without the identity', async () => {
    expect((await runTurn({ content: 'Hello', channelId: 'http', verbosity: 15 })).messages.at(-1)!.content).toBe('Hello');
    expect((await runTurn({ content: 'Hello', channelId: 'signal' })).messages.at(-1)!.content).toBe('Hello');
    const scheduled = (await runTurn({ content: 'Check on Sam.', channelId: 'scheduler', verbosity: 15 })).messages.at(-1)!.content;
    expect(scheduled).toBe(`${renderTurnGuidance(['scheduler-delivery'])}\n\nCheck on Sam.`);
  });
});
