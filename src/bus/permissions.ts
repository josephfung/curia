import type { Layer, EventType } from './events.js';

// Phase 3: agent and execution layers added for skill event types
// Phase 6: agent layer can publish memory.store and memory.query for the KG audit trail;
//          system layer gets full access so audit logger and monitoring can observe these events.
const publishAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['inbound.message']),
  dispatch: new Set(['agent.task', 'outbound.message']),
  agent: new Set(['agent.response', 'skill.invoke', 'skill.result', 'memory.store', 'memory.query']),
  execution: new Set(['skill.result']),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'outbound.message', 'skill.invoke', 'skill.result', 'memory.store', 'memory.query']),
};

const subscribeAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['outbound.message']),
  dispatch: new Set(['inbound.message', 'agent.response']),
  agent: new Set(['agent.task', 'skill.result']),
  execution: new Set(['skill.invoke']),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'outbound.message', 'skill.invoke', 'skill.result', 'memory.store', 'memory.query']),
};

export function canPublish(layer: Layer, eventType: EventType): boolean {
  return publishAllowlist[layer].has(eventType);
}

export function canSubscribe(layer: Layer, eventType: EventType): boolean {
  return subscribeAllowlist[layer].has(eventType);
}
