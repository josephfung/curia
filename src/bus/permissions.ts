import type { Layer, EventType } from './events.js';

// Phase 1 subset — additional event types will be added as features are built
const publishAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['inbound.message']),
  dispatch: new Set(['agent.task', 'outbound.message']),
  agent: new Set(['agent.response']),
  execution: new Set([]),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'outbound.message']),
};

const subscribeAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['outbound.message']),
  dispatch: new Set(['inbound.message', 'agent.response']),
  agent: new Set(['agent.task']),
  execution: new Set([]),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'outbound.message']),
};

export function canPublish(layer: Layer, eventType: EventType): boolean {
  return publishAllowlist[layer].has(eventType);
}

export function canSubscribe(layer: Layer, eventType: EventType): boolean {
  return subscribeAllowlist[layer].has(eventType);
}
