// handler.test.ts — delegate skill: forwarding of relay context for specialist resume (#995).
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { DelegateHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { BusEvent, AgentTaskEvent } from '../../src/bus/events.js';
import { createAgentResponse } from '../../src/bus/events.js';

/** Fake bus that, when an agent.task is published, immediately delivers a successful
 *  agent.response parented to it so DelegateHandler's await resolves. */
function makeBus() {
  const published: BusEvent[] = [];
  const responseHandlers: Array<(e: BusEvent) => unknown> = [];
  const bus = {
    subscribe(type: string, _layer: string, handler: (e: BusEvent) => unknown) {
      if (type === 'agent.response') responseHandlers.push(handler);
    },
    async publish(_layer: string, event: BusEvent) {
      published.push(event);
      if (event.type === 'agent.task') {
        const task = event as AgentTaskEvent;
        const resp = createAgentResponse({
          agentId: task.payload.agentId,
          conversationId: task.payload.conversationId,
          content: 'done',
          skillsCalled: [],
          parentEventId: task.id,
        });
        for (const h of responseHandlers) await h(resp);
      }
    },
  } as unknown as EventBus;
  return { bus, published };
}

const agentRegistry = {
  has: (n: string) => n === 'research-analyst',
  get: (n: string) => ({ name: n, role: 'specialist' }),
  listSpecialists: () => [{ name: 'research-analyst' }],
} as unknown as SkillContext['agentRegistry'];

function makeCtx(bus: EventBus, over: Partial<SkillContext> = {}): SkillContext {
  return {
    input: { agent: 'research-analyst', task: 'find the acquisition comps' },
    log: pino({ level: 'silent' }),
    bus,
    agentRegistry,
    agentId: 'coordinator',
    conversationId: 'user-conv',
    channelId: 'email',
    taskMetadata: { originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' } },
    ...over,
  } as unknown as SkillContext;
}

describe('DelegateHandler relay-context forwarding (#995)', () => {
  it('forwards delegationOrigin (coordinator routing + brief) and originator on the specialist task', async () => {
    const { bus, published } = makeBus();
    const result = await new DelegateHandler().execute(makeCtx(bus));
    expect(result.success).toBe(true);

    const task = published.find(e => e.type === 'agent.task') as AgentTaskEvent;
    expect(task.payload.metadata).toMatchObject({
      delegationOrigin: {
        conversationId: 'user-conv',
        channelId: 'email',
        agentId: 'coordinator',
        originalTask: 'find the acquisition comps',
      },
      originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' },
    });
  });
});
