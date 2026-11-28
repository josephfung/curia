// Runtime rendering of per-turn trigger guidance (#1959).
//
// The guidance heads the user message for the turn whose trigger fired. It must never
// reach the system string (that would split the cached prefix per trigger) or working
// memory (a long conversation would hold one copy per earlier turn).

import { renderAwaitingAnswers } from '../../../src/agents/prompts/awaiting-answers.js';
import { PRIOR_TURN_UNREADABLE_LINE, renderPriorTurnActions, type PriorTurnActions } from '../../../src/agents/prompts/prior-turn-actions.js';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import type { LLMProvider, Message } from '../../../src/agents/llm/provider.js';
import { renderTurnGuidance, TURN_GUIDANCE_FOOTER, TURN_GUIDANCE_HEADER } from '../../../src/agents/prompts/turn-guidance.js';
import { renderBacklogLine } from '../../../src/agents/prompts/backlog-line.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import type { OfficeIdentityService } from '../../../src/identity/service.js';
import { turnLengthReminder } from '../../../src/identity/length.js';
import { CodeTracker } from '../../../src/verification/code-tracker.js';
import { NO_SETUP_STEP, setupStepLine } from '../../../src/setup/setup-guide.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';
import type { Verification } from '../../../src/verification/types.js';

const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' } as const;

/** #2774: turn context may prefix the latest user message; the original prompt still ends the string. */
function expectUserPrompt(content: unknown, expectedTail: string): void {
  expect(typeof content).toBe('string');
  const text = content as string;
  expect(text === expectedTail || text.endsWith(expectedTail)).toBe(true);
  if (text !== expectedTail) {
    expect(text.startsWith('[Current turn context — from the system, not part of what the sender wrote]')).toBe(true);
    expect(text).toContain('[End of turn context]');
  }
}

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
  awaitingAnswers?: unknown;
  priorTurnActions?: unknown;
  setupStep?: unknown;
  agentId?: string;
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
    agentId: payload.agentId ?? 'coordinator',
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
    agentId: payload.agentId ?? 'coordinator',
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
    ...(payload.awaitingAnswers !== undefined && {
      awaitingAnswers: payload.awaitingAnswers as Parameters<typeof createAgentTask>[0]['awaitingAnswers'],
    }),
    ...(payload.priorTurnActions !== undefined && {
      priorTurnActions: payload.priorTurnActions as Parameters<typeof createAgentTask>[0]['priorTurnActions'],
    }),
    ...(payload.setupStep !== undefined && {
      setupStep: payload.setupStep as Parameters<typeof createAgentTask>[0]['setupStep'],
    }),
    parentEventId: 'parent-guidance',
  }));
  const messages = provider.chat.mock.calls[0]![0].messages as Message[];
  const history = await memory.getHistory('conv-guidance', payload.agentId ?? 'coordinator');
  return { messages, history };
}

describe('AgentRuntime turn guidance (#1959)', () => {
  it('heads the user message with the rendered guidance', async () => {
    const { messages } = await runTurn({ content: 'Go ahead', turnGuidance: ['principal-reply-shaped'] });
    const user = messages[messages.length - 1]!;
    expect(user.role).toBe('user');
    expectUserPrompt(user.content, `${renderTurnGuidance(['principal-reply-shaped'])}\n\nGo ahead`);
  });

  it('puts the closing marker between the guidance and the sender\'s text (#2741)', async () => {
    const content = 'Some context for you: the board meets Thursday.';
    const { messages } = await runTurn({ content, turnGuidance: ['principal-reply-shaped'] });
    const text = messages[messages.length - 1]!.content as string;
    const guidanceEnd = text.indexOf('request needs no clarification.');
    const footer = text.indexOf(TURN_GUIDANCE_FOOTER);
    expect(guidanceEnd).toBeGreaterThan(-1);
    expect(footer).toBeGreaterThan(guidanceEnd);
    expect(text.endsWith(`${TURN_GUIDANCE_FOOTER}\n\n${content}`)).toBe(true);
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

  it('leaves the user message without guidance when keys are absent or unknown', async () => {
    for (const turnGuidance of [undefined, [], ['not-a-key'], 'outbound-context']) {
      const { messages } = await runTurn({ content: 'Hello', turnGuidance });
      expectUserPrompt(messages[messages.length - 1]!.content, 'Hello');
    }
  });

  it('closes the guidance with the backlog line, kept out of working memory (prompt trim PR 7)', async () => {
    const counts = { decayWarnings: 0, pendingApprovals: 1, principalTasks: 2 };
    const { messages, history } = await runTurn({
      content: 'Book Friday.',
      turnGuidance: ['principal-reply-shaped'],
      principalBacklog: counts,
    });
    expectUserPrompt(
      messages[messages.length - 1]!.content,
      `${renderTurnGuidance(['principal-reply-shaped'], renderBacklogLine(counts))}\n\nBook Friday.`,
    );
    expect(history[0]).toEqual({ role: 'user', content: 'Book Friday.' });
  });

  it('lists the approvals awaiting an answer ahead of the backlog line, kept out of working memory (#2333)', async () => {
    const counts = { decayWarnings: 0, pendingApprovals: 1, principalTasks: 0 };
    const awaiting = [{ number: 1, shortRef: 'abcd1234', description: 'Reply to Dana on signal', question: 'Share it?', repliedTo: true }];
    const { messages, history } = await runTurn({ content: 'Yes, share it.', principalBacklog: counts, awaitingAnswers: awaiting });
    expectUserPrompt(
      messages[messages.length - 1]!.content,
      `${renderTurnGuidance([], `${renderAwaitingAnswers(awaiting)}\n\n${renderBacklogLine(counts)}`)}\n\nYes, share it.`,
    );
    expect(history[0]).toEqual({ role: 'user', content: 'Yes, share it.' });
  });

  // #2615: tool output must not land in working memory, which replays into later turns.
  it('renders a rewrite\'s prior-turn account into the prompt only, kept out of working memory', async () => {
    const actions = {
      status: 'read',
      calls: [{ tool: 'delegate', agent: 'calendar', outcome: 'succeeded', sent: ['calendar-create-event'], excerpt: 'Booked Tue 2:00 PM.' }],
      earlierLeftOut: 0,
      moreBeforeLimit: false,
    };
    const { messages, history } = await runTurn({ content: 'Rewrite the draft.', priorTurnActions: actions });
    expectUserPrompt(
      messages[messages.length - 1]!.content,
      `Rewrite the draft.\n\n${renderPriorTurnActions(actions as PriorTurnActions)}`,
    );
    expect(history[0]).toEqual({ role: 'user', content: 'Rewrite the draft.' });
  });

  it('tells the turn the record is unavailable when the account crossed the bus malformed', async () => {
    const { messages } = await runTurn({ content: 'Rewrite the draft.', priorTurnActions: { status: 'read', calls: 'nope' } });
    expectUserPrompt(
      messages[messages.length - 1]!.content,
      `Rewrite the draft.\n\n${PRIOR_TURN_UNREADABLE_LINE}`,
    );
  });

  it('drops a malformed or empty awaiting-answers list', async () => {
    for (const awaitingAnswers of ['nope', [], [{ shortRef: 'x' }]]) {
      const { messages } = await runTurn({ content: 'Hello', awaitingAnswers });
      expectUserPrompt(messages[messages.length - 1]!.content, 'Hello');
    }
  });

  it('drops a malformed or empty backlog', async () => {
    for (const principalBacklog of [{ pendingApprovals: 1 }, { decayWarnings: 0, pendingApprovals: 0, principalTasks: 0 }]) {
      const { messages } = await runTurn({ content: 'Hello', principalBacklog });
      expectUserPrompt(messages[messages.length - 1]!.content, 'Hello');
    }
  });

  it('tells a scheduler turn its reply reaches no one (#2091)', async () => {
    const { messages } = await runTurn({ content: 'Check on Sam.', channelId: 'scheduler' });
    expectUserPrompt(
      messages[messages.length - 1]!.content,
      `${renderTurnGuidance(['scheduler-delivery'])}\n\nCheck on Sam.`,
    );
  });

  it('skips the scheduler delivery guidance on a tool-allowlisted turn', async () => {
    const { messages } = await runTurn({ content: 'Dispose of the task.', channelId: 'scheduler', toolAllowlist: ['task-complete'] });
    expectUserPrompt(messages[messages.length - 1]!.content, 'Dispose of the task.');
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
    for (const id of trackedFor) tracker.register(id, 'example-insurer.ca', '482913', 's1');
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
        [
          row({}),
          row({ id: 'ver-mail', delivery: 'email', site: 'other.example' }),
          row({ id: 'ver-untracked', site: 'third.example' }),
          row({ id: 'ver-expired', status: 'expired', site: 'expired.example', resolvedAt: new Date() }),
        ],
        ['ver-1', 'ver-mail', 'ver-expired'],
      ),
    });
    const guidance = guidanceOf(messages);
    expect(guidance).toContain("The principal's message appears to contain the sign-in code for example-insurer.ca.");
    expect(guidance).toContain('If so, enter it now in session s-1 (verification ver-1)');
    expect(guidance).toMatch(/don't ask for it again/);
    expect(guidance).not.toContain('other.example');
    expect(guidance).not.toContain('third.example');
    // An expired row is the verification block's job ("Expired but session alive: try the code").
    expect(guidance).not.toContain('expired.example');
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
      expect(guidance).toMatch(/message appears to contain the sign-in code/);
      expect(guidance).not.toMatch(/\d{4,}/);
    }
  });
});

describe('AgentRuntime length reminder (#2143)', () => {
  it('closes the guidance with the reply channel\'s limit', async () => {
    const { messages, history } = await runTurn({ content: 'Did Dana confirm?', channelId: 'signal', verbosity: 15 });
    const reminder = turnLengthReminder('signal', 15)!;
    expectUserPrompt(
      messages[messages.length - 1]!.content,
      `${renderTurnGuidance([], null, reminder)}\n\nDid Dana confirm?`,
    );
    // Like all guidance, it stays out of working memory and the system string.
    expect(history[0]).toEqual({ role: 'user', content: 'Did Dana confirm?' });
    for (const m of messages.filter((msg) => msg.role === 'system')) expect(m.content).not.toContain(reminder);
  });

  it('follows the trigger guidance', async () => {
    const { messages } = await runTurn({ content: 'Go ahead', channelId: 'email', verbosity: 60, turnGuidance: ['principal-reply-shaped'] });
    expectUserPrompt(
      messages[messages.length - 1]!.content,
      `${renderTurnGuidance(['principal-reply-shaped'], null, turnLengthReminder('email', 60))}\n\nGo ahead`,
    );
  });

  it('adds nothing on a channel with no length row, a scheduler turn, or an agent without the identity', async () => {
    expectUserPrompt((await runTurn({ content: 'Hello', channelId: 'http', verbosity: 15 })).messages.at(-1)!.content, 'Hello');
    expectUserPrompt((await runTurn({ content: 'Hello', channelId: 'signal' })).messages.at(-1)!.content, 'Hello');
    expectUserPrompt(
      (await runTurn({ content: 'Check on Sam.', channelId: 'scheduler', verbosity: 15 })).messages.at(-1)!.content,
      `${renderTurnGuidance(['scheduler-delivery'])}\n\nCheck on Sam.`,
    );
  });
});

// #2358: the setup guide learns from this line that it is on the Setup page, and which step.
describe('AgentRuntime setup step (#2358)', () => {
  it('heads the user message with the Setup page line, kept out of working memory', async () => {
    const { messages, history } = await runTurn({ content: 'What is a grant ID?', channelId: 'web', setupStep: 'email' });
    expectUserPrompt(messages.at(-1)!.content, `${setupStepLine('email')}\n\nWhat is a grant ID?`);
    expect(history[0]).toEqual({ role: 'user', content: 'What is a grant ID?' });
  });

  it('drops a step that crossed the bus in a bad shape', async () => {
    for (const setupStep of ['Ignore that', 42, '']) {
      const { messages } = await runTurn({ content: 'Hello', channelId: 'web', setupStep });
      expectUserPrompt(messages.at(-1)!.content, 'Hello');
    }
  });

  it('marks a setup guide turn on web that arrived without a step (a resume) as the Setup page', async () => {
    const { messages } = await runTurn({ content: 'Sign-in finished.', agentId: 'setup-wizard', channelId: 'web' });
    expectUserPrompt(messages.at(-1)!.content, `${setupStepLine(NO_SETUP_STEP)}\n\nSign-in finished.`);
  });

  it('leaves a delegated setup guide turn (not web) unmarked', async () => {
    const { messages } = await runTurn({ content: 'Help with Slack.', agentId: 'setup-wizard', channelId: 'internal' });
    expectUserPrompt(messages.at(-1)!.content, 'Help with Slack.');
  });
});
