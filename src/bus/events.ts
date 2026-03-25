import { randomUUID } from 'node:crypto';

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

export type BusEvent =
  | InboundMessageEvent
  | AgentTaskEvent
  | AgentResponseEvent
  | OutboundMessageEvent;

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
