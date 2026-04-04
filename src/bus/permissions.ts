import type { Layer, EventType } from './events.js';

// Phase 3: agent and execution layers added for skill event types
// Phase 6: agent layer can publish memory.store and memory.query for the KG audit trail;
//          system layer gets full access so audit logger and monitoring can observe these events.
// Contacts Phase A: dispatch layer publishes contact.resolved and contact.unknown after resolution;
//                   system layer gets full access for audit logging.
// Error Recovery: agent layer can publish agent.error; dispatch layer subscribes to notify users;
//                 system layer gets full access for audit logging and monitoring.
const publishAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['inbound.message']),
  dispatch: new Set(['agent.task', 'outbound.message', 'outbound.blocked', 'contact.resolved', 'contact.unknown', 'message.held', 'message.rejected']),
  agent: new Set(['agent.response', 'agent.error', 'skill.invoke', 'skill.result', 'memory.store', 'memory.query']),
  execution: new Set(['skill.result']),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'agent.error', 'outbound.message', 'outbound.blocked', 'skill.invoke', 'skill.result', 'memory.store', 'memory.query', 'contact.resolved', 'contact.unknown', 'message.held', 'message.rejected', 'schedule.created', 'schedule.fired', 'schedule.suspended']),
};

const subscribeAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['outbound.message', 'outbound.blocked', 'message.held', 'message.rejected']),
  dispatch: new Set(['inbound.message', 'agent.response', 'agent.error']),
  agent: new Set(['agent.task', 'skill.result']),
  execution: new Set(['skill.invoke']),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'agent.error', 'outbound.message', 'outbound.blocked', 'skill.invoke', 'skill.result', 'memory.store', 'memory.query', 'contact.resolved', 'contact.unknown', 'message.held', 'message.rejected', 'schedule.created', 'schedule.fired', 'schedule.suspended']),
};

export function canPublish(layer: Layer, eventType: EventType): boolean {
  return publishAllowlist[layer].has(eventType);
}

export function canSubscribe(layer: Layer, eventType: EventType): boolean {
  return subscribeAllowlist[layer].has(eventType);
}
