// outbound-entry.test.ts — delegate owns the release of the outbound-context entry
// whose reply it routes (#1972).
//
// The coordinator used to decide from a specialist's prose whether an exchange had
// closed and call context-bridge-release itself; on the production model it released
// after interim results. Now delegate links the entry (outbound_entry_id, or the id of
// an entry the target owns quoted in the brief) and settles it from the result shape:
// kept only while routing the reply again could still work (no run started, or a
// retryable failure), released otherwise unless the specialist kept it open.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DelegateHandler } from './handler.js';
import { settlementFor } from './outbound-entry.js';
import { encodeResumeToken } from '../../src/agents/resume-token.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { BusEvent, AgentTaskEvent, AgentResponseEvent } from '../../src/bus/events.js';
import { createAgentResponse } from '../../src/bus/events.js';
import type { OutboundContextCapability, OutboundContextRow } from '../../src/dispatch/outbound-context.js';

type AgentResponsePayload = AgentResponseEvent['payload'];

const ENTRY_ID = '7f0c2d1e-3b4a-4c5d-8e6f-0a1b2c3d4e5f';
const OTHER_ENTRY_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

/** Bus that answers each agent.task with the given response payload. */
function makeBus(response: Partial<AgentResponsePayload> = {}) {
  const published: BusEvent[] = [];
  const handlers: Array<(e: BusEvent) => unknown> = [];
  const bus = {
    subscribe(type: string, _layer: string, handler: (e: BusEvent) => unknown) {
      if (type === 'agent.response') handlers.push(handler);
    },
    async publish(_layer: string, event: BusEvent) {
      published.push(event);
      if (event.type === 'agent.task') {
        const task = event as AgentTaskEvent;
        const resp = createAgentResponse({
          agentId: task.payload.agentId,
          conversationId: task.payload.conversationId,
          content: 'Drafted a reply to Dana suggesting Tuesday at 11. It is in your Drafts.',
          skillsCalled: [],
          parentEventId: task.id,
          ...response,
        } as AgentResponsePayload & { parentEventId: string });
        for (const h of handlers) await h(resp);
      }
    },
  } as unknown as EventBus;
  return { bus, published };
}

function row(id: string, delegationHint: string | null): OutboundContextRow {
  return {
    id, conversationId: 'thread-1', channelId: 'signal', agentId: 'ceo-inbox',
    contentPreview: 'Dana proposed Tuesday 8am. Accept, or suggest another time?',
    expectedReply: null, delegationHint, metadata: null,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), released: false,
  };
}

function makeOutboundContext(entries: OutboundContextRow[]) {
  return {
    getEntry: vi.fn(async (id: string) => entries.find(e => e.id === id) ?? null),
    releaseUnlessKeptOpen: vi.fn().mockResolvedValue('released'),
  } as unknown as OutboundContextCapability & {
    getEntry: ReturnType<typeof vi.fn>;
    releaseUnlessKeptOpen: ReturnType<typeof vi.fn>;
  };
}

const agentRegistry = {
  has: (n: string) => n === 'ceo-inbox' || n === 'calendar',
  get: (n: string) => ({ name: n, role: 'specialist' }),
  listSpecialists: () => [{ name: 'ceo-inbox' }, { name: 'calendar' }],
} as unknown as ToolContext['agentRegistry'];

function makeCtx(bus: EventBus, outboundContext: OutboundContextCapability | undefined, input: Record<string, unknown>): ToolContext {
  return {
    input: { agent: 'ceo-inbox', task: '8am is too early, suggest Tuesday at 11 instead.', ...input },
    log: pino({ level: 'silent' }),
    bus,
    agentRegistry,
    outboundContext,
    agentId: 'coordinator',
    conversationId: 'signal:+15555550100',
    channelId: 'signal',
    taskMetadata: {},
  } as unknown as ToolContext;
}

function publishedTask(published: BusEvent[]): AgentTaskEvent {
  return published.find(e => e.type === 'agent.task') as AgentTaskEvent;
}

describe('delegate: outbound-context entry lifecycle (#1972)', () => {
  it('releases the linked entry after the specialist takes the reply, scoped to its delegated task', async () => {
    const { bus, published } = makeBus();
    const oc = makeOutboundContext([row(ENTRY_ID, 'ceo-inbox')]);
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(result.success).toBe(true);
    const task = publishedTask(published);
    expect(oc.releaseUnlessKeptOpen).toHaveBeenCalledWith(ENTRY_ID, task.id);
  });

  it('names the entry in the specialist brief, but not in the resume brief source', async () => {
    const { bus, published } = makeBus();
    const oc = makeOutboundContext([row(ENTRY_ID, 'ceo-inbox')]);
    await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    const task = publishedTask(published);
    expect(task.payload.content).toContain(ENTRY_ID);
    // originalTask seeds a future resume_token; the entry note belongs to this run only.
    const origin = task.payload.metadata?.['delegationOrigin'] as { originalTask: string };
    expect(origin.originalTask).not.toContain(ENTRY_ID);
  });

  it('releases on a clarification request — the follow-up question gets its own entry', async () => {
    const { bus } = makeBus({
      content: JSON.stringify({
        _curia_protocol: 'clarification_request',
        question: 'Which day instead?',
        context: 'Dana proposed Tuesday 8am',
        resume_token: 'tok-1',
      }),
    });
    const oc = makeOutboundContext([row(ENTRY_ID, 'ceo-inbox')]);
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(result.success && (result.data as Record<string, unknown>).needs_clarification).toBe(true);
    expect(oc.releaseUnlessKeptOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps the entry on a retryable failure, so routing the reply again can link it', async () => {
    const { bus } = makeBus({ isError: true, reason: 'api_error', retryable: true, content: 'error' });
    const oc = makeOutboundContext([row(ENTRY_ID, 'ceo-inbox')]);
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(result.success && (result.data as Record<string, unknown>).failed).toBe(true);
    expect(oc.releaseUnlessKeptOpen).not.toHaveBeenCalled();
    expect((result as { data: Record<string, unknown> }).data.outbound_entry).toEqual({ id: ENTRY_ID, status: 'kept' });
  });

  it('releases on a non-retryable failure — routing the reply again cannot help', async () => {
    const { bus } = makeBus({ isError: true, reason: 'maxTurns', retryable: false, content: 'error' });
    const oc = makeOutboundContext([row(ENTRY_ID, 'ceo-inbox')]);
    await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(oc.releaseUnlessKeptOpen).toHaveBeenCalledTimes(1);
  });

  it('releases when the specialist declines — the exchange is over for that owner', async () => {
    const { bus } = makeBus({
      content: 'I cannot do this.\n<specialist_decline reason="out_of_scope">Not an inbox task.</specialist_decline>',
    });
    const oc = makeOutboundContext([row(ENTRY_ID, 'ceo-inbox')]);
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(result.success && (result.data as Record<string, unknown>).declined).toBe(true);
    expect(oc.releaseUnlessKeptOpen).toHaveBeenCalledTimes(1);
  });

  it('reports the outcome to the coordinator on the result', async () => {
    const { bus } = makeBus();
    const oc = makeOutboundContext([row(ENTRY_ID, 'ceo-inbox')]);
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect((result as { data: Record<string, unknown> }).data.outbound_entry).toEqual({ id: ENTRY_ID, status: 'released' });
  });

  it('never links a task-wake binding — the coordinator closes it with reply', async () => {
    const { bus } = makeBus();
    const binding = { ...row(ENTRY_ID, 'ceo-inbox'), metadata: { bind_reply: true, task_id: 'task-1' } };
    const oc = makeOutboundContext([binding]);
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(oc.releaseUnlessKeptOpen).not.toHaveBeenCalled();
    expect((result as { data: Record<string, unknown> }).data.outbound_entry).toMatchObject({
      id: ENTRY_ID, status: 'not_linked', reason: expect.stringMatching(/task-wake/),
    });
  });

  it('links an entry the target owns when the brief quotes its id instead of passing outbound_entry_id', async () => {
    const { bus, published } = makeBus();
    const oc = makeOutboundContext([row(ENTRY_ID, 'ceo-inbox')]);
    await new DelegateHandler().execute(
      makeCtx(bus, oc, { task: `Principal answered entry ${ENTRY_ID}: suggest Tuesday at 11.` }),
    );

    expect(oc.releaseUnlessKeptOpen).toHaveBeenCalledWith(ENTRY_ID, publishedTask(published).id);
  });

  it('does not link a quoted id whose entry another agent owns', async () => {
    const { bus } = makeBus();
    const oc = makeOutboundContext([row(OTHER_ENTRY_ID, 'calendar')]);
    await new DelegateHandler().execute(
      makeCtx(bus, oc, { task: `See entry ${OTHER_ENTRY_ID}; suggest Tuesday at 11.` }),
    );

    expect(oc.releaseUnlessKeptOpen).not.toHaveBeenCalled();
  });

  it('delegates without linking when outbound_entry_id names another agent\'s entry', async () => {
    const { bus, published } = makeBus();
    const oc = makeOutboundContext([row(ENTRY_ID, 'calendar')]);
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    // The reply still reaches the specialist the coordinator chose; only the release is
    // withheld, and the coordinator is told why.
    expect(result.success).toBe(true);
    expect(publishedTask(published)).toBeDefined();
    expect(oc.releaseUnlessKeptOpen).not.toHaveBeenCalled();
    expect((result as { data: Record<string, unknown> }).data.outbound_entry).toMatchObject({
      status: 'not_linked', reason: 'entry is owned by calendar, not ceo-inbox',
    });
  });

  it('delegates without linking when the entry is no longer active', async () => {
    const { bus } = makeBus();
    const oc = makeOutboundContext([]);
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(result.success).toBe(true);
    expect(oc.releaseUnlessKeptOpen).not.toHaveBeenCalled();
  });

  it('links an entry with no hint when outbound_entry_id names it explicitly', async () => {
    const { bus } = makeBus();
    const oc = makeOutboundContext([row(ENTRY_ID, null)]);
    await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(oc.releaseUnlessKeptOpen).toHaveBeenCalledTimes(1);
  });

  it('still returns the specialist result when the release throws', async () => {
    const { bus } = makeBus();
    const oc = makeOutboundContext([row(ENTRY_ID, 'ceo-inbox')]);
    oc.releaseUnlessKeptOpen.mockRejectedValue(new Error('db down'));
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(result.success).toBe(true);
    expect((result as { data: { response: string } }).data.response).toMatch(/Drafts/);
  });

  it('still delegates when the entry lookup throws', async () => {
    const { bus, published } = makeBus();
    const oc = makeOutboundContext([]);
    oc.getEntry.mockRejectedValue(new Error('db down'));
    const result = await new DelegateHandler().execute(makeCtx(bus, oc, { outbound_entry_id: ENTRY_ID }));

    expect(result.success).toBe(true);
    expect(publishedTask(published)).toBeDefined();
    expect(oc.releaseUnlessKeptOpen).not.toHaveBeenCalled();
  });

  it('works unchanged without the outboundContext capability', async () => {
    const { bus } = makeBus();
    const result = await new DelegateHandler().execute(makeCtx(bus, undefined, { outbound_entry_id: ENTRY_ID }));
    expect(result.success).toBe(true);
  });
});

describe('settlementFor: every delegate result shape (#1972)', () => {
  const ok = (data: Record<string, unknown>) => ({ success: true as const, data });
  const created = { taskCreated: true, resumeToken: undefined };

  it.each([
    ['an answer', ok({ response: 'done', agent: 'x' }), 'release'],
    ['a clarification request', ok({ needs_clarification: true, question: 'q', context: 'c', resume_token: 't' }), 'release'],
    ['a paused long task', ok({ paused: true, done: 1, total: 3, next: 'n', message: 'm' }), 'release'],
    ['a decline', ok({ declined: true, failed: true, reason: 'specialist_decline', retryable: false }), 'release'],
    ['a non-retryable failure', ok({ failed: true, reason: 'maxTurns', retryable: false }), 'release'],
    ['a wait timeout', ok({ failed: true, reason: 'timeout', retryable: false, possibly_succeeded: true }), 'release'],
    ['a retryable failure', ok({ failed: true, reason: 'api_error', retryable: true }), 'keep'],
    ['an in-flight refusal', ok({ in_flight: true, reason: 'already_in_flight' }), 'keep'],
    ['a guard block', ok({ failed: true, blocked: true, reason: 'blocked', retryable: false }), 'keep'],
  ] as const)('%s → %s', (_label, result, action) => {
    expect(settlementFor(result, created).action).toBe(action);
  });

  it('keeps on a brief rejected before dispatch (e.g. date validation)', () => {
    expect(settlementFor({ success: false, error: 'resolve the date first' }, { taskCreated: false, resumeToken: undefined }).action)
      .toBe('keep');
  });

  it('releases when a resume token cannot be decoded — that entry can only lead to the same dead resume', () => {
    expect(settlementFor({ success: false, error: 'corrupted' }, { taskCreated: false, resumeToken: 'not-a-token' }).action)
      .toBe('release');
  });

  it('keeps when a valid token was aimed at the wrong specialist — the coordinator can re-route', () => {
    const token = encodeResumeToken({ agent: 'calendar', originalTask: 'find a time', context: 'asked a day' });
    expect(settlementFor({ success: false, error: 'agent mismatch' }, { taskCreated: false, resumeToken: token }).action)
      .toBe('keep');
  });
});
