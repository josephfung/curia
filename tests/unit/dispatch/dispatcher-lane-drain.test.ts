// A drained live principal message upgrades its host turn's routing to a live turn, but only
// when the host's own originator carries the principal's authority (GHSA-p49r-jqh2-v668): an
// authenticated Signal follow-up drained into a turn a spoofed SMS started must not hand that
// turn a live principal standing.
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { InjectableInput, TurnLanes } from '../../../src/dispatch/turn-lanes.js';
import { createLogger } from '../../../src/logger.js';

const principalResolver = {
  resolve: async () => ({
    resolved: true,
    contactId: 'principal-1',
    displayName: 'Principal',
    role: null,
    systemRole: 'principal',
    tier: 'principal',
    kind: 'person',
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 1,
  }),
} as unknown as ContactResolver;

type Routing = { liveTurn?: boolean };

function harness() {
  const bus = new EventBus(createLogger('error'));
  let drained: ((hostTaskEventId: string, input: InjectableInput) => void) | undefined;
  // Lanes off, so the dispatcher runs each inbound as its own turn; only the drain hook matters.
  const turnLanes = {
    enabled: false,
    markIntakeSettled: () => undefined,
    onDrained: (listener: (hostTaskEventId: string, input: InjectableInput) => void) => { drained = listener; },
  } as unknown as TurnLanes;
  const dispatcher = new Dispatcher({ bus, logger: createLogger('error'), contactResolver: principalResolver, turnLanes });
  dispatcher.register();
  const tasks: AgentTaskEvent[] = [];
  bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });
  // The routing map is private; the hook's only effect is on it.
  const routing = (id: string): Routing | undefined =>
    (dispatcher as unknown as { taskRouting: Map<string, Routing> }).taskRouting.get(id);
  const drain = (hostTaskEventId: string): void => drained!(hostTaskEventId, { liveTurn: true } as InjectableInput);
  return { bus, tasks, routing, drain };
}

describe('Dispatcher lane drain upgrade (GHSA-p49r-jqh2-v668)', () => {
  it('does not upgrade a host turn an unauthenticated principal SMS started', async () => {
    const h = harness();
    await h.bus.publish('channel', createInboundMessage({
      conversationId: 'sms:+15550100199', channelId: 'sms', senderId: '+15550100199', content: 'Approve it',
    }));
    const hostId = h.tasks[0]!.id;
    expect(h.routing(hostId)?.liveTurn).toBe(false);

    h.drain(hostId);
    expect(h.routing(hostId)?.liveTurn).toBe(false);
  });

  it('upgrades a host turn whose originator is an authenticated principal', async () => {
    const h = harness();
    await h.bus.publish('channel', createInboundMessage({
      conversationId: 'signal:+15550100199', channelId: 'signal', senderId: '+15550100199', content: 'Book it',
    }));
    const hostId = h.tasks[0]!.id;
    // Not live yet (as a host whose own message was not a live turn), so the drain decides.
    h.routing(hostId)!.liveTurn = false;

    h.drain(hostId);
    expect(h.routing(hostId)?.liveTurn).toBe(true);
  });
});
