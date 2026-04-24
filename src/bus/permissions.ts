import type { Layer, EventType } from './events.js';

// Phase 3: agent and execution layers added for skill event types
// Phase 6: agent layer can publish memory.store and memory.query for the KG audit trail;
//          system layer gets full access so audit logger and monitoring can observe these events.
// Contacts Phase A: dispatch layer publishes contact.resolved and contact.unknown after resolution;
//                   system layer gets full access for audit logging.
// Error Recovery: agent layer can publish agent.error; dispatch layer subscribes to notify users;
//                 system layer gets full access for audit logging and monitoring.
// Contact Merge: dispatch layer publishes contact.duplicate_detected and contact.merged — these
//                fire as background side-effects of createContact() when DedupService is wired.
// Bullpen: agent layer publishes agent.discuss; dispatch and system layers subscribe.
// Checkpoint pipeline: dispatch layer publishes conversation.checkpoint after inactivity;
//                      system layer's ConversationCheckpointProcessor subscribes to run skills.
// Spec 10 (audit log hardening): agent layer publishes llm.call for LLM provenance (NIST AI 600-1,
//          EU AI Act Art. 12); dispatch layer publishes human.decision for HITL records (EU AI Act Art. 14).
//          system layer gets full access to both for audit logging and monitoring.
// Spec 06 (secrets isolation): execution layer publishes secret.accessed for every ctx.secret() call;
//          system layer gets full access for audit logging and monitoring.
// Observation mode (#311): dispatch layer publishes observation.triage.completed after each
//          observation-mode task; system layer subscribes for audit logging and monitoring.
const publishAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['inbound.message']),
  dispatch: new Set(['agent.task', 'outbound.message', 'outbound.blocked', 'contact.resolved', 'contact.unknown', 'message.held', 'message.rejected', 'contact.duplicate_detected', 'contact.merged', 'conversation.checkpoint', 'human.decision', 'observation.triage.completed']),
  agent: new Set(['agent.response', 'agent.error', 'skill.invoke', 'skill.result', 'memory.store', 'memory.query', 'agent.discuss', 'llm.call']),
  execution: new Set(['skill.result', 'secret.accessed']),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'agent.error', 'outbound.message', 'outbound.blocked', 'skill.invoke', 'skill.result', 'memory.store', 'memory.query', 'contact.resolved', 'contact.unknown', 'message.held', 'message.rejected', 'schedule.created', 'schedule.fired', 'schedule.suspended', 'schedule.recovered', 'schedule.drift_paused', 'config.change', 'contact.duplicate_detected', 'contact.merged', 'agent.discuss', 'conversation.checkpoint', 'llm.call', 'human.decision', 'secret.accessed', 'observation.triage.completed']),
};

// agent.discuss subscribe for 'dispatch': used by BullpenDispatcher (wired in index.ts after agent registration).
const subscribeAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['outbound.message', 'outbound.blocked', 'message.held', 'message.rejected']),
  dispatch: new Set(['inbound.message', 'agent.response', 'agent.error', 'agent.discuss']),
  agent: new Set(['agent.task', 'skill.result']),
  execution: new Set(['skill.invoke']),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'agent.error', 'outbound.message', 'outbound.blocked', 'skill.invoke', 'skill.result', 'memory.store', 'memory.query', 'contact.resolved', 'contact.unknown', 'message.held', 'message.rejected', 'schedule.created', 'schedule.fired', 'schedule.suspended', 'schedule.recovered', 'schedule.drift_paused', 'config.change', 'contact.duplicate_detected', 'contact.merged', 'agent.discuss', 'conversation.checkpoint', 'llm.call', 'human.decision', 'secret.accessed', 'observation.triage.completed']),
};

export function canPublish(layer: Layer, eventType: EventType): boolean {
  return publishAllowlist[layer].has(eventType);
}

export function canSubscribe(layer: Layer, eventType: EventType): boolean {
  return subscribeAllowlist[layer].has(eventType);
}
