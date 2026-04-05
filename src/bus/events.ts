import { randomUUID } from 'node:crypto';
import type { ErrorType } from '../errors/types.js';

// -- Base event shape --
// Every event on the bus shares these fields; parentEventId forms the causal chain.

interface BaseEvent {
  id: string;
  timestamp: Date;
  parentEventId?: string;
}

// -- Layer type --
// Describes which architectural layer produced the event.

export type Layer = 'channel' | 'dispatch' | 'agent' | 'execution' | 'system';

// -- Event payloads --

interface InboundMessagePayload {
  conversationId: string;
  channelId: string;
  senderId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface AgentTaskPayload {
  agentId: string;
  conversationId: string;
  channelId: string;
  senderId: string;
  content: string;
  metadata?: Record<string, unknown>;
  /** Resolved sender context from the contact resolver. Undefined if contacts not configured. */
  senderContext?: import('../contacts/types.js').InboundSenderContext;
}

interface AgentResponsePayload {
  agentId: string;
  conversationId: string;
  content: string;
}

interface OutboundMessagePayload {
  conversationId: string;
  channelId: string;
  content: string;
}

// OutboundBlockedPayload — emitted by the dispatch layer's content filter when an outbound
// message is blocked before delivery. `findings` lists each rule that triggered and why,
// providing an audit trail for security review and incident response.
interface OutboundBlockedPayload {
  blockId: string;
  conversationId: string;
  channelId: string;
  content: string;         // the blocked content (stored for forensics)
  recipientId: string;     // the intended external recipient that was protected
  reason: string;          // human-readable summary of why the message was blocked
  findings: Array<{ rule: string; detail: string }>;
}

interface SkillInvokePayload {
  agentId: string;
  conversationId: string;
  skillName: string;
  input: Record<string, unknown>;
  taskEventId: string;  // traces back to the agent.task that triggered this
}

interface SkillResultPayload {
  agentId: string;
  conversationId: string;
  skillName: string;
  result: { success: true; data: unknown } | { success: false; error: string };
  durationMs: number;
}

// Agent error payload — published by the agent runtime when an error occurs
// that the user needs to know about (budget exceeded, unrecoverable failure, etc.)
interface AgentErrorPayload {
  agentId: string;
  conversationId: string;
  errorType: ErrorType;
  source: string;
  message: string;
  retryable: boolean;
  context: Record<string, unknown>;
}

// Contact event payloads — emitted by the dispatch layer during contact resolution (Contacts Phase A).

interface ContactResolvedPayload {
  contactId: string;
  displayName: string;
  role: string | null;
  kgNodeId: string | null;
  // 'verified' means the contact has been confirmed via an authoritative source (e.g. KG match);
  // 'unverified' means the identity was inferred but not confirmed.
  verificationStatus: 'verified' | 'unverified';
  channel: string;
  channelIdentifier: string;
}

interface ContactUnknownPayload {
  channel: string;
  senderId: string;
  /** Channel trust level. Optional in Phase A; Phase B will make it required. */
  channelTrustLevel?: 'low' | 'medium' | 'high';
}

interface MessageHeldPayload {
  heldMessageId: string;
  channel: string;
  senderId: string;
  subject: string | null;
}

// MessageRejectedPayload — emitted by the dispatch layer when a message is rejected
// due to an unknown_sender: reject policy (or a blocked sender). The conversationId
// is included so the HTTP adapter can immediately resolve the pending response
// with an error rather than hanging until the 120-second timeout.
interface MessageRejectedPayload {
  conversationId: string;
  channelId: string;
  senderId: string;
  /** Why the message was rejected — used by the HTTP adapter to select the status code. */
  reason: 'unknown_sender' | 'provisional_sender' | 'blocked_sender';
}

// Memory event payloads — used for the knowledge graph audit trail (Phase 6).
// `source` is a structured provenance string (e.g. "agent:coordinator/task:task-1/channel:cli").

interface MemoryStorePayload {
  agentId: string;
  conversationId: string;
  nodeId: string;
  nodeType: string;
  label: string;
  source: string;
}

interface MemoryQueryPayload {
  agentId: string;
  conversationId: string;
  queryType: string; // 'entity' | 'search' | 'facts'
  queryParams: Record<string, unknown>;
  resultCount: number;
}

// Schedule event payloads — emitted by the scheduler (system layer) for audit trail.

interface ScheduleCreatedPayload {
  jobId: string;
  agentId: string;
  cronExpr: string | null;
  runAt: string | null;
  taskPayload: Record<string, unknown>;
  createdBy: string;
}

interface ScheduleFiredPayload {
  jobId: string;
  agentId: string;
  agentTaskId: string | null;
}

interface ScheduleSuspendedPayload {
  jobId: string;
  agentId: string;
  lastError: string;
  consecutiveFailures: number;
}

// ConfigChangePayload — emitted by the System layer whenever a config object changes.
// Currently only used by OfficeIdentityService (config_type: 'office_identity').
// The diff_summary is a human-readable description of what changed; it is not machine-parseable.
interface ConfigChangePayload {
  config_type: string;          // e.g. 'office_identity'
  version: number;              // new version number
  previous_version: number;     // previous version number (0 if this is the first)
  changed_by: string;           // 'wizard' | 'api' | 'file_load'
  note?: string;                // optional human-readable reason
  diff_summary: string;         // human-readable summary of what changed
}

// -- Discriminated union --
// The `type` field is the discriminant; `sourceLayer` records which layer emitted the event.

export interface InboundMessageEvent extends BaseEvent {
  type: 'inbound.message';
  sourceLayer: 'channel';
  payload: InboundMessagePayload;
}

export interface AgentTaskEvent extends BaseEvent {
  type: 'agent.task';
  sourceLayer: 'dispatch';
  payload: AgentTaskPayload;
}

export interface AgentResponseEvent extends BaseEvent {
  type: 'agent.response';
  sourceLayer: 'agent';
  payload: AgentResponsePayload;
}

export interface OutboundMessageEvent extends BaseEvent {
  type: 'outbound.message';
  sourceLayer: 'dispatch';
  payload: OutboundMessagePayload;
}

// OutboundBlockedEvent — published by the dispatch layer when the content filter
// intercepts and blocks an outbound message. Channel adapters subscribe to this so
// they can surface a failure signal to the user (e.g., "message could not be sent").
// System layer subscribes for audit logging and security monitoring.
export interface OutboundBlockedEvent extends BaseEvent {
  type: 'outbound.blocked';
  sourceLayer: 'dispatch';
  payload: OutboundBlockedPayload;
}

export interface SkillInvokeEvent extends BaseEvent {
  type: 'skill.invoke';
  sourceLayer: 'agent';
  payload: SkillInvokePayload;
}

export interface SkillResultEvent extends BaseEvent {
  type: 'skill.result';
  // sourceLayer is 'execution' because the result logically comes from the execution layer,
  // even though the agent layer publishes it on behalf (execution layer has no bus access in Phase 3).
  sourceLayer: 'execution';
  payload: SkillResultPayload;
}

export interface AgentErrorEvent extends BaseEvent {
  type: 'agent.error';
  sourceLayer: 'agent';
  payload: AgentErrorPayload;
}

// Contact events — emitted by the dispatch layer during the contact resolution step.
// contact.resolved fires when a sender maps to a known contact; contact.unknown fires when no match is found.

export interface ContactResolvedEvent extends BaseEvent {
  type: 'contact.resolved';
  sourceLayer: 'dispatch';
  payload: ContactResolvedPayload;
}

export interface ContactUnknownEvent extends BaseEvent {
  type: 'contact.unknown';
  sourceLayer: 'dispatch';
  payload: ContactUnknownPayload;
}

export interface MessageHeldEvent extends BaseEvent {
  type: 'message.held';
  sourceLayer: 'dispatch';
  payload: MessageHeldPayload;
}

export interface MessageRejectedEvent extends BaseEvent {
  type: 'message.rejected';
  sourceLayer: 'dispatch';
  payload: MessageRejectedPayload;
}

// Memory events — emitted by the agent layer whenever the knowledge graph is written to or queried.
// These form the audit trail for memory operations (Phase 6).

export interface MemoryStoreEvent extends BaseEvent {
  type: 'memory.store';
  sourceLayer: 'agent';
  payload: MemoryStorePayload;
}

export interface MemoryQueryEvent extends BaseEvent {
  type: 'memory.query';
  sourceLayer: 'agent';
  payload: MemoryQueryPayload;
}

export interface ScheduleCreatedEvent extends BaseEvent {
  type: 'schedule.created';
  sourceLayer: 'system';
  payload: ScheduleCreatedPayload;
}

export interface ScheduleFiredEvent extends BaseEvent {
  type: 'schedule.fired';
  sourceLayer: 'system';
  payload: ScheduleFiredPayload;
}

export interface ScheduleSuspendedEvent extends BaseEvent {
  type: 'schedule.suspended';
  sourceLayer: 'system';
  payload: ScheduleSuspendedPayload;
}

export interface ConfigChangeEvent extends BaseEvent {
  type: 'config.change';
  sourceLayer: 'system';
  payload: ConfigChangePayload;
}

export type BusEvent =
  | InboundMessageEvent
  | AgentTaskEvent
  | AgentResponseEvent
  | OutboundMessageEvent
  | SkillInvokeEvent
  | SkillResultEvent
  | AgentErrorEvent          // Error recovery: structured error events for audit and user notification
  | MemoryStoreEvent      // Phase 6: knowledge graph write audit
  | MemoryQueryEvent      // Phase 6: knowledge graph read audit
  | ContactResolvedEvent  // Contacts Phase A: sender matched to a known contact
  | ContactUnknownEvent   // Contacts Phase A: sender has no contact record
  | MessageHeldEvent      // Unknown sender policy: message held for CEO review
  | MessageRejectedEvent  // Unknown sender policy: message rejected, signals HTTP adapter to return 403
  | OutboundBlockedEvent  // Outbound content filter: message blocked before delivery (#38)
  | ScheduleCreatedEvent   // Scheduler: job created
  | ScheduleFiredEvent     // Scheduler: job fired
  | ScheduleSuspendedEvent  // Scheduler: job auto-suspended
  | ConfigChangeEvent;      // System: config object changed (office identity, etc.)

// Convenience alias for use in handler maps / switch statements.
export type EventType = BusEvent['type'];

// -- Factory functions --
// Factories assign UUIDs and timestamps so callers never need to provide them.

export function createInboundMessage(
  payload: InboundMessagePayload,
  parentEventId?: string,
): InboundMessageEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'inbound.message',
    sourceLayer: 'channel',
    payload,
    parentEventId,
  };
}

export function createAgentTask(
  // parentEventId is required for agent.task — every task must trace back to a trigger event.
  payload: AgentTaskPayload & { parentEventId: string },
): AgentTaskEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.task',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createAgentResponse(
  // parentEventId is required — responses must reference the task that prompted them.
  payload: AgentResponsePayload & { parentEventId: string },
): AgentResponseEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.response',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createOutboundMessage(
  // parentEventId is required — outbound messages must trace back to the response that generated them.
  payload: OutboundMessagePayload & { parentEventId: string },
): OutboundMessageEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'outbound.message',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createOutboundBlocked(
  // parentEventId is required — every blocked event must trace back to the agent.response that was intercepted.
  payload: OutboundBlockedPayload & { parentEventId: string },
): OutboundBlockedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'outbound.blocked',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createSkillInvoke(
  // parentEventId is required — every skill invocation must trace back to the agent.task that triggered it.
  payload: SkillInvokePayload & { parentEventId: string },
): SkillInvokeEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'skill.invoke',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createSkillResult(
  // parentEventId is required — results must reference the skill.invoke event they respond to.
  payload: SkillResultPayload & { parentEventId: string },
): SkillResultEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'skill.result',
    sourceLayer: 'execution',
    payload: rest,
    parentEventId,
  };
}

export function createAgentError(
  // parentEventId is required — error events must trace back to the task that triggered them.
  payload: AgentErrorPayload & { parentEventId: string },
): AgentErrorEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.error',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createMemoryStore(
  // parentEventId is required — every memory write must trace back to the agent.task that triggered it.
  payload: MemoryStorePayload & { parentEventId: string },
): MemoryStoreEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'memory.store',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createMemoryQuery(
  // parentEventId is required — every memory read must trace back to the agent.task that triggered it.
  payload: MemoryQueryPayload & { parentEventId: string },
): MemoryQueryEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'memory.query',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createContactResolved(
  // parentEventId is required — every resolution must trace back to the inbound event that triggered it.
  payload: ContactResolvedPayload & { parentEventId: string },
): ContactResolvedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'contact.resolved',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createContactUnknown(
  // parentEventId is required — unknown-contact signals must trace back to the inbound event.
  payload: ContactUnknownPayload & { parentEventId: string },
): ContactUnknownEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'contact.unknown',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createMessageHeld(
  // parentEventId is required — held-message events must trace back to the inbound event.
  payload: MessageHeldPayload & { parentEventId: string },
): MessageHeldEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'message.held',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createMessageRejected(
  // parentEventId is required — rejection events must trace back to the inbound event.
  payload: MessageRejectedPayload & { parentEventId: string },
): MessageRejectedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'message.rejected',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleCreated(
  payload: ScheduleCreatedPayload & { parentEventId?: string },
): ScheduleCreatedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.created',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleFired(
  payload: ScheduleFiredPayload & { parentEventId?: string },
): ScheduleFiredEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.fired',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleSuspended(
  payload: ScheduleSuspendedPayload & { parentEventId?: string },
): ScheduleSuspendedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.suspended',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createConfigChange(
  payload: ConfigChangePayload & { parentEventId?: string },
): ConfigChangeEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'config.change',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}
